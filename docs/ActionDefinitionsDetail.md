# Documentación Detallada de Definición de Acciones

Este documento proporciona una explicación detallada de cómo se definen las Acciones (APIs y Scripts) que la FSM puede ejecutar. Las APIs se definen en archivos JSON individuales dentro de `config/api_definitions/`, mientras que las acciones de script se definen parcialmente en `config/states.json` y sus archivos de código residen en `config/scripts/`.

## 1. Definición de APIs (`config/api_definitions/<api_id>.json`)

Cada archivo en este directorio define una API externa que el sistema puede llamar.

### Campos Principales:

-   **`apiId` (String, Obligatorio):**
    -   Identificador único para esta API. Debe coincidir con el nombre del archivo (sin la extensión `.json`).
    -   Ejemplo: `"api_get_user_profile"`

-   **`description` (String, Opcional):**
    -   Descripción legible de lo que hace la API.
    -   Ejemplo: `"Obtiene el perfil completo del usuario desde el sistema CRM."`

-   **`url_template` (String, Obligatorio):**
    -   La URL completa para llamar a la API. Puede contener plantillas `{{params.nombreParametro}}` que se resolverán usando los `consumesParameters` definidos para esta API.
    -   Ejemplo: `"https://api.example.com/users/{{params.userId}}/profile?include_details={{params.detailsFlag}}"`

-   **`method` (String, Obligatorio):**
    -   El método HTTP a utilizar.
    -   Valores comunes: `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`.

-   **`headers_template` (Objeto, Opcional):**
    -   Un objeto donde cada par clave-valor representa una cabecera HTTP. Los valores pueden ser plantillas `{{params.nombreParametro}}`.
    -   Ejemplo:
        ```json
        "headers_template": {
          "Content-Type": "application/json",
          "Authorization": "Bearer {{params.authToken}}",
          "X-Custom-Header": "{{params.customHeaderValue}}"
        }
        ```

-   **`body_template` (Objeto o String, Opcional):**
    -   Define el cuerpo de la solicitud para métodos como `POST`, `PUT`, `PATCH`.
    -   Si es un objeto, se convertirá a JSON. Puede contener plantillas `{{params.nombreParametro}}`.
    -   Si es un string, se enviará tal cual (útil para XML, texto plano, etc., aunque las plantillas también aplican).
    -   Ejemplo (Objeto JSON):
        ```json
        "body_template": {
          "user_id": "{{params.userId}}",
          "preferences": {
            "notifications": "{{params.notificationPref}}"
          },
          "raw_input_data": "{{params.rawInput}}"
        }
        ```

-   **`query_params_template` (Objeto, Opcional):**
    -   Un objeto donde cada par clave-valor representa un parámetro de query para la URL. Los valores pueden ser plantillas `{{params.nombreParametro}}`.
    -   Estos se añadirán a la `url_template`. Si un valor de parámetro es `null` o `undefined` después de renderizar la plantilla, ese parámetro de query no se incluirá.
    -   Ejemplo:
        ```json
        "query_params_template": {
          "include_history": "{{params.fetchHistoryFlag}}", // si fetchHistoryFlag es true/false
          "page_size": "{{params.pageSize}}"
        }
        ```

-   **`timeout_ms` (Número, Opcional):**
    -   Timeout en milisegundos para la solicitud a la API. Si no se especifica, se usará un valor por defecto del sistema (ej. `process.env.DEFAULT_API_TIMEOUT_MS`).

-   **`response_stream_key_template` (String, Opcional):**
    -   Plantilla para generar la clave del Stream de Redis donde se esperará la respuesta si esta API se llama de forma asíncrona (es decir, `executionMode: "ASYNCHRONOUS"` en `states.json`).
    -   Puede usar `{{sessionId}}` y `{{correlationId}}`.
    -   Ejemplo: `"api_responses:{{sessionId}}:{{correlationId}}:{{apiId}}"`

### `producesParameters` (Objeto, Obligatorio si la API devuelve datos útiles)

Define cómo los datos de la respuesta JSON de la API se mapean a nombres de parámetros estandarizados que la FSM y las plantillas usarán. Estos nombres estandarizados se almacenarán en `currentParameters`.

-   Cada **clave** es el nombre estandarizado del parámetro (ej. `"userName"`, `"orderStatus"`).
-   Cada **valor** es un string que representa el path (usando notación de puntos) al dato deseado dentro del objeto de respuesta de la API (generalmente dentro de `apiResponse.data`).
-   Ejemplo:
    ```json
    "producesParameters": {
      "userName": "data.profile.displayName",
      "userEmail": "data.contactInfo.primaryEmail",
      "lastOrderId": "data.orders[0].id", // Accede al ID del primer pedido en un array
      "fullProfileData": "data.profile" // Guarda el objeto profile completo
    }
    ```
    Si la API devuelve `{"data": {"profile": {"displayName": "Jules"}}}`, entonces `currentParameters.userName` será `"Jules"`.

