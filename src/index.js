require('dotenv').config();

const fs = require('fs');
const path = require('path');
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
const API_RESPONSE_KEY_PREFIX = 'api_response:'; // Must match simulateApiResponder.js
let aiPromptContent = '';

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

async function checkForAndCombineApiResponse(sessionId, currentText) {
  let combinedText = currentText;
  // Simplified check: Iterate through possible correlation IDs or a more direct lookup if FSM provides context
  // For now, we'll use SCAN to find any response for the session.
  // This is NOT efficient for production but okay for simulation.
  // A better way: FSM indicates it's waiting for a specific correlationId.
  let cursor = '0';
  let apiResponseData = null;
  let foundKey = null;

  try {
    do {
      const scanResult = await redisClient.getClient().scan(cursor, 'MATCH', `${API_RESPONSE_KEY_PREFIX}${sessionId}:*`, 'COUNT', '10');
      cursor = scanResult[0];
      const keys = scanResult[1];

      if (keys.length > 0) {
        // Take the first one found for this simple simulation
        foundKey = keys[0];
        const responseJson = await redisClient.get(foundKey);
        if (responseJson) {
          apiResponseData = JSON.parse(responseJson);
          logger.info({ sessionId, correlationKey: foundKey, apiResponseData }, 'Found and retrieved API response from Redis.');
          await redisClient.del(foundKey); // Delete after processing
          logger.info({ sessionId, correlationKey: foundKey }, 'Processed API response deleted from Redis.');
        }
        break;
      }
    } while (cursor !== '0');

    if (apiResponseData) {
      combinedText = `${currentText}\n\n[API Response Context: ${JSON.stringify(apiResponseData)}]`;
      logger.info({ sessionId }, 'Combined user text with API response context.');
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'Error checking for or combining API response from Redis.');
  }
  return combinedText;
}


