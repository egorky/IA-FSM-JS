require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { startApiServer } = require('./apiServer');
const { startSocketServer, stopSocketServer } = require('./socketServer');
const redisClient = require('./redisClient');
const { connectAri, closeAri } = require('./ariClient');
const { startDemoServers, stopDemoServers } = require('./demoApiServers'); // For DEMO_MODE
const fsm = require('./fsm'); // Contains FSM_SESSION_PREFIX, initializeOrRestoreSession, processInput, saveSessionAsync
const { loadStateConfig, getStateById } = require('./configLoader');
const { getAllApiConfigs: getAllApiConfigsForDemo } = require('./apiConfigLoader'); // For demo mode
const { processTemplate } = require('./templateProcessor'); // Added templateProcessor
const aiService = require('./aiService');
const jsonValidator = require('./jsonValidator');
const { validateAIResponse: customAIResponseValidator } = require('../config/customAIResponseValidator');

const PROMPT_PATH = path.join(__dirname, '../config/aiPrompt.txt');
let aiPromptContent = '';
const CONSUMER_GROUP_NAME = process.env.REDIS_STREAM_CONSUMER_GROUP || 'fsm_ai_group';
const CONSUMER_NAME_PREFIX = process.env.REDIS_STREAM_CONSUMER_NAME_PREFIX || `fsm_consumer_${uuidv4()}`;
// DEMO_MODE is now imported from configConstants to ensure it's the same source of truth
const { DEMO_MODE } = require('./configConstants');


function loadAIPrompt() {
  try {
    if (fs.existsSync(PROMPT_PATH)) {
      aiPromptContent = fs.readFileSync(PROMPT_PATH, 'utf-8');
      logger.info('AI prompt content loaded successfully.');
    } else {
      logger.error(`AI prompt file not found at ${PROMPT_PATH}. AI processing will likely fail.`);
    }
  } catch (error) {
    logger.error({ err: error, promptPath: PROMPT_PATH }, 'Error loading AI prompt file.');
  }
}

async function ensureStreamGroupExists(streamKey, groupName) {
    try {
        await redisClient.xgroupCreate(streamKey, groupName, '$', true); // true for MKSTREAM
    } catch (err) {
        if (err && err.message.includes('BUSYGROUP')) {
            logger.warn({ streamKey, groupName }, 'Redis Stream consumer group already exists.');
        } else {
            logger.error({ err, streamKey, groupName }, 'Failed to create or verify Redis Stream consumer group.');
            // Not rethrowing, as the stream might be created by another instance/worker.
            // XREADGROUP will fail if group doesn't exist after all.
        }
    }
}

// Importar getApiConfigById para usarlo en processStreamResponsesAndUpdateContext
const { getApiConfigById: getAllApiConfigs } = require('./apiConfigLoader');


