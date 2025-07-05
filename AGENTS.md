# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js Avanzado

Este documento guía el trabajo con el proyecto FSM, que ahora incluye procesamiento IA mejorado, manejo avanzado de estados (saltos y dependencias), ejecución de scripts JS, y un flujo de datos más rico.

## Estructura del Proyecto Clave (Secciones Relevantes Modificadas/Añadidas)

-   `package.json`: Incluye `axios`, `uuid`, `ioredis`, `pino`.
-   `config/`:
    -   `states.json`:
        -   `payloadResponse.apiHooks`: Contiene `synchronousCallSetup`, `asynchronousCallDispatch`, y el nuevo `executeScript`.
        -   Cada entrada en estos arrays es ahora un **objeto** que define la acción (`apiId` o detalles del script) y puede incluir una propiedad `dependsOn`.
        -   `dependsOn`: Objeto opcional que especifica `parameters` (del usuario/IA) y/o `apiResults` (IDs de otras APIs) que deben existir para que la acción se ejecute.
        -   `synchronousCallSetup`: Objetos `{ "apiId": "...", "dependsOn": { ... } }`. Resultados en `currentParameters.sync_api_results.{apiId}`.
        -   `asynchronousCallDispatch`: Objetos `{ "apiId": "...", "dependsOn": { ... } }`.
        -   `executeScript`: Nueva sección. Array de objetos `{ "scriptId": "...", "filePath": "...", "functionName": "...", "assignResultTo": "...", "isAsync": false, "dependsOn": { ... } }`. Resultados en `currentParameters[assignResultTo]` o `currentParameters.script_results[scriptIdOfilePath]`.
    -   `aiPrompt.txt`: Guía general para la IA. Su efectividad se ve aumentada por el prompt más rico construido por `index.js`.
    -   `api_definitions/`: Definiciones de API.
    -   `scripts/`: Nuevo directorio para snippets de código JS ejecutables por la FSM.
-   `src/`:
    -   `index.js` (`handleInputWithAI`):
        -   Orquesta el flujo: carga sesión (incl. `conversationHistory`), procesa respuestas de Redis Stream, **construye prompt enriquecido para IA (con historial, parámetros recolectados, contexto de API asíncrona, y `customInstructions` del turno anterior)**, llama a IA, luego llama a `fsm.processInput`.
        -   **Responsable de poblar `sessionData.conversationHistory`** después de recibir la respuesta de la FSM.
    -   `scriptExecutor.js` (Nuevo): Carga y ejecuta scripts de `config/scripts/`.
    -   `fsm.js` (`processInput`):
        -   Acepta `userInputText` (para que `index.js` lo use en el historial).
        -   **Manejo de Estados Saltados**: Si se detecta un salto de estado, procesa acciones (`synchronousCallSetup`, `executeScript`, `asynchronousCallDispatch`) de los estados intermedios, respetando sus `dependsOn`.
        -   **Ejecución de Acciones con Dependencias**: Utiliza `areDependenciesMet` antes de ejecutar cualquier API o script.
        -   Guarda `sync_api_results` y `script_results` en `currentParameters`.
    -   `redisClient.js`: `getClient()` expuesto para acceso directo (usado en `simulateApiResponder.js`).
-   `scripts/simulateApiResponder.js`: Actualizado para usar `MAXLEN ~ <count>` al añadir mensajes a streams.
-   `env.example`: Incluye `REDIS_SESSION_TTL` y `SIMULATOR_STREAM_MAXLEN`.

## Flujo de Datos Resumido (con Nuevas Capacidades)

1.  **Entrada Usuario** (`userInput`, `userInputText`) -> `handleInputWithAI` en `index.js`.
2.  `handleInputWithAI`:
    a.  Carga sesión FSM (con `parameters`, `sync_api_results` del ciclo anterior, `async_api_results` procesados, `pendingApiResponses`, `conversationHistory`, `script_results` del ciclo anterior).
    b.  Procesa respuestas de **Redis Stream** pendientes (de `asynchronousCallDispatch` previas), actualiza `currentParameters.async_api_results`.
    c.  **Construye Prompt para IA**: Combina `userInputText`, `customInstructions` (del `payloadResponse` del estado anterior), contexto de API asíncronas, historial de conversación formateado, y parámetros recolectados formateados.
    d.  Llama a `aiService.js` con este prompt enriquecido.
    e.  Recibe `aiIntent`, `aiParameters` de la IA y los valida.
