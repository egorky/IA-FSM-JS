const { getStateById, getInitialStateId, getAllStates: getAllStatesConfig } = require('./configLoader');
const redisClient = require('./redisClient');
const { processTemplate } = require('./templateProcessor');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');
const apiCallerService = require('./apiCallerService');
const { getApiConfigById } = require('./apiConfigLoader');
const scriptExecutor = require('./scriptExecutor'); // Nuevo import

const FSM_SESSION_PREFIX = 'fsm_session:';

function saveSessionAsync(sessionKey, sessionData, sessionTTL) {
  const jsonData = JSON.stringify(sessionData);
  // Default TTL from env var if not provided or invalid in call
  const effectiveTTL = (sessionTTL && sessionTTL > 0) ? sessionTTL : (parseInt(process.env.REDIS_SESSION_TTL, 10) || 3600);

  let promise = redisClient.set(sessionKey, jsonData, 'EX', effectiveTTL);
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
    session.sync_api_results = session.sync_api_results || {};
    session.parameters = session.parameters || {};
    session.conversationHistory = session.conversationHistory || []; // Initialize conversationHistory
    logger.debug({ sessionId }, 'FSM session restored from Redis.');
    return session;
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {},
      history: [initialStateId], // History of states visited
      conversationHistory: [], // History of user:AI interactions
      pendingApiResponses: {},
      sync_api_results: {},
    };
    // saveSessionAsync will use default TTL from env if not passed here
    saveSessionAsync(sessionKey, initialSession);
    logger.info({ sessionId, initialStateId }, 'FSM new session initialized.');
    return initialSession;
  }
}

function areDependenciesMet(dependsOn, currentParameters, sessionId) {
  if (!dependsOn) return true; // No dependencies defined

  if (dependsOn.parameters) {
    for (const param of dependsOn.parameters) {
      if (!currentParameters.hasOwnProperty(param) || currentParameters[param] === null || currentParameters[param] === '') {
        logger.debug({ sessionId, missingParam: param, check: 'dependency' }, 'Dependency not met: missing parameter');
        return false;
      }
    }
  }

  if (dependsOn.apiResults) {
    for (const apiDep of dependsOn.apiResults) {
      const apiResult = currentParameters.sync_api_results?.[apiDep.apiId] || currentParameters.async_api_results?.[apiDep.apiId];
      if (!apiResult) {
        logger.debug({ sessionId, missingApiResult: apiDep.apiId, check: 'dependency' }, 'Dependency not met: missing API result');
        return false;
      }
      if (apiDep.status && apiResult.status !== apiDep.status) {
        logger.debug({ sessionId, apiId: apiDep.apiId, expectedStatus: apiDep.status, actualStatus: apiResult.status, check: 'dependency' }, 'Dependency not met: API result status mismatch');
        return false;
      }
    }
  }
  return true;
}

