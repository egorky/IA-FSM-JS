require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { startApiServer } = require('./apiServer');
const { startSocketServer, stopSocketServer } = require('./socketServer');
const redisClient = require('./redisClient');
const { connectAri, closeAri } = require('./ariClient');
const fsm = require('./fsm');
const { loadStateConfig } = require('./configLoader');
const aiService = require('./aiService');
const jsonValidator = require('./jsonValidator');
const { validateAIResponse: customAIResponseValidator } = require('../config/customAIResponseValidator');

const PROMPT_PATH = path.join(__dirname, '../config/aiPrompt.txt');
// API_RESPONSE_KEY_PREFIX is no longer used for SCAN, replaced by stream logic.
let aiPromptContent = '';
const CONSUMER_GROUP_NAME = process.env.REDIS_STREAM_CONSUMER_GROUP || 'fsm_ai_group';
const CONSUMER_NAME_PREFIX = process.env.REDIS_STREAM_CONSUMER_NAME_PREFIX || `fsm_consumer_${uuidv4()}`; // Unique consumer per instance

function loadAIPrompt() {
  try {
    if (fs.existsSync(PROMPT_PATH)) {
      aiPromptContent = fs.readFileSync(PROMPT_PATH, 'utf-8');
      logger.info('AI prompt content loaded successfully.');
    } else {
      logger.error(`AI prompt file not found at ${PROMPT_PATH}. AI processing will likely fail.`);
      aiPromptContent = '';
    }
  } catch (error) {
    logger.error({ err: error, promptPath: PROMPT_PATH }, 'Error loading AI prompt file.');
    aiPromptContent = '';
  }
}

async function ensureStreamGroupExists(streamKey, groupName) {
    try {
        // Attempt to create the group. If it exists, Redis returns an error that ioredis might throw.
        // The 'MKSTREAM' option creates the stream if it doesn't exist.
        await redisClient.xgroupCreate(streamKey, groupName, '$', true); // true for MKSTREAM
    } catch (err) {
        if (err && err.message.includes('BUSYGROUP')) {
            logger.warn({ streamKey, groupName }, 'Redis Stream consumer group already exists.');
        } else {
            logger.error({ err, streamKey, groupName }, 'Failed to create or verify Redis Stream consumer group.');
            throw err; // Rethrow if it's not a BUSYGROUP error
        }
    }
}


async function checkForApiResponses(sessionId, sessionData, currentText) {
  let combinedText = currentText;
  const pendingResponses = sessionData.pendingApiResponses || {};
  let newParametersFromApi = {};

  for (const correlationId in pendingResponses) {
    const pendingInfo = pendingResponses[correlationId];
    if (!pendingInfo || !pendingInfo.responseStreamKey) continue;

    logger.debug({ sessionId, correlationId, streamKey: pendingInfo.responseStreamKey }, 'Checking for API response in stream.');

    // Ensure consumer group exists for this stream (idempotent)
    await ensureStreamGroupExists(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME);

    try {
      // Try to read a new message for this consumer. '>' means only new messages.
      // BLOCK for a short time, e.g., 100ms, not to halt the entire user interaction for too long if no message.
      // The main "waiting" happens if the input request explicitly says waitForCorrelationId.
      const blockTimeoutMs = parseInt(process.env.REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM, 10) || 100;
      const streamResult = await redisClient.xreadgroup(
        CONSUMER_GROUP_NAME,
        `${CONSUMER_NAME_PREFIX}:${sessionId}`, // Unique consumer name per session
        [pendingInfo.responseStreamKey, '>'], // '>' means new messages for this consumer group
        blockTimeoutMs, // Short block, or 0 for non-blocking
        1 // Read one message
      );

      if (streamResult && streamResult.length > 0) {
        const streamName = streamResult[0][0]; // e.g., 'api_responses_stream:sessionId:correlationId'
        const messages = streamResult[0][1];   // Array of messages [[messageId, [field, value, ...]]]

        if (messages.length > 0) {
          const messageId = messages[0][0];
          const messageFields = messages[0][1]; // Array of [field, value, field, value,...]
          let apiResponse = { correlationId: 'unknown' }; // Default
          for (let i = 0; i < messageFields.length; i += 2) {
            try {
              // Assuming all values in stream are JSON strings
              apiResponse[messageFields[i]] = JSON.parse(messageFields[i+1]);
            } catch (e) {
              apiResponse[messageFields[i]] = messageFields[i+1]; // Fallback if not JSON string
            }
          }

          logger.info({ sessionId, correlationId: apiResponse.correlationId, stream: streamName, messageId, apiResponseStatus: apiResponse.status }, 'Retrieved API response from stream.');

          const contextMarker = apiResponse.apiId || pendingInfo.apiId || 'UNKNOWN_API';
          if (apiResponse.status === 'success') {
            combinedText += `\n\n[API Response Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify(apiResponse.data)}]`;
            // Optionally merge apiResponse.data into parameters if needed immediately by FSM or template
            // For now, we primarily make it available to the AI via combinedText.
            // And store it for potential direct use by FSM templates
            newParametersFromApi[`api_${contextMarker}_data`] = apiResponse.data;

          } else {
            combinedText += `\n\n[API Error Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify({ httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout })}]`;
            newParametersFromApi[`api_${contextMarker}_error`] = { httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout };
          }

          // Acknowledge the message
          await redisClient.xack(streamName, CONSUMER_GROUP_NAME, messageId);
          logger.debug({ sessionId, streamName, messageId }, 'Acknowledged API response message from stream.');

          delete sessionData.pendingApiResponses[correlationId]; // Remove from pending
        }
      }
    } catch (err) {
      logger.error({ err, sessionId, correlationId, streamKey: pendingInfo.responseStreamKey }, 'Error reading from Redis Stream or processing message.');
    }
  }
  return { combinedText, updatedSessionData: sessionData, newParametersFromApi };
}


