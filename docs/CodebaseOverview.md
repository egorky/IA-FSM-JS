# Visión General del Código Base - Servicio FSM con IA y Llamadas API Asíncronas (Redis Streams)

Este documento proporciona una explicación detallada de cada archivo principal y pieza de código dentro del proyecto del Servicio FSM, ahora con integración de IA y un mecanismo robusto para llamadas API asíncronas usando Redis Streams.

## Estructura del Proyecto Actualizada

```
.
├── config/
│   ├── states.json                 # Define los estados y la lógica de la FSM
│   ├── aiPrompt.txt                # Prompt para la IA
│   ├── aiResponseSchema.json       # Esquema para validar la respuesta de la IA
│   ├── customAIResponseValidator.js # Validador JS personalizado para respuesta de IA
│   └── api_definitions/            # (NUEVO) Definiciones de APIs externas
│       ├── fetch_doctor_availability.json # Ejemplo
│       └── submit_appointment_booking.json # Ejemplo
├── docs/
│   └── CodebaseOverview.md         # Este archivo
├── scripts/
│   └── simulateApiResponder.js     # Script para simular respuestas de API externas (ahora usa XADD)
├── src/
│   ├── index.js                    # Punto de entrada, orquesta flujo IA y espera/lee de Redis Streams
│   ├── logger.js                   # Configuración del logger (Pino)
│   ├── aiService.js                # Servicio para interactuar con proveedores de IA
│   ├── jsonValidator.js            # Validador de JSON para respuestas de IA
│   ├── apiConfigLoader.js          # (NUEVO) Carga definiciones de API desde config/api_definitions/
│   ├── apiCallerService.js         # (NUEVO) Realiza llamadas HTTP asíncronas con Axios
│   ├── apiServer.js                # Servidor API Express
│   ├── ariClient.js                # Cliente Asterisk ARI
│   ├── socketServer.js             # Servidor de Sockets UNIX
│   ├── configLoader.js             # Carga y valida states.json
│   ├── fsm.js                      # Lógica FSM, dispara llamadas API vía apiCallerService, gestiona pendingApiResponses
│   ├── redisClient.js              # Cliente Redis, ahora con funciones para Streams y cliente subscriber
│   └── templateProcessor.js        # Procesa plantillas
├── .env.example                    # Ejemplo de variables de entorno (actualizado)
├── AGENTS.md                       # Instrucciones para agentes AI (actualizado)
├── FSM_Documentation.md            # Documentación general y casos de uso (actualizado)
├── package.json                    # Dependencias y scripts (actualizado con axios, uuid)
└── README.md                       # README principal (actualizado)
```

## Archivos y Módulos

### 1. `package.json` (Actualizado)
   - **Dependencias Adicionales**:
     - `axios`: Para realizar llamadas HTTP en `apiCallerService.js`.
     - `uuid`: Para generar `correlationId`s únicos en `fsm.js`.

### 2. Carpeta `config/` (Actualizada)
   - `states.json`:
     - **Nuevo**: En `payloadResponse`, puede incluir un array `asyncApiCallsToTrigger`. Cada objeto especifica:
       - `apiId` (string): Referencia a un archivo en `config/api_definitions/`.
       - `params` (object): Parámetros para la plantilla de la API (ej: `{ "specialty": "{{medical_specialty}}" }`).
       - `assignCorrelationIdTo` (string, opcional): Clave bajo la cual se guardará el `correlationId` generado en `sessionData.parameters`.
   - `api_definitions/` (NUEVO Directorio):
     - Contiene archivos JSON, uno por cada API externa que el sistema puede llamar.
     - **Estructura de cada archivo de definición de API** (ej: `fetch_doctor_availability.json`):
       - `apiId` (string): Identificador único (debe coincidir con el usado en `asyncApiCallsToTrigger`).
       - `description` (string): Descripción de la API.
       - `url` (string): URL de la API, puede contener placeholders `{{param}}`.
       - `method` (string): Método HTTP (GET, POST, PUT, etc.).
       - `headers` (object): Headers HTTP, los valores pueden ser placeholders.
       - `query_params_template` (object, opcional para GET): Plantilla para parámetros query, valores pueden ser placeholders.
       - `body_template` (object/string, opcional para POST/PUT): Plantilla para el cuerpo de la solicitud, puede contener placeholders.
       - `timeout_ms` (number): Timeout específico para esta API en milisegundos.
       - `response_stream_key_template` (string): Plantilla para la clave del Redis Stream donde se esperará/escribirá la respuesta de esta API (ej: `"api_responses_stream:{{sessionId}}:{{correlationId}}"`).
   - `aiPrompt.txt`, `aiResponseSchema.json`, `customAIResponseValidator.js`: Sin cambios funcionales mayores en esta iteración, pero el prompt está preparado para contexto de API.

