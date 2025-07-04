/**
 * Resuelve el valor de un parámetro, que puede ser una referencia a collectedParameters
 * o un literal.
 * @param {string|number|boolean} arg El argumento a resolver.
 * @param {object} parameters El objeto collectedParameters.
 * @returns {*} El valor resuelto.
 */
function resolveArgument(arg, parameters) {
  // console.log(`TEMPLATE_PROCESSOR_DEBUG: resolveArgument received - arg: [${arg}] (type: ${typeof arg})`); // Eliminado
  // console.log(`TEMPLATE_PROCESSOR_DEBUG: resolveArgument parameters context: ${JSON.stringify(parameters)}`); // Eliminado
  if (typeof arg === 'string') {
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
      return arg.substring(1, arg.length - 1);
    }
    return parameters.hasOwnProperty(arg) ? parameters[arg] : undefined;
  }
  return arg;
}

const PREDEFINED_FUNCTIONS = {
  default: (value, defaultValue) => {
    return (value !== null && value !== undefined && value !== '') ? value : defaultValue;
  },
  toUpperCase: (str) => {
    return (str !== null && str !== undefined) ? String(str).toUpperCase() : '';
  },
  toLowerCase: (str) => {
    return (str !== null && str !== undefined) ? String(str).toLowerCase() : '';
  },
  capitalize: (str) => {
    if (str === null || str === undefined || str === '') return '';
    const s = String(str);
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  },
  formatNumber: (num, decimalPlaces = 2) => {
    const n = parseFloat(num);
    if (isNaN(n)) return '[ERROR: formatNumber espera un número]';
    const dp = parseInt(decimalPlaces, 10);
    if (isNaN(dp) || dp < 0) return '[ERROR: formatNumber espera un número positivo de decimales]';
    return n.toFixed(dp);
  },
  add: (...nums) => {
    return nums.reduce((sum, num) => {
      const n = parseFloat(num);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  },
  subtract: (num1, num2) => {
    const n1 = parseFloat(num1);
    const n2 = parseFloat(num2);
    if (isNaN(n1) || isNaN(n2)) return '[ERROR: subtract espera dos números]';
    return n1 - n2;
  },
};

// Intento de importar isolated-vm.
let ivm;
try {
  ivm = require('isolated-vm');
  console.log("TemplateProcessor: 'isolated-vm' cargado exitosamente. Funcionalidad {{sandbox_js:...}} estará habilitada.");
} catch (e) {
  console.warn("TemplateProcessor: No se pudo cargar 'isolated-vm'. La funcionalidad {{sandbox_js:...}} estará deshabilitada. Error:", e.message);
  ivm = null;
}

/**
 * Procesa un string de plantilla, reemplazando placeholders y ejecutando funciones.
 * @param {string} text El string de plantilla.
 * @param {object} parameters El objeto collectedParameters.
 * @returns {string} El string procesado.
 */
function renderString(text, parameters) {
  if (typeof text !== 'string') return text;

  let processedText = text;

  // 1. Reemplazar placeholders de fecha/hora
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  processedText = processedText.replace(/\{\{current_date\}\}/g, `${year}-${month}-${day}`);
  processedText = processedText.replace(/\{\{current_time\}\}/g, `${hours}:${minutes}:${seconds}`);
  processedText = processedText.replace(/\{\{current_datetime\}\}/g, `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`);

  // 2. Procesar {{sandbox_js: ... }} si ivm está disponible
  if (ivm) {
    processedText = processedText.replace(/\{\{sandbox_js:\s*([\s\S]+?)\s*\}\}/g, (match, jsCode) => {
      let isolate;
      let context;
      try {
        // Crear una copia profunda y plana de parameters para el sandbox
        // Esto evita problemas con objetos complejos y funciones en ExternalCopy
        const safeParameters = JSON.parse(JSON.stringify(parameters));

        isolate = new ivm.Isolate({ memoryLimit: 16 }); // Límite de memoria de 16MB
        context = isolate.createContextSync();
        const jail = context.global;

        jail.setSync('collectedParameters', new ivm.ExternalCopy(safeParameters).copyInto());

        // Para permitir que el script devuelva un valor, podemos envolverlo.
        // O confiar en que la última expresión evaluada es el resultado.
        // Por ahora, confiamos en la última expresión o un return explícito.
        const script = isolate.compileScriptSync(jsCode);
        const result = script.runSync(context, { timeout: 100 }); // Timeout de 100ms

        return (result !== undefined && result !== null) ? String(result) : '';
      } catch (e) {
        console.error(`TemplateProcessor: Error ejecutando sandbox_js: "${jsCode.substring(0, 70)}..."`, e.message);
        return `[JS_SANDBOX_ERROR: ${e.message.substring(0, 100)}]`;
      } finally {
        if (context) {
          try { context.release(); } catch (e) { /* ignore */ }
        }
        if (isolate) {
          try { isolate.dispose(); } catch (e) { /* ignore */ }
        }
      }
    });
  }

  // 3. Reemplazar placeholders de funciones predefinidas {{functionName(arg1, 'literal', arg3)}}
  processedText = processedText.replace(/\{\{([a-zA-Z0-9_]+)\(([^)]*)\)\}\}/g, (match, functionName, argsString) => {
    if (PREDEFINED_FUNCTIONS.hasOwnProperty(functionName)) {
      try {
        const args = [];
        if (argsString.trim() !== '') {
          const argRegex = /(?:([a-zA-Z_][a-zA-Z0-9_]*)|"([^"]*)"|'([^']*)'|([0-9]+\.?[0-9]*)|(true|false))/g;
          let argMatch;
          while((argMatch = argRegex.exec(argsString)) !== null) {
            if (argMatch[1] !== undefined) args.push(argMatch[1]);
            else if (argMatch[2] !== undefined) args.push(`"${argMatch[2]}"`);
            else if (argMatch[3] !== undefined) args.push(`'${argMatch[3]}'`);
            else if (argMatch[4] !== undefined) args.push(parseFloat(argMatch[4]));
            else if (argMatch[5] !== undefined) args.push(argMatch[5].toLowerCase() === 'true');
          }
        }

        const resolvedArgs = args.map(arg => resolveArgument(arg, parameters));
        const result = PREDEFINED_FUNCTIONS[functionName](...resolvedArgs);
        return (result !== undefined && result !== null) ? String(result) : '';
      } catch (e) {
        console.error(`TemplateProcessor: Error ejecutando función '${functionName}' con args '${argsString}':`, e.message);
        return `[ERROR: ${functionName} - ${e.message}]`;
      }
    }
    return `[ERROR: Función desconocida '${functionName}']`;
  });

  // 4. Reemplazar placeholders de parámetros {{paramName}} (último, para no interferir con argumentos de funciones)
  processedText = processedText.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (match, paramName) => {
    if (parameters.hasOwnProperty(paramName) && parameters[paramName] !== null && parameters[paramName] !== undefined) {
      return String(parameters[paramName]);
    }
    return '';
  });

  return processedText;
}

/**
 * Procesa recursivamente una plantilla (string, array u objeto)
 * @param {*} template La plantilla a procesar.
 * @param {object} parameters El objeto collectedParameters.
 * @returns {*} La plantilla procesada.
 */
function processTemplate(template, parameters) {
  if (typeof template === 'string') {
    return renderString(template, parameters);
  }
  if (Array.isArray(template)) {
    return template.map(item => processTemplate(item, parameters));
  }
  if (typeof template === 'object' && template !== null) {
    const result = {};
    for (const key in template) {
      if (template.hasOwnProperty(key)) {
        result[key] = processTemplate(template[key], parameters);
      }
    }
    return result;
  }
  return template;
}

module.exports = { processTemplate };