async function processStreamResponsesAndUpdateContext(sessionId, sessionData, currentParameters) {
    let fullTextUpdateForAI = '';
    let sessionModified = false;
    const allApiConfigs = getAllApiConfigs(); // Cargar todas las configs de API una vez

    const pendingResponsesToEvaluate = { ...sessionData.pendingApiResponses };

    for (const correlationId in pendingResponsesToEvaluate) {
        const pendingInfo = sessionData.pendingApiResponses[correlationId];
        if (!pendingInfo) continue;

        if (pendingInfo.waitForResultConfig && pendingInfo.waitForResultConfig.point === "BEFORE_AI_PROMPT_NEXT_TURN") {
            logger.info({ sessionId, correlationId, apiId: pendingInfo.apiId, streamKey: pendingInfo.responseStreamKey },
                `Actively waiting for stream response (Point: BEFORE_AI_PROMPT_NEXT_TURN).`);

            const timeoutMs = pendingInfo.waitForResultConfig.timeoutMs || parseInt(process.env.DEFAULT_ASYNC_WAIT_TIMEOUT_MS, 10) || 7000;
            let apiMessageData = null;
            let streamReadStatus = 'error';

            try {
                await ensureStreamGroupExists(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME);
                const streamResult = await redisClient.xreadgroup(
                    CONSUMER_GROUP_NAME,
                    `${CONSUMER_NAME_PREFIX}:${sessionId}:${correlationId}`,
                    [pendingInfo.responseStreamKey, '>'],
                    timeoutMs, 1
                );

                if (streamResult && streamResult.length > 0 && streamResult[0][1].length > 0) {
                    const messageId = streamResult[0][1][0][0];
                    const messageFields = streamResult[0][1][0][1];
                    apiMessageData = {};
                    for (let i = 0; i < messageFields.length; i += 2) {
                        try { apiMessageData[messageFields[i]] = JSON.parse(messageFields[i+1]); }
                        catch (e) { apiMessageData[messageFields[i]] = messageFields[i+1]; }
                    }
                    streamReadStatus = apiMessageData.status || 'error';
                    logger.info({ sessionId, correlationId, apiId: pendingInfo.apiId, status: streamReadStatus }, 'Retrieved actively awaited API response from stream.');
                    await redisClient.xack(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME, messageId);
                } else {
                    streamReadStatus = 'timeout_wait';
                    logger.warn({sessionId, correlationId, apiId: pendingInfo.apiId, streamKey: pendingInfo.responseStreamKey, timeoutMs}, "Timed out waiting for actively awaited API response.");
                }
            } catch (err) {
                logger.error({ err, sessionId, correlationId, apiId: pendingInfo.apiId, streamKey: pendingInfo.responseStreamKey }, 'Error during active wait/read from stream.');
                streamReadStatus = 'system_error_wait';
            }

            const apiDef = allApiConfigs[pendingInfo.apiId];
            const contextMarker = pendingInfo.apiId || 'UNKNOWN_API';
            const asyncNamespace = `async_api_results_${contextMarker}`; // Consistente con checkNonAwaited

            if (streamReadStatus === 'success' && apiMessageData && apiMessageData.data !== undefined) {
                fullTextUpdateForAI += `\n\n[API Response Context for '${contextMarker}' (ID: ${correlationId}): ${JSON.stringify(apiMessageData.data)}]`;
                currentParameters[asyncNamespace] = { status: 'success', data: apiMessageData.data, httpCode: apiMessageData.httpCode };
                if (apiDef && apiDef.producesParameters) {
                    for (const standardName in apiDef.producesParameters) {
                        const path = apiDef.producesParameters[standardName];
                        let value;
                        try { value = path.split('.').reduce((o, k) => (o || {})[k], apiMessageData); } // apiMessageData ya tiene 'data' en su interior si es exitoso
                        catch(e){ value = undefined; }
                        if (value !== undefined) currentParameters[standardName] = value;
                         else logger.warn({sessionId, apiId: pendingInfo.apiId, standardName, path, responseData: apiMessageData}, "Could not map producedParameter from awaited API response.");
                    }
                }
            } else if (streamReadStatus === 'timeout_wait' && pendingInfo.waitForResultConfig.onTimeoutFallback?.mapToProducesParameters) {
                const fallbackParams = pendingInfo.waitForResultConfig.onTimeoutFallback.mapToProducesParameters;
                fullTextUpdateForAI += `\n\n[API Fallback Context for '${contextMarker}' (ID: ${correlationId}): Timeout, using fallback: ${JSON.stringify(fallbackParams)}]`;
                currentParameters[asyncNamespace] = { status: 'timeout', fallback_applied: true, data: fallbackParams };
                for (const paramName in fallbackParams) {
                    currentParameters[paramName] = fallbackParams[paramName];
                }
            } else {
                const errorMessage = apiMessageData?.errorMessage || streamReadStatus;
                fullTextUpdateForAI += `\n\n[API Error Context for '${contextMarker}' (ID: ${correlationId}): ${errorMessage}]`;
                currentParameters[asyncNamespace] = { status: 'error', message: errorMessage, data: apiMessageData?.data, httpCode: apiMessageData?.httpCode };
            }
            delete sessionData.pendingApiResponses[correlationId];
            sessionModified = true;
        }
    }
    return { fullTextUpdateForAI, sessionModified };
}


