const { getStateById, getInitialStateId } = require('./configLoader');
const redisClient = require('./redisClient');
const { processTemplate } = require('./templateProcessor'); // Nuevo

const FSM_SESSION_PREFIX = 'fsm_session:';

/**
 * Inicializa una nueva sesión de FSM o recupera una existente.
 * @param {string} sessionId ID único para la sesión de conversación.
 * @returns {Promise<object>} El estado actual de la FSM para la sesión.
 *                            { currentStateId: string, parameters: object, history: array }
 */
async function initializeOrRestoreSession(sessionId) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionData = await redisClient.get(sessionKey);

  if (sessionData) {
    return JSON.parse(sessionData);
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {}, // Parámetros recolectados
      history: [initialStateId], // Historial de estados visitados
    };
    // Aplicar TTL también a la sesión inicial
    const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
    if (sessionTTL && sessionTTL > 0) {
      await redisClient.set(sessionKey, JSON.stringify(initialSession), 'EX', sessionTTL);
      console.log(`FSM initial session ${sessionId} saved to Redis with TTL: ${sessionTTL}s`);
    } else {
      await redisClient.set(sessionKey, JSON.stringify(initialSession));
      console.log(`FSM initial session ${sessionId} saved to Redis without TTL.`);
    }
    return initialSession;
  }
}

/**
 * Procesa una entrada para la FSM.
 * @param {string} sessionId ID de la sesión.
 * @param {string} [intent] La intención detectada del usuario (opcional).
 * @param {object} [inputParameters] Parámetros proporcionados en esta interacción (ej: { "age": 30 }).
 * @returns {Promise<object>} Un objeto con:
 *                            - nextStateId: El ID del nuevo estado.
 *                            - parametersToCollect: Parámetros requeridos/opcionales del nuevo estado.
 *                            - apisToCall: APIs a llamar para el nuevo estado.
 *                            - sessionData: Datos actualizados de la sesión.
 */
