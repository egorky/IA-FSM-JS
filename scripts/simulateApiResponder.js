// scripts/simulateApiResponder.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') }); // Load .env from root
const redisClient = require('../src/redisClient');
const logger = require('../src/logger');

const API_REQUEST_QUEUE_KEY = 'fsm_api_request_queue'; // Must match fsm.js
const API_RESPONSE_KEY_PREFIX = 'api_response:'; // Prefix for storing responses
const POLLING_INTERVAL_MS = 3000; // Poll every 3 seconds
const RESPONSE_TTL_SECONDS = 300; // Store response for 5 minutes

async function processRequest(requestDetails) {
  logger.info({ requestDetails }, 'API Responder: Processing request');
  const { sessionId, correlationId, type, requestParams } = requestDetails;

  let responseData = {};

  // Simulate different API responses based on type
  if (type === 'fetch_doctors_for_specialty') {
    responseData = {
      doctors: [
        { id: 'doc123', name: 'Dr. Alice Smith', specialty: requestParams.specialty || 'Unknown', availableSlots: ['10:00 AM', '2:00 PM'] },
        { id: 'doc456', name: 'Dr. Bob Johnson', specialty: requestParams.specialty || 'Unknown', availableSlots: ['11:00 AM', '3:00 PM'] },
      ],
      notes: `Found doctors for specialty: ${requestParams.specialty}. Location preference was: ${requestParams.locationPreference || 'any'}.`,
    };
  } else if (type === 'another_api_type') {
    responseData = {
      message: 'Response from another_api_type',
      data: requestParams,
    };
  } else {
    logger.warn({ type }, 'API Responder: Unknown API request type');
    responseData = { error: 'Unknown API request type', requestType: type };
  }

  const responseKey = `${API_RESPONSE_KEY_PREFIX}${sessionId}:${correlationId}`;
  try {
    await redisClient.set(responseKey, JSON.stringify(responseData), 'EX', RESPONSE_TTL_SECONDS);
    logger.info({ responseKey, responseData, ttl: RESPONSE_TTL_SECONDS }, 'API Responder: Response stored in Redis.');
  } catch (err) {
    logger.error({ err, responseKey }, 'API Responder: Error storing response in Redis.');
  }
}

async function pollQueue() {
  logger.debug('API Responder: Polling API request queue...');
  try {
    const requestJson = await redisClient.rpop(API_REQUEST_QUEUE_KEY);
    if (requestJson) {
      try {
        const requestDetails = JSON.parse(requestJson);
        await processRequest(requestDetails);
      } catch (parseError) {
        logger.error({ err: parseError, requestJson }, 'API Responder: Error parsing request from queue.');
        // Potentially push back to queue or to a dead-letter queue if needed
      }
    }
  } catch (err) {
    logger.error({ err }, 'API Responder: Error polling Redis queue.');
  }
  setTimeout(pollQueue, POLLING_INTERVAL_MS); // Continue polling
}

async function main() {
  logger.info('Starting Simulated API Responder...');
  try {
    await redisClient.connect(); // Ensure Redis client is connected
    logger.info('API Responder: Connected to Redis.');
    pollQueue();
  } catch (err) {
    logger.fatal({ err }, 'API Responder: Could not connect to Redis. Exiting.');
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('API Responder: Shutting down...');
  if (redisClient.getClient()) { // Check if client exists
    await redisClient.quit();
    logger.info('API Responder: Redis connection closed.');
  }
  process.exit(0);
});