async function handleInputWithAI(sessionId, clientInput, source) {
  // clientInput could be simple text, or JSON like { userInput: "text", waitForCorrelationId: "cid" }
  let userInputText = clientInput;
  let waitForCorrelationId = null;

  if (typeof clientInput === 'object' && clientInput !== null) {
    userInputText = clientInput.userInput || '';
    waitForCorrelationId = clientInput.waitForCorrelationId || null;
  } else if (typeof clientInput !== 'string') {
    userInputText = String(clientInput); // Ensure it's a string
  }

  logger.info({ sessionId, userInputLength: userInputText?.length, waitForCorrelationId, source }, 'Handling input with AI');

  redisClient.set(`input_text:${sessionId}:${Date.now()}`, JSON.stringify({ userInputText, waitForCorrelationId, source }), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log input_text to Redis'));

  let sessionData = await fsm.initializeOrRestoreSession(sessionId);
  let currentParameters = { ...sessionData.parameters }; // Start with parameters from session

  let fullTextInputForAI = userInputText;

  // If explicitly waiting for a correlationId, block and read
  if (waitForCorrelationId && sessionData.pendingApiResponses && sessionData.pendingApiResponses[waitForCorrelationId]) {
    const pendingInfo = sessionData.pendingApiResponses[waitForCorrelationId];
    logger.info({sessionId, correlationId: waitForCorrelationId, streamKey: pendingInfo.responseStreamKey}, `Explicitly waiting for API response on stream.`);
    await ensureStreamGroupExists(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME);
    try {
      const blockTimeoutMs = parseInt(process.env.REDIS_STREAM_XREAD_BLOCK_WAIT_MS, 10) || 5000; // Configurable wait
      const streamResult = await redisClient.xreadgroup(
        CONSUMER_GROUP_NAME,
        `${CONSUMER_NAME_PREFIX}:${sessionId}`,
        [pendingInfo.responseStreamKey, '>'],
        blockTimeoutMs, 1
      );

      if (streamResult && streamResult.length > 0 && streamResult[0][1].length > 0) {
        const messageId = streamResult[0][1][0][0];
        const messageFields = streamResult[0][1][0][1];
        let apiResponse = { correlationId: 'unknown' };
        for (let i = 0; i < messageFields.length; i += 2) {
            try { apiResponse[messageFields[i]] = JSON.parse(messageFields[i+1]); }
            catch (e) { apiResponse[messageFields[i]] = messageFields[i+1]; }
        }
        logger.info({ sessionId, correlationId: apiResponse.correlationId, apiResponseStatus: apiResponse.status }, 'Retrieved explicitly awaited API response.');
        const contextMarker = apiResponse.apiId || pendingInfo.apiId || 'UNKNOWN_API';
        if (apiResponse.status === 'success') {
            fullTextInputForAI += `\n\n[API Response Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify(apiResponse.data)}]`;
            currentParameters[`api_${contextMarker}_data`] = apiResponse.data;
        } else {
            fullTextInputForAI += `\n\n[API Error Context for '${contextMarker}' (ID: ${apiResponse.correlationId}): ${JSON.stringify({ httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout })}]`;
            currentParameters[`api_${contextMarker}_error`] = { httpCode: apiResponse.httpCode, message: apiResponse.errorMessage, isTimeout: apiResponse.isTimeout };
        }
        await redisClient.xack(pendingInfo.responseStreamKey, CONSUMER_GROUP_NAME, messageId);
        delete sessionData.pendingApiResponses[waitForCorrelationId];
      } else {
        logger.warn({sessionId, correlationId: waitForCorrelationId}, "Timed out waiting for explicit API response.");
        // Could add specific error context for AI about the timeout
        fullTextInputForAI += `\n\n[API Timeout Context: No response received for expected API call (ID: ${waitForCorrelationId}) within timeout.]`;
        currentParameters[`api_wait_timeout_for_${pendingInfo.apiId || waitForCorrelationId}`] = true;
        // FSM might need to handle this timeout (e.g. transition to an error state or retry)
        // For now, we remove it from pending so we don't wait again unless FSM re-triggers
        delete sessionData.pendingApiResponses[waitForCorrelationId];
      }
    } catch (err) {
      logger.error({ err, sessionId, correlationId: waitForCorrelationId }, 'Error during explicit wait for API response from Redis Stream.');
       delete sessionData.pendingApiResponses[waitForCorrelationId]; // Also remove if error
    }
  } else {
    // If not explicitly waiting, check for any other pending responses non-blockingly / short-block
    const { combinedText, updatedSessionData, newParametersFromApi } = await checkForApiResponses(sessionId, sessionData, fullTextInputForAI);
    fullTextInputForAI = combinedText;
    sessionData = updatedSessionData;
    currentParameters = {...currentParameters, ...newParametersFromApi};
  }

  sessionData.parameters = currentParameters; // Persist any new params from API data
  // Save session early here as pendingApiResponses might have changed
  fsm.saveSessionAsync(`${fsm.FSM_SESSION_PREFIX}${sessionId}`, sessionData, parseInt(process.env.REDIS_SESSION_TTL, 10));


  if (!aiPromptContent) {
    logger.error({ sessionId, source }, 'AI prompt is not loaded. Cannot process AI response.');
    // ... (fallback logic as before, using fullTextInputForAI)
    const fallbackFsmInput = { intent: 'ai_prompt_missing_error', parameters: { raw_text: fullTextInputForAI } };
    redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters); // Pass currentParameters
  }

  let aiJsonResponse;
  try {
    redisClient.set(`ai_actual_input:${sessionId}:${Date.now()}`, JSON.stringify({ textForAI: fullTextInputForAI }), 'EX', 3600)
      .catch(err => logger.error({ err, sessionId }, 'Failed to log actual_input_for_ai to Redis'));

    aiJsonResponse = await aiService.getAIResponse(fullTextInputForAI, aiPromptContent);
  } catch (aiError) {
    logger.error({ err: aiError, sessionId, source }, 'AI service failed to get response.');
    const fallbackFsmInput = { intent: 'ai_processing_error', parameters: { error: aiError.message, original_text: fullTextInputForAI } };
     redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(AI Error Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, {...currentParameters, ...fallbackFsmInput.parameters});
  }

  const schemaValidationResult = jsonValidator.validateJson(aiJsonResponse);
  if (!schemaValidationResult.isValid) {
    logger.warn({ sessionId, errors: schemaValidationResult.errors, aiResponse: aiJsonResponse, source }, 'AI response failed JSON schema validation.');
    const fallbackFsmInput = { intent: 'ai_schema_validation_error', parameters: { errors: schemaValidationResult.errors, original_response: aiJsonResponse } };
    redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Schema Error Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, {...currentParameters, ...fallbackFsmInput.parameters});
  }

  let finalAiResponse = aiJsonResponse;
  if (typeof customAIResponseValidator === 'function') {
    const customValidationResult = customAIResponseValidator(aiJsonResponse);
    if (!customValidationResult.isValid) {
      logger.warn({ sessionId, message: customValidationResult.message, aiResponse: aiJsonResponse, source }, 'AI response failed custom validation.');
      const fallbackFsmInput = { intent: 'ai_custom_validation_error', parameters: { error_message: customValidationResult.message, original_response: aiJsonResponse } };
      redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Custom Val Error Fallback) FSM Input log failed'));
      return fsm.processInput(sessionId, fallbackFsmInput.intent, {...currentParameters, ...fallbackFsmInput.parameters});
    }
    if (customValidationResult.validatedResponse) {
      finalAiResponse = customValidationResult.validatedResponse;
      logger.info({sessionId, source}, "AI response was modified by custom validator.");
    }
  }

  logger.info({ sessionId, intent: finalAiResponse.intent, /* parameters: finalAiResponse.parameters,*/ source }, 'AI response validated, proceeding to FSM.');

  // Merge AI parameters with existing currentParameters (which includes API responses)
  // AI parameters should generally take precedence for things it directly extracted from user's latest utterance.
  const fsmInputParameters = {...currentParameters, ...finalAiResponse.parameters};

  redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify({intent: finalAiResponse.intent, parameters: fsmInputParameters}), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log fsm_input to Redis'));

  const fsmResult = await fsm.processInput(sessionId, finalAiResponse.intent, fsmInputParameters);
  // fsm.processInput will save the updated sessionData (which includes its own currentParameters and pendingApiResponses)

  redisClient.set(`fsm_output:${sessionId}:${Date.now()}`, JSON.stringify(fsmResult), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log fsm_output to Redis'));

  return fsmResult;
}

