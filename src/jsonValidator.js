// src/jsonValidator.js
const Ajv = require('ajv');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let ajv;
let schema;

const SCHEMA_PATH = path.join(__dirname, '../config/aiResponseSchema.json');

function loadSchema() {
  try {
    if (fs.existsSync(SCHEMA_PATH)) {
      const schemaFile = fs.readFileSync(SCHEMA_PATH, 'utf-8');
      schema = JSON.parse(schemaFile);
      ajv = new Ajv(); // options can be added here if needed
      logger.info('AI response JSON schema loaded successfully.');
    } else {
      logger.warn(`AI response JSON schema file not found at ${SCHEMA_PATH}. Validation will be skipped.`);
      schema = null;
      ajv = null;
    }
  } catch (error) {
    logger.error({ err: error, schemaPath: SCHEMA_PATH }, 'Error loading AI response JSON schema');
    schema = null;
    ajv = null;
  }
}

// Load schema on module initialization
loadSchema();

/**
 * Validates a JSON object against the pre-loaded AI response schema.
 * @param {object} jsonResponse The JSON object to validate.
 * @returns {{isValid: boolean, errors: object[] | null}} Validation result.
 */
function validateJson(jsonResponse) {
  if (!ajv || !schema) {
    logger.warn('AJV or schema not initialized, skipping JSON schema validation.');
    // If no schema is loaded, consider it valid to not block the flow,
    // but this might need adjustment based on strictness requirements.
    return { isValid: true, errors: null };
  }

  const validate = ajv.compile(schema);
  const isValid = validate(jsonResponse);

  if (!isValid) {
    logger.warn({ errors: validate.errors, response: jsonResponse }, 'AI Response JSON validation failed against schema.');
    return { isValid: false, errors: validate.errors };
  }

  logger.debug({ response: jsonResponse }, 'AI Response JSON validated successfully against schema.');
  return { isValid: true, errors: null };
}

module.exports = {
  validateJson,
  loadSchema, // Expose for potential re-loading if needed
};
