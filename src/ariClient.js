const Ari = require('ari-client');
const fsm = require('./fsm');
const { loadStateConfig } = require('./configLoader'); // Para asegurar que esté cargada

const ARI_APP_NAME = process.env.ARI_APP_NAME || 'fsm-ari-app';
const ARI_USERNAME = process.env.ARI_USERNAME || 'ariuser';
const ARI_PASSWORD = process.env.ARI_PASSWORD || 'aripass';
const ARI_URL = process.env.ARI_URL || 'http://localhost:8088'; // ej: 'http://asterisk_ip:8088'

let ariClient = null;

/**
 * Procesa los datos de una llamada entrante a la aplicación Stasis.
 * @param {object} event El evento StasisStart.
 * @param {object} channel El canal de la llamada.
 */
async function handleStasisStart(event, channel) {
  console.log(`ARI: Llamada ${channel.id} entrando a la aplicación Stasis ${ARI_APP_NAME}`);

  // El sessionId para la FSM será el ID del canal de Asterisk.
  const sessionId = channel.id;
  let currentFsmState;

  try {
    // Inicializar o restaurar la sesión FSM.
    // Para ARI, la primera interacción no suele traer 'intent' o 'parameters' explícitos,
    // se asume que se inicia el flujo.
    currentFsmState = await fsm.processInput(sessionId, null, {});
    console.log(`ARI: Sesión FSM ${sessionId} iniciada/restaurada. Estado actual: ${currentFsmState.nextStateId}`);

    await channel.answer();
    console.log(`ARI: Canal ${channel.id} respondido.`);

    // Aquí comienza la lógica de interacción con el usuario vía ARI.
    // Esto es un esqueleto y necesitará ser expandido enormemente.
    // Por ejemplo, reproducir un audio, esperar DTMF, etc.

    // 1. Procesar el payloadResponse devuelto por la FSM.
    // Para ARI, el contenido de payloadResponse necesitará ser interpretado
    // para realizar acciones de llamada (reproducir audios, etc.).
    if (currentFsmState.payloadResponse && Object.keys(currentFsmState.payloadResponse).length > 0) {
      console.log(`ARI: Para el estado ${currentFsmState.nextStateId}, se recibió el siguiente payloadResponse:`);
      console.log(JSON.stringify(currentFsmState.payloadResponse, null, 2)); // Loguear el payload completo

      // Ejemplo de cómo se podría buscar una clave específica dentro de payloadResponse,
      // como los antiguos 'apiHooks' si se mantiene esa sub-estructura, o 'prompts'.
      if (currentFsmState.payloadResponse.apiHooks) {
        const onEnterApis = currentFsmState.payloadResponse.apiHooks.onEnterState;
        if (onEnterApis && onEnterApis.length > 0) {
          console.log(`ARI: (Dentro de payloadResponse) Hook 'onEnterState' APIs: ${onEnterApis.join(', ')}`);
          // await channel.setChannelVar({ variable: 'ON_ENTER_APIS', value: onEnterApis.join(',') });
        }
      }
      if (currentFsmState.payloadResponse.prompts && currentFsmState.payloadResponse.prompts.main) {
        console.log(`ARI: (Dentro de payloadResponse) Prompt principal: ${currentFsmState.payloadResponse.prompts.main}`);
        // Ejemplo de acción ARI: reproducir este prompt (requiere que el prompt sea un archivo de sonido válido o use TTS)
        // try {
        //   await channel.play({ media: `sound:${currentFsmState.payloadResponse.prompts.main}` });
        // } catch (playError) {
        //   console.error(`ARI: Error al intentar reproducir prompt: ${playError}`);
        // }
      }
      // La lógica real para actuar sobre el payloadResponse en ARI será específica de la aplicación.
    }

    // 2. Determinar qué preguntar o qué hacer basándose en `parametersToCollect`
    // Esta es la parte más compleja y depende mucho de cómo se quiera interactuar.
    // Ejemplo muy básico: si hay parámetros requeridos, reproducir un mensaje genérico.
    if (currentFsmState.parametersToCollect && currentFsmState.parametersToCollect.required.length > 0) {
      const firstRequiredParam = currentFsmState.parametersToCollect.required[0];
      const promptFile = `sound:fsm_prompt_for_${firstRequiredParam}`; // ej: fsm_prompt_for_patient_id_number
      console.log(`ARI: Solicitando parámetro ${firstRequiredParam}. Reproduciendo ${promptFile}`);

      // Ejemplo de cómo se podría usar play y luego esperar por DTMF o ASR (no implementado aquí)
      // await channel.play({ media: promptFile });
      // Luego, se necesitaría un handler para StasisDTMFReceived o un puente a una app ASR.
    } else {
      // Si no hay parámetros que recolectar, quizás el estado es informativo o final.
      const currentStateConfig = currentFsmState.nextStateConfig; // El estado al que se llegó
      if (currentStateConfig && currentStateConfig.description) {
          console.log(`ARI: Estado ${currentFsmState.nextStateId} alcanzado. Descripción: ${currentStateConfig.description}`);
          // Podría reproducir un mensaje relacionado con la descripción.
          // await channel.play({ media: `sound:fsm_state_${currentFsmState.nextStateId}` });
      }
    }

    // IMPORTANTE: Esta función `handleStasisStart` solo maneja el inicio.
    // Se necesitarían handlers para `StasisDTMFReceived`, `ChannelHangupRequest`, etc.,
    // para continuar la interacción y alimentar de vuelta a `fsm.processInput`.
    // Por ejemplo, en `StasisDTMFReceived`, se recogería el DTMF, se mapearía a un parámetro
    // y/o intención, y se llamaría a `fsm.processInput(sessionId, intent, { paramName: dtmfValue })`.
    // La respuesta de la FSM indicaría el siguiente paso, que se traduciría a acciones ARI.

  } catch (error) {
    console.error(`ARI: Error en StasisStart para el canal ${channel.id}:`, error);
    // Intentar colgar la llamada si aún está activa y hay un error grave.
    try {
      await channel.hangup();
      console.log(`ARI: Canal ${channel.id} colgado debido a un error.`);
    } catch (hangupError) {
      console.error(`ARI: Error al intentar colgar el canal ${channel.id}:`, hangupError);
    }
  }
}