async function executeApiHook(hookType, hookConfigArray, currentParameters, sessionId, sessionData) {
    if (!hookConfigArray || !Array.isArray(hookConfigArray)) return;

    logger.info({ sessionId, hookType, count: hookConfigArray.length }, `Executing API hook: ${hookType}`);

    for (const apiCallDefinition of hookConfigArray) {
        // Adapt to states.json where apiHooks might contain simple strings (apiId) or objects
        let apiId;
        let dependsOn = null;

        if (typeof apiCallDefinition === 'string') {
            apiId = apiCallDefinition;
            // No dependencies if it's just a string
        } else if (typeof apiCallDefinition === 'object' && apiCallDefinition !== null && apiCallDefinition.apiId) {
            apiId = apiCallDefinition.apiId;
            dependsOn = apiCallDefinition.dependsOn;
        } else {
            logger.warn({sessionId, apiCallDefinition, hookType}, "API call in hook is malformed (not string or object with apiId). Skipping.");
            continue;
        }

        if (areDependenciesMet(dependsOn, currentParameters, sessionId)) {
            logger.info({ sessionId, apiId: apiId, hookType }, `Dependencies met for API, proceeding.`);
            if (hookType === 'synchronousCallSetup') {
                const correlationId = `sync_${apiId}_${Date.now()}`;
                const apiResponse = await apiCallerService.makeRequestAndWait(apiId, sessionId, correlationId, currentParameters);
                currentParameters.sync_api_results = currentParameters.sync_api_results || {};
                currentParameters.sync_api_results[apiId] = apiResponse;
                // sessionData.parameters is a reference to currentParameters, so it's updated.

                if (apiResponse.status === 'error') {
                    logger.warn({ sessionId, apiId: apiId, error: apiResponse.errorMessage }, 'Synchronous API call from hook failed.');
                }
            } else if (hookType === 'asynchronousCallDispatch') {
                const correlationId = uuidv4();
                const apiConfig = getApiConfigById(apiId);
                if (!apiConfig || !apiConfig.response_stream_key_template) {
                    logger.error({ apiId: apiId, sessionId }, `FSM: Missing apiConfig or response_stream_key_template for async call in hook. Skipping.`);
                    continue;
                }
                const templateContextForStreamKey = { ...currentParameters, correlationId, sessionId };
                const responseStreamKey = processTemplate(apiConfig.response_stream_key_template, templateContextForStreamKey);

                sessionData.pendingApiResponses[correlationId] = {
                    apiId: apiId,
                    responseStreamKey: responseStreamKey,
                    requestedAt: new Date().toISOString(),
                };
                apiCallerService.makeRequestAsync(apiId, sessionId, correlationId, currentParameters);
                logger.info({sessionId, correlationId, apiId: apiId, responseStreamKey}, "FSM: Marked async API call from hook as pending.");
            }
        } else {
            logger.info({ sessionId, apiId: apiId, hookType, dependencies: dependsOn }, `Dependencies NOT MET for API, skipping.`);
        }
    }
}

function getSkippedStates(currentInternalStateId, targetInternalStateId, allStatesMap) {
    const skippedStateConfigs = [];
    const path = []; // To store the sequence of state IDs in the path

    if (currentInternalStateId === targetInternalStateId) {
        return [];
    }

    // Attempt to find a path using a simple BFS-like approach on transitions.
    // This assumes states are somewhat connected and doesn't handle complex graphs perfectly
    // but is better than just numeric comparison for many FSMs.
    const queue = [[currentInternalStateId, [currentInternalStateId]]]; // [currentStateId, currentPathToIt]
    const visitedForPathFinding = new Set([currentInternalStateId]);
    let foundPath = null;

    while (queue.length > 0) {
        const [currId, currentPathArr] = queue.shift();

        if (currId === targetInternalStateId) {
            foundPath = currentPathArr;
            break;
        }

        const currConfig = allStatesMap[currId];
        if (!currConfig) continue;

        const nextPossibleStates = [];
        if (currConfig.transitions) {
            currConfig.transitions.forEach(t => nextPossibleStates.push(t.nextState));
        }
        if (currConfig.defaultNextState) {
            nextPossibleStates.push(currConfig.defaultNextState);
        }

        for (const nextId of nextPossibleStates) {
            if (nextId && !visitedForPathFinding.has(nextId)) {
                visitedForPathFinding.add(nextId);
                const newPath = [...currentPathArr, nextId];
                if (nextId === targetInternalStateId) {
                    foundPath = newPath;
                    break;
                }
                queue.push([nextId, newPath]);
            }
        }
        if (foundPath) break;
    }

    if (foundPath && foundPath.length > 2) { // Path includes start, intermediate(s), end
        // Skipped states are all states in the path except start (current) and end (target)
        for (let i = 1; i < foundPath.length - 1; i++) {
            const skippedId = foundPath[i];
            if (allStatesMap[skippedId]) {
                skippedStateConfigs.push(allStatesMap[skippedId]);
            }
        }
        logger.info({sessionId: null, from:currentInternalStateId, to:targetInternalStateId, path: foundPath, skipped: skippedStateConfigs.map(s=>s.id)}, "Path found, identified skipped states.");
    } else if (foundPath && foundPath.length <=2){
         logger.debug({sessionId: null, from:currentInternalStateId, to:targetInternalStateId, path: foundPath}, "Direct transition or no intermediate states in path, no states considered skipped.");
    } else {
        // Fallback to numeric prefix logic if no path found via transitions, as a last resort (with warnings)
        logger.warn({currentInternalStateId, targetInternalStateId}, "Could not determine path via transitions for skipped states. Falling back to numeric prefix logic. This is unreliable.");
        const getNumericPrefix = (stateId) => {
            if (!stateId || typeof stateId !== 'string') return NaN;
            const parts = stateId.split('_');
            const num = parseInt(parts[0], 10);
            return isNaN(num) ? NaN : num;
        };

        const currentNum = getNumericPrefix(currentInternalStateId);
        const targetNum = getNumericPrefix(targetInternalStateId);

        if (!isNaN(currentNum) && !isNaN(targetNum) && targetNum > currentNum + 1) {
            for (let i = currentNum + 1; i < targetNum; i++) {
                for (const stateIdKey in allStatesMap) {
                    if (getNumericPrefix(stateIdKey) === i) {
                        logger.debug({foundSkipped: allStatesMap[stateIdKey].id}, "Found potential skipped state by numeric prefix (fallback).");
                        skippedStateConfigs.push(allStatesMap[stateIdKey]);
                        break;
                    }
                }
            }
        } else {
            logger.debug({currentInternalStateId, targetInternalStateId, currentNum, targetNum}, "No skipped states identified by numeric prefix logic (fallback) or target is not numerically after current + 1.");
        }
    }

    if (skippedStateConfigs.length > 0) {
        logger.info({skipped: skippedStateConfigs.map(s=>s.id)}, "Identified skipped states to process.")
    }
    return skippedStateConfigs;
}

