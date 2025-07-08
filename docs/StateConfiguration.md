# Documentación de Configuración de Estados (`states.json`)

Este documento detalla la estructura y opciones de configuración para cada estado definido en el archivo `config/states.json` de la aplicación FSM.

## Estructura General de un Estado

Cada estado en el objeto `states` de `states.json` es un objeto JSON con un identificador único (la clave del estado) y los siguientes campos principales:

```json
"nombre_del_estado": {
  "id": "nombre_del_estado", // Debe coincidir con la clave
  "description": "Una descripción legible de lo que hace o representa este estado.",
  "stateLogic": {
    // ... Lógica de parámetros, acciones y requisitos de datos (ver abajo) ...
  },
  "payloadResponse": {
    // ... Definición de la respuesta al usuario y para la IA (ver abajo) ...
  },
  "transitions": [
    // ... Reglas para transicionar a otros estados (ver abajo) ...
  ],
  "defaultNextState": "otro_estado_id" // Opcional: Estado al que transicionar si se cumplen los parámetros pero ninguna otra transición coincide
}
```

---

## Campo `id` (String, Obligatorio)

El identificador único del estado. Debe ser idéntico a la clave que se usa para definir el estado en el objeto `states`.

-   **Ejemplo**: `"1_welcome"`

---

## Campo `description` (String, Opcional)

Una descripción textual para entender el propósito del estado. Útil para mantenimiento y debugging.

-   **Ejemplo**: `"Dar la bienvenida al paciente y capturar su número de identificación."`

---

## Objeto `stateLogic` (Obligatorio)

Contiene la lógica central del estado respecto a la recolección de datos y la ejecución de acciones.

### `stateLogic.awaitsUserInputParameters` (Objeto, Opcional)

Define los parámetros que se espera que la Inteligencia Artificial (IA) extraiga del input del usuario cuando la FSM se encuentra en este estado y está esperando una respuesta del usuario.

-   **`required` (Array de Strings, Opcional):** Lista de nombres de parámetros que son obligatorios. La FSM considerará que `allParametersMet` (para las transiciones) es verdadero para esta sección si todos estos parámetros han sido proporcionados por la IA y tienen un valor no nulo/no vacío.
-   **`optional` (Array de Strings, Opcional):** Lista de nombres de parámetros que la IA puede extraer pero no son estrictamente necesarios para cumplir la condición `allParametersMet` de esta sección.

-   **Ejemplo:**
    ```json
    "awaitsUserInputParameters": {
      "required": ["id_document_number"],
      "optional": ["user_preferred_language"]
    }
    ```

### `stateLogic.onEntry` (Array de Objetos de Acción, Opcional)

Define una lista de acciones (llamadas a API o ejecución de scripts) que deben ser consideradas y potencialmente ejecutadas cuando la FSM entra a este estado. Esto también aplica si el estado es "saltado" (es decir, la FSM transita a través de él sin detenerse a esperar input del usuario para este estado en particular). Las acciones se procesan antes de renderizar el `payloadResponse` principal del estado.

**Objeto de Acción (Común para API y SCRIPT):**

-   **`label` (String, Opcional):** Un nombre descriptivo para la acción, útil para logging y debugging.
    -   Ejemplo: `"Fetch User Profile Data"`
-   **`type` (String, Obligatorio):** Define el tipo de acción.
    -   Valores: `"API"`, `"SCRIPT"`.
-   **`id` (String, Obligatorio):** Identificador de la acción.
    -   Si `type` es `"API"`, este es el `apiId` que corresponde a un archivo en `config/api_definitions/`.
    -   Si `type` es `"SCRIPT"`, este es un `scriptId` único para esta acción de script.
-   **`executionMode` (String, Obligatorio):** Define cómo la FSM maneja la ejecución.
    -   `"SYNCHRONOUS"`: La FSM espera a que la acción se complete antes de continuar con el procesamiento de otras acciones síncronas o el renderizado del `payloadResponse`. Los resultados están disponibles en el mismo ciclo.
    -   `"ASYNCHRONOUS"`: La FSM despacha la acción y continúa el procesamiento sin esperar el resultado. El resultado se espera en un ciclo futuro (generalmente vía Redis Streams para APIs).
