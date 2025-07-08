// config/scripts/auth/cacheNewToken.js
const redisClient = require('../../../src/redisClient'); // Ajustar path si es necesario
const GLOBAL_TOKEN_REDIS_KEY = "global_api_auth_token:my_service";

async function persistNewToken(currentParameters, logger, sessionId) {
  // Este script espera que api_generate_token haya producido 'newAuthToken'
  // y ('newAuthTokenExpiryTimestamp' o 'newAuthTokenExpiresIn')
  // y que estos estén en currentParameters debido al mapeo de producesParameters de la API.
  const tokenToCache = currentParameters.newAuthToken;
  let expiryToCache; // Timestamp UNIX UTC en segundos

  if (currentParameters.hasOwnProperty('newAuthTokenExpiryTimestamp') && typeof currentParameters.newAuthTokenExpiryTimestamp === 'number') {
    expiryToCache = currentParameters.newAuthTokenExpiryTimestamp;
    logger.debug({sessionId, script: 'cacheNewToken.js'}, "Using provided newAuthTokenExpiryTimestamp.");
  } else if (currentParameters.hasOwnProperty('newAuthTokenExpiresIn')) {
    const expiresInSeconds = parseInt(currentParameters.newAuthTokenExpiresIn, 10);
    if (!isNaN(expiresInSeconds) && expiresInSeconds > 0) {
      expiryToCache = Math.floor(Date.now() / 1000) + expiresInSeconds;
      logger.debug({sessionId, script: 'cacheNewToken.js', expiresInSeconds, calculatedExpiry: expiryToCache}, "Calculated expiry timestamp from newAuthTokenExpiresIn.");
    } else {
      logger.error({sessionId, script: 'cacheNewToken.js', expiresIn: currentParameters.newAuthTokenExpiresIn}, "Invalid newAuthTokenExpiresIn value from token API.");
      return { status: "ERROR", message: "Invalid expires_in value from token API.", errorCode: "TOKEN_INVALID_EXPIRES_IN" };
    }
  }

  if (tokenToCache && typeof expiryToCache === 'number') {
    const now_utc_ts = Math.floor(Date.now() / 1000);
    // ttlSeconds para Redis debe ser la duración desde ahora hasta la expiración.
    // Si expiryToCache es un timestamp futuro, ttlSeconds es expiryToCache - now_utc_ts.
    const ttlSeconds = expiryToCache - now_utc_ts;

    if (ttlSeconds > 60) { // Solo guardar si tiene una validez razonable (ej. más de 1 minuto desde ahora)
      try {
        await redisClient.set(
          GLOBAL_TOKEN_REDIS_KEY,
          JSON.stringify({ token: tokenToCache, expiry: expiryToCache }), // Guardamos el timestamp de expiración absoluto
          'EX',
          ttlSeconds // El TTL para Redis es la duración restante
        );
        logger.info({ sessionId, script: 'cacheNewToken.js', key: GLOBAL_TOKEN_REDIS_KEY, tokenExpiryTimestamp: expiryToCache, redisTTL: ttlSeconds }, "New token successfully cached in global Redis.");

        // Devolver el token y su expiración para que se establezcan en currentParameters
        // para la sesión actual, bajo los nombres estándar que usa `manageToken.js`.
        return {
          status: "SUCCESS",
          output: {
            sessionAuthToken: tokenToCache,
            sessionAuthTokenExpiryTimestamp: expiryToCache
          }
        };
      } catch (err) {
        logger.error({ sessionId, script: 'cacheNewToken.js', err, key: GLOBAL_TOKEN_REDIS_KEY }, "Error saving new token to global Redis cache.");
        return { status: "ERROR", message: "Failed to save new token to Redis cache.", errorCode: "TOKEN_CACHE_SAVE_FAILED" };
      }
    } else {
      logger.warn({ sessionId, script: 'cacheNewToken.js', tokenToCache, expiryToCache, ttlSeconds }, "New token has very short or invalid TTL for global caching. Still providing for current session if positive TTL.");
      // Aún así, devolverlo para la sesión actual si es válido por un corto tiempo
      if (ttlSeconds > 0) {
        return {
          status: "SUCCESS",
          output: {
            sessionAuthToken: tokenToCache,
            sessionAuthTokenExpiryTimestamp: expiryToCache
          }
        };
      } else {
        return { status: "ERROR", message: "Token already expired or has no validity.", errorCode: "TOKEN_EXPIRED_ON_GENERATION" };
      }
    }
  } else {
    logger.error({ sessionId, script: 'cacheNewToken.js', tokenToCache, expiryToCache }, "New token or calculated/provided expiry not available. Cannot cache or use.");
    return { status: "ERROR", message: "Token data or expiry for caching is missing or invalid.", errorCode: "TOKEN_DATA_MISSING_FOR_CACHE" };
  }
}

module.exports = {
  persistNewToken
};
