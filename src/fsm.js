const { getStateById, getInitialStateId, getAllStates: getAllStatesConfig } = require('./configLoader');
const { getApiConfigById } = require('./apiConfigLoader');
const apiCallerService = require('./apiCallerService');
const scriptExecutor = require('./scriptExecutor');
const { processTemplate } = require('./templateProcessor');
const redisClient = require('./redisClient');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

const FSM_SESSION_PREFIX = 'fsm_session:';

// --- Funciones Auxiliares ---
function extractTemplateParams(templateString) {
  if (!templateString || typeof templateString !== 'string') {
    return [];
  }
  const regex = /\{\{([\w.-]+)\}\}/g; // Captura nombre de parámetro dentro de {{...}}
  const params = new Set();
  let match;
  while ((match = regex.exec(templateString)) !== null) {
    params.add(match[1]);
  }
  return Array.from(params);
}

/**
 * Construye un grafo de dependencias para acciones síncronas.
 * @param {Array<Object>} syncTasks - Array de objetos de tarea (acciones síncronas del masterActionPlan).
 * @param {Object} currentParameters - Parámetros actualmente disponibles.
 * @param {Object} sessionData - Datos completos de la sesión actual.
 * @param {Object} allApiConfigs - Mapa de todas las configuraciones de API.
 * @param {String} sessionId - ID de la sesión.
 * @returns {Object} { graph: { adj: Map<string, Array<string>>, inDegree: Map<string, number> }, taskMap: Map<string, Object>, unresolvedTasks: Array<Object> }
 */
function buildSyncActionGraph(syncTasks, currentParameters, sessionData, allApiConfigs, sessionId) {
    const graph = { adj: new Map(), inDegree: new Map() };
    const taskMap = new Map(); // Mapea task.uniqueId -> taskObject
    const taskProducesMap = new Map(); // Mapea paramName -> task.uniqueId que lo produce (solo síncronos)
    let unresolvedTasks = []; // Tareas que no se pueden ejecutar por dependencias USER_INPUT faltantes desde el inicio

    // Inicializar grafo y taskMap, y registrar qué parámetros produce cada tarea síncrona
    syncTasks.forEach((task, index) => {
        // Crear un uniqueId para cada tarea en este plan específico, ya que una misma API/Script puede ser llamada varias veces
        // o aparecer en diferentes contextos (ej. estado saltado vs estado actual)
        // Si la tarea ya tiene un uniqueId (ej. si masterActionPlan ya los genera), se puede usar ese.
        // Por ahora, generamos uno basado en su posición en la lista de tareas síncronas.
        const uniqueTaskId = task.uniqueId || `${task.type}_${task.id}_sync_${index}`;
        task.uniqueId = uniqueTaskId; // Asegurar que la tarea tenga este ID para referencia

        taskMap.set(uniqueTaskId, task);
        graph.adj.set(uniqueTaskId, []);
        graph.inDegree.set(uniqueTaskId, 0);

        if (task.executionMode === "SYNCHRONOUS") { // Solo nos interesan las productoras síncronas para este grafo
            if (task.type === "API") {
                const apiConfig = allApiConfigs[task.id];
                if (apiConfig && apiConfig.producesParameters) {
                    Object.keys(apiConfig.producesParameters).forEach(producedParam => {
                        if (taskProducesMap.has(producedParam) && taskProducesMap.get(producedParam) !== uniqueTaskId) {
                            logger.warn({sessionId, producedParam, existingProducer: taskProducesMap.get(producedParam), newProducer: uniqueTaskId }, "Multiple synchronous actions in plan produce the same parameter. Dependency graph will use the first encountered producer.");
                        }
                        if (!taskProducesMap.has(producedParam)) {
                            taskProducesMap.set(producedParam, uniqueTaskId);
                        }
                    });
                }
            } else if (task.type === "SCRIPT" && task.assignResultTo) {
                 if (taskProducesMap.has(task.assignResultTo) && taskProducesMap.get(task.assignResultTo) !== uniqueTaskId) {
                    logger.warn({sessionId, producedParam: task.assignResultTo, existingProducer: taskProducesMap.get(task.assignResultTo), newProducer: uniqueTaskId }, "Multiple synchronous actions (script) in plan produce the same parameter. Dependency graph will use the first encountered producer.");
                }
                if (!taskProducesMap.has(task.assignResultTo)) {
                    taskProducesMap.set(task.assignResultTo, uniqueTaskId);
                }
            }
        }
    });

    // Construir aristas basadas en dependencias
    taskMap.forEach((task, uniqueTaskId) => {
        let taskConsumesDef;
        if (task.type === "API") taskConsumesDef = allApiConfigs[task.id]?.consumesParameters;
        else if (task.type === "SCRIPT") taskConsumesDef = task.consumesParameters; // Asumiendo que los scripts lo definen igual

        if (taskConsumesDef) {
            for (const templateParamName in taskConsumesDef) {
                const pDef = taskConsumesDef[templateParamName];
                if (pDef.source === "API_RESULT" || pDef.source === "SCRIPT_RESULT") {
                    const producerParamName = pDef.producedParamName; // Nombre estandarizado del parámetro producido
                    const producerTaskUniqueId = taskProducesMap.get(producerParamName);

                    if (producerTaskUniqueId && producerTaskUniqueId !== uniqueTaskId) {
                        // Añadir arista: producerTaskUniqueId -> uniqueTaskId
                        graph.adj.get(producerTaskUniqueId).push(uniqueTaskId);
                        graph.inDegree.set(uniqueTaskId, (graph.inDegree.get(uniqueTaskId) || 0) + 1);
                    } else if (!currentParameters.hasOwnProperty(producerParamName) && pDef.required !== false) {
                        // Depende de un resultado de API/Script que no está en el plan síncrono actual ni en currentParameters
                        // Esto podría hacer que la tarea sea irresoluble si la dependencia es crítica.
                        // El ordenamiento topológico maneja esto: si su inDegree no llega a 0, no se ejecuta.
                         logger.warn({sessionId, taskId: uniqueTaskId, actionId: task.id, missingParam: producerParamName, fromSource: pDef.source}, "Task depends on an external or async API/Script result not yet available or planned sychronously.");
                    }
                }
            }
        }
    });

    // Identificar tareas que son irresolubles desde el inicio por USER_INPUT faltante
    // y que no tienen dependencias entrantes (inDegree === 0)
    taskMap.forEach((task, uniqueTaskId) => {
        if (graph.inDegree.get(uniqueTaskId) === 0) { // No depende de otras tareas síncronas del plan
            const { met, missing } = getActionDependencies(task, currentParameters, sessionData, allApiConfigs);
            if (!met && missing.some(m => m.includes("USER_INPUT") || m.includes("expected from AI as"))) {
                unresolvedTasks.push({...task, reason: "Missing initial USER_INPUT and no preceding sync tasks to provide it.", missingDeps: missing});
            }
        }
    });
    return { graph, taskMap, unresolvedTasks };
}