3.  `handleInputWithAI` -> `fsm.processInput(sessionId, aiIntent, aiParameters, initialCall, userInputText)`.
4.  `fsm.processInput`:
    a.  Fusiona `aiParameters` con `currentParameters` de la sesión.
    b.  Determina `candidateNextStateId`.
    c.  **Procesa Estados Saltados**: Si `candidateNextStateId` implica saltar estados, para cada estado saltado:
        i.  Ejecuta sus `synchronousCallSetup` (si `dependsOn` se cumplen), actualizando `currentParameters.sync_api_results`.
        ii. Ejecuta sus `executeScript` (si `dependsOn` se cumplen), actualizando `currentParameters` según `assignResultTo` o en `currentParameters.script_results`.
        iii.Ejecuta sus `asynchronousCallDispatch` (si `dependsOn` se cumplen), actualizando `sessionData.pendingApiResponses`.
    d.  **Procesa Estado Objetivo**:
        i.  Ejecuta `synchronousCallSetup` del `candidateNextStateId` (si `dependsOn` se cumplen).
        ii. Ejecuta `executeScript` del `candidateNextStateId` (si `dependsOn` se cumplen).
    e.  **Lógica de Transición FSM Principal**: Confirma `finalNextStateId`.
    f.  **Renderiza `payloadResponse`**: Para el `finalNextStateConfig` usando `currentParameters` actualizados.
    g.  **Despacha APIs/Scripts Asíncronos del Estado Final**: Ejecuta `asynchronousCallDispatch` del `finalNextStateConfig`.
    h.  Guarda sesión FSM actualizada (con `REDIS_SESSION_TTL`).
5.  `fsm.processInput` devuelve resultado -> `handleInputWithAI`.
6.  `handleInputWithAI`:
    a.  **Actualiza Historial**: Añade `{userInput: userInputText, aiOutput: renderedPayloadResponse.prompts.main}` a `sessionData.conversationHistory`.
    b.  Guarda la sesión nuevamente.
    c.  Envía `renderedPayloadResponse` al Cliente.
7.  **Worker Externo / `simulateApiResponder.js`**: Procesa llamada HTTP de `asynchronousCallDispatch`, escribe respuesta en Redis Stream (con `MAXLEN`).

## Consideraciones Clave para Agentes

*   **Definición de Acciones en `states.json`**: Al definir APIs o scripts, ahora se debe usar la estructura de objeto y considerar si se necesitan `dependsOn`.
    ```json
    "synchronousCallSetup": [
      {
        "apiId": "getUserDetails",
        "dependsOn": { "parameters": ["userId"] }
      }
    ],
    "executeScript": [
      {
        "scriptId": "formatUserData",
        "filePath": "formatters/user.js",
        "functionName": "formatForDisplay",
        "assignResultTo": "formattedUser",
        "dependsOn": { "apiResults": [{ "apiId": "getUserDetails", "status": "success" }] }
      }
    ]
    ```
*   **Flujo de Ejecución de Acciones**: Dentro de un estado (o un estado saltado), el orden general es: síncronas, scripts, asíncronas. Las dependencias pueden influir en si una acción específica se ejecuta.
*   **Namespacing de Parámetros en Plantillas y Scripts**:
    *   Usuario/IA: `{{param}}` (accedido como `currentParameters.param` en scripts).
    *   Resultados de API Síncrona: `{{sync_api_results.apiId.data...}}` (accedido como `currentParameters.sync_api_results.apiId.data...` en scripts).
    *   Resultados de API Asíncrona (del ciclo anterior): `{{async_api_results.apiId.data...}}` (accedido como `currentParameters.async_api_results.apiId.data...` en scripts).
    *   Resultados de Scripts: `{{nombre_asignado_en_assignResultTo}}` o `{{script_results.scriptIdOfilePath...}}` (accedido como `currentParameters.nombre_asignado_en_assignResultTo` o `currentParameters.script_results.scriptIdOfilePath...` en scripts).
*   **Prompt de IA**: La IA ahora recibe un prompt más rico. `customInstructions` pueden seguir usando resultados de `sync_api_results` (del ciclo anterior, renderizadas en el `payloadResponse` que forma la base del prompt actual), y además el prompt contendrá el historial de conversación y un resumen de parámetros ya recolectados.
*   **Desarrollo de Scripts (`config/scripts/`)**:
    *   Los scripts deben exportar la función especificada en `functionName`.
    *   Reciben `(currentParameters, logger, sessionId)`.
    *   Pueden ser síncronos o retornar Promesas (`isAsync: true`).
    *   Deben ser cuidadosos al modificar `currentParameters` directamente; es más seguro devolver valores.

Revisar `.env.example` para nuevas variables como `SIMULATOR_STREAM_MAXLEN`. El script `simulateApiResponder.js` es crucial para probar el flujo asíncrono y ahora ayuda a gestionar el tamaño del stream. La documentación `docs/ARI_Integration.md` detalla la interfaz con Asterisk.
---
*Fin del documento AGENTS.md*
