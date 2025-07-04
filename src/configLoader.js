const fs = require('fs');
const path = require('path');

const STATE_CONFIG_PATH = path.join(__dirname, '..', 'config', 'states.json');

let stateConfiguration = null;

/**
 * Carga la configuración de estados desde el archivo JSON.
 * @returns {object} La configuración de estados.
 * @throws {Error} Si el archivo de configuración no se encuentra o no es un JSON válido.
 */
function loadStateConfig() {
  if (stateConfiguration) {
    return stateConfiguration;
  }

  try {
    if (!fs.existsSync(STATE_CONFIG_PATH)) {
      throw new Error(`El archivo de configuración de estados no se encontró en: ${STATE_CONFIG_PATH}`);
    }
    const rawConfig = fs.readFileSync(STATE_CONFIG_PATH, 'utf-8');
    stateConfiguration = JSON.parse(rawConfig);

    // Validaciones básicas de la estructura
    if (!stateConfiguration.initialState || typeof stateConfiguration.initialState !== 'string') {
      throw new Error("La configuración de estados debe tener un 'initialState' de tipo string.");
    }
    if (!stateConfiguration.states || typeof stateConfiguration.states !== 'object' || Object.keys(stateConfiguration.states).length === 0) {
      throw new Error("La configuración de estados debe tener un objeto 'states' no vacío.");
    }
    if (!stateConfiguration.states[stateConfiguration.initialState]) {
        throw new Error(`El 'initialState' ("${stateConfiguration.initialState}") no existe en la definición de 'states'.`);
    }

    // Validación para la nueva estructura payloadResponse
    for (const stateId in stateConfiguration.states) {
      const state = stateConfiguration.states[stateId];
      if (state.payloadResponse && typeof state.payloadResponse !== 'object') {
        // Permitimos que payloadResponse no exista, pero si existe, debe ser un objeto.
        throw new Error(`El estado "${stateId}" tiene un campo 'payloadResponse' que no es un objeto.`);
      }
      // Eliminamos la validación específica de 'apiHooks' y 'apisToCall'
      // ya que 'payloadResponse' es de formato libre y puede o no contener 'apiHooks'.
      // Si se quiere validar 'apiHooks' dentro de 'payloadResponse', se haría aquí de forma anidada.
      // Por ahora, solo validamos que payloadResponse sea un objeto si existe.

      // Limpieza de campos obsoletos si aún estuvieran por error
      if (state.hasOwnProperty('apiHooks')) {
        console.warn(`ADVERTENCIA: El estado "${stateId}" contiene un campo 'apiHooks' obsoleto fuera de 'payloadResponse'. Será ignorado. Considere moverlo dentro de 'payloadResponse'.`);
      }
      if (state.hasOwnProperty('apisToCall')) {
        console.warn(`ADVERTENCIA: El estado "${stateId}" contiene un campo 'apisToCall' obsoleto. Será ignorado.`);
      }
    }

    console.log('Configuración de estados cargada y validada exitosamente.');
    return stateConfiguration;
  } catch (error) {
    console.error('Error al cargar o validar la configuración de estados:', error);
    // En un escenario real, podrías querer que la aplicación falle si no puede cargar la configuración.
    // Por ahora, lanzamos el error para que se maneje más arriba o se detenga la app.
    throw error;
  }
}

/**
 * Obtiene la configuración de un estado específico por su ID.
 * @param {string} stateId El ID del estado a obtener.
 * @returns {object | undefined} El objeto de configuración del estado o undefined si no se encuentra.
 */
function getStateById(stateId) {
  const config = loadStateConfig();
  return config.states[stateId];
}

/**
 * Obtiene el ID del estado inicial.
 * @returns {string} El ID del estado inicial.
 */
function getInitialStateId() {
  const config = loadStateConfig();
  return config.initialState;
}

module.exports = {
  loadStateConfig,
  getStateById,
  getInitialStateId,
};