/**
 * Realiza un ordenamiento topológico (Algoritmo de Kahn).
 * @param {Object} graph - El grafo con { adj: Map<string, Array<string>>, inDegree: Map<string, number> }.
 * @param {Map<string, Object>} taskMap - Mapa de task.uniqueId a objeto de tarea.
 * @param {Array<Object>} unresolvedTasksOnInit - Tareas ya marcadas como irresolubles.
 * @returns {Array<Object>|null} Array ordenado de objetos de tarea, o null si hay un ciclo.
 */
function topologicalSort(graph, taskMap, unresolvedTasksOnInit) {
    const sortedOrder = [];
    const queue = [];
    const inDegree = new Map(graph.inDegree); // Copiar para modificar

    const unresolvedOnInitIds = new Set(unresolvedTasksOnInit.map(t => t.uniqueId));

    taskMap.forEach((task, uniqueTaskId) => {
        if (inDegree.get(uniqueTaskId) === 0 && !unresolvedOnInitIds.has(uniqueTaskId)) {
            queue.push(uniqueTaskId);
        }
    });

    while (queue.length > 0) {
        const u_uniqueId = queue.shift();
        sortedOrder.push(taskMap.get(u_uniqueId));

        (graph.adj.get(u_uniqueId) || []).forEach(v_uniqueId => {
            inDegree.set(v_uniqueId, inDegree.get(v_uniqueId) - 1);
            if (inDegree.get(v_uniqueId) === 0 && !unresolvedOnInitIds.has(v_uniqueId)) {
                queue.push(v_uniqueId);
            }
        });
    }

    if (sortedOrder.length !== (taskMap.size - unresolvedOnInitIds.size)) {
        const cycleOrUnresolvedTasks = [];
        taskMap.forEach((task, uniqueTaskId) => {
            if (!unresolvedOnInitIds.has(uniqueTaskId) && !sortedOrder.some(st => st.uniqueId === uniqueTaskId)) {
                cycleOrUnresolvedTasks.push(task.id + (task.label ? ` (${task.label})` : '') + ` (InDegree: ${inDegree.get(uniqueTaskId)})`);
            }
        });
        logger.error({ detectedCycleOrUnresolved: cycleOrUnresolvedTasks, details: {sortedCount: sortedOrder.length, mapSize: taskMap.size, unresolvedOnInitCount: unresolvedOnInitIds.size} },
            "Cycle detected or unresolved dependencies in synchronous actions. Not all tasks could be sorted.");
        return null;
    }
    return sortedOrder;
}


