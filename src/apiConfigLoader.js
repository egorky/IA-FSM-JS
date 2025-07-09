// src/apiConfigLoader.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { DEMO_MODE } = require('./configConstants'); // DEMO_API_BASE_PORT no longer needed here

const STANDARD_API_DEFINITIONS_DIR = path.join(__dirname, '../config/api_definitions');
const DEMO_API_DEFINITIONS_DIR = path.join(__dirname, '../config/api_definitions_demo');
let apiConfigurations = {}; // Cache for loaded API configurations

/**
 * Loads all API definition JSON files from the appropriate directory based on DEMO_MODE.
 * Parses them and stores them in the apiConfigurations cache.
 */
function loadAllApiConfigs() {
  let definitionsDirToLoad = STANDARD_API_DEFINITIONS_DIR;
  let mode = "STANDARD";

  if (DEMO_MODE) {
    if (fs.existsSync(DEMO_API_DEFINITIONS_DIR)) {
      const demoFiles = fs.readdirSync(DEMO_API_DEFINITIONS_DIR).filter(f => path.extname(f) === '.json');
      if (demoFiles.length > 0) {
        definitionsDirToLoad = DEMO_API_DEFINITIONS_DIR;
        mode = "DEMO";
        logger.info(`DEMO_MODE: Loading API definitions from ${DEMO_API_DEFINITIONS_DIR}`);
      } else {
        logger.warn(`DEMO_MODE: Directory ${DEMO_API_DEFINITIONS_DIR} is empty. Falling back to standard API definitions.`);
      }
    } else {
      logger.warn(`DEMO_MODE: Directory ${DEMO_API_DEFINITIONS_DIR} not found. Falling back to standard API definitions.`);
    }
  }

  try {
    if (!fs.existsSync(definitionsDirToLoad)) {
      logger.warn(`API definitions directory not found: ${definitionsDirToLoad}. No external APIs will be configured.`);
      apiConfigurations = {};
      return;
    }

    const files = fs.readdirSync(definitionsDirToLoad);
    const tempConfigs = {};

    files.forEach(file => {
      if (path.extname(file) === '.json') {
        const filePath = path.join(definitionsDirToLoad, file);
        try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const config = JSON.parse(fileContent); // No URL overriding here
          if (config.apiId) {
            tempConfigs[config.apiId] = config;
            logger.debug(`Loaded API configuration for: ${config.apiId} (Mode: ${mode})`);
          } else {
            logger.warn(`API configuration file ${file} (Mode: ${mode}) is missing 'apiId'. Skipping.`);
          }
        } catch (error) {
          logger.error({ err: error, file: filePath, mode }, `Error parsing API configuration file.`);
        }
      }
    });
    apiConfigurations = tempConfigs; // Atomic update of the cache
    logger.info(`Successfully loaded ${Object.keys(apiConfigurations).length} API configurations (Mode: ${mode}).`);
  } catch (error) {
    logger.error({ err: error, directory: definitionsDirToLoad, mode }, 'Error reading API definitions directory.');
    apiConfigurations = {}; // Reset cache on error
  }
}

/**
 * Retrieves a specific API configuration by its ID.
 * The configuration loaded depends on DEMO_MODE (from demo or standard directory).
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
