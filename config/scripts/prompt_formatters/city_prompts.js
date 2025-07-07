// config/scripts/prompt_formatters/city_prompts.js
function formatCityGreeting(currentParameters, logger, sessionId) {
  // Script accedes to parameters via currentParameters, using the names
  // that were resolved by FSM (e.g. "userName" which was a producesParameter of an API).
  // The 'consumesParameters' in states.json for this script helps FSM ensure these are available.

  const userName = currentParameters.userName;
  const citiesMap = currentParameters.availableCitiesMap;
  // const hour = currentParameters.hour; // Example if 'hour' was resolved from sessionData.timeContext.hour

  let greeting = `Gracias`;
  if (userName && userName !== "Cliente (Info no disp.)") { // Check against fallback value
    greeting += `, ${userName}`;
  } else if (userName === "Cliente (Info no disp.)") {
    greeting += ""; // Or a generic "Estimado cliente" if preferred when name is unavailable
  } else {
    greeting += ` por contactarnos`; // Fallback if userName is completely missing
  }

  // Example of using another consumed param, like a list of cities from an API
  // if (citiesMap && Object.keys(citiesMap).length > 0) {
  //   const cityNames = Object.keys(citiesMap).join(', ');
  //   greeting += `. Actualmente ofrecemos servicio en ${cityNames}.`;
  // }

  logger.info({sessionId, script: 'city_prompts.js', function: 'formatCityGreeting', generatedGreeting: greeting}, "Generated city greeting part.");
  return greeting; // This value will be assigned to currentParameters.customCityGreetingForPrompt
}

module.exports = {
  formatCityGreeting
};