async function processInput(sessionId, intent, inputParameters = {}) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionData = await initializeOrRestoreSession(sessionId);
  let currentStateId = sessionData.currentStateId;

  // Handle DEFAULT_INTENT
  let effectiveIntent = intent;
  if (!effectiveIntent && process.env.DEFAULT_INTENT) {
    effectiveIntent = process.env.DEFAULT_INTENT;
    console.log(`FSM Info: No intent provided for session [${sessionId}]. Using DEFAULT_INTENT: [${effectiveIntent}]`);
  }

  let currentParameters = { ...sessionData.parameters, ...inputParameters }; // Merge con nuevos parámetros

  const currentStateConfig = getStateById(currentStateId);
  if (!currentStateConfig) {
    throw new Error(`Configuración no encontrada para el estado: ${currentStateId}`);
  }

  let nextStateId = null;
  let matchedTransition = false;

  // 1. Evaluar transiciones basadas en intención (tienen prioridad)
  // Usar effectiveIntent en lugar de intent
  if (effectiveIntent && currentStateConfig.transitions && currentStateConfig.transitions.length > 0) {
    for (const transition of currentStateConfig.transitions) {
      if (transition.condition && transition.condition.intent === effectiveIntent) {
        // Aquí podríamos añadir lógica más compleja para la condición de intención si fuera necesario
        // Por ejemplo, si la condición también depende de ciertos parámetros + la intención.
        // Por ahora, si la intención coincide, se transita.
        nextStateId = transition.nextState;
        matchedTransition = true;
        break;
      }
    }
  }

  // 2. Si no hay transición por intención, evaluar transiciones basadas en parámetros
  if (!matchedTransition && currentStateConfig.transitions && currentStateConfig.transitions.length > 0) {
    for (const transition of currentStateConfig.transitions) {
      if (transition.condition) {
        // Asegurarse de que esta condición no sea solo por intención si ya hemos manejado effectiveIntent
        if (!transition.condition.intent) {
          if (typeof transition.condition.allParametersMet === 'undefined' || transition.condition.allParametersMet) {
            const requiredParams = currentStateConfig.parameters?.required || [];
            const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
            if (allRequiredMet) {
              nextStateId = transition.nextState;
              matchedTransition = true;
              break;
            }
          } else if (transition.condition.allParametersMet === false) { // No allParametersMet y sin intent
              nextStateId = transition.nextState;
              matchedTransition = true;
              break;
          }
        }
      }
    }
  }

  // 3. Si no hay transición específica y se cumplen los parámetros requeridos, usar defaultNextState
  if (!matchedTransition && currentStateConfig.defaultNextState) {
    const requiredParams = currentStateConfig.parameters?.required || [];
    const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
    if (allRequiredMet) {
      nextStateId = currentStateConfig.defaultNextState;
    }
  }

  // 4. Si no hay cambio de estado, permanecemos en el actual
  if (!nextStateId) {
    nextStateId = currentStateId;
  }

  // Actualizar sesión
  if (currentStateId !== nextStateId) {
    console.log(`FSM Info: Session [${sessionId}] transitioning from state [${currentStateId}] to [${nextStateId}]`);
  }
  sessionData.currentStateId = nextStateId;
  sessionData.parameters = currentParameters; // Guardar todos los parámetros acumulados
  if (nextStateId !== currentStateId) {
    sessionData.history.push(nextStateId);
  }

  // console.log("FSM DEBUG: sessionData.parameters before saving to Redis:\n", JSON.stringify(sessionData.parameters, null, 2)); // Eliminado
  const sessionTTL = parseInt(process.env.REDIS_SESSION_TTL, 10);
  if (sessionTTL && sessionTTL > 0) {
    await redisClient.set(sessionKey, JSON.stringify(sessionData), 'EX', sessionTTL);
    console.log(`FSM session ${sessionId} saved to Redis with TTL: ${sessionTTL}s`);
  } else {
    await redisClient.set(sessionKey, JSON.stringify(sessionData));
    console.log(`FSM session ${sessionId} saved to Redis without TTL.`);
  }

  const nextStateConfig = getStateById(nextStateId);
  if (!nextStateConfig) {
    throw new Error(`Configuración no encontrada para el siguiente estado: ${nextStateId}`);
  }

  // Determinar parámetros a recolectar para el nuevo estado
  // Estos son los parámetros que el nuevo estado define, menos los que ya tenemos.
  const collectedParametersForNextState = {};
  const requiredForNext = nextStateConfig.parameters?.required || [];
  const optionalForNext = nextStateConfig.parameters?.optional || [];

  const parametersToCollect = {
      required: requiredForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === ''),
      optional: optionalForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '')
  };

  // Aseguramos que currentParameters (que se guarda en sessionData.parameters)
  // es la fusión de lo que había en sesión + lo que acaba de llegar.
  // Esta lógica ya estaba al principio de la función:
  // let currentParameters = { ...sessionData.parameters, ...inputParameters };
  // Y sessionData.parameters = currentParameters; se hace antes de guardar.
  // Por lo tanto, sessionData.parameters ya es la fusión completa.

  let renderedPayloadResponse = {};
  if (nextStateConfig.payloadResponse) {
    // console.log("FSM DEBUG: Parameters passed to templateProcessor:\n", JSON.stringify(currentParameters, null, 2)); // Eliminado
    try {
      renderedPayloadResponse = processTemplate(nextStateConfig.payloadResponse, currentParameters);
    } catch (templateError) {
      console.error(`FSM: Error procesando plantilla para estado ${nextStateId}:`, templateError);
      // Decidir si devolver el payload sin procesar, uno vacío, o añadir info de error al payload.
      // Por ahora, devolvemos el payload original si falla el templating.
      renderedPayloadResponse = nextStateConfig.payloadResponse;
    }
  }

  // console.log("FSM DEBUG: Final sessionData.parameters in returned object:\n", JSON.stringify(sessionData.parameters, null, 2)); // Eliminado
  // console.log("FSM DEBUG: Final parametersToCollect:\n", JSON.stringify(parametersToCollect, null, 2)); // Eliminado

  return {
    nextStateId: nextStateId,
    currentStateConfig: currentStateConfig, // Estado desde el que se partió para esta transición
    nextStateConfig: nextStateConfig,       // Estado al que se llegó
    parametersToCollect: parametersToCollect,
    payloadResponse: renderedPayloadResponse, // Devolver el payloadResponse procesado
    sessionData: sessionData, // Devuelve el estado completo de la sesión actualizado (con parameters fusionados)
  };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
};
