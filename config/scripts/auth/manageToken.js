// config/scripts/auth/manageToken.js
const redisClient = require('../../../src/redisClient'); // Ajustar path si es necesario
const GLOBAL_TOKEN_REDIS_KEY = "global_api_auth_token:my_service"; // Clave global para el token en Redis

async function ensureValidApiToken(currentParameters, logger, sessionId) {
  const now_utc_ts = Math.floor(Date.now() / 1000);
  const bufferSeconds = 300; // 5 minutos de margen antes de la expiración real

  let tokenToValidate = currentParameters.sessionAuthToken;
  let expiryToValidate = currentParameters.sessionAuthTokenExpiryTimestamp;

  logger.debug({ sessionId, script: 'manageToken.js', currentToken: tokenToValidate, currentExpiry: expiryToValidate }, "Checking token from currentParameters first.");

  // Si no está en currentParameters (ej. primera vez en la sesión), intentar cargar de caché global de Redis
  if (!tokenToValidate && !expiryToValidate) {
    try {
      const cachedTokenDataString = await redisClient.get(GLOBAL_TOKEN_REDIS_KEY);
      if (cachedTokenDataString) {
        const parsedCache = JSON.parse(cachedTokenDataString);
        tokenToValidate = parsedCache.token;
        expiryToValidate = parsedCache.expiry;
        // Ponerlo en currentParameters para que esté disponible para el output de este script y potencialmente para otros
        currentParameters.sessionAuthToken = tokenToValidate; // Actualiza currentParameters
        currentParameters.sessionAuthTokenExpiryTimestamp = expiryToValidate; // Actualiza currentParameters
        logger.info({ sessionId, script: 'manageToken.js' }, "Token loaded from global Redis cache into currentParameters.");
      }
    } catch (err) {
      logger.error({ sessionId, script: 'manageToken.js', err }, "Error reading token from global Redis cache.");
      // Continuar, se tratará como si no hubiera token
    }
  }

  if (tokenToValidate && expiryToValidate && (expiryToValidate > now_utc_ts + bufferSeconds)) {
    logger.info({ sessionId, script: 'manageToken.js', expiry: expiryToValidate, nowPlusBuffer: now_utc_ts + bufferSeconds }, "Token existente es válido.");
    return {
      status: "SUCCESS",
      output: {
        activeAuthToken: tokenToValidate, // El token que se puede usar
        needsNewToken: false
      }
    };
  } else {
    if (tokenToValidate) {
        logger.info({ sessionId, script: 'manageToken.js', tokenExpiry: expiryToValidate, now: now_utc_ts, buffer: bufferSeconds }, "Token existente ha expirado o está a punto de expirar.");
    } else {
        logger.info({ sessionId, script: 'manageToken.js' }, "No hay token existente. Se necesita nuevo token.");
    }
    return {
      status: "SUCCESS", // El script en sí tuvo éxito en su lógica de determinar
      output: {
        activeAuthToken: null,
        needsNewToken: true // Señal para la FSM para que llame a api_generate_token
      }
    };
  }
}

module.exports = {
  ensureValidApiToken
};