async function main() {
  logger.info(`Valor de process.env.ENABLE_API: ${process.env.ENABLE_API}`);
  // ... (rest of main remains similar, ensuring redisClient.connect() is awaited)
  try {
    logger.info('Inicializando aplicación FSM...');
    loadStateConfig();
    jsonValidator.loadSchema();
    loadAIPrompt();

    await redisClient.connect(); // Ensure main client is connected
    await redisClient.getSubscriberClient(); // Ensure subscriber client is connected
    logger.info('Conexión con Redis (main y subscriber) establecida.');

    // ... (rest of server startups)
    const enableApi = process.env.ENABLE_API !== 'false';
    if (enableApi) {
      startApiServer(handleInputWithAI);
    } else {
      logger.info('Módulo API está deshabilitado por configuración (ENABLE_API=false).');
    }

    const enableAri = process.env.ENABLE_ARI !== 'false';
    if (enableAri) {
      logger.info('Intentando conectar a Asterisk ARI...');
      await connectAri(handleInputWithAI);
      // ariConnected = true; // This variable is not used elsewhere in main after this block
      logger.info('Módulo ARI iniciado (o intentando conectar).');
    } else {
      logger.info('Módulo ARI está deshabilitado por configuración (ENABLE_ARI=false).');
    }

    const enableSocketServer = process.env.ENABLE_SOCKET_SERVER !== 'false';
    const fsmSocketPath = process.env.FSM_SOCKET_PATH;
    if (enableSocketServer) {
      if (fsmSocketPath) {
        startSocketServer(fsmSocketPath, handleInputWithAI);
        // socketServerStarted = true; // This variable is not used elsewhere in main after this block
      } else {
        logger.warn('ADVERTENCIA: ENABLE_SOCKET_SERVER está en true, pero FSM_SOCKET_PATH no está definido. El servidor de sockets no se iniciará.');
      }
    } else {
      logger.info('Módulo Socket Server está deshabilitado por configuración (ENABLE_SOCKET_SERVER=false).');
    }

    if (enableApi || process.env.ENABLE_ARI !== 'false' || (enableSocketServer && fsmSocketPath) ) {
      logger.info('Aplicación FSM iniciada y lista (al menos un módulo de interfaz está activo).');
    } else {
      logger.warn('ADVERTENCIA: Todos los módulos de interfaz (API, ARI, Socket) están deshabilitados. La aplicación no podrá recibir solicitudes.');
    }

  } catch (error) {
    logger.fatal({ err: error }, 'Error fatal durante la inicialización de la aplicación');
    // ariConnected and socketServerStarted are not reliable here if error happened before they were set.
    // Shutdown logic will attempt to close what it can based on env vars.
    await shutdown('fatal_initialization_error'); // Attempt graceful shutdown
    process.exit(1); // Still exit, but after attempting cleanup
  }
}

async function shutdown(signal) {
  logger.info({signal}, `\nRecibida señal ${signal}. Cerrando la aplicación FSM...`);

  // No need to check ariConnected/socketServerStarted, just rely on env flags and let modules handle null clients
  if (process.env.ENABLE_ARI !== 'false') {
      await closeAri().catch(err => logger.error({ err }, 'Error al cerrar ARI'));
  }
  if (process.env.ENABLE_SOCKET_SERVER !== 'false' && process.env.FSM_SOCKET_PATH) {
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => logger.error({ err }, 'Error al cerrar Socket Server'));
  }
  await redisClient.quit().catch(err => logger.error({ err }, 'Error al cerrar Redis'));

  logger.info('Aplicación FSM cerrada.');
  if (signal !== 'fatal_initialization_error') { // Avoid double exit if called from fatal error handler
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error, origin) => {
  logger.fatal({ err: error, origin }, 'Excepción no capturada');
  // Attempt graceful shutdown before exiting, but this might be risky if state is very corrupt
  shutdown('uncaughtException').finally(() => {
    process.exit(1);
  });
});
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Rechazo de promesa no manejado');
  shutdown('unhandledRejection').finally(() => {
    process.exit(1);
  });
});

main();
