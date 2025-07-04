// scripts/simulateApiResponder.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const redisClient = require('../src/redisClient');
const logger = require('../src/logger');
const { getApiConfigById } = require('../src/apiConfigLoader'); // To get API details for mock data

// This script is now a one-shot tool to add a specific response to a Redis Stream.
// It simulates an external worker that has processed an API call and is now reporting the result.

// Usage: node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [customDataJsonString]
// Example: node scripts/simulateApiResponder.js api_responses_stream:sess123:corr789 sess123 corr789 fetch_doctor_availability success 200 '{"custom_field":"custom_value"}'
// Example (error): node scripts/simulateApiResponder.js api_responses_stream:sess123:corr789 sess123 corr789 fetch_doctor_availability error 503 '{"error_detail":"Service unavailable"}'

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    logger.error('Usage: node simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [customDataJsonString]');
    process.exit(1);
  }

  const [responseStreamKey, sessionId, correlationId, apiId, statusArg, httpCodeArg, customDataJsonString] = args;

  const status = statusArg || 'success'; // Default to success
  const httpCode = parseInt(httpCodeArg, 10) || (status === 'success' ? 200 : 500);
  const isTimeout = status === 'error' && (httpCodeArg === 'TIMEOUT' || (httpCodeArg === '504' || httpCode === 504));


  logger.info({ responseStreamKey, sessionId, correlationId, apiId, status, httpCode, customDataJsonString }, 'Simulating API response.');

  await redisClient.connect(); // Ensure Redis is connected

  let responsePayload = {
    correlationId,
    sessionId,
    apiId,
    status,
    httpCode: httpCode || null, // Ensure null if not a valid number
    data: null,
    errorMessage: null,
    isTimeout: isTimeout,
    timestamp: new Date().toISOString(),
  };

  if (status === 'success') {
    if (customDataJsonString) {
        try {
            responsePayload.data = JSON.parse(customDataJsonString);
        } catch (e) {
            logger.warn({customDataJsonString, err: e}, "Could not parse customDataJsonString, using default mock.");
            responsePayload.data = { message: `Successfully processed ${apiId}`, defaultMock: true };
        }
    } else {
        // Generate some default mock data based on apiId if no custom data provided
        if (apiId === 'fetch_doctor_availability') {
            responsePayload.data = {
                doctors: [
                    { id: 'docSim1', name: 'Dr. Simulated One', specialty: 'Cardiology', slots: ['1PM', '3PM'] },
                    { id: 'docSim2', name: 'Dr. Virtual Two', specialty: 'Cardiology', slots: ['2PM', '4PM'] },
                ],
                source: 'simulator'
            };
        } else if (apiId === 'submit_appointment_booking') {
            responsePayload.data = {
                bookingId: `simBK-${uuidv4().slice(0,8)}`,
                status: 'CONFIRMED_BY_SIMULATOR',
                message: 'Appointment booking request received by simulator.'
            };
        } else {
            responsePayload.data = { message: `Successfully processed ${apiId}`, defaultMock: true };
        }
    }
  } else { // Error status
    if (customDataJsonString) {
        try {
            const customErrorData = JSON.parse(customDataJsonString);
            responsePayload.errorMessage = customErrorData.errorMessage || customErrorData.message || `Simulated error for ${apiId}`;
            if(customErrorData.detail) responsePayload.data = customErrorData.detail; // Put extra error details in 'data' if any
        } catch(e) {
             logger.warn({customDataJsonString, err: e}, "Could not parse customDataJsonString for error, using default mock error.");
            responsePayload.errorMessage = isTimeout ? `Simulated TIMEOUT for ${apiId}` : `Simulated error for ${apiId}`;
        }
    } else {
        responsePayload.errorMessage = isTimeout ? `Simulated TIMEOUT for ${apiId}` : `Simulated error for ${apiId}`;
    }
    if (isTimeout) responsePayload.httpCode = null; // Typically timeouts don't have HTTP codes from target
  }

  // Convert payload to field-value array for XADD
  // All values in the stream message MUST be strings.
  const messageFields = [];
  for (const key in responsePayload) {
    messageFields.push(key, JSON.stringify(responsePayload[key])); // Stringify each value
  }

  try {
    const messageId = await redisClient.xadd(responseStreamKey, '*', ...messageFields);
    logger.info({ responseStreamKey, messageId, payloadSent: responsePayload }, 'Successfully added simulated API response to Redis Stream.');
  } catch (err) {
    logger.error({ err, responseStreamKey, payload: responsePayload }, 'Error adding message to Redis Stream.');
  } finally {
    await redisClient.quit();
  }
}

main().catch(err => {
  logger.fatal({ err }, 'Unhandled error in simulateApiResponder main.');
  process.exit(1);
});
