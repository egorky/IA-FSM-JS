// src/configConstants.js
const logger = require('./logger');

const DEMO_MODE = process.env.DEMO_MODE === 'true';

if (DEMO_MODE) {
  logger.warn('DEMO_MODE is active globally (read from configConstants.js).');
}

module.exports = {
  DEMO_MODE,
  DEMO_API_BASE_PORT: parseInt(process.env.DEMO_API_BASE_PORT, 10) || 7080,
};
