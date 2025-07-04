const Redis = require('ioredis');

// Configuración de Redis. Debería moverse a variables de entorno en una aplicación real.
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  // password: process.env.REDIS_PASSWORD || undefined, // Descomentar si Redis tiene contraseña
  // db: process.env.REDIS_DB || 0, // Descomentar si se usa una DB específica
};

let client;
let connectionPromise;

/**
 * Establece la conexión con el servidor Redis.
 * Devuelve una promesa que se resuelve cuando la conexión está lista.
 */
function connect() {
  if (!client) {
    client = new Redis(redisConfig);

    client.on('connect', () => {
      console.log('Conectado a Redis.');
    });

    client.on('error', (err) => {
      console.error('Error de conexión con Redis:', err);
      // En una aplicación real, podrías querer reintentar la conexión o terminar la aplicación
      // si Redis es crítico.
      // Por ahora, si hay un error en la conexión inicial, las operaciones fallarán.
      client = null; // Resetear cliente para permitir reintentos si se implementa
      connectionPromise = null; // Resetear promesa
    });

    client.on('close', () => {
        console.log('Conexión con Redis cerrada.');
        client = null;
        connectionPromise = null;
    });

    client.on('reconnecting', () => {
        console.log('Reconectando a Redis...');
    });

    // Creamos una promesa para asegurar que las operaciones esperan a que la conexión esté lista.
    // Sin embargo, ioredis maneja una cola de comandos internamente, por lo que
    // las llamadas a get/set pueden funcionar incluso antes de que el evento 'connect' se dispare explícitamente.
    // Pero es buena práctica tener una forma de saber si la conexión es viable.
    connectionPromise = new Promise((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject); // Rechazar si la conexión inicial falla
    });
  }
  return connectionPromise;
}

/**
 * Obtiene un valor de Redis.
 * @param {string} key La clave a obtener.
 * @returns {Promise<string | null>} El valor o null si la clave no existe.
 */
async function get(key) {
  if (!client) {
    // Intenta conectar si el cliente no está inicializado.
    // Esto es un fallback, idealmente connect() se llama al inicio de la app.
    await connect().catch(err => {
        console.error("Fallo al autoconectar Redis en GET:", err);
        throw new Error("Redis no está conectado."); // Lanza error si no se puede conectar
    });
  }
  // Si después de intentar conectar, el cliente sigue sin estar disponible, lanza error.
  if (!client) throw new Error("Redis no está conectado y no se pudo establecer conexión.");

  return client.get(key);
}

/**
 * Guarda un valor en Redis.
 * @param {string} key La clave a guardar.
 * @param {string} value El valor a guardar.
 * @param {string} [mode] Modo de SET, ej: 'EX' para expiración.
 * @param {number} [duration] Duración para el modo, ej: 3600 para 1 hora con 'EX'.
 * @returns {Promise<string>} 'OK' si se guardó correctamente.
 */
async function set(key, value, mode, duration) {
  if (!client) {
    await connect().catch(err => {
        console.error("Fallo al autoconectar Redis en SET:", err);
        throw new Error("Redis no está conectado.");
    });
  }
  if (!client) throw new Error("Redis no está conectado y no se pudo establecer conexión.");

  if (mode && duration) {
    return client.set(key, value, mode, duration);
  }
  return client.set(key, value);
}

/**
 * Elimina una clave de Redis.
 * @param {string} key La clave a eliminar.
 * @returns {Promise<number>} El número de claves eliminadas.
 */
async function del(key) {
  if (!client) {
    await connect().catch(err => {
        console.error("Fallo al autoconectar Redis en DEL:", err);
        throw new Error("Redis no está conectado.");
    });
  }
  if (!client) throw new Error("Redis no está conectado y no se pudo establecer conexión.");
  return client.del(key);
}

/**
 * Cierra la conexión a Redis.
 * Es importante llamar a esto al apagar la aplicación para liberar recursos.
 */
async function quit() {
  if (client) {
    await client.quit();
    client = null;
    connectionPromise = null;
    console.log('Cliente Redis desconectado.');
  }
}

// Exportar una instancia o funciones. Por simplicidad, exportamos las funciones.
// La conexión se manejará internamente al llamar a las funciones si no está ya establecida.
// Es recomendable llamar a `connect()` explícitamente al inicio de la aplicación.
module.exports = {
  connect, // Para conectar explícitamente al inicio
  get,
  set,
  del,
  quit,   // Para desconectar limpiamente al apagar
  getClient: () => client // Para acceder al cliente directamente si es necesario (ej. para pub/sub)
};
