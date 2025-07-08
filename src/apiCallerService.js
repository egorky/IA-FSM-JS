// src/apiCallerService.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { getApiConfigById: getOriginalApiConfigById, getAllApiConfigs } = require('./apiConfigLoader'); // Renombrar para evitar conflicto y añadir getAll
const { processTemplate } = require('./templateProcessor');
const authService = require('./authService'); // NUEVO IMPORT
const redisClient = require('./redisClient'); // NUEVO IMPORT para DEMO_MODE async

const DEMO_MODE = process.env.DEMO_MODE === 'true';

// Wrapper para asegurar que la config de API siempre se cargue
function getApiConfigById(apiId) {
    const config = getOriginalApiConfigById(apiId);
    if (!config) {
        // Este log ya existe en los llamadores, pero una doble seguridad.
        logger.error({ apiId }, `apiCallerService: API configuration not found for apiId.`);
    }
    return config;
}


/**
 * Processes API call details (URL, headers, body, query_params) using templates.
 */
function prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters, sessionData /* NUEVO */) {
  const templateContext = {
    ...collectedParameters,
    sessionId,
    correlationId,
    system_api_key: process.env.SYSTEM_WIDE_API_KEY || '', // Example system-level param
  };

  let url = apiConfig.url;
  try {
    url = processTemplate(apiConfig.url, templateContext);
  } catch (e) {
    logger.error({ err: e, apiId: apiConfig.apiId, urlTemplate: apiConfig.url }, "apiCallerService: Error processing URL template.");
    throw new Error(`URL template processing error for ${apiConfig.apiId}`);
  }

  const headers = {};
  if (apiConfig.headers) {
    try {
      for (const key in apiConfig.headers) {
        headers[key] = processTemplate(apiConfig.headers[key], templateContext);
      }
    } catch (e) {
      logger.error({ err: e, apiId: apiConfig.apiId, headerTemplate: apiConfig.headers }, "apiCallerService: Error processing headers template.");
      throw new Error(`Headers template processing error for ${apiConfig.apiId}`);
    }
  }

  let body = null;
  if (apiConfig.method && ['POST', 'PUT', 'PATCH'].includes(apiConfig.method.toUpperCase())) {
    if (apiConfig.body_template) {
      try {
        body = processTemplate(JSON.parse(JSON.stringify(apiConfig.body_template)), templateContext);
      } catch (e) {
        logger.error({ err: e, apiId: apiConfig.apiId, bodyTemplate: apiConfig.body_template }, "apiCallerService: Error processing body template.");
        throw new Error(`Body template processing error for ${apiConfig.apiId}`);
      }
    }
  }

  let queryParams = null;
  if (apiConfig.method && apiConfig.method.toUpperCase() === 'GET' && apiConfig.query_params_template) {
    try {
      queryParams = processTemplate(JSON.parse(JSON.stringify(apiConfig.query_params_template)), templateContext);
      queryParams = Object.entries(queryParams).reduce((acc, [key, value]) => {
        if (value !== undefined && value !== null && value !== '') acc[key] = value;
        return acc;
      }, {});
    } catch (e) {
      logger.error({ err: e, apiId: apiConfig.apiId, queryParamsTemplate: apiConfig.query_params_template }, "apiCallerService: Error processing query_params template.");
      throw new Error(`Query params template processing error for ${apiConfig.apiId}`);
    }
  }

  return {
    method: apiConfig.method,
    url: url,
    headers: headers,
    data: body,
    params: queryParams,
    timeout: apiConfig.timeout_ms || parseInt(process.env.DEFAULT_API_TIMEOUT_MS, 10) || 10000,
  };
}

/**
 * Makes an asynchronous HTTP request (fire-and-forget).
 * The actual response from the third-party API is expected to be written to a Redis Stream
 * by an external worker/process. This service only dispatches the call.
 */
