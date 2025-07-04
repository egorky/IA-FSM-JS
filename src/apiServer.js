const express = require('express');
const fsm = require('./fsm');
const { loadStateConfig } = require('./configLoader');

const app = express();
app.use(express.json()); // Middleware para parsear JSON en las solicitudes

const PORT = process.env.PORT || 3000;

// Endpoint para procesar la lógica de la FSM
app.post('/fsm/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  // Loguear el req.body crudo y el content-type inmediatamente
  console.log("API SERVER RAW req.body:", req.body);
  console.log("API SERVER req.headers['content-type']:", req.headers['content-type']);

  const { intent, parameters } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId es requerido en la URL.' });
  }

  console.log(`API Request: POST /fsm/${sessionId}`);
  // Clonar req.body para logging diferido seguro
  const requestBodyForLog = { ...req.body };
  process.nextTick(() => {
    console.log("API Request Body (async log):\n", JSON.stringify(requestBodyForLog, null, 2));
  });

  try {
    const result = await fsm.processInput(sessionId, intent, parameters);

    const responseObject = {
      sessionId: sessionId,
      currentStateId: result.sessionData.currentStateId,
      nextStateId: result.nextStateId,
      parametersToCollect: result.parametersToCollect,
      payloadResponse: result.payloadResponse,
      collectedParameters: result.sessionData.parameters,
    };

    // Enviar respuesta inmediatamente
    res.json(responseObject);

    // Loguear la respuesta de forma diferida
    process.nextTick(() => {
      console.log("API Response Body (async log):\n", JSON.stringify(responseObject, null, 2));
    });

    // console.log("API SERVER DEBUG: result.sessionData.parameters from FSM (inside apiServer.js):\n", JSON.stringify(result.sessionData.parameters, null, 2)); // Eliminado
    // console.log("API SERVER DEBUG: result.parametersToCollect from FSM (inside apiServer.js):\n", JSON.stringify(result.parametersToCollect, null, 2)); // Eliminado

  } catch (error) {
    console.error(`Error procesando FSM para session ${sessionId}:`, error);
    if (error.message.includes('Configuración no encontrada') || error.message.includes('no existe en la definición de \'states\'')) {
        return res.status(404).json({ error: 'Estado no encontrado o error de configuración.', details: error.message });
    }
    if (error.message.includes('Redis no está conectado')) {
        return res.status(503).json({ error: 'Servicio no disponible temporalmente (Redis).', details: error.message });
    }
    res.status(500).json({ error: 'Error interno del servidor al procesar la solicitud.', details: error.message });
  }
});

// Endpoint de health check (opcional pero útil)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

function startApiServer() {
  try {
    loadStateConfig(); // Cargar y validar la configuración de estados al inicio
    app.listen(PORT, () => {
      console.log(`Servidor API de FSM escuchando en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar el servidor API:', error);
    process.exit(1); // Terminar la aplicación si la configuración de estados falla
  }
}

module.exports = { startApiServer, app }; // Exportar 'app' puede ser útil para tests