// This function processes ONE specific pending API response from a stream if specified by waitForCorrelationId
// ESTA FUNCIÓN (processSingleAwaitedApiResponse) SERÁ REEMPLAZADA/OBSOLETADA por la lógica en processStreamResponsesAndUpdateContext
// y la llamada explícita a ella más abajo. La comentaremos o eliminaremos después.
async function processSingleAwaitedApiResponse(sessionId, sessionData, waitForCorrelationId, currentParameters/*, fullTextInputForAI - ya no lo modifica directamente*/) {
    const pendingInfo = sessionData.pendingApiResponses[waitForCorrelationId]; // CUIDADO: Esta función asume que pendingInfo existe.
    if (!pendingInfo) {
        logger.warn({sessionId, waitForCorrelationId}, "processSingleAwaitedApiResponse called for a non-existent pending response.");
        return { textUpdate: '', newParameters: {} };
    }
    logger.info({sessionId, correlationId: waitForCorrelationId, streamKey: pendingInfo.responseStreamKey}, `Explicitly waiting for API response on stream (legacy call).`);
    await ensureStreamGroupExists(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME);

    let newParametersFromThisApi = {};
    let textUpdateFromThisApi = '';

    try {
      const blockTimeoutMs = parseInt(process.env.REDIS_STREAM_XREAD_BLOCK_WAIT_MS, 10) || 5000;
      const streamResult = await redisClient.xreadgroup(
        CONSUMER_GROUP_NAME,
        `${CONSUMER_NAME_PREFIX}:${sessionId}`, // Consumer name
        [pendingInfo.responseStreamKey, '>'],   // Read new messages for this group
        blockTimeoutMs, 1                       // Block and count
      );

      if (streamResult && streamResult.length > 0 && streamResult[0][1].length > 0) {
        const messageId = streamResult[0][1][0][0];
        const messageFields = streamResult[0][1][0][1];
        let apiResponse = { correlationId: 'unknown' }; // Default
        for (let i = 0; i < messageFields.length; i += 2) {
            try { apiResponse[messageFields[i]] = JSON.parse(messageFields[i+1]); }
            catch (e) { apiResponse[messageFields[i]] = messageFields[i+1]; }
        }
        logger.info({ sessionId, correlationId: apiResponse.correlationId, apiResponseStatus: apiResponse.status }, 'Retrieved explicitly awaited API response from stream.');

        const contextMarker = apiResponse.apiId || pendingInfo.apiId || 'UNKNOWN_API';
        const apiResultKeyNamespace = `async_api_results.${contextMarker}`;

        if (apiResponse.status === 'success') {
            textUpdateFromThisApi = `\n\n[API Response Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify(apiResponse.data)}]`;
            newParametersFromThisApi[apiResultKeyNamespace] = { status: 'success', data: apiResponse.data };
        } else {
            textUpdateFromThisApi = `\n\n[API Error Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify({ httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout })}]`;
            newParametersFromThisApi[apiResultKeyNamespace] = { status: 'error', httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout };
        }
        await redisClient.xack(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME, messageId);
        delete sessionData.pendingApiResponses[waitForCorrelationId];
      } else {
        logger.warn({sessionId, correlationId: waitForCorrelationId, stream: pendingInfo.responseStreamKey}, "Timed out waiting for explicit API response on stream.");
        textUpdateFromThisApi = `\n\n[API Timeout Context: No response received for expected API call (ID: ${waitForCorrelationId}) for API '${pendingInfo.apiId}' within timeout.]`;
        newParametersFromThisApi[`async_api_results.${pendingInfo.apiId}_timeout`] = true;
        delete sessionData.pendingApiResponses[waitForCorrelationId];
      }
    } catch (err) {
      logger.error({ err, sessionId, correlationId: waitForCorrelationId, streamKey: pendingInfo.responseStreamKey }, 'Error during explicit wait/read from Redis Stream.');
      textUpdateFromThisApi = `\n\n[API Error Context: System error while waiting for API call (ID: ${waitForCorrelationId}) for API '${pendingInfo.apiId}'.]`;
      newParametersFromThisApi[`async_api_results.${pendingInfo.apiId}_system_error`] = err.message;
      delete sessionData.pendingApiResponses[waitForCorrelationId];
    }
    return { textUpdate: textUpdateFromThisApi, newParameters: newParametersFromThisApi };
}