async function makeRequestAsync(apiId, sessionId, correlationId, collectedParameters, sessionData) { // Added sessionData
  const apiConfig = getApiConfigById(apiId);
  if (!apiConfig) {
    logger.error({ apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAsync: API configuration not found.');
    // For async, we might still dispatch a "failure" to the stream, or just log and return.
    // For now, returning false as it cannot proceed.
    return false;
  }

  logger.info({ apiId, sessionId, correlationId, url: apiConfig.url, DEMO_MODE }, 'apiCallerService.makeRequestAsync: Preparing to dispatch.');

  // In DEMO_MODE, for async calls that are NOT token generation, we will make a real HTTP call to the local demo server.
  // The local demo server will then be responsible for putting a message on the Redis Stream.
  // Token generation APIs (if async, though unusual) would be handled differently if needed,
  // but typically token gen is sync. For now, all async go to demo server if DEMO_MODE.

  // Actual API call logic (targets demo server if DEMO_MODE is true and URL was overridden by apiConfigLoader)
  try {
    let requestConfig = prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters, sessionData);

    if (DEMO_MODE && apiConfig.response_stream_key_template) { // If it's an async call in demo mode
        requestConfig.headers = {
            ...requestConfig.headers,
            'X-Session-ID': sessionId,
            'X-Correlation-ID': correlationId,
        };
        logger.debug({ apiId, sessionId, correlationId }, "DEMO_MODE: Added X-Session-ID and X-Correlation-ID headers for async call to demo server.");
    }

    if (apiConfig.authentication && apiConfig.authentication.authProfileId) {
      logger.debug({ apiId, sessionId, authProfileId: apiConfig.authentication.authProfileId }, "API requires authentication (async).");
      const tokenInfo = await authService.getValidToken(
        apiConfig.authentication.authProfileId,
        collectedParameters,
        sessionData,
        sessionId
      );

      if (tokenInfo && tokenInfo.tokenValue) {
        const placement = apiConfig.authentication.tokenPlacement;
        if (placement.in === "HEADER") {
          const scheme = placement.scheme ? `${placement.scheme} ` : "";
          requestConfig.headers = { ...requestConfig.headers, [placement.name]: `${scheme}${tokenInfo.tokenValue}` };
        } else if (placement.in === "QUERY_PARAMETER") {
          requestConfig.params = { ...requestConfig.params, [placement.name]: tokenInfo.tokenValue };
        }
        logger.debug({ apiId, sessionId }, "Auth token applied for async request.");
      } else {
        logger.error({ apiId, sessionId, authProfileId: apiConfig.authentication.authProfileId }, "Failed to obtain auth token for async API. Dispatching without auth.");
        // Decide if we dispatch a call that will fail, or an error message to the stream.
        // For now, it will dispatch without auth, likely causing API to fail.
        // A more robust solution might involve the external worker simulating an auth error if token is missing.
      }
    }

    logger.debug({ apiId, sessionId, correlationId, requestConfig: { ...requestConfig, data: requestconfig.data ? 'OMITTED_FOR_LOG' : null } }, 'apiCallerService.makeRequestAsync: Dispatching HTTP request.');

    axios(requestConfig)
      .then(response => {
        logger.info({ apiId, sessionId, correlationId, status: response.status }, 'apiCallerService.makeRequestAsync: HTTP request dispatched (external worker handles response).');
      })
      .catch(error => {
        logger.error({
          err: error.message, apiId, sessionId, correlationId,
          isTimeout: error.code === 'ECONNABORTED',
          responseData: error.response ? { status: error.response.status, data: error.response.data } : null
        }, 'apiCallerService.makeRequestAsync: HTTP dispatch failed or resulted in error.');
      });
    return true; // Dispatch initiated
  } catch (processingError) {
    logger.error({ err: processingError, apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAsync: Failed to prepare/process request config.');
    return false;
  }
}

/**
 * Makes a synchronous HTTP request and waits for the response or timeout.
 * Returns a structured response/error object.
 */
async function makeRequestAndWait(apiId, sessionId, correlationId, collectedParameters, sessionData) { // Added sessionData
  const apiConfig = getApiConfigById(apiId);
  if (!apiConfig) {
    logger.error({ apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAndWait: API configuration not found.');
    return { status: 'error', errorMessage: 'API configuration not found', httpCode: null, isTimeout: false, data: null, isAuthError: false };
  }

  logger.info({ apiId, sessionId, correlationId, url: apiConfig.url, DEMO_MODE }, 'apiCallerService.makeRequestAndWait: Preparing and making synchronous request.');

  if (DEMO_MODE && (apiId === 'api_generate_token' || apiId === 'api_generate_system_token')) {
    logger.warn({ apiId, sessionId, correlationId }, 'DEMO_MODE: Simulating synchronous API response for TOKEN GENERATION.');
    // Special handling for token generation API in DEMO_MODE - return hardcoded token
    return {
        status: 'success',
        httpCode: 200,
        data: { // Consistent with producesParameters of api_generate_token.json
            access_token: 'DEMO_ACCESS_TOKEN_12345_67890',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'read write demo_scope'
        },
        errorMessage: null,
        isTimeout: false,
        isDemoAuthToken: true // Mark that this is a demo auth token
    };
  }
  // For other APIs in DEMO_MODE, or if not in DEMO_MODE at all, proceed to actual call.
  // If DEMO_MODE is true, the URL in requestConfig will point to the local demo server.

  // Actual API call logic (targets demo server if DEMO_MODE is true and URL was overridden)
  try {
    let requestConfig = prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters, sessionData);

    if (apiConfig.authentication && apiConfig.authentication.authProfileId) {
      logger.debug({ apiId, sessionId, authProfileId: apiConfig.authentication.authProfileId }, "API requires authentication (sync).");
      const tokenInfo = await authService.getValidToken(
        apiConfig.authentication.authProfileId,
        collectedParameters,
        sessionData,
        sessionId
      );

      if (tokenInfo && tokenInfo.tokenValue) {
        const placement = apiConfig.authentication.tokenPlacement;
        if (placement.in === "HEADER") {
          const scheme = placement.scheme ? `${placement.scheme} ` : "";
          requestConfig.headers = { ...requestConfig.headers, [placement.name]: `${scheme}${tokenInfo.tokenValue}` };
        } else if (placement.in === "QUERY_PARAMETER") {
          requestConfig.params = { ...requestConfig.params, [placement.name]: tokenInfo.tokenValue };
        }
        logger.debug({ apiId, sessionId }, "Auth token applied for sync request.");
      } else {
        logger.error({ apiId, sessionId, authProfileId: apiConfig.authentication.authProfileId }, "Failed to obtain valid authentication token for sync API.");
        return { status: 'error', errorMessage: `Failed to obtain auth token for API ${apiId}`, httpCode: 401, isTimeout: false, data: null, isAuthError: true };
      }
    }

    logger.debug({ apiId, sessionId, correlationId, requestConfig: { ...requestConfig, data: requestConfig.data ? 'OMITTED_FOR_LOG' : null } }, 'apiCallerService.makeRequestAndWait: Executing HTTP request.');

    const response = await axios(requestConfig);
    logger.info({ apiId, sessionId, correlationId, status: response.status }, 'apiCallerService.makeRequestAndWait: Synchronous HTTP request successful.');
    return {
      status: 'success',
      httpCode: response.status,
      data: response.data,
      errorMessage: null,
      isTimeout: false,
    };
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED';
    logger.error({
      err: error.message, apiId, sessionId, correlationId, isTimeout,
      responseData: error.response ? { status: error.response.status, data: error.response.data } : null
    }, 'apiCallerService.makeRequestAndWait: Synchronous HTTP request failed or timed out.');
    return {
      status: 'error',
      httpCode: error.response?.status || null,
      data: error.response?.data || null,
      errorMessage: error.message,
      isTimeout: isTimeout,
    };
  }
}

module.exports = {
  makeRequestAsync,     // For fire-and-forget calls (responses via Redis Stream)
  makeRequestAndWait, // For calls where the FSM needs the response in the same turn
};
