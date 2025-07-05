const { getStateById, getInitialStateId } = require('./configLoader');
const redisClient = require('./redisClient');
const { processTemplate } = require('./templateProcessor');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');
const apiCallerService = require('./apiCallerService');
const { getApiConfigById } = require('./apiConfigLoader');

const FSM_SESSION_PREFIX = 'fsm_session:';

function saveSessionAsync(sessionKey, sessionData, sessionTTL) {
  const jsonData = JSON.stringify(sessionData);
  let promise = redisClient.set(sessionKey, jsonData); // Default no TTL
  if (sessionTTL && sessionTTL > 0) {
    promise = redisClient.set(sessionKey, jsonData, 'EX', sessionTTL);
  }
  promise.catch(err => {
    logger.error({ err, sessionId: sessionKey.split(':')[1] }, 'FSM session failed to save to Redis.');
  });
}

async function initializeOrRestoreSession(sessionId) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionDataString = await redisClient.get(sessionKey);
  if (sessionDataString) {
    const session = JSON.parse(sessionDataString);
    session.pendingApiResponses = session.pendingApiResponses || {};
    session.sync_api_results = session.sync_api_results || {}; // Initialize if not present
    session.parameters = session.parameters || {};
    logger.debug({ sessionId }, 'FSM session restored from Redis.');
    return session;
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {},
      history: [initialStateId],
      pendingApiResponses: {},
      sync_api_results: {}, // Initialize for new sessions
    };
    const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
    saveSessionAsync(sessionKey, initialSession, sessionTTL);
    logger.info({ sessionId, initialStateId }, 'FSM new session initialized.');
    return initialSession;
  }
}

