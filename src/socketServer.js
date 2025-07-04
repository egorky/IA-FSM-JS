const net = require('net');
const fs = require('fs');

let server;

/**
 * Inicia el servidor de sockets UNIX.
 * @param {string} socketPath La ruta del archivo de socket UNIX.
 * @param {function} fsmProcessInputCallback Callback para procesar los mensajes de la FSM.
 *                                           Debe ser una función async que acepte (sessionId, intent, parameters)
 *                                           y devuelva una promesa que resuelva con el resultado de la FSM.
 */
function startSocketServer(socketPath, fsmProcessInputCallback) {
  if (!socketPath) {
    console.error('Socket Server: FSM_SOCKET_PATH no está definido. El servidor de sockets no se iniciará.');
    return;
  }

  // Eliminar el socket antiguo si existe
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
      console.log(`Socket Server: Eliminado socket antiguo en ${socketPath}`);
    } catch (err) {
      console.error(`Socket Server: Error al eliminar socket antiguo ${socketPath}:`, err);
      // No continuar si no se puede eliminar el socket antiguo, ya que listen fallará.
      return;
    }
  }

  server = net.createServer((socket) => {
    console.log('Socket Server: Cliente conectado.');
    let RsessionId = null; // Para logging en caso de error de parseo

    socket.on('data', async (data) => {
      const message = data.toString();
      // No imprimir 'message' directamente aquí si va a ser parseado y luego impreso formateado.
      // console.log('Socket Server: Datos recibidos (raw):', message);

      try {
        const request = JSON.parse(message);
        RsessionId = request.sessionId; // Guardar para logging

        const capturedRequest = { ...request }; // Clonar para log diferido
        process.nextTick(() => {
          console.log("Socket Request JSON (async log):\n", JSON.stringify(capturedRequest, null, 2));
        });

        if (!request.sessionId) {
          throw new Error('sessionId es requerido en la solicitud del socket.');
        }

        const fsmResponse = await fsmProcessInputCallback(
          request.sessionId,
          request.intent,
          request.parameters
        );

        // Enviar respuesta inmediatamente
        socket.write(JSON.stringify(fsmResponse) + '\n');

        // Loguear respuesta de forma diferida
        const capturedResponse = { ...fsmResponse }; // Clonar por si acaso
        process.nextTick(() => {
          console.log("Socket Response JSON (async log):\n", JSON.stringify(capturedResponse, null, 2));
        });

      } catch (error) {
        console.error(`Socket Server: Error procesando mensaje para sessionId ${RsessionId || 'desconocido'} (mensaje original: ${message.substring(0,100)}...):`, error.message);
        const errorResponse = {
          error: error.message,
          // details: error.stack, // Omitir stack en producción o hacerlo condicional
        };

        // Intentar enviar error inmediatamente
        try {
          socket.write(JSON.stringify(errorResponse) + '\n');
        } catch (writeError) {
            console.error('Socket Server: Error escribiendo respuesta de error al socket:', writeError);
        }

        // Loguear error de forma diferida
        process.nextTick(() => {
          console.log("Socket Error Response JSON (async log):\n", JSON.stringify(errorResponse, null, 2));
        });
      }
    });

    socket.on('end', () => {
      console.log('Socket Server: Cliente desconectado.');
    });

    socket.on('error', (err) => {
      // No loguear errores ECONNRESET que son comunes cuando el cliente cierra abruptamente.
      if (err.code !== 'ECONNRESET') {
        console.error('Socket Server: Error en el socket del cliente:', err);
      }
    });
  });

  server.on('error', (err) => {
    console.error('Socket Server: Error del servidor:', err);
    // Si el error es EADDRINUSE, podría ser que fs.unlinkSync no funcionó a tiempo
    // o hay otro proceso.
    if (err.code === 'EADDRINUSE') {
        console.error(`Socket Server: La dirección ${socketPath} ya está en uso. Asegúrese de que no haya otro servidor corriendo o elimine el archivo de socket manualmente.`);
    }
  });

  server.listen(socketPath, () => {
    console.log(`Socket Server: Escuchando en ${socketPath}`);
    // Asegurar permisos correctos para el socket si es necesario (ej: 0o660 o 0o666)
    // fs.chmodSync(socketPath, 0o666); // Ejemplo, ajustar según necesidades de seguridad
  });

  // Manejar la limpieza del socket al salir
  // Esto se hace también en index.js, pero es bueno tenerlo aquí por si el módulo se usa diferente
  process.on('exit', () => {
    stopSocketServer(socketPath);
  });
}

/**
 * Detiene el servidor de sockets UNIX y elimina el archivo de socket.
 * @param {string} socketPath La ruta del archivo de socket UNIX.
 */
function stopSocketServer(socketPath) {
  return new Promise((resolve) => {
    if (server) {
      console.log('Socket Server: Cerrando servidor de sockets...');
      server.close(() => {
        console.log('Socket Server: Servidor de sockets cerrado.');
        if (socketPath && fs.existsSync(socketPath)) {
          try {
            fs.unlinkSync(socketPath);
            console.log(`Socket Server: Eliminado archivo de socket ${socketPath}`);
          } catch (err) {
            console.error(`Socket Server: Error al eliminar archivo de socket ${socketPath} al cerrar:`, err);
          }
        }
        server = null;
        resolve();
      });
    } else {
      // Si el servidor no está definido pero el path sí, intentar limpiar por si acaso
      if (socketPath && fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
          console.log(`Socket Server: Eliminado archivo de socket huérfano ${socketPath}`);
        } catch (err) {
          // No hacer mucho ruido si falla, podría no ser nuestro socket
        }
      }
      resolve();
    }
  });
}

module.exports = { startSocketServer, stopSocketServer };
