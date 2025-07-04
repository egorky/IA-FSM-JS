const { getStateById, getInitialStateId } = require('./configLoader');
const redisClient = require('./redisClient');
const { processTemplate } = require('./templateProcessor');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');
const apiCallerService = require('./apiCallerService');
const { getApiConfigById } = require('./apiConfigLoader');

const FSM_SESSION_PREFIX = 'fsm_session:';

/**
 * Asynchronously saves session data to Redis. Does not block.
 */
function saveSessionAsync(sessionKey, sessionData, sessionTTL) {
  const jsonData = JSON.stringify(sessionData);
  let promise;
  if (sessionTTL && sessionTTL > 0) {
    promise = redisClient.set(sessionKey, jsonData, 'EX', sessionTTL);
    logger.debug({ sessionId: sessionKey.split(':')[1], ttl: sessionTTL }, `FSM session saving to Redis with TTL.`);
  } else {
    promise = redisClient.set(sessionKey, jsonData);
    logger.debug({ sessionId: sessionKey.split(':')[1] }, `FSM session saving to Redis without TTL.`);
  }
  promise.catch(err => {
    logger.error({ err, sessionId: sessionKey.split(':')[1] }, 'FSM session failed to save to Redis asynchronously.');
  });
}

async function initializeOrRestoreSession(sessionId) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionDataString = await redisClient.get(sessionKey);

  if (sessionDataString) {
    logger.debug({ sessionId }, 'FSM session restored from Redis.');
    const session = JSON.parse(sessionDataString);
    if (!session.pendingApiResponses) {
      session.pendingApiResponses = {};
    }
    return session;
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {},
      history: [initialStateId],
      pendingApiResponses: {},
    };
    const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
    saveSessionAsync(sessionKey, initialSession, sessionTTL);
    logger.info({ sessionId, initialStateId }, 'FSM new session initialized.');
    return initialSession;
  }
}