-   **`consumesParameters` (Objeto, Opcional - Principalmente para Scripts):**
    *   Aunque las APIs definen sus `consumesParameters` en `api_definitions/`, los scripts pueden definirlos aquí para que la FSM valide sus dependencias antes de la ejecución. La estructura es idéntica a la de las APIs.
    *   Ejemplo:
        ```json
        "consumesParameters": {
          "userData": { "source": "COLLECTED_PARAM", "paramName": "userName", "required": true },
          "configValue": { "source": "STATIC", "value": "configA" }
        }
        ```
-   **`ignoreIfOutputExists` (Booleano, Opcional, Default: `false`):**
    -   Si es `true`:
        -   Para APIs: Si todos los parámetros definidos en `producesParameters` (en `api_definitions/`) de esta API ya existen en `currentParameters`, la API no se vuelve a llamar.
        -   Para Scripts: Si el parámetro especificado en `assignResultTo` ya existe en `currentParameters`, el script no se vuelve a ejecutar.
    -   Útil para evitar llamadas redundantes si los datos ya fueron obtenidos (ej. por un estado anterior o una acción previa en el mismo `onEntry`).
-   **`runIfCondition` (Objeto, Opcional):** Permite la ejecución condicional de la acción.
    -   `paramPath` (String, Obligatorio dentro de `runIfCondition`): Path (usando notación de puntos) al valor dentro de `currentParameters` que se evaluará. Ejemplo: `"tokenStatus.output.needsNewToken"`.
    -   `equals` (Valor, Opcional): La acción se ejecuta si el valor en `paramPath` es estrictamente igual (`===`) a este valor.
    -   `exists` (Booleano, Opcional): La acción se ejecuta si el `paramPath` existe (si `true`) o no existe (si `false`).
    -   (Futuro: `isDefined`, `greaterThan`, etc.)
    -   Ejemplo:
        ```json
        "runIfCondition": {
          "paramPath": "tokenStatus.output.needsNewToken",
          "equals": true
        }
        ```

**Campos Específicos para `type: "SCRIPT"`:**

-   **`filePath` (String, Obligatorio):** Ruta relativa al archivo JavaScript desde el directorio `config/scripts/`. Ejemplo: `"auth/manageToken.js"`.
-   **`functionName` (String, Obligatorio):** Nombre de la función exportada dentro del archivo script que se debe ejecutar. Ejemplo: `"ensureValidApiToken"`.
-   **`assignResultTo` (String, Opcional):** Si se especifica, el valor devuelto por la función del script (específicamente, el campo `output` si el script devuelve un objeto estructurado, o el valor directo si no) se asignará a `currentParameters` usando esta cadena como clave.
    -   Ejemplo: `"userAuthDetails"` (resultaría en `currentParameters.userAuthDetails = ...`)
-   **`canForceTransition` (Booleano, Opcional, Default: `false`):**
    -   Si es `true`, el script puede devolver un objeto estructurado con `status: "FORCE_TRANSITION"` y `transitionDetails: { nextStateId: "...", intent: "...", parameters: {...} }` para forzar a la FSM a transicionar a un estado específico, potencialmente alterando el flujo normal.

**Ejemplo de `onEntry`:**
```json
"onEntry": [
  {
    "label": "Log Interaction Start",
    "type": "API", "id": "api_log_interaction_start", "executionMode": "ASYNCHRONOUS"
  },
  {
    "label": "Check Token Validity",
    "type": "SCRIPT", "id": "checkToken",
    "filePath": "auth/tokenChecker.js", "functionName": "isValid",
    "assignResultTo": "tokenValidity",
    "executionMode": "SYNCHRONOUS"
  },
  {
    "label": "Fetch User Profile if Token Valid",
    "type": "API", "id": "api_get_user_profile", "executionMode": "SYNCHRONOUS",
    "ignoreIfOutputExists": true,
    "runIfCondition": { "paramPath": "tokenValidity.isValid", "equals": true }
  }
]
```

### `stateLogic.dataRequirementsForPrompt` (Array de Strings, Opcional)

Lista explícita de nombres de parámetros (que pueden ser producidos por APIs o scripts) que son considerados *críticos* para la correcta renderización de `payloadResponse.prompts` o `payloadResponse.customInstructions` de este estado.
La FSM intentará asegurar que estos parámetros estén disponibles, potencialmente añadiendo sus APIs/scripts productores al plan de ejecución síncrono si aún no lo están.

-   **Ejemplo**:
    ```json
    "dataRequirementsForPrompt": ["userName", "availableAppointmentSlots"]
    ```