// This function checks for any other pending (non-awaited) API responses
async function checkNonAwaitedApiResponses(sessionId, sessionData, currentParameters) {
    let combinedTextUpdate = '';
    let newParametersFromTheseApis = {};
    const pendingResponsesCopy = { ...sessionData.pendingApiResponses }; // Iterate over a copy

    for (const correlationId in pendingResponsesCopy) {
        const pendingInfo = pendingResponsesCopy[correlationId];
        if (!pendingInfo || !pendingInfo.responseStreamKey) continue;

        logger.debug({ sessionId, correlationId, streamKey: pendingInfo.responseStreamKey }, 'Checking non-awaited API response in stream.');
        await ensureStreamGroupExists(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME);
        try {
            const blockTimeoutMs = parseInt(process.env.REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM, 10) || 50; // Very short block
            const streamResult = await redisClient.xreadgroup(
                CONSUMER_GROUP_NAME, `${CONSUMER_NAME_PREFIX}:${sessionId}`,
                [pendingInfo.responseStreamKey, '>'], blockTimeoutMs, 1
            );

            if (streamResult && streamResult.length > 0 && streamResult[0][1].length > 0) {
                const messageId = streamResult[0][1][0][0];
                const messageFields = streamResult[0][1][0][1];
                let apiResponse = { correlationId: 'unknown' };
                for (let i = 0; i < messageFields.length; i += 2) {
                    try { apiResponse[messageFields[i]] = JSON.parse(messageFields[i+1]); }
                    catch (e) { apiResponse[messageFields[i]] = messageFields[i+1]; }
                }
                logger.info({ sessionId, correlationId: apiResponse.correlationId, apiResponseStatus: apiResponse.status }, 'Retrieved non-awaited API response.');
                const contextMarker = apiResponse.apiId || pendingInfo.apiId || 'UNKNOWN_API';
                const apiResultKeyNamespace = `async_api_results.${contextMarker}`;

                if (apiResponse.status === 'success') {
                    combinedTextUpdate += `\n\n[API Response Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify(apiResponse.data)}]`;
                    newParametersFromTheseApis[apiResultKeyNamespace] = { status: 'success', data: apiResponse.data };
                } else {
                    combinedTextUpdate += `\n\n[API Error Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify({ httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout })}]`;
                    newParametersFromTheseApis[apiResultKeyNamespace] = { status: 'error', httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout };
                }
                await redisClient.xack(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME, messageId);
                delete sessionData.pendingApiResponses[correlationId];
            }
        } catch (err) {
            logger.error({ err, sessionId, correlationId, streamKey: pendingInfo.responseStreamKey }, 'Error reading non-awaited API response from Redis Stream.');
        }
    }
    return { textUpdate: combinedTextUpdate, newParameters: newParametersFromTheseApis };
}


