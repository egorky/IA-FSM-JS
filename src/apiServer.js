const express = require('express');
const { loadStateConfig } = require('./configLoader');
const logger = require('./logger'); // Use pino logger
const redisClient = require('./redisClient'); // For logging FSM output if not done elsewhere

const app = express();
// Middleware para parsear JSON en las solicitudes
// Aumentar el límite de tamaño del payload si es necesario, por ejemplo a 10mb
app.use(express.json({ limit: process.env.API_JSON_PAYLOAD_LIMIT || '1mb' }));
// Middleware para parsear texto plano, que será la entrada para la IA
app.use(express.text({ limit: process.env.API_TEXT_PAYLOAD_LIMIT || '1mb', type: ['text/plain', 'application/octet-stream'] }));


const PORT = process.env.PORT || 3000;
let aiInputHandler; // Placeholder for the AI input handler function from index.js

// Endpoint para procesar la lógica de la FSM vía AI
// Ahora espera texto plano en el cuerpo de la solicitud
app.post('/fsm/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  let textInput;

  if (req.headers['content-type'] && req.headers['content-type'].startsWith('text/plain')) {
    textInput = req.body;
  } else if (typeof req.body === 'string') { // Fallback if content-type is not set but body is string
    textInput = req.body;
  } else if (req.body && req.body.text_input) { // If JSON is sent with a 'text_input' field
    textInput = req.body.text_input;
    logger.warn({ sessionId }, "Received JSON with text_input field, expected text/plain. Processing text_input.");
  } else {
    logger.warn({ sessionId, contentType: req.headers['content-type'], bodyType: typeof req.body },
      'Request body is not text/plain or a string. Attempting to stringify or use fallback.');
    try {
        textInput = JSON.stringify(req.body); // Last resort, try to stringify if it's an object
    } catch (e) {
        return res.status(400).json({ error: 'Invalid request body. Expected text/plain or JSON with text_input field.' });
    }
  }

  if (!sessionId) {
    logger.warn('API call missing sessionId in URL.');
    return res.status(400).json({ error: 'sessionId is requerido en la URL.' });
  }
  if (typeof textInput !== 'string' || textInput.trim() === '') {
    logger.warn({ sessionId }, 'API call with empty or non-string textInput.');
    return res.status(400).json({ error: 'textInput (raw text) is requerido en el body.' });
  }


  logger.info({ sessionId, inputLength: textInput.length, contentType: req.headers['content-type'] }, `API Request: POST /fsm/${sessionId}`);

  // Log raw input text to Redis (handled by handleInputWithAI, but good to be aware)
  // await redisClient.set(`api_raw_input:${sessionId}:${Date.now()}`, JSON.stringify({textInput}), 'EX', 3600)
  //   .catch(err => logger.error({err}, "Failed to log API raw input to Redis"));

  if (!aiInputHandler) {
    logger.error('aiInputHandler not initialized in apiServer. This is a critical setup error.');
    return res.status(500).json({ error: 'Internal server error: AI handler not configured.' });
  }

  try {
    // Delegate to the central AI input handler from index.js
    const result = await aiInputHandler(sessionId, textInput, 'api');

    // The structure of 'result' is the FSM's output
    const responseObject = {
      sessionId: sessionId,
      currentStateId: result.sessionData.currentStateId, // Corrected path
      nextStateId: result.nextStateId,
      parametersToCollect: result.parametersToCollect,
      payloadResponse: result.payloadResponse,
      collectedParameters: result.sessionData.parameters, // Corrected path
    };

    // Log FSM output to Redis (this might be redundant if handleInputWithAI already does it comprehensively)
    // For API, this is the final response being sent out.
    redisClient.set(`api_fsm_output:${sessionId}:${Date.now()}`, JSON.stringify(responseObject), 'EX', 3600)
        .catch(err => logger.error({ err, sessionId }, 'Failed to log API FSM output to Redis'));

    res.json(responseObject);

  } catch (error) {
    logger.error({ err: error, sessionId }, `Error procesando FSM para session ${sessionId} via API`);
    // Basic error mapping, can be expanded
    if (error.message.includes('Configuración no encontrada') || error.message.includes('no existe en la definición de \'states\'')) {
        return res.status(404).json({ error: 'Estado no encontrado o error de configuración.', details: error.message });
    }
    if (error.message.includes('Redis no está conectado')) { // This check might be too generic now
        return res.status(503).json({ error: 'Servicio no disponible temporalmente.', details: error.message });
    }
    if (error.message.includes('AI_PROVIDER')) { // Errors from aiService related to provider
        return res.status(503).json({ error: 'AI service provider error.', details: error.message });
    }
    res.status(500).json({ error: 'Error interno del servidor al procesar la solicitud.', details: error.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Modified startApiServer to accept the AI handler
function startApiServer(handler) {
  if (typeof handler !== 'function') {
    logger.fatal('CRITICAL: startApiServer called without a valid AI input handler.');
    process.exit(1); // Exit if handler is not provided, as it's essential.
  }
  aiInputHandler = handler;

  try {
    loadStateConfig(); // Cargar y validar la configuración de estados al inicio
    app.listen(PORT, () => {
      logger.info(`Servidor API de FSM escuchando en el puerto ${PORT}`);
    });
  } catch (error) {
    logger.fatal({ err: error }, 'No se pudo iniciar el servidor API');
    process.exit(1);
  }
}

module.exports = { startApiServer, app };