### 3. `src/index.js` (Actualizado)
   - **`handleInputWithAI(sessionId, clientInput, source)`**:
     - **Entrada del Cliente**: Ahora puede recibir un objeto como `clientInput` con `{ userInput: "...", waitForCorrelationId: "..." }` para indicar que se debe esperar una respuesta de API específica.
     - **Carga de Sesión**: Recupera `sessionData` de Redis, que ahora incluye `pendingApiResponses`.
     - **Espera/Comprobación de Respuestas de API (Redis Streams)**:
       - Si `waitForCorrelationId` se proporciona y está en `pendingApiResponses`:
         - Obtiene el `responseStreamKey` de `pendingApiResponses[waitForCorrelationId]`.
         - Llama a `ensureStreamGroupExists` para ese stream.
         - Realiza una lectura bloqueante (`redisClient.xreadgroup`) en el stream con un timeout configurable (`REDIS_STREAM_XREAD_BLOCK_WAIT_MS`).
         - Si se recibe un mensaje: lo parsea (según formato definido en Plan Paso 5), combina `data` o `error` con `userInputText`, hace `XACK`, y elimina la entrada de `pendingApiResponses`.
         - Si hay timeout: añade un contexto de timeout a `userInputText` y elimina la entrada de `pendingApiResponses`.
       - También (o si no hay `waitForCorrelationId` explícito): Itera sobre `pendingApiResponses` y realiza lecturas no bloqueantes o con timeout corto (`REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM`) en los streams correspondientes, procesando los mensajes encontrados de manera similar.
     - **Parámetros Actualizados**: Parámetros derivados de respuestas API (ej: `api_{apiId}_data` o `api_{apiId}_error`) se fusionan con `currentParameters` de la sesión.
     - La sesión (con `pendingApiResponses` y parámetros actualizados) se guarda antes de llamar a la IA si ha habido cambios por respuestas de API.
     - El texto (potencialmente combinado con datos/errores de API) se envía a `aiService.getAIResponse`.
     - El resto del flujo (validación de IA, llamada a FSM) continúa, pero la FSM ahora opera con parámetros que pueden haber sido enriquecidos o actualizados por respuestas de API.
   - **`ensureStreamGroupExists(streamKey, groupName)`**: Nueva función helper para crear grupos de consumidores de Redis Stream si no existen (`XGROUP CREATE ... MKSTREAM`).
   - **`main()`**: Asegura la conexión de ambos clientes Redis (main y subscriber) al inicio.

### 4. `src/logger.js`
   - Sin cambios.

### 5. `src/aiService.js`
   - Sin cambios funcionales mayores. Recibe el texto (potencialmente combinado) de `handleInputWithAI`.

### 6. `src/jsonValidator.js`
   - Sin cambios funcionales mayores.

### 7. `src/apiConfigLoader.js` (NUEVO)
   - **Propósito**: Cargar y gestionar las configuraciones de las API externas.
   - **Funcionalidad**:
     - Lee todos los archivos `.json` del directorio `config/api_definitions/`.
     - Parsea cada archivo y lo almacena en un objeto caché, indexado por `apiId`.
     - Proporciona `getApiConfigById(apiId)` para recuperar una configuración específica.
     - Carga todas las configuraciones al iniciarse el módulo.

### 8. `src/apiCallerService.js` (NUEVO)
   - **Propósito**: Realizar las llamadas HTTP asíncronas a las APIs externas.
   - **`makeRequest(apiId, sessionId, correlationId, collectedParameters)`**:
     - Obtiene la configuración de la API usando `apiConfigLoader.getApiConfigById(apiId)`.
     - Utiliza `templateProcessor.processTemplate` para renderizar placeholders en la URL, headers, `body_template` y `query_params_template` usando `collectedParameters` y otros datos de contexto (`sessionId`, `correlationId`).
     - Realiza la llamada HTTP usando `axios` con el `method`, `url`, `headers`, `data` (cuerpo), `params` (query) y `timeout` configurados.
     - **Importante**: Esta función es "fire-and-forget" desde la perspectiva de quien la llama (`fsm.js`). No espera la respuesta HTTP. Su rol es despachar la solicitud.
     - Registra (log) el intento de despacho. El manejo de la respuesta real (éxito/error) y su publicación en el Redis Stream es responsabilidad de un "worker externo" (simulado por `scripts/simulateApiResponder.js`).