// --- Funciones de Sesión ---
async function initializeOrRestoreSession(sessionId) {
  const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
  let sessionDataString = await redisClient.get(sessionKey);
  if (sessionDataString) {
    const session = JSON.parse(sessionDataString);
    session.parameters = session.parameters || {};
    session.pendingApiResponses = session.pendingApiResponses || {};
    session.sync_api_results = session.sync_api_results || {};
    session.script_results = session.script_results || {};
    session.conversationHistory = session.conversationHistory || [];
    logger.debug({ sessionId }, 'FSM session restored from Redis.');
    return session;
  } else {
    const initialStateId = getInitialStateId();
    const initialSession = {
      currentStateId: initialStateId,
      parameters: {},
      history: [initialStateId],
      conversationHistory: [],
      pendingApiResponses: {},
      sync_api_results: {},
      script_results: {},
    };
    saveSessionAsync(sessionKey, initialSession);
    logger.info({ sessionId, initialStateId }, 'FSM new session initialized.');
    return initialSession;
  }
}

function saveSessionAsync(sessionKey, sessionData, sessionTTL) {
  const jsonData = JSON.stringify(sessionData);
  const effectiveTTL = (sessionTTL && sessionTTL > 0) ? sessionTTL : (parseInt(process.env.REDIS_SESSION_TTL, 10) || 3600);
  redisClient.set(sessionKey, jsonData, 'EX', effectiveTTL)
    .catch(err => logger.error({ err, sessionId: sessionKey.split(':')[1] }, 'FSM session failed to save to Redis.'));
}

// --- Nueva Lógica de Orquestación de Acciones ---

function getActionDependencies(action, currentParameters, sessionData, allApiConfigs) {
    let consumesParamsDef = null;
    if (action.type === "API") {
        const apiConfig = allApiConfigs[action.id]; // Usar un mapa pre-cargado para eficiencia
        if (!apiConfig) return { met: false, missing: [`API config for ${action.id} not found`] };
        consumesParamsDef = apiConfig.consumesParameters;
    } else if (action.type === "SCRIPT") {
        // Asumimos que los scripts pueden definir 'consumesParameters' en su objeto de acción en states.json
        consumesParamsDef = action.consumesParameters;
    }

    if (!consumesParamsDef || Object.keys(consumesParamsDef).length === 0) {
        return { met: true, missing: [], templateParams: {} };
    }

    const missingParams = [];
    const templateParams = {};

    for (const templateParamName in consumesParamsDef) {
        const PDef = consumesParamsDef[templateParamName];
        let value;
        let valueFound = false;

        if (PDef.source === "USER_INPUT") {
            if (currentParameters.hasOwnProperty(PDef.aiParamName) && currentParameters[PDef.aiParamName] !== null && currentParameters[PDef.aiParamName] !== '') {
                value = currentParameters[PDef.aiParamName];
                valueFound = true;
            }
        } else if (PDef.source === "API_RESULT" || PDef.source === "SCRIPT_RESULT") { // Added SCRIPT_RESULT
            // producedParamName es el nombre estandarizado del parámetro tal como lo produce la API/Script
            // (es decir, la clave en producesParameters de la API, o el assignResultTo del Script)
            if (currentParameters.hasOwnProperty(PDef.producedParamName) && currentParameters[PDef.producedParamName] !== null) {
                value = currentParameters[PDef.producedParamName];
                valueFound = true;
            }
        } else if (PDef.source === "STATIC") {
            value = PDef.value;
            valueFound = true;
        } else if (PDef.source === "SESSION_DATA") {
            try { value = PDef.path.split('.').reduce((o, k) => (o || {})[k], sessionData); } catch (e) { value = undefined; }
            if (typeof value !== 'undefined') valueFound = true;
        } else if (PDef.source === "COLLECTED_PARAM") {
            if (currentParameters.hasOwnProperty(PDef.paramName) && currentParameters[PDef.paramName] !== null && currentParameters[PDef.paramName] !== '') {
                value = currentParameters[PDef.paramName];
                valueFound = true;
            }
        }

        if (valueFound) {
            templateParams[templateParamName] = value;
        } else if (PDef.required !== false) { // Es requerido y no se encontró
            missingParams.push(templateParamName + (PDef.aiParamName ? ` (expected from AI as ${PDef.aiParamName})` : PDef.producedParamName ? ` (expected from API ${PDef.apiId} as ${PDef.producedParamName})` : ` (type: ${PDef.source})`));
        }
    }

    if (missingParams.length > 0) {
        return { met: false, missing: missingParams, templateParams: {} };
    }
    return { met: true, missing: [], templateParams };
}

