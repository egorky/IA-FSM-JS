// src/apiConfigLoader.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { DEMO_MODE, DEMO_API_BASE_PORT } = require('./configConstants');

const API_DEFINITIONS_DIR = path.join(__dirname, '../config/api_definitions');
let apiConfigurations = {}; // Cache for loaded API configurations

/**
 * Loads all API definition JSON files from the config/api_definitions directory.
 * Parses them and stores them in the apiConfigurations cache.
 * If DEMO_MODE is active, it overrides url_template to point to local demo servers.
 */
function loadAllApiConfigs() {
  try {
    if (!fs.existsSync(API_DEFINITIONS_DIR)) {
      logger.warn(`API definitions directory not found: ${API_DEFINITIONS_DIR}. No external APIs will be configured.`);
      apiConfigurations = {};
      return;
    }

    const files = fs.readdirSync(API_DEFINITIONS_DIR);
    const tempConfigs = {};

    files.forEach(file => {
      if (path.extname(file) === '.json') {
        const filePath = path.join(API_DEFINITIONS_DIR, file);
        try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          let config = JSON.parse(fileContent);
          if (config.apiId) {
            if (DEMO_MODE && config.url_template) {
              try {
                const originalUrl = new URL(config.url_template.startsWith('http') ? config.url_template : `http://dummybase.com${config.url_template}`);
                const demoPath = originalUrl.pathname;
                const newDemoUrl = `http://127.0.0.1:${DEMO_API_BASE_PORT}${demoPath}`;
                logger.info({ apiId: config.apiId, original: config.url_template, new: newDemoUrl }, "DEMO_MODE: Overriding API URL to local demo server.");
                config.url_template = newDemoUrl; // Override URL
                config.isDemoOverridden = true; // Mark as overridden
              } catch (urlParseError) {
                logger.error({ apiId: config.apiId, url_template: config.url_template, err: urlParseError }, "DEMO_MODE: Failed to parse and override URL for demo server. Using original.");
              }
            }
            tempConfigs[config.apiId] = config;
            logger.debug(`Loaded API configuration for: ${config.apiId}${DEMO_MODE && config.isDemoOverridden ? ' (URL overridden for DEMO)' : ''}`);
          } else {
            logger.warn(`API configuration file ${file} is missing 'apiId'. Skipping.`);
          }
        } catch (error) {
          logger.error({ err: error, file: filePath }, `Error parsing API configuration file.`);
        }
      }
    });
    apiConfigurations = tempConfigs; // Atomic update of the cache
    logger.info(`Successfully loaded ${Object.keys(apiConfigurations).length} API configurations.${DEMO_MODE ? ' (DEMO_MODE active, URLs may be overridden)' : ''}`);
  } catch (error) {
    logger.error({ err: error, directory: API_DEFINITIONS_DIR }, 'Error reading API definitions directory.');
    apiConfigurations = {}; // Reset cache on error
  }
}

/**
 * Retrieves a specific API configuration by its ID.
 * If DEMO_MODE is active, the returned config may have its url_template overridden.
 * @param {string} apiId - The ID of the API configuration to retrieve.
 * @returns {object | undefined} The API configuration object, or undefined if not found.
 */
function getApiConfigById(apiId) {
  if (Object.keys(apiConfigurations).length === 0) {
    // Attempt to load if cache is empty (e.g., first call or after an error)
    // In a server context, this loadAllApiConfigs() would typically be called once at startup.
    // For robustness in different usage scenarios, we can add a lazy load here.
    logger.info('API configurations cache is empty, attempting to load now...');
    loadAllApiConfigs();
  }
  if (!apiConfigurations[apiId]) {
    logger.warn({ apiId }, `API configuration not found for apiId.`);
    return undefined;
  }
  return apiConfigurations[apiId];
}

// Initial load of all configurations when the module is first required.
loadAllApiConfigs();

module.exports = {
  loadAllApiConfigs, // Expose for potential manual reloading
  getApiConfigById,
  getAllApiConfigs: () => apiConfigurations // For debugging or other potential uses
};