async function executeScriptHook(scriptHookConfigArray, currentParameters, sessionId, sessionData) {
    if (!scriptHookConfigArray || !Array.isArray(scriptHookConfigArray)) return;

    logger.info({ sessionId, hookType: 'executeScript', count: scriptHookConfigArray.length }, 'Executing script hook.');

    for (const scriptDefinition of scriptHookConfigArray) {
        if (!scriptDefinition.scriptId || (!scriptDefinition.filePath && !scriptDefinition.scriptId) || !scriptDefinition.functionName) {
            logger.warn({sessionId, scriptDefinition}, "Script definition is malformed (missing scriptId/filePath or functionName). Skipping.");
            continue;
        }

        if (areDependenciesMet(scriptDefinition.dependsOn, currentParameters, sessionId)) {
            logger.info({ sessionId, scriptId: scriptDefinition.scriptId, functionName: scriptDefinition.functionName }, `Dependencies met for script, proceeding.`);

            const executionResult = await scriptExecutor.executeScript(scriptDefinition, currentParameters, sessionId);

            if (executionResult.error) {
                logger.warn({ sessionId, scriptId: scriptDefinition.scriptId, error: executionResult.error }, 'Script execution failed.');
                // Optionally store error in a designated place in currentParameters
                // currentParameters.script_errors = currentParameters.script_errors || {};
                // currentParameters.script_errors[scriptDefinition.scriptId || scriptDefinition.filePath] = executionResult.error;
            } else if (scriptDefinition.assignResultTo && typeof executionResult.result !== 'undefined') {
                currentParameters[scriptDefinition.assignResultTo] = executionResult.result;
                logger.info({sessionId, scriptId: scriptDefinition.scriptId, assignResultTo: scriptDefinition.assignResultTo, value: executionResult.result}, "Script result assigned to currentParameters.")
            } else if (typeof executionResult.result !== 'undefined') {
                // Default namespace if assignResultTo is not specified but there's a result
                currentParameters.script_results = currentParameters.script_results || {};
                const resultKey = scriptDefinition.scriptId || scriptDefinition.filePath; // Use scriptId or filePath as key
                currentParameters.script_results[resultKey] = executionResult.result;
                logger.info({sessionId, scriptKey: resultKey, result: executionResult.result}, "Script result stored in default script_results namespace.")
            }
            // sessionData.parameters is a reference to currentParameters, so it's implicitly updated.

        } else {
            logger.info({ sessionId, scriptId: scriptDefinition.scriptId, dependencies: scriptDefinition.dependsOn }, `Dependencies NOT MET for script, skipping.`);
        }
    }
}