async function executeSingleAction(action, currentParameters, sessionData, sessionId, allApiConfigs) {
    const actionId = action.id;
    logger.debug({sessionId, actionId, type: action.type, mode:action.executionMode}, "Attempting to execute action");

    let apiConfig;
    if (action.type === "API") {
        apiConfig = allApiConfigs[actionId];
        if (!apiConfig) {
            logger.error({ sessionId, actionId }, "API config not found for action.");
            return { error: `API config for ${actionId} not found` };
        }
        if (action.ignoreIfOutputExists && apiConfig.producesParameters) {
            const outputs = Object.keys(apiConfig.producesParameters);
            if (outputs.every(outParam => currentParameters.hasOwnProperty(outParam))) {
                logger.info({sessionId, actionId}, "Skipping API action as its output already exists and ignoreIfOutputExists is true.");
                return { skipped: true };
            }
        }
    } else if (action.type === "SCRIPT") {
        if (action.ignoreIfOutputExists && action.assignResultTo && currentParameters.hasOwnProperty(action.assignResultTo)) {
            logger.info({sessionId, actionId}, "Skipping SCRIPT action as its output already exists and ignoreIfOutputExists is true.");
            return { skipped: true };
        }
    } else {
        return { error: `Unknown action type: ${action.type}` };
    }

    const { templateParams } = getActionDependencies(action, currentParameters, sessionData, allApiConfigs);
    // Nota: getActionDependencies ya chequea 'required'. Aquí asumimos que se llamó antes y dio 'met:true'.
    // O, si se llama aquí, necesitamos manejar el 'met:false'. Por ahora, el planificador lo hará antes.

    if (action.type === "API") {
        const correlationId = `${action.executionMode === "SYNCHRONOUS" ? "sync" : "async"}_${actionId}_${Date.now()}`;
        if (action.executionMode === "SYNCHRONOUS") {
            const apiResponse = await apiCallerService.makeRequestAndWait(actionId, sessionId, correlationId, templateParams);
            currentParameters.sync_api_results = currentParameters.sync_api_results || {};
            currentParameters.sync_api_results[actionId] = apiResponse;
            if (apiResponse.status === 'success' && apiConfig.producesParameters) {
                for (const standardName in apiConfig.producesParameters) {
                    const pathInResponse = apiConfig.producesParameters[standardName];
                    let value;
                    try { value = pathInResponse.split('.').reduce((o, k) => (o || {})[k], apiResponse); } catch(e) { value = undefined; }
                    if (typeof value !== 'undefined') currentParameters[standardName] = value;
                    else logger.warn({sessionId, actionId, standardName, pathInResponse}, "Could not map API producedParameter.");
                }
            }
            return { success: true, data: apiResponse };
        } else { // ASYNCHRONOUS
            if (!apiConfig.response_stream_key_template) {
                return { error: `Missing response_stream_key_template for async API ${actionId}`};
            }
            const streamCorrId = uuidv4();
            const templateContextForStreamKey = { ...currentParameters, ...templateParams, correlationId: streamCorrId, sessionId };
            const responseStreamKey = processTemplate(apiConfig.response_stream_key_template, templateContextForStreamKey);

            const pendingResponseEntry = {
                apiId: actionId,
                responseStreamKey,
                requestedAt: new Date().toISOString()
            };
            if (action.waitForResult) { // NUEVO: Guardar configuración de waitForResult
                pendingResponseEntry.waitForResultConfig = action.waitForResult;
                logger.debug({sessionId, correlationId: streamCorrId, apiId: actionId, waitForResultConfig: action.waitForResult}, "ASYNCHRONOUS API call includes waitForResult config.");
            }
            sessionData.pendingApiResponses[streamCorrId] = pendingResponseEntry;

            apiCallerService.makeRequestAsync(actionId, sessionId, streamCorrId, templateParams);
            logger.info({sessionId, correlationId: streamCorrId, apiId: actionId}, "Dispatched ASYNCHRONOUS API call.");
            return { dispatchedAsync: true, correlationId: streamCorrId };
        }
    } else if (action.type === "SCRIPT") {
        const scriptExecutionOutcome = await scriptExecutor.executeScript(action, currentParameters, sessionId);

        currentParameters.script_results = currentParameters.script_results || {};
        currentParameters.script_results[action.id] = scriptExecutionOutcome; // Guardar el outcome completo

        if (scriptExecutionOutcome.error) {
            logger.warn({ sessionId, scriptId: action.id, error: scriptExecutionOutcome.error }, 'Script execution failed at executor level.');
            return { error: scriptExecutionOutcome.error, scriptOutputInternal: scriptExecutionOutcome };
        }

        const scriptReturn = scriptExecutionOutcome.result;

        if (typeof scriptReturn !== 'object' || scriptReturn === null || !scriptReturn.status) {
            logger.warn({sessionId, scriptId: action.id, returned: scriptReturn}, "Script did not return a standard structured object with 'status'. Handling as direct result for backward compatibility or simple scripts.");
            if (action.assignResultTo && typeof scriptReturn !== 'undefined') {
                currentParameters[action.assignResultTo] = scriptReturn;
            }
            if (action.canForceTransition && typeof scriptReturn === 'object' && scriptReturn !== null && scriptReturn.forceTransitionToState) {
                 logger.info({sessionId, scriptId: action.id, forcedTransitionDetails: scriptReturn}, "Script (legacy forcedTransition format) forcing transition.");
                 return { success: true, data: scriptReturn, forcedTransition: { nextState: scriptReturn.forceTransitionToState, intent: scriptReturn.intent, parameters: scriptReturn.parameters } };
            }
            return { success: true, data: scriptReturn };
        }

        switch (scriptReturn.status) {
            case "SUCCESS":
                if (action.assignResultTo && typeof scriptReturn.output !== 'undefined') {
                    currentParameters[action.assignResultTo] = scriptReturn.output;
                }
                logger.info({sessionId, scriptId: action.id, output: scriptReturn.output}, "Script executed successfully with SUCCESS status.");
                return { success: true, data: scriptReturn.output };
            case "ERROR":
                logger.error({ sessionId, scriptId: action.id, message: scriptReturn.message, errorCode: scriptReturn.errorCode }, 'Script reported an ERROR status.');
                return { error: scriptReturn.message || `Script ${action.id} reported an error`, errorCode: scriptReturn.errorCode, scriptOutputInternal: scriptReturn };
            case "FORCE_TRANSITION":
                if (action.canForceTransition && scriptReturn.transitionDetails && scriptReturn.transitionDetails.nextStateId) {
                    logger.info({ sessionId, scriptId: action.id, transitionDetails: scriptReturn.transitionDetails }, "Script forcing transition with new structured format.");
                    return {
                        success: true,
                        forcedTransition: {
                            nextState: scriptReturn.transitionDetails.nextStateId,
                            intent: scriptReturn.transitionDetails.intent,
                            parameters: scriptReturn.transitionDetails.parameters
                        },
                        data: scriptReturn
                    };
                } else {
                    logger.warn({ sessionId, scriptId: action.id, scriptReturn }, "Script tried to FORCE_TRANSITION, but 'canForceTransition' is false or details missing. Treating as SUCCESS.");
                    if (action.assignResultTo && typeof scriptReturn.output !== 'undefined') {
                         currentParameters[action.assignResultTo] = scriptReturn.output;
                    }
                    return { success: true, data: scriptReturn.output || scriptReturn };
                }
            default:
                logger.warn({ sessionId, scriptId: action.id, unknownStatus: scriptReturn.status, returnedValue: scriptReturn }, "Script returned unknown status in structured object.");
                return { error: `Script ${action.id} returned unknown status: ${scriptReturn.status}`, scriptOutputInternal: scriptReturn };
        }
    }
}

