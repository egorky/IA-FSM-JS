// src/authService.js
const logger = require('./logger');
const redisClient = require('./redisClient');
const apiCallerService = require('./apiCallerService');
const { getApiConfigById } = require('./apiConfigLoader');
const { getAuthProfileById } = require('./authProfileLoader');
const { processTemplate } = require('./templateProcessor'); // Necesario si las plantillas de token API usan params

/**
 * Obtiene un token de autenticación válido según el perfil.
 * Maneja la caché y la generación/refresco de tokens.
 * @param {String} authProfileId - El ID del perfil de autenticación a usar.
 * @param {Object} currentParameters - Parámetros actuales para resolver plantillas.
 * @param {Object} sessionData - Datos de sesión.
 * @param {String} sessionIdForLog - El ID de la sesión actual, para logging.
 * @returns {Promise<Object|null>} Objeto con { tokenValue, tokenType, scheme (del profile.tokenPlacement) } o null si falla.
 */
async function getValidToken(authProfileId, currentParameters, sessionData, sessionIdForLog) {
  const authProfile = getAuthProfileById(authProfileId);
  if (!authProfile) {
    logger.error({ sessionId: sessionIdForLog, authProfileId }, "Auth profile not found.");
    return null;
  }

  const {
    tokenCacheSettings,
    tokenGenerationDetails,
    authStrategy // Renombrado desde authType en el perfil de ejemplo
  } = authProfile;

  if (authStrategy !== "BEARER_TOKEN_FROM_API") { // Corregido para coincidir con el ejemplo de perfil
    logger.error({ sessionId: sessionIdForLog, authProfileId, authStrategy }, "Unsupported authentication strategy in profile.");
    return null;
  }

  const cacheKey = tokenCacheSettings.redisKey;
  const bufferSeconds = tokenCacheSettings.refreshBufferSeconds || 300;
  const nowUtcTs = Math.floor(Date.now() / 1000);

  // 1. Intentar leer de la caché de Redis
  try {
    const cachedTokenDataString = await redisClient.get(cacheKey);
    if (cachedTokenDataString) {
      const cachedToken = JSON.parse(cachedTokenDataString);
      if (cachedToken.tokenValue && cachedToken.expiryTimestamp && cachedToken.expiryTimestamp > (nowUtcTs + bufferSeconds)) {
        logger.info({ sessionId: sessionIdForLog, authProfileId, cacheKey }, "Valid token retrieved from cache.");
        return { tokenValue: cachedToken.tokenValue, tokenType: cachedToken.tokenType || "Bearer" };
      } else {
        logger.info({ sessionId: sessionIdForLog, authProfileId, cacheKey, expiry: cachedToken.expiryTimestamp, now: nowUtcTs + bufferSeconds }, "Cached token is expired or nearing expiry.");
      }
    } else {
      logger.info({ sessionId: sessionIdForLog, authProfileId, cacheKey }, "Token not found in cache.");
    }
  } catch (err) {
    logger.error({ err, sessionId: sessionIdForLog, authProfileId, cacheKey }, "Error reading token from Redis cache. Proceeding to generate new token.");
  }

  // 2. Si no está en caché o está expirado, generar nuevo token
  logger.info({ sessionId: sessionIdForLog, authProfileId }, "Attempting to generate a new token.");
  const tokenGenApiId = tokenGenerationDetails.apiId;
  const tokenGenApiConfig = getApiConfigById(tokenGenApiId);

  if (!tokenGenApiConfig) {
    logger.error({ sessionId: sessionIdForLog, authProfileId, tokenGenApiId }, "Token generation API config not found.");
    return null;
  }

  // Resolver consumesParameters para la API generadora de tokens
  let templateParamsForTokenAPI = {};
  if (tokenGenApiConfig.consumesParameters) {
    // Esta es una versión simplificada de getActionTemplateParameters de fsm.js
    // Debería idealmente usar una función compartida o una lógica más robusta.
    for (const key in tokenGenApiConfig.consumesParameters) {
        const pDef = tokenGenApiConfig.consumesParameters[key];
        if (pDef.source === "STATIC") {
            templateParamsForTokenAPI[key] = pDef.value;
        } else if (pDef.source === "SESSION_DATA" && sessionData) {
            try { templateParamsForTokenAPI[key] = pDef.path.split('.').reduce((o, k) => (o || {})[k], sessionData); } catch (e) { /* log o ignorar */ }
        } else if (pDef.source === "COLLECTED_PARAM" && currentParameters) {
            templateParamsForTokenAPI[key] = currentParameters[pDef.paramName];
        }
        // No se espera USER_INPUT o API_RESULT para una API de sistema de token usualmente.
    }
  }

  try {
    const response = await apiCallerService.makeRequestAndWait(tokenGenApiId, sessionIdForLog, `auth_token_gen_${Date.now()}`, templateParamsForTokenAPI);

    if (response.status === 'success' && response.data) {
      const tokenProdDetails = tokenGenerationDetails.producesAuthData;

      // Helper para extraer valor de path
      const getValueFromPath = (obj, pathStr) => {
        if (!pathStr || typeof pathStr !== 'string') return undefined;
        return pathStr.split('.').reduce((o, k) => (o || {})[k], obj);
      };

      const tokenValue = getValueFromPath(response, tokenProdDetails.tokenValue);
      const expiresInStr = getValueFromPath(response, tokenProdDetails.expiresInSeconds);
      const tokenType = getValueFromPath(response, tokenProdDetails.tokenType) || "Bearer"; // Default a Bearer

      const expiresIn = parseInt(expiresInStr, 10);

      if (tokenValue && !isNaN(expiresIn) && expiresIn > 0) {
        const expiryTimestampAbsoluto = nowUtcTs + expiresIn;
        // TTL para Redis: duración total menos el buffer, pero no menos que un mínimo (ej. 60s) para evitar seteos muy cortos.
        let redisTTL = expiresIn - bufferSeconds;
        if (redisTTL <= 0) redisTTL = Math.max(60, expiresIn); // Asegurar un TTL positivo si expiresIn es corto

        await redisClient.set(cacheKey, JSON.stringify({
            tokenValue, // Guardar con el nombre consistente
            expiryTimestamp: expiryTimestampAbsoluto,
            tokenType
        }), 'EX', redisTTL);

        logger.info({ sessionId: sessionIdForLog, authProfileId, cacheKey }, "New token generated and cached successfully.");
        return { tokenValue, tokenType };
      } else {
        logger.error({ sessionId: sessionIdForLog, authProfileId, responseData: response.data, extracted: {tokenValue, expiresIn, tokenType} }, "Failed to extract valid token or expiry from token API response.");
        return null;
      }
    } else {
      logger.error({ sessionId: sessionIdForLog, authProfileId, error: response.errorMessage, httpCode: response.httpCode }, "Token generation API call failed.");
      return null;
    }
  } catch (err) {
    logger.error({ err, sessionId: sessionIdForLog, authProfileId, tokenGenApiId }, "Exception during token generation API call.");
    return null;
  }
}

module.exports = {
  getValidToken,
};
