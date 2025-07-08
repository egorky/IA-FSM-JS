// config/scripts/auth/setActiveToken.js

function determineActiveToken(currentParameters, logger, sessionId) {
  // Este script se ejecuta después de:
  // 1. manageTokenScript (resultado en currentParameters.tokenStatus)
  // 2. (condicionalmente) api_generate_token (resultado en currentParameters.newAuthToken, etc.)
  // 3. (condicionalmente) cacheNewTokenScript (resultado en currentParameters.cachedTokenState, y actualiza sessionAuthToken/Expiry)

  const manageResult = currentParameters.tokenStatus?.output;
  const newCachedTokenInfo = currentParameters.cachedTokenState?.output; // Resultado de cacheNewTokenScript

  let activeToken = null;

  if (manageResult?.needsNewToken) {
    // Se necesitaba un nuevo token. Debería haber sido generado y cacheado.
    // cacheNewTokenScript lo habrá puesto en sessionAuthToken/sessionAuthTokenExpiry para currentParameters.
    // O si se usa directamente el output de api_generate_token:
    activeToken = newCachedTokenInfo?.sessionAuthToken || currentParameters.newAuthToken || null;
    if (activeToken) {
        logger.info({sessionId, script: "setActiveToken"}, "Using newly generated and cached token as active token.");
    } else {
        logger.warn({sessionId, script: "setActiveToken"}, "needsNewToken was true, but no new token seems available from api_generate_token/cacheNewTokenScript outputs.");
    }
  } else if (manageResult?.activeAuthToken) {
    // No se necesitaba un nuevo token, el existente (de sesión o caché global) es válido.
    activeToken = manageResult.activeAuthToken;
    logger.info({sessionId, script: "setActiveToken"}, "Using existing valid token as active token.");
  } else {
    // Caso inesperado: manageTokenScript no indicó necesidad de nuevo token, pero tampoco proveyó uno activo.
    // Esto podría pasar si manageTokenScript no encontró token y no se configuró para requerir uno nuevo explícitamente,
    // o si su lógica interna tiene algún caso no cubierto.
    logger.warn({sessionId, script: "setActiveToken", manageResult}, "Could not determine active token. manageTokenScript result was inconclusive or new token flow failed.");
  }

  if (!activeToken) {
    logger.error({sessionId, script: "setActiveToken"}, "Failed to determine an active API token for subsequent calls.");
    return { status: "ERROR", message: "Failed to determine active API token." };
  }

  return {
    status: "SUCCESS",
    output: activeToken // Simplemente devuelve el token string
  };
}

module.exports = {
  determineActiveToken
};
