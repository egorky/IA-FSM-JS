require('dotenv').config(); // Cargar variables de entorno desde .env al inicio

require('dotenv').config(); // Cargar variables de entorno desde .env al inicio

const fs = require('fs');
const path = require('path');
const logger = require('./logger'); // Usar pino logger
const { startApiServer } = require('./apiServer');
const { startSocketServer, stopSocketServer } = require('./socketServer');
const redisClient = require('./redisClient');
const { connectAri, closeAri } = require('./ariClient');
const fsm = require('./fsm');
const { loadStateConfig } = require('./configLoader');
const aiService = require('./aiService'); // Import AI Service
const jsonValidator = require('./jsonValidator'); // Import JSON Validator
const { validateAIResponse: customAIResponseValidator } = require('../config/customAIResponseValidator'); // Import custom validator

const PROMPT_PATH = path.join(__dirname, '../config/aiPrompt.txt');
let aiPromptContent = '';

function loadAIPrompt() {
  try {
    if (fs.existsSync(PROMPT_PATH)) {
      aiPromptContent = fs.readFileSync(PROMPT_PATH, 'utf-8');
      logger.info('AI prompt content loaded successfully.');
    } else {
      logger.error(`AI prompt file not found at ${PROMPT_PATH}. AI processing will likely fail.`);
      aiPromptContent = ''; // Ensure it's empty if not found
    }
  } catch (error) {
    logger.error({ err: error, promptPath: PROMPT_PATH }, 'Error loading AI prompt file.');
    aiPromptContent = '';
  }
}

async function handleInputWithAI(sessionId, textInput, source) {
  logger.info({ sessionId, textInputLength: textInput?.length, source }, 'Handling input with AI');
  await redisClient.set(`input_text:${sessionId}:${Date.now()}`, JSON.stringify({ textInput, source }), 'EX', 3600)
    .catch(err => logger.error({ err }, 'Failed to log input_text to Redis'));

  if (!aiPromptContent) {
    logger.error({ sessionId, source }, 'AI prompt is not loaded. Cannot process AI response.');
    // Fallback: Try to pass input directly to FSM if it looks like JSON, or use a default
    try {
        const parsedInput = JSON.parse(textInput);
        if (parsedInput.intent && parsedInput.parameters) {
            logger.warn({sessionId, source }, "AI prompt missing, but input was valid JSON. Proceeding with input as FSM params.");
            await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(parsedInput), 'EX', 3600)
              .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis (fallback)'));
            return fsm.processInput(sessionId, parsedInput.intent, parsedInput.parameters);
        }
    } catch (e) {
        // Not JSON, or not the right structure
    }
    // Default fallback: use a generic intent or error state
    logger.warn({sessionId, source}, "AI prompt missing and input not usable. Using default 'general_inquiry'.");
    const fallbackFsmInput = { intent: 'general_inquiry', parameters: { raw_text: textInput } };
    await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600)
        .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis (default fallback)'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  let aiJsonResponse;
  try {
    aiJsonResponse = await aiService.getAIResponse(textInput, aiPromptContent);
    // aiService already logs its input/output to Redis
  } catch (aiError) {
    logger.error({ err: aiError, sessionId, textInput, source }, 'AI service failed to get response.');
    // Fallback to a generic intent if AI fails
    const fallbackFsmInput = { intent: 'ai_processing_error', parameters: { error: aiError.message, original_text: textInput } };
    await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600)
        .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis (AI error fallback)'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  // Schema Validation
  const schemaValidationResult = jsonValidator.validateJson(aiJsonResponse);
  if (!schemaValidationResult.isValid) {
    logger.warn({ sessionId, errors: schemaValidationResult.errors, aiResponse: aiJsonResponse, source }, 'AI response failed JSON schema validation.');
    // Fallback or error handling for schema validation failure
    const fallbackFsmInput = { intent: 'ai_schema_validation_error', parameters: { errors: schemaValidationResult.errors, original_response: aiJsonResponse } };
    await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600)
        .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis (schema error fallback)'));
    return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
  }

  // Custom Validation
  let finalAiResponse = aiJsonResponse;
  if (typeof customAIResponseValidator === 'function') {
    const customValidationResult = customAIResponseValidator(aiJsonResponse);
    if (!customValidationResult.isValid) {
      logger.warn({ sessionId, message: customValidationResult.message, aiResponse: aiJsonResponse, source }, 'AI response failed custom validation.');
      // Fallback or error handling for custom validation failure
      const fallbackFsmInput = { intent: 'ai_custom_validation_error', parameters: { error_message: customValidationResult.message, original_response: aiJsonResponse } };
      await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(fallbackFsmInput), 'EX', 3600)
        .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis (custom validation error fallback)'));
      return fsm.processInput(sessionId, fallbackFsmInput.intent, fallbackFsmInput.parameters);
    }
    if (customValidationResult.validatedResponse) {
      finalAiResponse = customValidationResult.validatedResponse;
      logger.info({sessionId, source}, "AI response was modified by custom validator.");
    }
  }

  logger.info({ sessionId, intent: finalAiResponse.intent, parameters: finalAiResponse.parameters, source }, 'AI response validated, proceeding to FSM.');

  await redisClient.set(`fsm_input:${sessionId}:${Date.now()}`, JSON.stringify(finalAiResponse), 'EX', 3600)
    .catch(err => logger.error({ err }, 'Failed to log fsm_input to Redis'));

  const fsmResult = await fsm.processInput(sessionId, finalAiResponse.intent, finalAiResponse.parameters);

  // FSM output is logged by FSM itself or by the calling interface (apiServer, etc.)
  // For consistency, let's ensure it's logged here too if not elsewhere.
  // fsm.processInput now returns sessionData which includes the output.
  // The actual response sent to the client (apiServer, socketServer) will be logged there.
  // Here we log what FSM produced internally.
  await redisClient.set(`fsm_output:${sessionId}:${Date.now()}`, JSON.stringify(fsmResult), 'EX', 3600)
    .catch(err => logger.error({ err }, 'Failed to log fsm_output to Redis'));

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
    loadStateConfig(); // FSM states
    jsonValidator.loadSchema(); // AI Response JSON Schema
    loadAIPrompt(); // AI Prompt

    await redisClient.connect();
    logger.info('Conexión con Redis establecida.');

    const enableApi = process.env.ENABLE_API !== 'false';
    if (enableApi) {
      startApiServer(handleInputWithAI); // Pass the AI handler
    } else {
      logger.info('Módulo API está deshabilitado por configuración (ENABLE_API=false).');
    }

    const enableAri = process.env.ENABLE_ARI !== 'false';
    if (enableAri) {
      logger.info('Intentando conectar a Asterisk ARI...');
      await connectAri(handleInputWithAI); // Pass the AI handler
      ariConnected = true;
      logger.info('Módulo ARI iniciado (o intentando conectar).');
    } else {
      logger.info('Módulo ARI está deshabilitado por configuración (ENABLE_ARI=false).');
    }

    const enableSocketServer = process.env.ENABLE_SOCKET_SERVER !== 'false';
    const fsmSocketPath = process.env.FSM_SOCKET_PATH;
    if (enableSocketServer) {
      if (fsmSocketPath) {
        startSocketServer(fsmSocketPath, handleInputWithAI); // Pass the AI handler
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