---

## Objeto `payloadResponse` (Obligatorio)

Define lo que se le comunica al usuario y las instrucciones para la IA en este estado.

### `payloadResponse.prompts` (Objeto, Obligatorio)

Contiene las diferentes cadenas de texto que se pueden reproducir al usuario. Estas cadenas pueden usar plantillas `{{paramName}}` que se resuelven con valores de `currentParameters`.

-   **`main` (String, Obligatorio):** El prompt principal para el usuario.
-   **`validationExample` (String, Opcional):** Un ejemplo de la entrada esperada, si aplica.
-   **`reprompt` (String, Opcional):** Prompt a usar si el usuario no responde (no-input).
-   **`error` (String, Opcional):** Prompt a usar si la entrada del usuario no es entendida (no-match) o hay un error.

-   **Ejemplo:**
    ```json
    "prompts": {
      "main": "Gracias, {{userName}}. Por favor, dime en qué ciudad quieres ser atendido.",
      "validationExample": "Las opciones pueden ser: Guayaquil y Quito."
    }
    ```

### `payloadResponse.customInstructions` (String, Opcional)

Instrucciones específicas para la IA que se añaden al contexto del prompt de IA para este turno. Puede contener plantillas `{{paramName}}`.

-   **Ejemplo**: `"Analiza la respuesta del usuario para extraer 'city_name'. Ciudades disponibles son {{availableCitiesMap}}."`

### `payloadResponse.uiHints` (Objeto, Opcional)

Pistas para la interfaz de usuario (ej. una aplicación cliente, o para Asterisk ARI).

-   **Ejemplo**: `{ "ageInputType": "number", "dtmfMaxDigits": "4" }`

### `payloadResponse.finalMessage` (String, Opcional)

Si este estado es un estado terminal (sin más transiciones o interacciones), este mensaje se usa en lugar de `prompts.main`.

-   **Ejemplo**: `"Su cita ha sido confirmada. ¡Gracias!"`

### `payloadResponse.transferMessage` (String, Opcional)

Si este estado resulta en una transferencia a un agente humano, este mensaje se le puede decir al usuario.

-   **Ejemplo**: `"Un momento, por favor, lo transferiré con un agente."`

---

## Array `transitions` (Obligatorio, puede estar vacío para estados terminales)

Define las reglas para moverse de este estado a otros estados. Es un array de objetos, donde cada objeto representa una posible transición. La FSM evalúa las transiciones en el orden en que aparecen.

**Objeto de Transición:**

-   **`nextState` (String, Obligatorio):** El `id` del estado al que se transicionará si la condición se cumple.
-   **`condition` (Objeto, Obligatorio):** Define la condición para que esta transición ocurra.
    -   **`intent` (String, Opcional):** La transición ocurre si el `intent` devuelto por la IA coincide con este valor.
    -   **`allParametersMet` (Booleano, Opcional):**
        -   Si es `true`, la transición ocurre si todos los parámetros definidos en `stateLogic.awaitsUserInputParameters.required` para el estado *actual* han sido proporcionados y tienen valor.
        -   Si es `false`, la transición ocurre si *no* todos los parámetros requeridos han sido proporcionados.
    -   **`scriptCondition` (Objeto, Opcional - Futuro):**
        -   `scriptId` / `filePath` / `functionName`: Un script síncrono que se ejecuta.
        -   El script debe devolver `true` o `false`. Si es `true`, la condición se cumple.
    -   **`customCondition` (Objeto, Opcional - Futuro):** Para condiciones más complejas sobre `currentParameters`.
        -   Ejemplo: `{ "param": "userAge", "operator": "GREATER_THAN", "value": 18 }`

-   **Ejemplo de `transitions`:**
    ```json
    "transitions": [
      {
        "nextState": "2_get_city",
        "condition": { "allParametersMet": true }
      },
      {
        "nextState": "99_transfer_to_human",
        "condition": { "intent": "request_human_agent" }
      }
    ]
    ```

---

## Campo `defaultNextState` (String, Opcional)

Si se han cumplido los `awaitsUserInputParameters.required` del estado actual, pero ninguna de las condiciones en el array `transitions` se evalúa como verdadera, la FSM transicionará a este `defaultNextState`.

-   **Ejemplo**: `"2_get_city"`

---
Este documento se actualizará a medida que se añadan más funcionalidades a la configuración de estados.
```
