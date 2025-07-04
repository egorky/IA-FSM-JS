// src/apiCallerService.js
const axios = require('axios');
const logger = require('./logger');
const { getApiConfigById } = require('./apiConfigLoader');
const { processTemplate } = require('./templateProcessor'); // Assuming this can process simple objects/strings
const redisClient = require('./redisClient'); // To write to Redis Stream (or a log for now)

// This service INITIATES async calls.
// A separate worker/process would listen for the actual 3rd party API responses
// and then write them to the Redis Stream defined in `response_stream_key_template`.

/**
 * Makes an asynchronous HTTP request based on a loaded API configuration.
 * This function dispatches the request and logs its initiation. It does not await the HTTP response itself.
 * The actual response from the third-party API is expected to be written to a Redis Stream
 * by an external worker/process.
 *
 * @param {string} apiId - The ID of the API to call (from config/api_definitions).
 * @param {string} sessionId - The current session ID.
 * @param {string} correlationId - A unique ID to correlate this request with its eventual response.
 * @param {object} collectedParameters - Parameters collected so far in the FSM session, for templating.
 * @returns {Promise<boolean>} True if the request was successfully dispatched, false otherwise.
 */
async function makeRequest(apiId, sessionId, correlationId, collectedParameters) {
  const apiConfig = getApiConfigById(apiId);

  if (!apiConfig) {
    logger.error({ apiId, sessionId, correlationId }, 'apiCallerService: API configuration not found.');
    return false;
  }

  logger.info({ apiId, sessionId, correlationId, apiConfigUrl: apiConfig.url }, 'apiCallerService: Preparing to make request.');

  // Prepare context for template processing, including sessionId and correlationId
  const templateContext = {
    ...collectedParameters,
    sessionId,
    correlationId,
    system_api_key: process.env.SYSTEM_WIDE_API_KEY || '' // Example of a system-level parameter
  };

  let url = apiConfig.url;
  try {
    url = processTemplate(apiConfig.url, templateContext);
  } catch (e) {
    logger.error({ err: e, apiId, urlTemplate: apiConfig.url }, "apiCallerService: Error processing URL template.");
    return false;
  }

  const headers = {};
  if (apiConfig.headers) {
    try {
      for (const key in apiConfig.headers) {
        headers[key] = processTemplate(apiConfig.headers[key], templateContext);
      }
    } catch (e) {
      logger.error({ err: e, apiId, headerTemplate: apiConfig.headers }, "apiCallerService: Error processing headers template.");
      return false;
    }
  }

  let body = null;
  if (apiConfig.method && ['POST', 'PUT', 'PATCH'].includes(apiConfig.method.toUpperCase())) {
    if (apiConfig.body_template) {
      try {
        // processTemplate expects a string or a structure where strings will be processed.
        // If body_template is an object, it should recursively process string values.
        body = processTemplate(JSON.parse(JSON.stringify(apiConfig.body_template)), templateContext);
      } catch (e) {
        logger.error({ err: e, apiId, bodyTemplate: apiConfig.body_template }, "apiCallerService: Error processing body template.");
        return false;
      }
    }
  }

  let queryParams = null;
  if (apiConfig.method && apiConfig.method.toUpperCase() === 'GET' && apiConfig.query_params_template) {
    try {
        queryParams = processTemplate(JSON.parse(JSON.stringify(apiConfig.query_params_template)), templateContext);
        // Filter out any params that didn't resolve or are empty, if desired
        queryParams = Object.entries(queryParams).reduce((acc, [key, value]) => {
            if (value !== undefined && value !== null && value !== '') acc[key] = value;
            return acc;
        }, {});
    } catch (e) {
        logger.error({ err: e, apiId, queryParamsTemplate: apiConfig.query_params_template }, "apiCallerService: Error processing query_params template.");
        return false;
    }
  }


  const requestConfig = {
    method: apiConfig.method,
    url: url,
    headers: headers,
    data: body,
    params: queryParams, // Axios uses 'params' for URL query parameters
    timeout: apiConfig.timeout_ms || 10000, // Default timeout if not specified
  };

  logger.debug({ apiId, sessionId, correlationId, requestConfig: { ...requestConfig, data: body ? 'OMITTED_FOR_LOG' : null } }, 'apiCallerService: Dispatching HTTP request.');

  // Fire and forget the actual HTTP call.
  // The external API's response will be handled by another system/worker
  // which will then publish a message to the appropriate Redis Stream.
  axios(requestConfig)
    .then(response => {
      // This is where the EXTERNAL WORKER would pick up.
      // For our app, we just log that the call was made. The worker is responsible for the stream write.
      logger.info({ apiId, sessionId, correlationId, status: response.status }, 'apiCallerService: HTTP request dispatched successfully (actual response handling is external).');
      // In a real scenario, the external worker would get response.data, response.status
      // and write to the stream: apiConfig.response_stream_key_template (rendered)
      // Example message to stream:
      // { correlationId, status: "success", http_code: response.status, data: response.data, timestamp: new Date().toISOString() }
    })
    .catch(error => {
      // This is also where the EXTERNAL WORKER would pick up an error.
      logger.error({
        err: error.message, // Log only message to avoid large objects if error.response is big
        apiId,
        sessionId,
        correlationId,
        isTimeout: error.code === 'ECONNABORTED',
        responseData: error.response ? { status: error.response.status, data: error.response.data } : null
      }, 'apiCallerService: HTTP request dispatch failed or resulted in error (actual error handling and stream write is external).');
      // Example error message to stream:
      // { correlationId, status: "error", http_code: error.response?.status, error_message: error.message, isTimeout: error.code === 'ECONNABORTED', timestamp: new Date().toISOString() }
    });

  // We return true because the request dispatch process was initiated.
  // The success/failure of the actual HTTP call is handled asynchronously and reported via Redis Stream by an external entity.
  return true;
}

module.exports = {
  makeRequest,
};
