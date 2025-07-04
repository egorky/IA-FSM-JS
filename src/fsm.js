const { getStateById, getInitialStateId } = require('./configLoader');
const redisClient = require('./redisClient');
const { processTemplate } = require('./templateProcessor');
const logger = require('./logger'); // Use pino logger

const FSM_SESSION_PREFIX = 'fsm_session:';
const API_REQUEST_QUEUE_KEY = 'fsm_api_request_queue'; // Redis key for simulated API request queue

/**
 * Asynchronously saves session data to Redis. Does not block.
 * @param {string} sessionKey Key for Redis.
 * @param {object} sessionData Data to save.
 * @param {number} sessionTTL TTL in seconds.
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

/**
 * Asynchronously "sends" an API request to the simulated queue in Redis.
 * @param {object} apiRequestDetails The details of the API request.
 */
function sendApiRequestAsync(apiRequestDetails) {
  const jsonData = JSON.stringify(apiRequestDetails);
  redisClient.lpush(API_REQUEST_QUEUE_KEY, jsonData)
    .then(length => {
      logger.info({ apiRequest: apiRequestDetails, queueLength: length }, 'Simulated API request sent to Redis queue.');
    })
    .catch(err => {
      logger.error({ err, apiRequest: apiRequestDetails }, 'Failed to send simulated API request to Redis queue.');
    });
}

async function initializeOrRestoreSession(sessionId) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionDataString = await redisClient.get(sessionKey);

  if (sessionDataString) {
    logger.debug({ sessionId }, 'FSM session restored from Redis.');
    return JSON.parse(sessionDataString);
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {},
      history: [initialStateId],
    };
    const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
    // Save initial session asynchronously (fire and forget)
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

  const currentStateConfig = getStateById(currentStateId);
  if (!currentStateConfig) {
    logger.error({ currentStateId, sessionId }, 'FSM Error: Configuración no encontrada para el estado actual.');
    throw new Error(`Configuración no encontrada para el estado: ${currentStateId}`);
  }
  logger.debug({ sessionId, currentStateId, currentParameters, effectiveIntent }, 'FSM processing input');

  let nextStateId = null;
  let matchedTransition = false;

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

  if (currentStateId !== nextStateId) {
    logger.info({ sessionId, fromState: currentStateId, toState: nextStateId }, `FSM transitioning`);
  }
  sessionData.currentStateId = nextStateId;
  sessionData.parameters = currentParameters;
  if (nextStateId !== currentStateId && !sessionData.history.includes(nextStateId)) {
    sessionData.history.push(nextStateId);
  }

  const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
  saveSessionAsync(sessionKey, sessionData, sessionTTL);

  const nextStateConfig = getStateById(nextStateId);
  if (!nextStateConfig) {
    logger.error({ nextStateId, sessionId }, 'FSM Error: Configuración no encontrada para el siguiente estado.');
    throw new Error(`Configuración no encontrada para el siguiente estado: ${nextStateId}`);
  }

  const requiredForNext = nextStateConfig.parameters?.required || [];
  const optionalForNext = nextStateConfig.parameters?.optional || [];
  const parametersToCollect = {
      required: requiredForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === ''),
      optional: optionalForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '')
  };

  let renderedPayloadResponse = {};
  if (nextStateConfig.payloadResponse) {
    try {
      // Process the entire payloadResponse first, as externalApiCall might depend on its rendered values.
      renderedPayloadResponse = processTemplate(nextStateConfig.payloadResponse, currentParameters);

      // Check for and process externalApiCall if it exists in the *original* config,
      // then render its specific parts.
      if (nextStateConfig.payloadResponse.externalApiCall) {
        let apiCallDetails = JSON.parse(JSON.stringify(nextStateConfig.payloadResponse.externalApiCall)); // Deep copy

        // Render requestParams
        if (apiCallDetails.requestParams) {
          apiCallDetails.requestParams = processTemplate(apiCallDetails.requestParams, currentParameters);
        }
        // Render correlationId
        if (apiCallDetails.correlationId) {
          apiCallDetails.correlationId = processTemplate(apiCallDetails.correlationId, currentParameters);
        }

        const apiRequest = {
          sessionId: sessionId,
          correlationId: apiCallDetails.correlationId || `${sessionId}-${Date.now()}`, // Fallback correlationId
          type: apiCallDetails.type,
          requestParams: apiCallDetails.requestParams || {},
          timestamp: new Date().toISOString()
        };
        sendApiRequestAsync(apiRequest);
        // The renderedPayloadResponse should still contain the original externalApiCall structure if needed by client
        // Or we can decide to strip it, or add the rendered version. For now, keeping original in renderedPayload.
      }
    } catch (templateError) {
      logger.error({ err: templateError, sessionId, state: nextStateId }, `FSM Error: Error procesando plantilla o externalApiCall para estado.`);
      // Fallback to unrendered payload if main processing fails
      renderedPayloadResponse = nextStateConfig.payloadResponse;
    }
  }

  logger.debug({ sessionId, nextStateId, paramsToCollect: parametersToCollect.required.length, payloadKeys: Object.keys(renderedPayloadResponse).length }, 'FSM processing complete');

  return {
    nextStateId: nextStateId,
    currentStateConfig: currentStateConfig,
    nextStateConfig: nextStateConfig,
    parametersToCollect: parametersToCollect,
    payloadResponse: renderedPayloadResponse, // This will include the (unrendered) externalApiCall if it was in original
    sessionData: sessionData,
  };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
};
