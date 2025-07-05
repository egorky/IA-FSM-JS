require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { startApiServer } = require('./apiServer');
const { startSocketServer, stopSocketServer } = require('./socketServer');
const redisClient = require('./redisClient');
const { connectAri, closeAri } = require('./ariClient');
const fsm = require('./fsm'); // Contains FSM_SESSION_PREFIX, initializeOrRestoreSession, processInput, saveSessionAsync
const { loadStateConfig, getStateById } = require('./configLoader');
const { processTemplate } = require('./templateProcessor'); // Added templateProcessor
const aiService = require('./aiService');
const jsonValidator = require('./jsonValidator');
const { validateAIResponse: customAIResponseValidator } = require('../config/customAIResponseValidator');

const PROMPT_PATH = path.join(__dirname, '../config/aiPrompt.txt');
let aiPromptContent = '';
const CONSUMER_GROUP_NAME = process.env.REDIS_STREAM_CONSUMER_GROUP || 'fsm_ai_group';
const CONSUMER_NAME_PREFIX = process.env.REDIS_STREAM_CONSUMER_NAME_PREFIX || `fsm_consumer_${uuidv4()}`;

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

// This function processes ONE specific pending API response from a stream if specified by waitForCorrelationId
async function processSingleAwaitedApiResponse(sessionId, sessionData, waitForCorrelationId, currentParameters, fullTextInputForAI) {
    const pendingInfo = sessionData.pendingApiResponses[waitForCorrelationId];
    logger.info({sessionId, correlationId: waitForCorrelationId, streamKey: pendingInfo.responseStreamKey}, `Explicitly waiting for API response on stream.`);
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
  let currentParameters = { ...sessionData.parameters }; // Parameters before this turn's FSM processing
  let fullTextInputForAI = userInputText;

  // Get customInstructions from the current state for the AI prompt
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

  // Prepend custom instructions to the AI input if they exist
  if (renderedCustomInstructions) {
    fullTextInputForAI = `State Instructions: "${renderedCustomInstructions}"\n\nUser Input: "${fullTextInputForAI}"`;
  }


  // Process explicitly awaited API response first
  if (waitForCorrelationId && sessionData.pendingApiResponses && sessionData.pendingApiResponses[waitForCorrelationId]) {
    const { textUpdate, newParameters } = await processSingleAwaitedApiResponse(sessionId, sessionData, waitForCorrelationId, currentParameters, fullTextInputForAI);
    fullTextInputForAI += textUpdate;
    currentParameters = { ...currentParameters, ...newParameters };
    // sessionData.pendingApiResponses was modified in processSingleAwaitedApiResponse
  }

  // Process any other non-awaited pending responses
  const { textUpdate: otherTextUpdates, newParameters: otherNewParams } = await checkNonAwaitedApiResponses(sessionId, sessionData, currentParameters);
  fullTextInputForAI += otherTextUpdates;
  currentParameters = { ...currentParameters, ...otherNewParams };

  sessionData.parameters = currentParameters; // Update session with params from API responses
  // Save session if pendingApiResponses changed or new API params were added
  if (Object.keys(sessionData.pendingApiResponses).length < Object.keys(clientInput.pendingApiResponses || {}).length || Object.keys(otherNewParams).length > 0) {
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
  const fsmResult = await fsm.processInput(sessionId, aiIntent, aiParameters, initialCall);
  // fsm.processInput now handles saving the final sessionData itself.

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