function getSkippedStateConfigs(startStateId, endStateId, allStatesMap) {
    if (startStateId === endStateId) return [];
    const queue = [[startStateId, []]]; // currId, path_configs_to_curr_excluding_start
    const visited = new Set([startStateId]);
    while (queue.length > 0) {
        const [currId, path] = queue.shift();
        const currConfig = allStatesMap[currId];
        if (!currConfig) continue;
        const transitions = currConfig.transitions || [];
        const nextPossibleIds = transitions.map(t => t.nextState);
        if (currConfig.defaultNextState) nextPossibleIds.push(currConfig.defaultNextState);

        for (const nextId of nextPossibleIds) {
            if (nextId === endStateId) return path; // Path are the skipped states
            if (nextId && allStatesMap[nextId] && !visited.has(nextId)) {
                visited.add(nextId);
                queue.push([nextId, [...path, allStatesMap[nextId]]]);
            }
        }
    }
    return []; // No direct path found implies direct transition or error
}

async function processInput(sessionId, intent, inputParametersAi = {}, initialCall = false, userInputText = null) {
    const sessionKey = `${FSM_SESSION_PREFIX}${sessionId}`;
    let sessionData = await initializeOrRestoreSession(sessionId);
    let currentParameters = { ...sessionData.parameters, ...inputParametersAi };
    sessionData.parameters = currentParameters;

    const fsmCurrentStateConfigAtStart = getStateById(sessionData.currentStateId);
    logger.debug({ sessionId, currentState: sessionData.currentStateId, intent }, 'FSM processInput: Start');

    // 1. Determinar Estado Objetivo (candidateNextStateId)
    let candidateNextStateId = sessionData.currentStateId;
    // ... (Lógica de transición: si intent o allParametersMet para awaitsUserInputParameters del estado actual)
    const requiredForCurrentTransition = fsmCurrentStateConfigAtStart.stateLogic?.awaitsUserInputParameters?.required || [];
    const allParamsMetForCurrent = requiredForCurrentTransition.every(p => currentParameters.hasOwnProperty(p) && currentParameters[p] !== null && currentParameters[p] !== '');

    if (fsmCurrentStateConfigAtStart.transitions) {
        for (const transition of fsmCurrentStateConfigAtStart.transitions) {
            let conditionMet = false;
            if (transition.condition.intent && transition.condition.intent === intent) conditionMet = true;
            if (transition.condition.allParametersMet && allParamsMetForCurrent) conditionMet = true;
            // TODO: Add more complex condition checks (e.g., specific param value)
            if (conditionMet) {
                candidateNextStateId = transition.nextState;
                break;
            }
        }
    }
    if (candidateNextStateId === sessionData.currentStateId && fsmCurrentStateConfigAtStart.defaultNextState && allParamsMetForCurrent) {
        candidateNextStateId = fsmCurrentStateConfigAtStart.defaultNextState;
    }
    const candidateNextStateConfig = getStateById(candidateNextStateId);
    if (!candidateNextStateConfig) throw new Error(`Config for candidate state ${candidateNextStateId} not found.`);

    // 2. Recopilar Acciones de Estados a Procesar (Saltados + Candidato)
    const allApiConfigs = getApiConfigById(); // Obtener todas las configs de API una vez
    const allStatesMap = getAllStatesConfig();
    const skippedStateConfigs = getSkippedStateConfigs(sessionData.currentStateId, candidateNextStateId, allStatesMap);
    const statesToProcessConfigs = [...skippedStateConfigs, candidateNextStateConfig];

    let masterActionPlan = []; // { action, stateId, status: 'pending'/'done'/'error'/'skipped', result }

    for (const stateConfig of statesToProcessConfigs) {
        (stateConfig.stateLogic?.onEntry || []).forEach(action => {
            masterActionPlan.push({ ...action, stateId: stateConfig.id, status: 'pending' });
        });
    }

    // --- Añadir Acciones Inducidas por dataRequirementsForPrompt ---
    const requiredByPromptParams = new Set();
    if (candidateNextStateConfig.payloadResponse?.prompts) {
        for (const key in candidateNextStateConfig.payloadResponse.prompts) {
            if (typeof candidateNextStateConfig.payloadResponse.prompts[key] === 'string') {
                extractTemplateParams(candidateNextStateConfig.payloadResponse.prompts[key])
                    .forEach(param => requiredByPromptParams.add(param));
            }
        }
    }
    if (candidateNextStateConfig.payloadResponse?.customInstructions) {
        extractTemplateParams(candidateNextStateConfig.payloadResponse.customInstructions)
            .forEach(param => requiredByPromptParams.add(param));
    }
    (candidateNextStateConfig.stateLogic?.dataRequirementsForPrompt || []).forEach(param => requiredByPromptParams.add(param));

    if (requiredByPromptParams.size > 0) {
        logger.debug({ sessionId, params: Array.from(requiredByPromptParams) }, "Parameters identified as required by candidate state's prompts/customInstructions.");
        for (const paramName of requiredByPromptParams) {
            if (!currentParameters.hasOwnProperty(paramName)) {
                let foundProducer = false;
                // `allApiConfigs` es un mapa de apiId -> apiConfig
                for (const apiId in allApiConfigs) {
                    const apiConfig = allApiConfigs[apiId];
                    if (apiConfig.producesParameters && apiConfig.producesParameters.hasOwnProperty(paramName)) {
                        const existingAction = masterActionPlan.find(a => a.id === apiId && a.type === "API");
                        if (!existingAction) {
                            logger.info({ sessionId, paramName, producingApiId: apiId }, `Adding API to plan: produces parameter required by prompt.`);
                            masterActionPlan.push({
                                label: `Induced by prompt requirement for {{${paramName}}}`,
                                type: "API",
                                id: apiId,
                                executionMode: "SYNCHRONOUS", // Debe ser síncrona si es para el prompt actual
                                stateId: candidateNextStateConfig.id,
                                status: 'pending',
                                isCriticalForPrompt: true // Marcarla como crítica
                            });
                        } else if (existingAction.executionMode === "ASYNCHRONOUS") {
                            logger.warn({sessionId, paramName, existingAction},"Parameter for prompt produced by an API already in plan as ASYNCHRONOUS. This might lead to the parameter not being available for the current prompt. Consider making the onEntry action SYNCHRONOUS or using dataRequirementsForPrompt to enforce synchronous execution if needed earlier.");
                        }
                        foundProducer = true;
                        break;
                    }
                }
                if (!foundProducer) {
                    // Podría también verificar si un SCRIPT produce este parámetro si los scripts definieran 'producesParameters'
                    logger.warn({sessionId, paramName}, "Parameter required by prompt, but no API producer found for it and not in currentParameters.");
                }
            }
        }
    }
    // --- FIN de Añadir Acciones Inducidas ---

    // 3. Planificación y Ejecución de Tareas Síncronas usando Grafo y Orden Topológico
    let initialSyncTasksFromPlan = masterActionPlan.filter(task => task.executionMode === "SYNCHRONOUS" && task.status === 'pending');

    if (initialSyncTasksFromPlan.length > 0) {
        logger.info({sessionId, count: initialSyncTasksFromPlan.length}, "Building dependency graph for synchronous actions.");
        const { graph, taskMap: syncTaskMap, unresolvedTasks: unresolvedTasksOnInit } =
            buildSyncActionGraph(initialSyncTasksFromPlan, currentParameters, sessionData, allApiConfigs, sessionId);

        unresolvedTasksOnInit.forEach(unresolvedTask => {
            const planTask = masterActionPlan.find(t => t.uniqueId === unresolvedTask.uniqueId);
            if (planTask) {
                planTask.status = 'unresolved_user_input';
                planTask.missingDeps = unresolvedTask.missingDeps; // Asignar missingDeps si buildSyncActionGraph lo populó
                logger.warn({sessionId, action: planTask.id, state: planTask.stateId, missing: planTask.missingDeps, uniqueId: planTask.uniqueId}, "Synchronous action unresolved due to missing initial USER_INPUT.");
            }
        });

        const resolvableTasksForGraphBuild = initialSyncTasksFromPlan.filter(task => !unresolvedTasksOnInit.some(ut => ut.uniqueId === task.uniqueId));
        const { graph: resolvableGraph, taskMap: resolvableTaskMapForSort } =
            buildSyncActionGraph(resolvableTasksForGraphBuild, currentParameters, sessionData, allApiConfigs, sessionId);

        const sortedTasks = topologicalSort(resolvableGraph, resolvableTaskMapForSort, []);

        if (sortedTasks) {
            logger.info({sessionId, count: sortedTasks.length}, "Executing synchronous actions in topological order.");
            for (const task of sortedTasks) {
                // La tarea ya fue evaluada por getActionDependencies dentro de buildSyncActionGraph para USER_INPUT iniciales.
                // El ordenamiento topológico asegura que las dependencias API_RESULT/SCRIPT_RESULT de otras tareas síncronas en el plan se respetan.
                logger.debug({sessionId, actionId: task.id, stateId: task.stateId, uniqueId: task.uniqueId}, "Executing topologically sorted synchronous action.");
                const result = await executeSingleAction(task, currentParameters, sessionData, sessionId, allApiConfigs);

                const planTaskToUpdate = masterActionPlan.find(t => t.uniqueId === task.uniqueId);
                if (planTaskToUpdate) {
                    planTaskToUpdate.status = result.error ? 'error' : (result.skipped ? 'skipped' : 'done');
                    planTaskToUpdate.result = result;
                    if (result.forcedTransition) {
                        candidateNextStateId = result.forcedTransition.nextState;
                        logger.info({sessionId, forcedTo: candidateNextStateId, byScript: task.id}, "Script forced transition.");
                        // TODO: Considerar si detener la ejecución síncrona aquí y re-planificar.
                    }
                    if (result.error) {
                        logger.error({sessionId, actionId: task.id, error: result.error}, "Error executing synchronous action. Dependent tasks might be affected.");
                        // TODO: Propagar fallo a tareas dependientes en el grafo.
                    }
                }
            }
        } else if (resolvableTaskMapForSort.size > 0) {
            logger.error({sessionId, taskCount: resolvableTaskMapForSort.size}, "Could not establish a valid execution order for resolvable synchronous actions (cycle detected or other complex unresolved dependencies).");
            resolvableTaskMapForSort.forEach(task => {
                const planTask = masterActionPlan.find(t => t.uniqueId === task.uniqueId);
                if (planTask && planTask.status === 'pending') {
                     planTask.status = 'unresolved_cycle_or_dependency';
                }
            });
        }
    } else {
        logger.info({sessionId}, "No pending synchronous actions to execute via graph.");
    }

    // Loguear el estado final de todas las tareas síncronas originalmente planeadas
    masterActionPlan.filter(t => t.executionMode === "SYNCHRONOUS")
        .forEach(task => {
            if (task.status !== 'done' && task.status !== 'skipped') {
                 logger.warn({sessionId, action: task.id, state: task.stateId, status: task.status, missing: task.missingDeps, result: task.result, uniqueId:task.uniqueId}, "Final status of a synchronous action.");
            }
        });

    // 4. Despacho de Acciones Asíncronas de `onEntry` (de todos los estados procesados)
    for (const task of masterActionPlan) {
        if (task.status === 'pending' && task.executionMode === 'ASYNCHRONOUS') {
             const { met } = getActionDependencies(task, currentParameters, sessionData, allApiConfigs);
             if (met) {
                await executeSingleAction(task, currentParameters, sessionData, sessionId, allApiConfigs); // Despacha
                task.status = 'dispatched'; // Marcar como despachada
             } else {
                logger.warn({sessionId, action: task.id, state: t.stateId, missing: task.missingDeps}, "Skipping ASYNC action due to unmet dependencies.");
                task.status = 'skipped_deps';
             }
        }
    }

    // 5. Transición Final y Renderizado
    const finalNextStateId = candidateNextStateId; // Actualizado si un script forzó
    const finalNextStateConfig = getStateById(finalNextStateId);
     if (!finalNextStateConfig) throw new Error(`Config for FINAL state ${finalNextStateId} not found.`);


    if (sessionData.currentStateId !== finalNextStateId) {
        const onTransitionActions = fsmCurrentStateConfigAtStart.stateLogic?.onTransition || [];
        for (const action of onTransitionActions) { // Generalmente asíncronas
             const { met } = getActionDependencies(action, currentParameters, sessionData, allApiConfigs);
             if(met) await executeSingleAction(action, currentParameters, sessionData, sessionId, allApiConfigs);
        }
        logger.info({ sessionId, fromState: sessionData.currentStateId, toState: finalNextStateId }, `FSM transitioning`);
        sessionData.currentStateId = finalNextStateId;
        if (!sessionData.history.includes(finalNextStateId)) sessionData.history.push(finalNextStateId);
    }

    let renderedPayloadResponse = {};
    if (finalNextStateConfig.payloadResponse) {
        try {
            renderedPayloadResponse = processTemplate(JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse)), currentParameters);
        } catch (templateError) {
            logger.error({ err: templateError, sessionId, state: finalNextStateId }, `Error processing payloadResponse template.`);
            renderedPayloadResponse = JSON.parse(JSON.stringify(finalNextStateConfig.payloadResponse));
        }
    }

    const parametersToCollect = { required: [], optional: [] };
    const requiredForNextState = finalNextStateConfig.stateLogic?.awaitsUserInputParameters?.required || [];
    const optionalForNextState = finalNextStateConfig.stateLogic?.awaitsUserInputParameters?.optional || [];
    parametersToCollect.required = requiredForNextState.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '');
    parametersToCollect.optional = optionalForNextState.filter(p => !currentParameters.hasOwnProperty(p) || currentParameters[p] === null || currentParameters[p] === '');

    saveSessionAsync(sessionKey, sessionData);
    return {
        sessionId,
        currentStateId: finalNextStateId,
        nextStateId: finalNextStateId,
        parametersToCollect,
        payloadResponse: renderedPayloadResponse,
        collectedParameters: currentParameters,
    };
}

module.exports = {
  initializeOrRestoreSession,
  processInput,
  saveSessionAsync,
  FSM_SESSION_PREFIX
};
```
