const net = require('net');
const fs = require('fs');
const logger = require('./logger'); // Use pino logger
const redisClient = require('./redisClient'); // For logging FSM output

let server;
let aiInputHandlerSocket; // Placeholder for the AI input handler

/**
 * Inicia el servidor de sockets UNIX.
 * @param {string} socketPath La ruta del archivo de socket UNIX.
 * @param {function} handler Callback para procesar los mensajes (ahora el AI handler).
 */
function startSocketServer(socketPath, handler) {
  if (typeof handler !== 'function') {
    logger.fatal('CRITICAL: startSocketServer called without a valid AI input handler.');
    process.exit(1);
  }
  aiInputHandlerSocket = handler;

  if (!socketPath) {
    logger.error('Socket Server: FSM_SOCKET_PATH no está definido. El servidor de sockets no se iniciará.');
    return;
  }

  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
      logger.info(`Socket Server: Eliminado socket antiguo en ${socketPath}`);
    } catch (err) {
      logger.error({ err, socketPath }, `Socket Server: Error al eliminar socket antiguo ${socketPath}`);
      return;
    }
  }

  server = net.createServer((socket) => {
    logger.info('Socket Server: Cliente conectado.');
    let RsessionId = null; // Para logging en caso de error de parseo o si falta sessionId

    socket.on('data', async (data) => {
      const message = data.toString().trim(); // Trim to remove potential newlines from client
      if (!message) {
        logger.warn('Socket Server: Received empty message.');
        return;
      }

      let requestPayload;
      let sessionIdFromPayload;
      let textInputFromPayload;

      try {
        // Expecting JSON: { "sessionId": "xxx", "textInput": "user says something" }
        requestPayload = JSON.parse(message);
        sessionIdFromPayload = requestPayload.sessionId;
        textInputFromPayload = requestPayload.textInput;
        RsessionId = sessionIdFromPayload; // For logging outside this try block

        logger.debug({ sessionId: RsessionId, request: requestPayload }, 'Socket Server: Datos JSON recibidos');

        if (!sessionIdFromPayload || typeof sessionIdFromPayload !== 'string') {
          throw new Error('sessionId es requerido y debe ser un string en la solicitud del socket.');
        }
        if (!textInputFromPayload || typeof textInputFromPayload !== 'string') {
          throw new Error('textInput es requerido y debe ser un string en la solicitud del socket.');
        }

        // Delegate to the central AI input handler
        const fsmResult = await aiInputHandlerSocket(sessionIdFromPayload, textInputFromPayload, 'socket');

        // Construct the response expected by the client
        const responseObject = {
          sessionId: sessionIdFromPayload,
          currentStateId: fsmResult.sessionData.currentStateId,
          nextStateId: fsmResult.nextStateId,
          parametersToCollect: fsmResult.parametersToCollect,
          payloadResponse: fsmResult.payloadResponse,
          collectedParameters: fsmResult.sessionData.parameters,
        };

        socket.write(JSON.stringify(responseObject) + '\n');

        // Log FSM output for socket to Redis
        redisClient.set(`socket_fsm_output:${sessionIdFromPayload}:${Date.now()}`, JSON.stringify(responseObject), 'EX', 3600)
            .catch(err => logger.error({ err, sessionId: sessionIdFromPayload }, 'Failed to log Socket FSM output to Redis'));


      } catch (error) {
        logger.error({ err: error, sessionId: RsessionId, rawMessage: message.substring(0, 200) },
          `Socket Server: Error procesando mensaje para sessionId ${RsessionId || 'desconocido'}`);

        const errorResponse = {
          error: error.message,
          sessionId: RsessionId || null,
        };
        try {
          socket.write(JSON.stringify(errorResponse) + '\n');
        } catch (writeError) {
            logger.error({ err: writeError }, 'Socket Server: Error escribiendo respuesta de error al socket');
        }
      }
    });

    socket.on('end', () => {
      logger.info({ sessionId: RsessionId }, 'Socket Server: Cliente desconectado.');
    });

    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') { // ECONNRESET is common, client closed abruptly
        logger.error({ err, sessionId: RsessionId }, 'Socket Server: Error en el socket del cliente.');
      } else {
        logger.warn({ sessionId: RsessionId }, 'Socket Server: Cliente cerró conexión abruptamente (ECONNRESET).');
      }
    });
  });

  server.on('error', (err) => {
    logger.error({ err, socketPath }, 'Socket Server: Error del servidor.');
    if (err.code === 'EADDRINUSE') {
        logger.error(`Socket Server: La dirección ${socketPath} ya está en uso.`);
    }
  });

  server.listen(socketPath, () => {
    logger.info(`Socket Server: Escuchando en ${socketPath}`);
    try {
      fs.chmodSync(socketPath, 0o666); // Permisos para que otros usuarios puedan acceder
      logger.info(`Socket Server: Permisos de ${socketPath} establecidos a 666.`);
    } catch (chmodError) {
      logger.error({ err: chmodError, socketPath }, `Socket Server: Error al establecer permisos para ${socketPath}.`);
    }
  });

  process.on('exit', () => { // Ensure cleanup on exit
    stopSocketServer(socketPath);
  });
}


function stopSocketServer(socketPath) {
  return new Promise((resolve) => {
    if (server) {
      logger.info('Socket Server: Cerrando servidor de sockets...');
      server.close(() => {
        logger.info('Socket Server: Servidor de sockets cerrado.');
        if (socketPath && fs.existsSync(socketPath)) {
          try {
            fs.unlinkSync(socketPath);
            logger.info(`Socket Server: Eliminado archivo de socket ${socketPath}`);
          } catch (err) {
            logger.error({ err, socketPath }, `Socket Server: Error al eliminar archivo de socket ${socketPath} al cerrar`);
          }
        }
        server = null;
        resolve();
      });
    } else {
      if (socketPath && fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
          logger.info(`Socket Server: Eliminado archivo de socket huérfano ${socketPath}`);
        } catch (err) {
          // Silently fail if it's not our socket or already gone
        }
      }
      resolve();
    }
  });
}

module.exports = { startSocketServer, stopSocketServer };