async function processInput(sessionId, intent, inputParameters = {}, initialCall = false) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionData = await initializeOrRestoreSession(sessionId);
  let currentStateId = sessionData.currentStateId;

  // Merge incoming parameters and ensure session.parameters is the single source of truth for currentParameters
  let currentParameters = { ...sessionData.parameters, ...inputParameters };
  sessionData.parameters = currentParameters; // Update sessionData's parameters

  if (!sessionData.sync_api_results) sessionData.sync_api_results = {};
  if (!sessionData.pendingApiResponses) sessionData.pendingApiResponses = {};

  let effectiveIntent = intent;
  if (!initialCall && !effectiveIntent && process.env.DEFAULT_INTENT) { // Avoid default intent on very first call if not desired
    effectiveIntent = process.env.DEFAULT_INTENT;
    logger.info({ sessionId, defaultIntent: effectiveIntent }, `FSM: No intent. Using DEFAULT_INTENT.`);
  }

  logger.debug({ sessionId, currentStateId, intent: effectiveIntent, inputParametersCount: Object.keys(inputParameters).length }, 'FSM processing input: Start');

  // --- Phase 1: Determine Target State (current or next based on transitions) ---
  // This logic determines the state whose 'synchronousCallSetup' should be processed.
  // If there's an intent, we first see if it causes an immediate transition.
  // If so, the target state for syncAPIs is the new state. Otherwise, it's the current state.

  let preliminaryNextStateId = null;
  let preliminaryMatchedTransition = false;
  const fsmCurrentStateConfig = getStateById(currentStateId); // Config of the state *before* transitions for this input

  if (effectiveIntent && fsmCurrentStateConfig.transitions && fsmCurrentStateConfig.transitions.length > 0) {
    for (const transition of fsmCurrentStateConfig.transitions) {
      if (transition.condition && transition.condition.intent === effectiveIntent) {
        preliminaryNextStateId = transition.nextState;
        preliminaryMatchedTransition = true;
        break;
      }
    }
  }
  // Parameter-based transitions are typically evaluated *after* parameters for the current state are collected
  // and after synchronous APIs for the current state might have run.
  // For now, we'll assume synchronous APIs are primarily for the *current state* before parameter collection prompts,
  // or for the *target state* if an intent causes an immediate transition.

  const targetStateIdForSyncApis = preliminaryNextStateId || currentStateId;
  const targetStateConfigForSyncApis = getStateById(targetStateIdForSyncApis);

  if (!targetStateConfigForSyncApis) {
    logger.error({ targetStateIdForSyncApis, sessionId }, 'FSM Error: Config for target state (for sync APIs) not found.');
    throw new Error(`Config for target state ${targetStateIdForSyncApis} not found.`);
  }

  // --- Phase 2: Execute Synchronous API Calls (`synchronousCallSetup`) for the target state ---
  const syncCallsDefinition = targetStateConfigForSyncApis.payloadResponse?.apiHooks?.synchronousCallSetup;
  if (syncCallsDefinition && Array.isArray(syncCallsDefinition)) {
    logger.info({sessionId, state: targetStateIdForSyncApis, apis: syncCallsDefinition}, "Executing synchronousCallSetup APIs");
    for (const apiId of syncCallsDefinition) {
      const correlationId = `sync_${apiId}_${Date.now()}`; // Simpler correlation for sync calls
      const apiResponse = await apiCallerService.makeRequestAndWait(apiId, sessionId, correlationId, currentParameters);

      // Namespace results to avoid collision and for clarity in templates
      currentParameters.sync_api_results = currentParameters.sync_api_results || {};
      currentParameters.sync_api_results[apiId] = apiResponse; // Store full response (status, data, error)
      sessionData.parameters = currentParameters; // Update session parameters immediately

      if (apiResponse.status === 'error') {
        logger.warn({ sessionId, apiId, error: apiResponse.errorMessage }, 'Synchronous API call failed.');
        // Potentially transition to a specific error state or add error flags for AI/templating
        // For now, the error is in sync_api_results and can be checked by templates/AI
      }
    }
  }

  // --- Phase 3: FSM Transition Logic (Now with potentially updated currentParameters from sync APIs) ---
  // This is the main transition logic based on intent and allParametersMet for the *original* currentStateId
  // Or, if a preliminaryNextStateId was determined by intent, that becomes the new currentStateId.

  let nextStateId = currentStateId; // Start with current state
  let finalNextStateConfig = fsmCurrentStateConfig; // And its config

  if (preliminaryNextStateId) { // Intent-based transition already determined
      nextStateId = preliminaryNextStateId;
      finalNextStateConfig = getStateById(nextStateId);
      if (!finalNextStateConfig) {
          logger.error({ nextStateId, sessionId }, 'FSM Error: Config for intent-based next state not found.');
          throw new Error(`Config for next state ${nextStateId} not found.`);
      }
      logger.debug({ sessionId, transitionTo: nextStateId, reason: `Intent match: ${effectiveIntent}` }, 'FSM transition by intent confirmed');
  } else { // No intent-based transition, evaluate parameter-based transitions for fsmCurrentStateConfig
      let parameterTransitionFound = false;
      if (fsmCurrentStateConfig.transitions && fsmCurrentStateConfig.transitions.length > 0) {
          for (const transition of fsmCurrentStateConfig.transitions) {
              if (transition.condition && !transition.condition.intent) {
                  if (typeof transition.condition.allParametersMet === 'undefined' || transition.condition.allParametersMet) {
                      const requiredParams = fsmCurrentStateConfig.parameters?.required || [];
                      const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
                      if (allRequiredMet) {
                          nextStateId = transition.nextState;
                          parameterTransitionFound = true;
                          logger.debug({ sessionId, transitionTo: nextStateId, reason: 'All params met for current state' }, 'FSM transition by params');
                          break;
                      }
                  } else if (transition.condition.allParametersMet === false) {
                      nextStateId = transition.nextState;
                      parameterTransitionFound = true;
                      logger.debug({ sessionId, transitionTo: nextStateId, reason: 'Condition allParametersMet: false for current state' }, 'FSM transition by allParametersMet:false');
                      break;
                  }
              }
          }
      }
      if (!parameterTransitionFound && fsmCurrentStateConfig.defaultNextState) {
          const requiredParams = fsmCurrentStateConfig.parameters?.required || [];
          const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
          if (allRequiredMet) {
              nextStateId = fsmCurrentStateConfig.defaultNextState;
              logger.debug({ sessionId, transitionTo: nextStateId, reason: 'Default next state for current state, all params met' }, 'FSM transition by defaultNextState');
          }
      }
      // If nextStateId changed, update finalNextStateConfig
      if (nextStateId !== currentStateId) {
          finalNextStateConfig = getStateById(nextStateId);
          if (!finalNextStateConfig) {
              logger.error({ nextStateId, sessionId }, 'FSM Error: Config for parameter-based next state not found.');
              throw new Error(`Config for next state ${nextStateId} not found.`);
          }
      }
  }

  if (currentStateId !== nextStateId) {
    logger.info({ sessionId, fromState: currentStateId, toState: nextStateId }, `FSM transitioning`);
    sessionData.currentStateId = nextStateId;
    if (!sessionData.history.length || sessionData.history[sessionData.history.length - 1] !== nextStateId) {
      sessionData.history.push(nextStateId);
    }
  } else {
    logger.debug({ sessionId, state: currentStateId }, 'FSM staying in current state');
  }
  // sessionData.parameters is already currentParameters

  // --- Phase 4: Render PayloadResponse for the *final* next state ---
  let renderedPayloadResponse = {};
  if (finalNextStateConfig.payloadResponse) {
    try {
      // currentParameters now includes results from synchronousCallSetup
      renderedPayloadResponse = processTemplate(
        JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse)),
        currentParameters
      );
    } catch (templateError) {
      logger.error({ err: templateError, sessionId, state: nextStateId }, `FSM Error: Processing payloadResponse template for state.`);
      renderedPayloadResponse = JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse)); // Fallback
    }
  }

  // --- Phase 5: Initiate Asynchronous API Calls (`asynchronousCallDispatch`) for the *final* next state ---
  // These are based on the state we are *now in* or *transitioning to definitively*.
  // The `apiHooks` should be read from the *original* config, not the rendered one.
  const asyncCallsDispatch = finalNextStateConfig.payloadResponse?.apiHooks?.asynchronousCallDispatch;
  if (asyncCallsDispatch && Array.isArray(asyncCallsDispatch)) {
    logger.info({sessionId, state: nextStateId, apis: asyncCallsDispatch}, "Initiating asynchronousCallDispatch APIs");
    for (const apiId of asyncCallsDispatch) { // Assuming this is just an array of apiIds
      const callDefinition = { apiId: apiId }; // Minimal definition if only apiId is provided
      // If `asyncApiCallsToTrigger` structure was intended here, this loop needs adjustment
      // For now, let's assume `asynchronousCallDispatch` contains objects like `asyncApiCallsToTrigger` items.
      // The user's states.json uses simple strings, so we adapt:

      const correlationId = uuidv4(); // Always generate new for async

      // If 'assignCorrelationIdTo' was part of a richer object structure for these calls:
      // if (callDefinition.assignCorrelationIdTo) {
      //   currentParameters[callDefinition.assignCorrelationIdTo] = correlationId;
      //   sessionData.parameters[callDefinition.assignCorrelationIdTo] = correlationId;
      // }

      let processedApiParams = {}; // Params for async calls might be defined differently or use currentParameters
      // if (callDefinition.params) {
      //   processedApiParams = processTemplate(JSON.parse(JSON.stringify(callDefinition.params)), currentParameters);
      // }

      const apiConfig = getApiConfigById(apiId); // apiId directly from the array
      if (!apiConfig || !apiConfig.response_stream_key_template) {
        logger.error({ apiId, sessionId }, `FSM: Missing apiConfig or response_stream_key_template for async call. Skipping.`);
        continue;
      }

      const templateContextForStreamKey = { ...currentParameters, correlationId, sessionId };
      const responseStreamKey = processTemplate(apiConfig.response_stream_key_template, templateContextForStreamKey);

      sessionData.pendingApiResponses[correlationId] = {
        apiId: apiId,
        responseStreamKey: responseStreamKey,
        requestedAt: new Date().toISOString(),
      };
      logger.info({sessionId, correlationId, apiId, responseStreamKey}, "FSM: Marked async API call as pending.");

      apiCallerService.makeRequestAsync(apiId, sessionId, correlationId, processedApiParams);
    }
  }

  const requiredForNext = finalNextStateConfig.parameters?.required || [];
  const optionalForNext = finalNextStateConfig.parameters?.optional || [];
  const parametersToCollect = {
    required: requiredForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === ''),
    optional: optionalForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '')
  };

  const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
  saveSessionAsync(sessionKey, sessionData, sessionTTL);

  logger.debug({ sessionId, finalState: nextStateId, paramsToCollectCount: parametersToCollect.required.length }, 'FSM processing complete.');

  return {
    nextStateId: nextStateId, // The state ID FSM has decided upon
    currentStateConfig: fsmCurrentStateConfig, // Config of state at start of this processInput
    nextStateConfig: finalNextStateConfig, // Config of the state FSM is now in
    parametersToCollect: parametersToCollect,
    payloadResponse: renderedPayloadResponse,
    sessionData: sessionData, // Contains updated .parameters, .pendingApiResponses, .sync_api_results
  };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
  saveSessionAsync, // Exported for potential use by index.js if session needs saving outside fsm.processInput
  FSM_SESSION_PREFIX
};