### 9. `src/configLoader.js`
   - Sin cambios funcionales mayores.

### 10. `src/redisClient.js` (Actualizado)
   - **Cliente Subscriber**: Se añade un `subscriberClient` separado para operaciones Redis bloqueantes (como `XREADGROUP ... BLOCK`) para no interferir con otras operaciones Redis no bloqueantes.
   - **Nuevas Funciones para Streams**:
     - `xadd(streamKey, id, ...fieldValuePairs)`: Para añadir mensajes a un stream.
     - `xreadgroup(groupName, consumerName, streamsArray, blockMs, count)`: Para leer de un stream usando un grupo de consumidores.
     - `xack(streamKey, groupName, ...messageIds)`: Para confirmar el procesamiento de mensajes.
     - `xgroupCreate(streamKey, groupName, id, mkstream)`: Para crear un grupo de consumidores (y el stream si `mkstream` es true y no existe).
   - `connect()` y `quit()` ahora manejan ambos clientes (main y subscriber).
   - Lógica de reconexión y logging mejorada.

### 11. `src/fsm.js` (Actualizado)
   - **`initializeOrRestoreSession`**: Ahora inicializa `sessionData.pendingApiResponses = {}` si no existe.
   - **`processInput()`**:
     - Después de determinar `nextStateConfig` y `renderedPayloadResponse`:
       - Busca la directiva `asyncApiCallsToTrigger` en `nextStateConfig.payloadResponse` (del config original, no del renderizado).
       - Para cada API en `asyncApiCallsToTrigger`:
         - Genera un `correlationId` único usando `uuidv4()`.
         - Si `callDefinition.assignCorrelationIdTo` está definido, el `correlationId` se almacena en `currentParameters` (y por ende en `sessionData.parameters`).
         - Renderiza los `params` de la API usando `templateProcessor` y `currentParameters`.
         - Obtiene la configuración de la API (de `apiConfigLoader`) para encontrar el `response_stream_key_template`.
         - Renderiza el `response_stream_key_template` usando `currentParameters`, `sessionId` y el `correlationId` generado.
         - Almacena un objeto en `sessionData.pendingApiResponses[correlationId]` con `{ apiId, responseStreamKey, requestedAt }`.
         - Llama a `apiCallerService.makeRequest(apiId, sessionId, correlationId, processedApiParams)` para despachar la llamada HTTP.
     - La `sessionData` actualizada (incluyendo `pendingApiResponses` y cualquier `correlationId` añadido a `parameters`) se guarda en Redis.
   - Referencias a `API_REQUEST_QUEUE_KEY` y `sendApiRequestAsync` eliminadas.

### 12. `src/templateProcessor.js`
    - Sin cambios funcionales mayores, pero su uso se extiende a las plantillas de definición de API.

### 13. `scripts/simulateApiResponder.js` (Actualizado)
    - Ya no sondea una lista de Redis.
    - Ahora es una herramienta CLI que se ejecuta manualmente para simular la respuesta de una API específica.
    - **Uso**: `node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [customDataJsonString]`
    - Construye un mensaje JSON (conforme al formato definido en el Plan Paso 5: `correlationId`, `sessionId`, `apiId`, `status`, `httpCode`, `data`, `errorMessage`, `isTimeout`, `timestamp`).
    - Usa `redisClient.xadd()` para añadir este mensaje al `responseStreamKey` especificado.
    - Los valores del mensaje (ej: `data` o `errorMessage`) se generan según los argumentos `status`, `apiId` o el `customDataJsonString`.

### 14. `.env.example` (Actualizado)
    - **Nuevas Variables para Redis Streams**:
        - `REDIS_STREAM_CONSUMER_GROUP`: Nombre del grupo de consumidores (ej: `fsm_ai_group`).
        - `REDIS_STREAM_CONSUMER_NAME_PREFIX`: Prefijo para nombres de consumidor (ej: `fsm_consumer_`). Se le añade un UUID al inicio de la app.
        - `REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM`: Timeout corto para lecturas no bloqueantes de streams en `checkForApiResponses`.
        - `REDIS_STREAM_XREAD_BLOCK_WAIT_MS`: Timeout más largo para lecturas bloqueantes cuando `waitForCorrelationId` está presente.
    - (Otras variables para IA, logging, etc., ya estaban presentes).

---
*Fin del documento.*