### `consumesParameters` (Objeto, Opcional)

Describe cada parámetro que esta API necesita para construir su `url_template`, `headers_template`, `body_template`, o `query_params_template`.

-   Cada **clave** es el nombre del parámetro tal como se usa en las plantillas de esta API (ej. `userId` si la plantilla es `{{params.userId}}`).
-   Cada **valor** es un objeto que define la fuente y los detalles del parámetro:
    -   **`source` (String, Obligatorio):** De dónde proviene el valor. Valores posibles:
        -   `"USER_INPUT"`: El valor es extraído por la IA del input del usuario.
        -   `"API_RESULT"`: El valor es el resultado (un `producedParameter`) de otra API.
        -   `"SCRIPT_RESULT"`: El valor es el resultado (el `assignResultTo`) de un Script.
        -   `"STATIC"`: Un valor fijo.
        -   `"SESSION_DATA"`: Un valor tomado directamente de `sessionData` (el objeto de sesión de la FSM en Redis).
        -   `"COLLECTED_PARAM"`: Un parámetro que ya existe en `currentParameters` (obtenido por cualquier medio previamente).
    -   **`aiParamName` (String, Obligatorio si `source: "USER_INPUT"`):** El nombre del parámetro que la IA debe haber extraído.
    -   **`apiId` (String, Obligatorio si `source: "API_RESULT"`):** El `apiId` de la API que produce el parámetro.
    -   **`scriptId` (String, Obligatorio si `source: "SCRIPT_RESULT"`):** El `id` del script que produce el parámetro.
    -   **`producedParamName` (String, Obligatorio si `source: "API_RESULT"` o `"SCRIPT_RESULT"`):** El nombre estandarizado del parámetro tal como fue definido en `producesParameters` de la API productora, o el `assignResultTo` del script productor.
    -   **`value` (Cualquier tipo, Obligatorio si `source: "STATIC"`):** El valor fijo a usar.
    -   **`path` (String, Obligatorio si `source: "SESSION_DATA"`):** Path (notación de puntos) al valor dentro del objeto `sessionData`. Ejemplo: `"callDetails.callerId"`.
    -   **`paramName` (String, Obligatorio si `source: "COLLECTED_PARAM"`):** El nombre del parámetro tal como existe en `currentParameters`.
    -   **`required` (Booleano, Opcional, Default: `true`):** Si `true`, la FSM considerará que esta dependencia debe cumplirse para ejecutar la API. Si `false`, la API podría llamarse incluso si este parámetro no se resuelve (la plantilla de la API debe ser capaz de manejar un valor faltante, por ejemplo, no incluyendo un query param opcional).
    -   `mapTo` (String, Opcional): Si el nombre usado en la plantilla de esta API (la clave) es diferente al `aiParamName` o `producedParamName`, se puede usar `mapTo` para especificar el nombre en la plantilla. Generalmente no es necesario si las claves de `consumesParameters` ya son los nombres de las plantillas.

-   **Ejemplo:**
    ```json
    "consumesParameters": {
      "userIdInUrl": { "source": "USER_INPUT", "aiParamName": "id_document_number", "required": true },
      "authToken": { "source": "COLLECTED_PARAM", "paramName": "activeApiToken", "required": true },
      "productDetails": { "source": "API_RESULT", "apiId": "api_get_product_info", "producedParamName": "productDataSheet", "required": true },
      "processingMode": { "source": "STATIC", "value": "fast" },
      "userLanguage": { "source": "SESSION_DATA", "path": "preferences.language", "required": false }
    }
    ```

---

## 2. Definición y Uso de Scripts

Los scripts son piezas de código JavaScript personalizadas que la FSM puede ejecutar como parte de la lógica de un estado.

### A. Definición de una Acción de Script en `config/states.json`

Dentro de un estado, en un array de acciones (ej. `stateLogic.onEntry`), un objeto de acción de `type: "SCRIPT"` se define con los siguientes campos:

-   **`label` (String, Opcional):** Nombre descriptivo.
-   **`type` (String, Obligatorio):** Debe ser `"SCRIPT"`.
-   **`id` (String, Obligatorio):** Un identificador único para esta acción de script (ej. `"calculateDiscountScript"`).
-   **`filePath` (String, Obligatorio):** Ruta relativa al archivo JavaScript desde `config/scripts/`. Ejemplo: `"calculations/applyDiscount.js"`.
-   **`functionName` (String, Obligatorio):** Nombre de la función exportada en el archivo script a ejecutar. Ejemplo: `"calculateAndApply"`.
-   **`executionMode` (String, Obligatorio):** `"SYNCHRONOUS"` o `"ASYNCHRONOUS"`.
-   **`assignResultTo` (String, Opcional):** Si se provee, el campo `output` del objeto de retorno estructurado del script (o el valor directo si no es estructurado) se guardará en `currentParameters` con esta clave.
-   **`consumesParameters` (Objeto, Opcional):** Misma estructura que para las APIs. Permite al script declarar formalmente los datos que necesita de `currentParameters` o `sessionData`. La FSM usará esto para la planificación de dependencias.
-   **`canForceTransition` (Booleano, Opcional, Default: `false`):** Si `true`, el script puede devolver un objeto estructurado con `status: "FORCE_TRANSITION"` para redirigir la FSM.
-   **`ignoreIfOutputExists` (Booleano, Opcional, Default: `false`):** Si `true` y `assignResultTo` está definido y ese parámetro ya existe en `currentParameters`, el script no se ejecuta.
-   **`runIfCondition` (Objeto, Opcional):** (Ver `docs/StateConfiguration.md`) Para ejecución condicional.

### B. Estructura de un Archivo de Script en `config/scripts/`

-   Los archivos JavaScript deben exportar la función especificada en `functionName`.
-   La función recibe tres argumentos:
    1.  `currentParameters` (Objeto): Una copia de todos los parámetros acumulados en la FSM hasta el momento de la ejecución del script (incluye parámetros de IA, resultados de APIs síncronas previas en el mismo ciclo, resultados de scripts previos, etc.). Los scripts pueden leer de aquí. Si necesitan modificar parámetros para que otras acciones los vean, deben hacerlo a través de su valor de retorno y `assignResultTo`.
    2.  `logger` (Objeto): Una instancia del logger de la aplicación (`pino`), para que los scripts puedan registrar información.
    3.  `sessionId` (String): El ID de la sesión actual.
-   **Retorno del Script (Estandarizado):** Se recomienda que los scripts devuelvan un objeto con la siguiente estructura para una mejor integración con la FSM:
    ```javascript
    return {
      status: "SUCCESS", // Valores posibles: "SUCCESS", "ERROR", "FORCE_TRANSITION"
      output: { /* Cualquier dato que el script quiera asignar vía assignResultTo */ }, // Usado si status es "SUCCESS"
      message: "Mensaje de error descriptivo.", // Usado si status es "ERROR"
      errorCode: "CUSTOM_SCRIPT_ERROR_CODE", // Usado si status es "ERROR"
      transitionDetails: { // Usado si status es "FORCE_TRANSITION" y canForceTransition es true
        nextStateId: "id_del_siguiente_estado",
        intent: "intent_forzado_por_script", // Opcional
        parameters: { /* parámetros a pasar al nuevo estado, opcional */ }
      }
    };
    ```
    -   Si un script no devuelve un objeto con un campo `status`, su valor de retorno directo se considerará el `output` para `assignResultTo` (comportamiento de compatibilidad).
    -   Si `canForceTransition` es `true` en la configuración, y el script devuelve `status: "FORCE_TRANSITION"` con `transitionDetails` válidos, la FSM intentará esa transición.

-   **Ejemplo de Script (`config/scripts/example.js`):**
    ```javascript
    function processData(currentParameters, logger, sessionId) {
      const userName = currentParameters.userName;
      const orderCount = currentParameters.userTotalOrders;

      if (!userName) {
        return { status: "ERROR", message: "User name not found.", errorCode: "USER_NAME_MISSING" };
      }

      let summary = `${userName} tiene ${orderCount || 0} pedidos.`;
      if (orderCount > 10) {
        summary += " ¡Es un cliente VIP!";
        // Ejemplo de forzar transición si es VIP
        // if (actionConfig.canForceTransition) { // El script no conoce actionConfig directamente
        //   return {
        //     status: "FORCE_TRANSITION",
        //     transitionDetails: { nextStateId: "vip_treatment_state" }
        //   };
        // }
      }
      return { status: "SUCCESS", output: { customerSummary: summary, vipStatus: orderCount > 10 } };
    }

    module.exports = { processData };
    ```

---
Este documento se actualizará a medida que evolucionen las capacidades de definición de APIs y Scripts.
```