async function processInput(sessionId, intent, inputParameters = {}) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionData = await initializeOrRestoreSession(sessionId);
  let currentStateId = sessionData.currentStateId;

  let effectiveIntent = intent;
  if (!effectiveIntent && process.env.DEFAULT_INTENT) {
    effectiveIntent = process.env.DEFAULT_INTENT;
    logger.info({ sessionId, defaultIntent: effectiveIntent }, `FSM: No intent provided. Using DEFAULT_INTENT.`);
  }

  let currentParameters = { ...sessionData.parameters, ...inputParameters };
  sessionData.parameters = currentParameters;
  if (!sessionData.pendingApiResponses) {
    sessionData.pendingApiResponses = {};
  }

  const currentStateConfig = getStateById(currentStateId);
  if (!currentStateConfig) {
    logger.error({ currentStateId, sessionId }, 'FSM Error: Configuración no encontrada para el estado actual.');
    throw new Error(`Configuración no encontrada para el estado: ${currentStateId}`);
  }
  logger.debug({ sessionId, currentStateId, /*currentParameters: 'OMITTED'*/ effectiveIntent }, 'FSM processing input');

  let nextStateId = null;
  let matchedTransition = false;

  // ... (transition logic - unchanged) ...
  if (effectiveIntent && currentStateConfig.transitions && currentStateConfig.transitions.length > 0) {
    for (const transition of currentStateConfig.transitions) {
      if (transition.condition && transition.condition.intent === effectiveIntent) {
        nextStateId = transition.nextState;
        matchedTransition = true;
        logger.debug({ sessionId, transitionTo: nextStateId, reason: `Intent match: ${effectiveIntent}` }, 'FSM transition by intent');
        break;
      }
    }
  }
  if (!matchedTransition && currentStateConfig.transitions && currentStateConfig.transitions.length > 0) {
    for (const transition of currentStateConfig.transitions) {
      if (transition.condition && !transition.condition.intent) {
        if (typeof transition.condition.allParametersMet === 'undefined' || transition.condition.allParametersMet) {
          const requiredParams = currentStateConfig.parameters?.required || [];
          const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
          if (allRequiredMet) {
            nextStateId = transition.nextState;
            matchedTransition = true;
            logger.debug({ sessionId, transitionTo: nextStateId, reason: 'All parameters met' }, 'FSM transition by parameters');
            break;
          }
        } else if (transition.condition.allParametersMet === false) {
            nextStateId = transition.nextState;
            matchedTransition = true;
            logger.debug({ sessionId, transitionTo: nextStateId, reason: 'Condition allParametersMet: false' }, 'FSM transition by explicit allParametersMet:false');
            break;
        }
      }
    }
  }
  if (!matchedTransition && currentStateConfig.defaultNextState) {
    const requiredParams = currentStateConfig.parameters?.required || [];
    const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
    if (allRequiredMet) {
      nextStateId = currentStateConfig.defaultNextState;
      logger.debug({ sessionId, transitionTo: nextStateId, reason: 'Default next state, all params met' }, 'FSM transition by defaultNextState');
    }
  }
  if (!nextStateId) {
    nextStateId = currentStateId;
    logger.debug({ sessionId, state: currentStateId }, 'FSM staying in current state');
  }
  // --- End of transition logic ---

  if (currentStateId !== nextStateId) {
    logger.info({ sessionId, fromState: currentStateId, toState: nextStateId }, `FSM transitioning`);
  }
  sessionData.currentStateId = nextStateId;
  if (nextStateId !== currentStateId && (!sessionData.history.length || sessionData.history[sessionData.history.length -1] !== nextStateId) ) {
    sessionData.history.push(nextStateId);
  }

  const nextStateConfig = getStateById(nextStateId);
  if (!nextStateConfig) {
    logger.error({ nextStateId, sessionId }, 'FSM Error: Configuración no encontrada para el siguiente estado.');
    throw new Error(`Configuración no encontrada para el siguiente estado: ${nextStateId}`);
  }

  let renderedPayloadResponse = {};
  if (nextStateConfig.payloadResponse) {
    try {
      renderedPayloadResponse = processTemplate(
        JSON.parse(JSON.stringify(nextStateConfig.payloadResponse)),
        currentParameters
      );

      const asyncCallsDefinition = nextStateConfig.payloadResponse.asyncApiCallsToTrigger; // Use original config path
      if (asyncCallsDefinition && Array.isArray(asyncCallsDefinition)) {
        for (const callDefinition of asyncCallsDefinition) {
          const correlationId = callDefinition.assignCorrelationIdTo
            ? currentParameters[callDefinition.assignCorrelationIdTo] || uuidv4()
            : uuidv4();

          if (callDefinition.assignCorrelationIdTo) {
            currentParameters[callDefinition.assignCorrelationIdTo] = correlationId;
            sessionData.parameters[callDefinition.assignCorrelationIdTo] = correlationId;
          }

          let processedApiParams = {};
          if (callDefinition.params) {
            processedApiParams = processTemplate(
              JSON.parse(JSON.stringify(callDefinition.params)),
              currentParameters
            );
          }

          const apiConfig = getApiConfigById(callDefinition.apiId);
          if (!apiConfig || !apiConfig.response_stream_key_template) {
            logger.error({ apiId: callDefinition.apiId, sessionId }, `FSM: Missing apiConfig or response_stream_key_template for async API call. Skipping.`);
            continue;
          }

          const templateContextForStreamKey = { ...currentParameters, correlationId, sessionId };
          const responseStreamKey = processTemplate(apiConfig.response_stream_key_template, templateContextForStreamKey);

          sessionData.pendingApiResponses[correlationId] = {
            apiId: callDefinition.apiId,
            responseStreamKey: responseStreamKey, // Store the actual stream key
            requestedAt: new Date().toISOString(),
          };
          logger.info({sessionId, correlationId, apiId: callDefinition.apiId, responseStreamKey}, "FSM: Marked API call as pending. Triggering call via apiCallerService.");

          // apiCallerService.makeRequest is fire-and-forget for the FSM.
          // It handles its own logging of dispatch.
          apiCallerService.makeRequest(callDefinition.apiId, sessionId, correlationId, processedApiParams);
        }
      }
    } catch (templateError) {
      logger.error({ err: templateError, sessionId, state: nextStateId }, `FSM Error: Error procesando plantilla o asyncApiCallsToTrigger.`);
      renderedPayloadResponse = JSON.parse(JSON.stringify(nextStateConfig.payloadResponse));
    }
  }

  const requiredForNext = nextStateConfig.parameters?.required || [];
  const optionalForNext = nextStateConfig.parameters?.optional || [];
  const parametersToCollect = {
      required: requiredForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === ''),
      optional: optionalForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '')
  };

  const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
  saveSessionAsync(sessionKey, sessionData, sessionTTL);

  logger.debug({ sessionId, nextStateId, paramsToCollect: parametersToCollect.required.length, /*payloadKeys: Object.keys(renderedPayloadResponse).length*/ }, 'FSM processing complete');

  return {
    nextStateId: nextStateId,
    currentStateConfig: currentStateConfig,
    nextStateConfig: nextStateConfig,
    parametersToCollect: parametersToCollect,
    payloadResponse: renderedPayloadResponse,
    sessionData: sessionData,
  };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
  // Expose for handleInputWithAI to save session after stream processing
  saveSessionAsync,
  FSM_SESSION_PREFIX
};
