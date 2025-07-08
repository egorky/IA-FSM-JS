// config/scripts/example/testScript.js
function testFunction(currentParameters, logger, sessionId) {
  logger.info({ sessionId, script: 'testScript.js', function: 'testFunction', params: currentParameters }, 'Test script called.');

  const newParamValue = `Hello from test script! Current time: ${new Date().toLocaleTimeString()}`;

  // Ejemplo de modificación de currentParameters directamente (si es permitido por diseño)
  // o devolver un objeto con los cambios.
  // Por ahora, devolvemos un valor que será asignado por scriptExecutor.
  return newParamValue;
}

function anotherTest(currentParameters, logger, sessionId) {
    logger.info({sessionId, script: 'testScript.js', function: 'anotherTest'}, 'Another test function called.');
    return {
        message: "Another test successful",
        inputParamForMedicalSpecialty: currentParameters.medical_specialty || "Not provided"
    };
}

async function asyncTest(currentParameters, logger, sessionId) {
    logger.info({sessionId, script: 'testScript.js', function: 'asyncTest'}, 'Async test function called. Waiting 100ms.');
    await new Promise(resolve => setTimeout(resolve, 100));
    logger.info({sessionId, script: 'testScript.js', function: 'asyncTest'}, 'Async test finished.');
    return `Async result after 100ms for session ${sessionId}`;
}

module.exports = {
  testFunction,
  anotherTest,
  asyncTest
};
