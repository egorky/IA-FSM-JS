require('dotenv').config(); // Cargar variables de entorno desde .env al inicio

const { startApiServer } = require('./apiServer');
const { startSocketServer, stopSocketServer } = require('./socketServer'); // Nuevo
const redisClient = require('./redisClient');
const { connectAri, closeAri } = require('./ariClient');
const fsm = require('./fsm'); // Necesario para pasar processInput
const { loadStateConfig } = require('./configLoader');

async function main() {
  console.log(`Valor de process.env.ENABLE_API: ${process.env.ENABLE_API}`);
  console.log(`Valor de process.env.ENABLE_ARI: ${process.env.ENABLE_ARI}`);
  console.log(`Valor de process.env.ENABLE_SOCKET_SERVER: ${process.env.ENABLE_SOCKET_SERVER}`);
  console.log(`Valor de process.env.FSM_SOCKET_PATH: ${process.env.FSM_SOCKET_PATH}`);

  let ariConnected = false;
  let socketServerStarted = false;

  try {
    // 1. Cargar configuración de la FSM (ya se hace en apiServer y ariClient al iniciar, pero podemos asegurar aquí)
    console.log('Inicializando aplicación FSM...');
    loadStateConfig();
    console.log('Configuración de estados cargada.');

    // 2. Conectar a Redis
    await redisClient.connect();
    console.log('Conexión con Redis establecida.');

    // 3. Iniciar el servidor API
    // startApiServer ya maneja su propia carga de config y logging
    const enableApi = process.env.ENABLE_API !== 'false'; // Habilitado por defecto
    if (enableApi) {
      startApiServer();
      // No hay un 'await' aquí porque app.listen es asíncrono pero no devuelve una promesa
      // que necesitemos esperar para continuar. El log de 'escuchando en puerto X'
      // se manejará dentro de startApiServer.
    } else {
      console.log('Módulo API está deshabilitado por configuración (ENABLE_API=false).');
    }

    // 4. Conectar al cliente ARI de Asterisk (si está habilitado o configurado)
    const enableAri = process.env.ENABLE_ARI !== 'false'; // Habilitado por defecto
    if (enableAri) {
      console.log('Intentando conectar a Asterisk ARI...');
      await connectAri(); // connectAri maneja sus propios reintentos iniciales si falla
      ariConnected = true; // Marcar como conectado solo si se intentó y tuvo éxito (o está en proceso)
      console.log('Módulo ARI iniciado (o intentando conectar).');
    } else {
      console.log('Módulo ARI está deshabilitado por configuración (ENABLE_ARI=false).');
    }

    // 5. Iniciar el servidor de Sockets UNIX (si está habilitado)
    const enableSocketServer = process.env.ENABLE_SOCKET_SERVER !== 'false'; // Habilitado por defecto
    const fsmSocketPath = process.env.FSM_SOCKET_PATH;
    if (enableSocketServer) {
      if (fsmSocketPath) {
        startSocketServer(fsmSocketPath, fsm.processInput);
        socketServerStarted = true;
      } else {
        console.warn('ADVERTENCIA: ENABLE_SOCKET_SERVER está en true, pero FSM_SOCKET_PATH no está definido. El servidor de sockets no se iniciará.');
      }
    } else {
      console.log('Módulo Socket Server está deshabilitado por configuración (ENABLE_SOCKET_SERVER=false).');
    }


    if (enableApi || enableAri || socketServerStarted) {
      console.log('Aplicación FSM iniciada y lista (al menos un módulo de interfaz está activo).');
    } else {
      console.warn('ADVERTENCIA: Todos los módulos de interfaz (API, ARI, Socket) están deshabilitados. La aplicación no podrá recibir solicitudes.');
      // Podríamos optar por salir si ningún módulo está activo, o dejarla corriendo "ociosa".
      // Por ahora, la dejamos correr.
    }

  } catch (error) {
    console.error('Error fatal durante la inicialización de la aplicación:', error);
    // Intentar cerrar conexiones abiertas antes de salir
    if (ariConnected && process.env.ENABLE_ARI !== 'false') { // Solo cerrar si estaba habilitado e intentó conectar
      await closeAri().catch(err => console.error('Error al cerrar ARI durante el apagado por error:', err));
    }
    if (socketServerStarted && process.env.ENABLE_SOCKET_SERVER !== 'false') { // Solo cerrar si estaba habilitado e intentó conectar
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => console.error('Error al cerrar Socket Server durante el apagado por error:', err));
    }
    await redisClient.quit().catch(err => console.error('Error al cerrar Redis durante el apagado por error:', err));
    process.exit(1);
  }
}

// Manejar cierre gracefully
async function shutdown(signal) {
  console.log(`\nRecibida señal ${signal}. Cerrando la aplicación FSM...`);

  // Aquí no cerramos el servidor HTTP explícitamente con server.close()
  // porque no guardamos la instancia del servidor desde startApiServer.
  // Para un cierre más limpio, startApiServer debería devolver el servidor.
  // Por ahora, las conexiones existentes podrían interrumpirse si la API estaba activa.

  if (process.env.ENABLE_ARI !== 'false') { // Solo intentar cerrar si estaba habilitado
      await closeAri().catch(err => console.error('Error al cerrar ARI:', err));
  }
  if (process.env.ENABLE_SOCKET_SERVER !== 'false' && process.env.FSM_SOCKET_PATH) { // Solo intentar cerrar si estaba habilitado y con path
      await stopSocketServer(process.env.FSM_SOCKET_PATH).catch(err => console.error('Error al cerrar Socket Server:', err));
  }
  await redisClient.quit().catch(err => console.error('Error al cerrar Redis:', err));

  console.log('Aplicación FSM cerrada.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('Excepción no capturada:', error);
  // Considera si quieres intentar un shutdown aquí o simplemente salir.
  // Si el estado es muy inestable, un shutdown podría fallar o empeorar las cosas.
  // shutdown('uncaughtException').then(() => process.exit(1)).catch(() => process.exit(1));
  process.exit(1); // Salir directamente para evitar estado inconsistente
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Rechazo de promesa no manejado:', promise, 'razón:', reason);
  // Similar a uncaughtException, decide la estrategia de salida.
  // shutdown('unhandledRejection').then(() => process.exit(1)).catch(() => process.exit(1));
  process.exit(1);
});

main();
