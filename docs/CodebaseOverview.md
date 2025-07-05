# Visión General del Código Base - FSM con IA y API Sincrónicas/Asíncronas (Redis Streams)

Este documento detalla la estructura y flujo del proyecto FSM, ahora con capacidades de IA y manejo diferenciado de llamadas API síncronas y asíncronas.

## Estructura del Proyecto Clave

```
.
├── config/
│   ├── states.json                 # Lógica FSM. Ahora con payloadResponse.apiHooks.synchronousCallSetup y .asynchronousCallDispatch
│   ├── aiPrompt.txt                # Prompt IA (instrucciones para usar sync_api_results y API Response Context)
│   ├── aiResponseSchema.json       # Esquema validación IA
│   ├── customAIResponseValidator.js # Validador JS personalizado IA
│   └── api_definitions/            # Definiciones de API externas (url, method, plantillas, timeout, response_stream_key_template)
│       └── (ej: fetch_user.json)
├── docs/
│   └── CodebaseOverview.md         # Este archivo
├── scripts/
│   └── simulateApiResponder.js     # CLI para XADD respuestas API simuladas a Redis Streams
├── src/
│   ├── index.js                    # Orquestador: maneja input, espera/lee de streams, llama IA, llama FSM
│   ├── logger.js                   # Pino logger
│   ├── aiService.js                # Interactúa con proveedores IA
│   ├── jsonValidator.js            # Valida JSON de IA
│   ├── apiConfigLoader.js          # Carga config/api_definitions/
│   ├── apiCallerService.js         # Métodos makeRequestAndWait (sync) y makeRequestAsync (async) con Axios
│   ├── configLoader.js             # Carga states.json
│   ├── fsm.js                      # Motor FSM: ejecuta sync APIs, lógica de transición, despacha async APIs
│   ├── redisClient.js              # Cliente Redis: funciones Stream (xadd, xreadgroup, xack, xgroupCreate), cliente subscriber
│   └── templateProcessor.js        # Procesa plantillas ({{...}})
├── .env.example                    # Variables de entorno (timeouts API, config Redis Stream)
├── package.json                    # Dependencias (axios, uuid)
└── README.md, AGENTS.md, FSM_Documentation.md # Documentación principal (actualizada)
```

## Módulos Detallados y Flujo

### 1. `package.json`
   - Añadidas `axios` (llamadas HTTP) y `uuid` (correlation IDs).

### 2. `config/api_definitions/` y `src/apiConfigLoader.js`
   - `api_definitions/`: Contiene archivos JSON por API, definiendo `apiId`, `url`, `method`, plantillas para `headers`, `body_template`, `query_params_template`, `timeout_ms`, y `response_stream_key_template`.
   - `apiConfigLoader.js`: Carga estas definiciones en memoria al inicio. Provee `getApiConfigById(apiId)`.

### 3. `src/apiCallerService.js` (Actualizado)
   - `prepareRequestConfig()`: Función interna para procesar plantillas en URL, headers, body, query_params.
   - `makeRequestAndWait(apiId, sessionId, correlationId, params)`:
     - Usa `prepareRequestConfig`.
     - Ejecuta la llamada HTTP con `await axios()`.
     - Devuelve `{ status: 'success', data: ..., httpCode: ... }` o `{ status: 'error', errorMessage: ..., httpCode: ..., isTimeout: ... }`.
     - Usado por `fsm.js` para APIs en `synchronousCallSetup`.
   - `makeRequestAsync(apiId, sessionId, correlationId, params)`:
     - Usa `prepareRequestConfig`.
     - Ejecuta `axios()` sin `await` (fire-and-forget).
     - Registra el despacho. La respuesta real es manejada por un worker externo que escribe al Redis Stream.
     - Usado por `fsm.js` para APIs en `asynchronousCallDispatch`.

### 4. `src/redisClient.js` (Actualizado)
   - Mantiene un cliente principal y un `subscriberClient` para operaciones bloqueantes de streams.
   - Funciones añadidas/mejoradas: `xadd`, `xreadgroup`, `xack`, `xgroupCreate`.
   - Mejor manejo de conexión/desconexión y logging.

### 5. `config/states.json` y `src/configLoader.js`
   - `states.json`:
     - `payloadResponse.apiHooks.synchronousCallSetup`: Array de `apiId`s. Estas APIs son llamadas por el servidor FSM, y sus respuestas se esperan **dentro del mismo turno de conversación**.
     - `payloadResponse.apiHooks.asynchronousCallDispatch`: Array de `apiId`s (o definiciones más ricas si se adaptan). Estas APIs son llamadas por el servidor FSM de forma asíncrona (fire-and-forget). Sus respuestas se esperan en un **turno subsecuente** a través de Redis Streams.
     - Plantillas `{{...}}` pueden ahora usar `{{sync_api_results.apiId.field}}` para acceder a resultados de llamadas síncronas del turno actual, y `{{async_api_results.apiId.field}}` (o similar, dependiendo de cómo `index.js` los guarde) para resultados de llamadas asíncronas de turnos anteriores. `customInstructions` para la IA pueden también usar estos.
   - `configLoader.js`: Carga `states.json`.