/**
 * Manejador para el evento StasisEnd.
 * @param {object} event El evento StasisEnd.
 * @param {object} channel El canal que finalizó.
 */
async function handleStasisEnd(event, channel) {
  console.log(`ARI: Llamada ${channel.id} finalizando en aplicación Stasis ${ARI_APP_NAME}`);
  // Aquí se podría limpiar la sesión de Redis si se desea,
  // aunque generalmente se deja que expire para poder retomar si la llamada cae y vuelve.
  // Ejemplo:
  // const sessionId = channel.id;
  // await redisClient.del(`${FSM_SESSION_PREFIX}${sessionId}`); // Asumiendo que FSM_SESSION_PREFIX está disponible
  // console.log(`ARI: Sesión FSM ${sessionId} limpiada de Redis.`);
}

/**
 * Conecta al cliente ARI y registra la aplicación Stasis.
 */
async function connectAri() {
  if (ariClient) {
    return ariClient;
  }

  try {
    loadStateConfig(); // Asegurar que la config FSM esté cargada y validada.

    ariClient = await Ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD);
    console.log(`ARI: Conectado a Asterisk en ${ARI_URL}`);

    ariClient.on('StasisStart', handleStasisStart);
    ariClient.on('StasisEnd', handleStasisEnd);

    // Podríamos necesitar más handlers, por ejemplo:
    // ariClient.on('StasisDTMFReceived', handleDtmf);
    // ariClient.on('ChannelHangupRequest', handleHangup);
    // ariClient.on('ChannelStateChange', (event, channel) => { ... });

    ariClient.on('error', (err) => {
      console.error('ARI: Error de conexión o runtime:', err);
      ariClient = null; // Permitir reconexión
      // Implementar lógica de reconexión si es necesario
      setTimeout(connectAri, 5000); // Reintentar conexión después de 5 segundos
    });

    ariClient.on('close', () => {
        console.log('ARI: Conexión con Asterisk cerrada.');
        ariClient = null;
        // Podrías intentar reconectar aquí si es deseado.
        // setTimeout(connectAri, 5000); // Ejemplo de reintento
    });

    await ariClient.start(ARI_APP_NAME);
    console.log(`ARI: Aplicación Stasis "${ARI_APP_NAME}" registrada y escuchando.`);

    return ariClient;

  } catch (err) {
    console.error(`ARI: No se pudo conectar o iniciar la aplicación Stasis:`, err);
    ariClient = null;
    // Reintentar conexión si falla al inicio
    console.log('ARI: Reintentando conexión en 10 segundos...');
    setTimeout(connectAri, 10000);
    throw err; // Lanzar para que el inicio general de la app pueda manejarlo si es el primer intento.
  }
}

/**
 * Cierra la conexión ARI de forma controlada.
 */
async function closeAri() {
  if (ariClient) {
    console.log('ARI: Cerrando conexión con Asterisk...');
    try {
      // No hay un método explícito 'stop' para la app en todas las versiones de cliente,
      // pero cerrar el cliente debería ser suficiente.
      await ariClient.close();
      console.log('ARI: Conexión con Asterisk cerrada.');
    } catch (err) {
      console.error('ARI: Error al cerrar la conexión con Asterisk:', err);
    } finally {
      ariClient = null;
    }
  }
}

module.exports = {
  connectAri,
  closeAri,
  // Podríamos exportar el cliente si otras partes de la app lo necesitan
  // getAriClient: () => ariClient
};
