// src/scriptExecutor.js
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const SCRIPTS_BASE_DIR = path.join(__dirname, '..', 'config', 'scripts');

async function executeScript(scriptDefinition, currentParameters, sessionId) {
  const { scriptId, filePath, functionName, isAsync = false } = scriptDefinition;
  // filePath tiene prioridad, si no, se construye a partir de scriptId.
  const effectiveFilePath = filePath ? filePath : `${scriptId}.js`;
  const scriptPath = path.join(SCRIPTS_BASE_DIR, effectiveFilePath);

  logger.debug({ sessionId, scriptId, scriptPath, functionName, effectiveFilePath }, 'Attempting to execute script.');

  try {
    if (!fs.existsSync(scriptPath)) {
      logger.error({ sessionId, scriptId, scriptPath }, 'Script file not found.');
      return { error: `Script file not found: ${scriptPath}` };
    }

    // Cargar el módulo del script. require() cachea los módulos.
    // Para desarrollo, si se quieren cambios en caliente, se necesitaría invalidar el caché de require
    // o usar una librería que maneje hot-reloading de módulos.
    const scriptModule = require(scriptPath);

    if (typeof scriptModule[functionName] !== 'function') {
      logger.error({ sessionId, scriptId, functionName, scriptPath }, 'Specified function not found in script module or not a function.');
      return { error: `Function ${functionName} not found in script ${scriptId} at ${scriptPath}` };
    }

    let result;
    // Los scripts reciben todos los parámetros actuales y una instancia del logger.
    // Podrían recibir también 'sessionId' y 'scriptDefinition' si fuera útil.
    if (isAsync) {
      result = await scriptModule[functionName](currentParameters, logger, sessionId);
    } else {
      result = scriptModule[functionName](currentParameters, logger, sessionId);
    }

    logger.info({ sessionId, scriptId, functionName, hasResult: typeof result !== 'undefined' }, 'Script executed successfully.');
    return { result }; // El resultado puede ser undefined si el script no devuelve nada

  } catch (error) {
    logger.error({ err: error, sessionId, scriptId, functionName, scriptPath }, 'Error during script execution.');
    return { error: `Error executing script ${scriptId} (${functionName} from ${scriptPath}): ${error.message}` };
  }
}

module.exports = { executeScript };