### 6. `src/fsm.js` (`processInput` Refactorizado)
   - **Fase 1: Inicialización y Determinación de Estado Objetivo para APIs Síncronas**:
     - Carga sesión (que incluye `parameters`, `sync_api_results`, `pendingApiResponses`).
     - Fusiona `inputParameters` (de la IA) con `sessionData.parameters`.
     - Determina el `targetStateIdForSyncApis` (estado actual, o el siguiente si hay una transición por `intent` inmediata).
   - **Fase 2: Ejecución de APIs Sincrónicas (`synchronousCallSetup`)**:
     - Si `targetStateConfigForSyncApis.payloadResponse.apiHooks.synchronousCallSetup` existe:
       - Para cada `apiId`: Llama `apiCallerService.makeRequestAndWait()`.
       - Resultados (éxito o error estructurado) se guardan en `currentParameters.sync_api_results[apiId]`. `sessionData.parameters` se actualiza.
       - Errores críticos aquí podrían llevar a un estado de error FSM.
   - **Fase 3: Lógica de Transición FSM Principal**:
     - Determina `nextStateId` final y `finalNextStateConfig` basado en `effectiveIntent` y `currentParameters` (que ahora incluyen `sync_api_results`).
   - **Fase 4: Renderizado de `payloadResponse`**:
     - El `payloadResponse` del `finalNextStateConfig` se renderiza usando `templateProcessor` con `currentParameters`. Plantillas aquí pueden acceder a `{{sync_api_results...}}`, `{{async_api_results...}}` (si `index.js` los puso en `currentParameters`), y parámetros normales.
   - **Fase 5: Despacho de APIs Asíncronas (`asynchronousCallDispatch`)**:
     - Si `finalNextStateConfig.payloadResponse.apiHooks.asynchronousCallDispatch` existe:
       - Para cada `apiId`:
         - Genera `correlationId` con `uuidv4()`.
         - (Opcional: si `assignCorrelationIdTo` está en la definición, guarda el `correlationId` en `currentParameters`).
         - Obtiene `response_stream_key_template` de la config de la API, la renderiza.
         - Almacena `{ apiId, responseStreamKey, requestedAt }` en `sessionData.pendingApiResponses[correlationId]`.
         - Llama a `apiCallerService.makeRequestAsync()` (fire-and-forget).
   - **Guardado de Sesión**: `sessionData` (con todos los parámetros, `sync_api_results`, `pendingApiResponses` actualizados) se guarda en Redis.
   - Devuelve la estructura de respuesta FSM.

### 7. `src/index.js` (`handleInputWithAI` Actualizado)
   - **Manejo de Entrada**: Acepta texto o JSON `{ userInput, waitForCorrelationId, initialCall }`.
   - **Carga de Sesión**: Llama `fsm.initializeOrRestoreSession()`. `currentParameters` se inicializa desde `sessionData.parameters`.
   - **Procesamiento de Respuestas Asíncronas de Streams**:
     - **Si `waitForCorrelationId`**: Llama a `processSingleAwaitedApiResponse()`:
       - Hace `XREADGROUP ... BLOCK` en el stream de respuesta esperado (de `sessionData.pendingApiResponses`).
       - Procesa el mensaje (éxito/error/timeout), lo añade a `fullTextInputForAI`, actualiza `currentParameters.async_api_results.{apiId}_data` o `_error`. Hace `XACK`. Elimina de `pendingApiResponses`.
       - Si hay timeout del `BLOCK`, añade contexto de timeout a `fullTextInputForAI` y `currentParameters`.
     - **Otras Respuestas Pendientes**: Llama a `checkNonAwaitedApiResponses()`:
       - Itera `pendingApiResponses`, hace `XREADGROUP` con timeout corto en cada stream. Procesa, combina, ACKea y actualiza similarmente.
   - **Guardado Intermedio de Sesión**: Si `pendingApiResponses` o `currentParameters` cambiaron debido a respuestas de streams, se guarda `sessionData`.
   - **Llamada a IA**: `aiService.getAIResponse(fullTextInputForAI, aiPromptContent)`.
   - **Validación de IA**.
   - **Llamada Principal a FSM**: `fsm.processInput(sessionId, aiIntent, aiParametersFromAI, initialCallFlag)`.
     - Nota: `fsm.processInput` recibe los `aiParameters` y los fusiona con los `currentParameters` de la sesión (que ya incluyen `async_api_results`). Luego `fsm.processInput` añade `sync_api_results`.
   - Registra E/S en Redis. Devuelve resultado FSM.

### 8. `config/aiPrompt.txt` (Actualizado)
   - Incluye instrucciones para que la IA use:
     - Datos de `customInstructions` que pueden contener `{{sync_api_results...}}` (ya renderizados cuando la IA los ve).
     - Contexto de `[API Response Context ...]` o `[API Error Context ...]` para resultados de llamadas asíncronas de turnos anteriores.

### 9. `scripts/simulateApiResponder.js` (Actualizado)
   - Herramienta CLI: `node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [customDataJsonString]`.
   - Usa `redisClient.xadd()` para escribir un mensaje formateado (ver Plan Paso 5 para formato) al `responseStreamKey` especificado. Simula un worker externo que responde a una llamada API.

---
*Fin del documento.*