async function handleInputWithAI(sessionId, clientInput, source) {
  let userInputText = clientInput;
  let waitForCorrelationId = null;
  let initialCall = false; // Flag to indicate if this is the very first interaction for a session

  if (typeof clientInput === 'object' && clientInput !== null) {
    userInputText = clientInput.userInput || '';
    waitForCorrelationId = clientInput.waitForCorrelationId || null;
    initialCall = clientInput.initialCall === true; // Client can flag the first call
  } else if (typeof clientInput !== 'string') {
    userInputText = String(clientInput);
  }

  logger.info({ sessionId, userInputLength: userInputText?.length, waitForCorrelationId, source, initialCall }, 'Handling input');

  redisClient.set(`input_text:${sessionId}:${Date.now()}`, JSON.stringify({ userInputText, waitForCorrelationId, source }), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log input_text to Redis'));

  let sessionData = await fsm.initializeOrRestoreSession(sessionId);
  let currentParameters = { ...sessionData.parameters };
  let baseUserInputForAI = userInputText; // Input original del usuario para este turno
  let contextFromStreams = ''; // Contexto de APIs asíncronas esperadas
  let sessionModifiedByAsync = false;

  // --- Procesar respuestas de stream que se deben esperar ANTES del prompt de IA ---
  if (sessionData.pendingApiResponses && Object.keys(sessionData.pendingApiResponses).length > 0) {
    const streamProcessingResult = await processStreamResponsesAndUpdateContext(sessionId, sessionData, currentParameters);
    contextFromStreams = streamProcessingResult.fullTextUpdateForAI;
    if (streamProcessingResult.sessionModified) {
      sessionModifiedByAsync = true;
      // currentParameters fue modificado por referencia dentro de processStreamResponsesAndUpdateContext
    }
  }
  // En este punto, sessionData.pendingApiResponses ha sido limpiado de las que se esperaron.
  // currentParameters está actualizado con resultados de esas APIs o sus fallbacks.

  // Construir el fullTextInputForAI para la IA
  let fullTextInputForAI = "";
  const currentStateId = sessionData.currentStateId;
  const stateConfig = getStateById(currentStateId);
  const currentStateId = sessionData.currentStateId;
  const stateConfig = getStateById(currentStateId);
  let renderedCustomInstructions = "";

  if (stateConfig && stateConfig.payloadResponse && stateConfig.payloadResponse.customInstructions) {
    try {
      // Render customInstructions using parameters available *before* this turn's sync operations
      // These are parameters from the session, including async_api_results from previous turns.
      renderedCustomInstructions = processTemplate(
        stateConfig.payloadResponse.customInstructions,
        currentParameters // Use parameters as they are at this point
      );
      logger.debug({ sessionId, currentStateId, renderedCustomInstructions }, "Rendered customInstructions for AI prompt.");
    } catch (templateError) {
      logger.error({ err: templateError, sessionId, currentStateId }, "Error rendering customInstructions for AI prompt.");
    }
  }

  // Prepend custom instructions
  // Prepend custom instructions
  if (renderedCustomInstructions) {
    fullTextInputForAI += `State Instructions: "${renderedCustomInstructions}"\n\n`;
  }
  // Prepend context from actively awaited streams
  if (contextFromStreams) {
    fullTextInputForAI += `${contextFromStreams}\n\n`;
  }

  // Añadir Historial de Conversación (si existe)
  if (sessionData.conversationHistory && sessionData.conversationHistory.length > 0) {
    const formattedHistory = sessionData.conversationHistory
      .map(turn => `User: ${turn.userInput}\nAI: ${turn.aiOutput}`)
      .join('\n\n'); // Doble salto de línea entre turnos completos
    fullTextInputForAI = `Previous Conversation History:\n${formattedHistory}\n\n${fullTextInputForAI}`;
    // OJO: Poner el historial antes podría ser muy largo. Considerar si va antes o después del input actual.
    // Por ahora, lo pongo antes, pero después de custom instructions y context de streams.
  }

  // Añadir Parámetros Recolectados (filtrados)
  const cleanParametersForAI = { ...currentParameters };
  delete cleanParametersForAI.sync_api_results;   // No enviar resultados crudos de API síncronas
  delete cleanParametersForAI.script_results;     // No enviar resultados crudos de scripts
  // async_api_results ya se manejan como contexto textual o se mapean a parámetros directos.
  // Eliminar también los que ya se mapearon para no ser redundantes, si es posible identificar.
  // Por ahora, una limpieza simple:
  for (const key in cleanParametersForAI) {
    if (key.startsWith('async_api_results_')) { // Eliminar los namespaces crudos de async
        delete cleanParametersForAI[key];
    }
  }

  if (Object.keys(cleanParametersForAI).length > 0) {
    try {
      const collectedParamsString = JSON.stringify(cleanParametersForAI);
      fullTextInputForAI = `[Currently Known Parameters: ${collectedParamsString}]\n\n${fullTextInputForAI}`;
    } catch (e) {
      logger.warn({sessionId, err: e}, "Could not stringify cleanParametersForAI for AI prompt.");
    }
  }

  // Finalmente, el input del usuario para este turno
  fullTextInputForAI += `Current User Input: "${baseUserInputForAI}"`;


  // Procesar las APIs asíncronas restantes que NO se esperaron activamente para el prompt de IA.
  // Estas actualizarán currentParameters para la FSM, pero su texto no se añade a fullTextInputForAI.
  const nonAwaitedProcessing = await checkNonAwaitedApiResponses(sessionId, sessionData, currentParameters);
  if (Object.keys(nonAwaitedProcessing.newParameters).length > 0) {
    currentParameters = { ...currentParameters, ...nonAwaitedProcessing.newParameters };
    sessionModifiedByAsync = true; // Marcamos que la sesión cambió
  }
  // `checkNonAwaitedApiResponses` ya borra de `sessionData.pendingApiResponses` las que procesa.

  sessionData.parameters = currentParameters; // Asegurar que currentParameters (con todos los resultados de streams) esté en sessionData

  if (sessionModifiedByAsync) {
      logger.info({sessionId}, "Session modified by async API response processing (waited or non-waited). Saving session before AI call.");
      fsm.saveSessionAsync(`${fsm.FSM_SESSION_PREFIX}${sessionId}`, sessionData, parseInt(process.env.REDIS_SESSION_TTL, 10));
  }

  // --- AI Processing ---
  let aiIntent, aiParameters;
  if (!aiPromptContent) {
    logger.error({ sessionId, source }, 'AI prompt is not loaded. Using direct/fallback.');
    // Try to parse fullTextInputForAI as JSON (if it was structured input initially)
    try {
        const parsedAsJson = JSON.parse(fullTextInputForAI);
        if (parsedAsJson.intent && parsedAsJson.parameters) {
            aiIntent = parsedAsJson.intent;
            aiParameters = parsedAsJson.parameters;
            logger.warn({sessionId}, "AI prompt missing, using JSON input directly for FSM.");
        } else {
            throw new Error("Not a valid FSM input structure");
        }
    } catch (e) {
        aiIntent = 'general_inquiry'; // Fallback intent
        aiParameters = { raw_text: fullTextInputForAI };
        logger.warn({sessionId}, "AI prompt missing, using 'general_inquiry' fallback.");
    }
  } else {
    redisClient.set(`ai_actual_input:${sessionId}:${Date.now()}`, JSON.stringify({ textForAI: fullTextInputForAI }), 'EX', 3600).catch(err => logger.error({ err, sessionId }, 'Log ai_actual_input failed'));
    try {
      // Pass sessionId to getAIResponse for enhanced logging in aiService
      const aiJsonResponse = await aiService.getAIResponse(fullTextInputForAI, aiPromptContent, sessionId);
      const schemaValidationResult = jsonValidator.validateJson(aiJsonResponse);
      if (!schemaValidationResult.isValid) {
        logger.warn({ sessionId, errors: schemaValidationResult.errors, aiResponse: aiJsonResponse }, 'AI response schema validation failed.');
        aiIntent = 'ai_schema_validation_error';
        aiParameters = { errors: schemaValidationResult.errors, original_response: aiJsonResponse };
      } else {
        let finalAiResponse = aiJsonResponse;
        if (typeof customAIResponseValidator === 'function') {
          const customValidationResult = customAIResponseValidator(aiJsonResponse);
          if (!customValidationResult.isValid) {
            logger.warn({ sessionId, message: customValidationResult.message, aiResponse: aiJsonResponse }, 'AI custom validation failed.');
            aiIntent = 'ai_custom_validation_error';
            aiParameters = { error_message: customValidationResult.message, original_response: aiJsonResponse };
          } else {
            finalAiResponse = customValidationResult.validatedResponse || finalAiResponse;
            aiIntent = finalAiResponse.intent;
            aiParameters = finalAiResponse.parameters;
          }
        } else {
            aiIntent = finalAiResponse.intent;
            aiParameters = finalAiResponse.parameters;
        }
      }
    } catch (aiError) {
      logger.error({ err: aiError, sessionId, source }, 'AI service failed.');
      aiIntent = 'ai_processing_error';
      aiParameters = { error: aiError.message, original_text: fullTextInputForAI };
    }
  }

  logger.info({ sessionId, intent: aiIntent, /*parameters: aiParameters,*/ source }, 'AI processing complete. Proceeding to FSM.');
  redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify({intent: aiIntent, parameters: aiParameters, combined_text_for_ai: fullTextInputForAI}), 'EX', 3600).catch(err => logger.error({ err }, 'Log fsm_input failed'));

  // Pass all current parameters (session + input + async API results) to FSM
  // FSM will then handle its synchronous APIs and merge results into these.
  const fsmResult = await fsm.processInput(sessionId, aiIntent, aiParameters, initialCall, baseUserInputForAI /* Pasar userInputText */);

  // --- Poblar Historial de Conversación ---
  if (fsmResult && fsmResult.payloadResponse?.prompts?.main) {
    if (!sessionData.conversationHistory) { // Doble chequeo, aunque initializeOrRestoreSession debería hacerlo
      sessionData.conversationHistory = [];
    }
    sessionData.conversationHistory.push({
      userInput: baseUserInputForAI, // El input original del usuario para este turno
      aiOutput: fsmResult.payloadResponse.prompts.main, // La respuesta principal que se le da al usuario
      intent: aiIntent, // Guardar el intent detectado por la IA para este turno
      parametersFromAI: aiParameters, // Guardar los parámetros extraídos por la IA
      timestamp: new Date().toISOString()
    });

    const MAX_HISTORY_TURNS = parseInt(process.env.CONVERSATION_HISTORY_MAX_TURNS, 10) || 10; // Default 10 turnos
    if (sessionData.conversationHistory.length > MAX_HISTORY_TURNS) {
      sessionData.conversationHistory.splice(0, sessionData.conversationHistory.length - MAX_HISTORY_TURNS);
    }
    // Guardar la sesión FSM actualizada con el nuevo historial
    // fsm.processInput ya guarda la sesión al final de su ejecución.
    // Si queremos asegurar que el historial se guarde *después* de que fsm.processInput guardó,
    // podríamos llamar a saveSessionAsync aquí de nuevo. O fsm.processInput podría devolver la sessionData actualizada
    // y la guardamos aquí.
    // Por ahora, asumimos que fsm.processInput guardó la sesión SIN este último historial.
    // Así que es necesario un guardado adicional aquí para el historial.
    fsm.saveSessionAsync(`${fsm.FSM_SESSION_PREFIX}${sessionId}`, sessionData, parseInt(process.env.REDIS_SESSION_TTL, 10));
    logger.debug({sessionId, historyLength: sessionData.conversationHistory.length}, "Conversation history updated and session saved.");
  }
  // --- Fin Poblar Historial ---


  redisClient.set(`fsm_output:${sessionId}:${Date.now()}`, JSON.stringify(fsmResult), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log fsm_output to Redis'));

  return fsmResult;
}

async function main() {
  logger.info(`API Enabled: ${process.env.ENABLE_API}, ARI Enabled: ${process.env.ENABLE_ARI}, Socket Enabled: ${process.env.ENABLE_SOCKET_SERVER}`);
  try {
    logger.info('Initializing FSM application...');
    loadStateConfig();
    jsonValidator.loadSchema();
    loadAIPrompt();

    await redisClient.connect();
    await redisClient.getSubscriberClient();
    logger.info('Redis clients (main & subscriber) connected.');

    if (DEMO_MODE) {
      await new Promise(resolve => startDemoServers(resolve));
      logger.info("Demo API servers started as DEMO_MODE is active.");
    }

    const enableApi = process.env.ENABLE_API !== 'false';
    if (enableApi) startApiServer(handleInputWithAI);
    else logger.info('API module disabled.');

    const enableAri = process.env.ENABLE_ARI !== 'false';
    if (enableAri) {
      await connectAri(handleInputWithAI);
      logger.info('ARI module initialized.');
    } else logger.info('ARI module disabled.');

    const enableSocketServer = process.env.ENABLE_SOCKET_SERVER !== 'false';
    const fsmSocketPath = process.env.FSM_SOCKET_PATH;
    if (enableSocketServer) {
      if (fsmSocketPath) startSocketServer(fsmSocketPath, handleInputWithAI);
      else logger.warn('Socket server enabled but FSM_SOCKET_PATH not set.');
    } else logger.info('Socket server module disabled.');

    if (enableApi || enableAri || (enableSocketServer && fsmSocketPath) ) {
      logger.info('FSM application started successfully.');
    } else {
      logger.warn('All interface modules are disabled. Application will not process requests.');
    }
  } catch (error) {
    logger.fatal({ err: error }, 'Fatal error during application initialization.');
    await shutdown('fatal_initialization_error').finally(() => process.exit(1));
  }
}

async function shutdown(signal) {
  logger.info({signal}, `Shutting down FSM application due to ${signal}...`);

  if (DEMO_MODE) {
    await new Promise(resolve => stopDemoServers(resolve));
    logger.info("Demo API servers stopped.");
  }

  if (process.env.ENABLE_ARI !== 'false') await closeAri().catch(err => logger.error({ err }, 'Error closing ARI'));
  if (process.env.ENABLE_SOCKET_SERVER !== 'false' && process.env.FSM_SOCKET_PATH) {
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => logger.error({ err }, 'Error closing Socket Server'));
  }
  await redisClient.quit().catch(err => logger.error({ err }, 'Error closing Redis clients'));
  logger.info('FSM application shutdown complete.');
  if (signal !== 'fatal_initialization_error') process.exit(0);
}

['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, () => shutdown(signal)));
process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err, origin }, 'UncaughtException. Shutting down...');
  shutdown('uncaughtException').finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'UnhandledRejection. Shutting down...');
  shutdown('unhandledRejection').finally(() => process.exit(1));
});

main();
