// src/apiCallerService.js
const axios = require('axios');
const logger = require('./logger');
const { getApiConfigById } = require('./apiConfigLoader');
const { processTemplate } = require('./templateProcessor');

/**
 * Processes API call details (URL, headers, body, query_params) using templates.
 */
function prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters) {
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
async function makeRequestAsync(apiId, sessionId, correlationId, collectedParameters) {
  const apiConfig = getApiConfigById(apiId);
  if (!apiConfig) {
    logger.error({ apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAsync: API configuration not found.');
    return false; // Or throw an error
  }

  logger.info({ apiId, sessionId, correlationId, url: apiConfig.url }, 'apiCallerService.makeRequestAsync: Preparing to dispatch.');

  try {
    const requestConfig = prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters);
    logger.debug({ apiId, sessionId, correlationId, requestConfig: { ...requestConfig, data: requestConfig.data ? 'OMITTED_FOR_LOG' : null } }, 'apiCallerService.makeRequestAsync: Dispatching HTTP request.');

    // Fire and forget
    axios(requestConfig)
      .then(response => {
        logger.info({ apiId, sessionId, correlationId, status: response.status }, 'apiCallerService.makeRequestAsync: HTTP request dispatched successfully (external worker handles response to stream).');
        // External worker would now take response.data, response.status, etc.,
        // and XADD to apiConfig.response_stream_key_template (rendered).
      })
      .catch(error => {
        logger.error({
          err: error.message, apiId, sessionId, correlationId,
          isTimeout: error.code === 'ECONNABORTED',
          responseData: error.response ? { status: error.response.status, data: error.response.data } : null
        }, 'apiCallerService.makeRequestAsync: HTTP request dispatch failed or resulted in error (external worker handles error reporting to stream).');
      });
    return true; // Dispatch initiated
  } catch (processingError) {
    // Error during request config preparation
    logger.error({ err: processingError, apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAsync: Failed to prepare request config.');
    return false;
  }
}

/**
 * Makes a synchronous HTTP request and waits for the response or timeout.
 * Returns a structured response/error object.
 */
async function makeRequestAndWait(apiId, sessionId, correlationId, collectedParameters) {
  const apiConfig = getApiConfigById(apiId);
  if (!apiConfig) {
    logger.error({ apiId, sessionId, correlationId }, 'apiCallerService.makeRequestAndWait: API configuration not found.');
    return { status: 'error', errorMessage: 'API configuration not found', httpCode: null, isTimeout: false, data: null };
  }

  logger.info({ apiId, sessionId, correlationId, url: apiConfig.url }, 'apiCallerService.makeRequestAndWait: Preparing and making synchronous request.');

  try {
    const requestConfig = prepareRequestConfig(apiConfig, sessionId, correlationId, collectedParameters);
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