async function handleInputWithAI(sessionId, textInput, source) {
  logger.info({ sessionId, textInputLength: textInput?.length, source }, 'Handling input with AI');

  // Log raw user input
  redisClient.set(`input_text:${sessionId}:${Date.now()}`, JSON.stringify({ textInput, source }), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log input_text to Redis'));

  // Check for and combine any pending API responses
  const fullTextInputForAI = await checkForAndCombineApiResponse(sessionId, textInput);

  if (!aiPromptContent) {
    logger.error({ sessionId, source }, 'AI prompt is not loaded. Cannot process AI response.');
    try {
        const parsedInput = JSON.parse(fullTextInputForAI); // Try parsing combined input
        if (parsedInput.intent && parsedInput.parameters) {
            logger.warn({sessionId, source }, "AI prompt missing, but input was valid JSON. Proceeding with input as FSM params.");
            redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(parsedInput), 'EX', 3600).catch(err => logger.error({ err }, '(Fallback) FSM Input log failed'));
            return fsm.processInput(sessionId, parsedInput.intent, parsedInput.parameters);
        }
    } catch (e) { /* Not JSON */ }
    logger.warn({sessionId, source}, "AI prompt missing and input not usable. Using default 'general_inquiry'.");
    const fallbackFsmInput = { intent: 'general_inquiry', parameters: { raw_text: fullTextInputForAI } };
    redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Default Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  let aiJsonResponse;
  try {
    // Log the text that will actually be sent to AI (could be combined with API response)
    redisClient.set(`ai_actual_input:${sessionId}:${Date.now()}`, JSON.stringify({ textForAI: fullTextInputForAI }), 'EX', 3600)
      .catch(err => logger.error({ err, sessionId }, 'Failed to log actual_input_for_ai to Redis'));

    aiJsonResponse = await aiService.getAIResponse(fullTextInputForAI, aiPromptContent);
    // aiService logs its direct input/output
  } catch (aiError) {
    logger.error({ err: aiError, sessionId, source }, 'AI service failed to get response.');
    const fallbackFsmInput = { intent: 'ai_processing_error', parameters: { error: aiError.message, original_text: fullTextInputForAI } };
    redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(AI Error Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  const schemaValidationResult = jsonValidator.validateJson(aiJsonResponse);
  if (!schemaValidationResult.isValid) {
    logger.warn({ sessionId, errors: schemaValidationResult.errors, aiResponse: aiJsonResponse, source }, 'AI response failed JSON schema validation.');
    const fallbackFsmInput = { intent: 'ai_schema_validation_error', parameters: { errors: schemaValidationResult.errors, original_response: aiJsonResponse } };
    redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Schema Error Fallback) FSM Input log failed'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  let finalAiResponse = aiJsonResponse;
  if (typeof customAIResponseValidator === 'function') {
    const customValidationResult = customAIResponseValidator(aiJsonResponse);
    if (!customValidationResult.isValid) {
      logger.warn({ sessionId, message: customValidationResult.message, aiResponse: aiJsonResponse, source }, 'AI response failed custom validation.');
      const fallbackFsmInput = { intent: 'ai_custom_validation_error', parameters: { error_message: customValidationResult.message, original_response: aiJsonResponse } };
      redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600).catch(err => logger.error({ err }, '(Custom Val Error Fallback) FSM Input log failed'));
      return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
    }
    if (customValidationResult.validatedResponse) {
      finalAiResponse = customValidationResult.validatedResponse;
      logger.info({sessionId, source}, "AI response was modified by custom validator.");
    }
  }

  logger.info({ sessionId, intent: finalAiResponse.intent, parameters: finalAiResponse.parameters, source }, 'AI response validated, proceeding to FSM.');

  redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(finalAiResponse), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log fsm_input to Redis'));

  const fsmResult = await fsm.processInput(sessionId, finalAiResponse.intent, finalAiResponse.parameters);

  redisClient.set(`fsm_output:${sessionId}:${Date.now()}`, JSON.stringify(fsmResult), 'EX', 3600)
    .catch(err => logger.error({ err, sessionId }, 'Failed to log fsm_output to Redis'));

  return fsmResult;
}

async function main() {
  logger.info(`Valor de process.env.ENABLE_API: ${process.env.ENABLE_API}`);
  logger.info(`Valor de process.env.ENABLE_ARI: ${process.env.ENABLE_ARI}`);
  logger.info(`Valor de process.env.ENABLE_SOCKET_SERVER: ${process.env.ENABLE_SOCKET_SERVER}`);
  logger.info(`Valor de process.env.FSM_SOCKET_PATH: ${process.env.FSM_SOCKET_PATH}`);
  logger.info(`Valor de process.env.AI_PROVIDER: ${process.env.AI_PROVIDER}`);

  let ariConnected = false;
  let socketServerStarted = false;

  try {
    logger.info('Inicializando aplicación FSM...');
    loadStateConfig();
    jsonValidator.loadSchema();
    loadAIPrompt();

    await redisClient.connect();
    logger.info('Conexión con Redis establecida.');

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
      ariConnected = true;
      logger.info('Módulo ARI iniciado (o intentando conectar).');
    } else {
      logger.info('Módulo ARI está deshabilitado por configuración (ENABLE_ARI=false).');
    }

    const enableSocketServer = process.env.ENABLE_SOCKET_SERVER !== 'false';
    const fsmSocketPath = process.env.FSM_SOCKET_PATH;
    if (enableSocketServer) {
      if (fsmSocketPath) {
        startSocketServer(fsmSocketPath, handleInputWithAI);
        socketServerStarted = true;
      } else {
        logger.warn('ADVERTENCIA: ENABLE_SOCKET_SERVER está en true, pero FSM_SOCKET_PATH no está definido. El servidor de sockets no se iniciará.');
      }
    } else {
      logger.info('Módulo Socket Server está deshabilitado por configuración (ENABLE_SOCKET_SERVER=false).');
    }

    if (enableApi || enableAri || socketServerStarted) {
      logger.info('Aplicación FSM iniciada y lista (al menos un módulo de interfaz está activo).');
    } else {
      logger.warn('ADVERTENCIA: Todos los módulos de interfaz (API, ARI, Socket) están deshabilitados. La aplicación no podrá recibir solicitudes.');
    }

  } catch (error) {
    logger.fatal({ err: error }, 'Error fatal durante la inicialización de la aplicación');
    if (ariConnected && process.env.ENABLE_ARI !== 'false') {
      await closeAri().catch(err => logger.error({ err }, 'Error al cerrar ARI durante el apagado por error'));
    }
    if (socketServerStarted && process.env.ENABLE_SOCKET_SERVER !== 'false') {
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => logger.error({ err }, 'Error al cerrar Socket Server durante el apagado por error'));
    }
    await redisClient.quit().catch(err => logger.error({ err }, 'Error al cerrar Redis durante el apagado por error'));
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(`\nRecibida señal ${signal}. Cerrando la aplicación FSM...`);

  if (process.env.ENABLE_ARI !== 'false') {
      await closeAri().catch(err => logger.error({ err }, 'Error al cerrar ARI'));
  }
  if (process.env.ENABLE_SOCKET_SERVER !== 'false' && process.env.FSM_SOCKET_PATH) {
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => logger.error({ err }, 'Error al cerrar Socket Server'));
  }
  await redisClient.quit().catch(err => logger.error({ err }, 'Error al cerrar Redis'));

  logger.info('Aplicación FSM cerrada.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Excepción no capturada');
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Rechazo de promesa no manejado');
  process.exit(1);
});

main();
