// config/customAIResponseValidator.js
// const logger = require('../src/logger'); // Optional: if you need logging within this custom validator

/**
 * Performs custom validation on the AI's JSON response.
 * This function is called after the JSON schema validation.
 *
 * @param {object} jsonResponse The JSON object output by the AI.
 * @returns {{isValid: boolean, message?: string, validatedResponse?: object}}
 *          isValid: true if the response passes custom validation, false otherwise.
 *          message: Optional. A message explaining why validation failed or succeeded.
 *          validatedResponse: Optional. The potentially modified/cleaned response. If not provided, jsonResponse is used.
 */
function validateAIResponse(jsonResponse) {
  // Example 1: Ensure that if intent is 'schedule_appointment', certain parameters exist.
  if (jsonResponse.intent === 'schedule_appointment') {
    const requiredParams = ['medical_specialty', 'appointment_date', 'appointment_time'];
    for (const param of requiredParams) {
      if (!jsonResponse.parameters || typeof jsonResponse.parameters[param] === 'undefined') {
        return {
          isValid: false,
          message: `Custom Validation: For intent 'schedule_appointment', parameter '${param}' is missing.`,
        };
      }
    }
  }

  // Example 2: Check for known problematic parameter values.
  if (jsonResponse.parameters && jsonResponse.parameters.some_parameter === 'invalid_value_known_to_cause_issues') {
    return {
      isValid: false,
      message: "Custom Validation: Parameter 'some_parameter' has a known problematic value.",
    };
  }

  // Example 3: Parameter value transformation/sanitization (optional)
  // If you want to slightly modify the response, you can return a `validatedResponse`.
  // For instance, trimming whitespace from all string parameters:
  /*
  let modified = false;
  const newParameters = { ...jsonResponse.parameters };
  if (jsonResponse.parameters) {
    for (const key in jsonResponse.parameters) {
      if (typeof jsonResponse.parameters[key] === 'string') {
        const trimmedValue = jsonResponse.parameters[key].trim();
        if (trimmedValue !== jsonResponse.parameters[key]) {
          newParameters[key] = trimmedValue;
          modified = true;
        }
      }
    }
  }
  if (modified) {
    // logger.debug('Custom validator trimmed whitespace from parameters.');
    return {
      isValid: true,
      message: 'Custom validation passed. Whitespace trimmed from parameters.',
      validatedResponse: { ...jsonResponse, parameters: newParameters },
    };
  }
  */

  // If all custom checks pass:
  return {
    isValid: true,
    message: 'Custom validation passed successfully.',
  };
}

module.exports = {
  validateAIResponse,
};