async function processInput(sessionId, intent, inputParameters = {}, initialCall = false, userInputText = null) { // Added userInputText
    const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
    let sessionData = await initializeOrRestoreSession(sessionId);
    let currentSessionStateId = sessionData.currentStateId;

    let currentParameters = { ...sessionData.parameters, ...inputParameters };
    sessionData.parameters = currentParameters;

    if (!sessionData.sync_api_results) sessionData.sync_api_results = {};
    if (!sessionData.pendingApiResponses) sessionData.pendingApiResponses = {};

    let effectiveIntent = intent;
    if (!initialCall && !effectiveIntent && process.env.DEFAULT_INTENT) {
        effectiveIntent = process.env.DEFAULT_INTENT;
    }
    logger.debug({ sessionId, currentSessionStateId, intent: effectiveIntent, inputParametersCount: Object.keys(inputParameters).length }, 'FSM processing input: Start');

    const fsmCurrentStateConfigAtStart = getStateById(currentSessionStateId); // Config of state at start of this cycle
    let candidateNextStateId = currentSessionStateId;
    let candidateNextStateConfig = fsmCurrentStateConfigAtStart;
    let transitionReason = "No transition initially";

    // --- FASE PRELIMINAR: Determinar el estado objetivo (candidateNextStateId) ---
    if (effectiveIntent && fsmCurrentStateConfigAtStart.transitions && fsmCurrentStateConfigAtStart.transitions.length > 0) {
        for (const transition of fsmCurrentStateConfigAtStart.transitions) {
            if (transition.condition && transition.condition.intent === effectiveIntent) {
                candidateNextStateId = transition.nextState;
                transitionReason = `Intent match: ${effectiveIntent}`;
                break;
            }
        }
    }
    if (candidateNextStateId === currentSessionStateId) {
        if (fsmCurrentStateConfigAtStart.transitions && fsmCurrentStateConfigAtStart.transitions.length > 0) {
            for (const transition of fsmCurrentStateConfigAtStart.transitions) {
                 if (transition.condition && !transition.condition.intent) {
                    const requiredParams = fsmCurrentStateConfigAtStart.parameters?.required || [];
                    const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
                    if ((typeof transition.condition.allParametersMet === 'undefined' || transition.condition.allParametersMet === true) && allRequiredMet) {
                        candidateNextStateId = transition.nextState;
                        transitionReason = 'All params met for current state';
                        break;
                    } else if (transition.condition.allParametersMet === false && !allRequiredMet ) { // Specific condition for not all params met
                        candidateNextStateId = transition.nextState;
                        transitionReason = 'Condition allParametersMet: false and not all met';
                        break;
                    }
                 }
            }
        }
    }
    if (candidateNextStateId === currentSessionStateId && fsmCurrentStateConfigAtStart.defaultNextState) {
        const requiredParams = fsmCurrentStateConfigAtStart.parameters?.required || [];
        const allRequiredMet = requiredParams.every(param => currentParameters.hasOwnProperty(param) && currentParameters[param] !== null && currentParameters[param] !== '');
        if (allRequiredMet) {
            candidateNextStateId = fsmCurrentStateConfigAtStart.defaultNextState;
            transitionReason = 'Default next state, all params met';
        }
    }

    if (candidateNextStateId !== currentSessionStateId) {
        candidateNextStateConfig = getStateById(candidateNextStateId);
        if (!candidateNextStateConfig) {
            logger.error({ candidateNextStateId, sessionId }, 'FSM Error: Config for candidate next state not found.');
            throw new Error(`Config for candidate next state ${candidateNextStateId} not found.`);
        }
        logger.debug({ sessionId, from: currentSessionStateId, to: candidateNextStateId, reason: transitionReason }, 'FSM preliminary transition determined');
    } else {
        logger.debug({ sessionId, state: currentSessionStateId, reason: transitionReason }, 'FSM preliminary: staying in current state');
    }

    // --- NUEVA FASE: Procesar acciones de estados intermedios/saltados ---
    const allStatesMap = getAllStatesConfig(); // Get all state configurations
    const skippedStatesConfigs = getSkippedStates(currentSessionStateId, candidateNextStateId, allStatesMap);

    if (skippedStatesConfigs.length > 0) {
        logger.info({sessionId, skippedStates: skippedStatesConfigs.map(s => s.id)}, "Processing API hooks for skipped states.");
        for (const skippedStateConfig of skippedStatesConfigs) {
            logger.debug({sessionId, skippedStateId: skippedStateConfig.id}, "Processing hooks for skipped state.");
            await executeApiHook('synchronousCallSetup', skippedStateConfig.payloadResponse?.apiHooks?.synchronousCallSetup, currentParameters, sessionId, sessionData);
            // Execute scripts for skipped state
            logger.info({sessionId, state: skippedStateConfig.id, type: 'SKIPPED_STATE'}, "Executing scriptHooks for skipped state.");
            await executeScriptHook(skippedStateConfig.payloadResponse?.apiHooks?.executeScript, currentParameters, sessionId, sessionData);
            await executeApiHook('asynchronousCallDispatch', skippedStateConfig.payloadResponse?.apiHooks?.asynchronousCallDispatch, currentParameters, sessionId, sessionData);
        }
    }

    // --- Fase de API Síncronas del ESTADO OBJETIVO (candidateNextStateConfig) ---
    logger.info({sessionId, state: candidateNextStateConfig.id, type: 'TARGET_STATE'}, "Executing synchronousCallSetup APIs for target state.");
    await executeApiHook('synchronousCallSetup', candidateNextStateConfig.payloadResponse?.apiHooks?.synchronousCallSetup, currentParameters, sessionId, sessionData);

    // --- Fase de Ejecución de Scripts del ESTADO OBJETIVO (candidateNextStateConfig) ---
    logger.info({sessionId, state: candidateNextStateConfig.id, type: 'TARGET_STATE'}, "Executing scriptHooks for target state.");
    await executeScriptHook(candidateNextStateConfig.payloadResponse?.apiHooks?.executeScript, currentParameters, sessionId, sessionData);

    // --- Fase de Lógica de Transición FINAL (Confirmar candidateNextStateId) ---
    // At this point, candidateNextStateId is considered the final destination for this cycle.
    // Future: Could re-evaluate if sync API results from target state itself could trigger another immediate transition.
    // For now, we commit to candidateNextStateId.
    let finalNextStateId = candidateNextStateId;
    let finalNextStateConfig = candidateNextStateConfig;

    if (currentSessionStateId !== finalNextStateId) {
        logger.info({ sessionId, fromState: currentSessionStateId, toState: finalNextStateId }, `FSM transitioning`);
        sessionData.currentStateId = finalNextStateId;
        if (!sessionData.history.length || sessionData.history[sessionData.history.length - 1] !== finalNextStateId) {
            sessionData.history.push(finalNextStateId);
        }
    } else {
        logger.debug({ sessionId, state: currentSessionStateId }, 'FSM staying in current state (final decision)');
    }

    // --- Fase de Renderizado de PayloadResponse (para finalNextStateConfig) ---
    let renderedPayloadResponse = {};
    if (finalNextStateConfig.payloadResponse) {
        try {
            renderedPayloadResponse = processTemplate(
                JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse)),
                currentParameters
            );
        } catch (templateError) {
            logger.error({ err: templateError, sessionId, state: finalNextStateId }, `FSM Error: Processing payloadResponse template.`);
            renderedPayloadResponse = JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse));
        }
    }

    // --- Fase de API Asíncronas del ESTADO FINAL (finalNextStateConfig) ---
    logger.info({sessionId, state: finalNextStateConfig.id, type: 'FINAL_STATE'}, "Executing asynchronousCallDispatch APIs for final state.");
    await executeApiHook('asynchronousCallDispatch', finalNextStateConfig.payloadResponse?.apiHooks?.asynchronousCallDispatch, currentParameters, sessionId, sessionData);

    const requiredForNext = finalNextStateConfig.parameters?.required || [];
    const optionalForNext = finalNextStateConfig.parameters?.optional || [];
    const parametersToCollect = {
        required: requiredForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === ''),
        optional: optionalForNext.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '')
    };

    saveSessionAsync(sessionKey, sessionData); // TTL will be handled by saveSessionAsync

    logger.debug({ sessionId, finalState: finalNextStateId, paramsToCollectCount: parametersToCollect.required.length }, 'FSM processing complete.');

    return {
        nextStateId: finalNextStateId,
        currentStateConfig: fsmCurrentStateConfigAtStart,
        nextStateConfig: finalNextStateConfig,
        parametersToCollect: parametersToCollect,
        payloadResponse: renderedPayloadResponse,
        sessionData: sessionData,
    };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
  saveSessionAsync,
  FSM_SESSION_PREFIX
};
