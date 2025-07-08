# Node.js FSM Service con Integración de IA y Llamadas API Sincrónicas/Asíncronas

Este proyecto implementa una Máquina de Estados Finitos (FSM) en Node.js, con procesamiento de Lenguaje Natural mediante IA y un mecanismo robusto para realizar llamadas a APIs externas de forma **sincrónica** (bloqueante, para datos necesarios en el turno actual) y **asíncrona** (no bloqueante, para datos del próximo turno vía Redis Streams).

## Características Principales

*   **Procesamiento de Entrada por IA**:
    *   Acepta texto de usuario (o JSON estructurado).
    *   Usa `src/aiService.js` (OpenAI, Google Gemini, Groq) para extraer `intent` y `parameters` (guiado por `config/aiPrompt.txt`).
    *   Valida respuesta de IA (`config/aiResponseSchema.json`, `config/customAIResponseValidator.js`).
*   **Gestión Dual de APIs Externas**:
    *   **Llamadas Sincrónicas**:
        *   Definidas en `config/states.json` bajo `payloadResponse.apiHooks.synchronousCallSetup` (array de `apiId`s).
        *   `fsm.js` las ejecuta **y espera sus respuestas** usando `apiCallerService.makeRequestAndWait()`.
        *   Resultados se fusionan en `collectedParameters.sync_api_results.{apiId}` y están disponibles *inmediatamente* para la lógica FSM, plantillas de respuesta al usuario, y `customInstructions` para la IA del turno actual.
    *   **Llamadas Asíncronas (para el próximo ciclo)**:
        *   Definidas en `config/states.json` bajo `payloadResponse.apiHooks.asynchronousCallDispatch` (array de `apiId`s).
        *   `fsm.js` usa `apiCallerService.makeRequestAsync()` (fire-and-forget).
        *   Se registra la llamada pendiente en `sessionData.pendingApiResponses` (con `correlationId` y `responseStreamKey`).
        *   Un *worker externo* (simulado por `scripts/simulateApiResponder.js`) escribe la respuesta de la API de terceros al `responseStreamKey` (Redis Stream).
*   **Consumo de Respuestas Asíncronas (Redis Streams)**:
    *   `src/index.js` (`handleInputWithAI`): Antes de llamar a la IA, verifica y consume mensajes de los Redis Streams pendientes (usando `XREADGROUP`).
    *   Datos/errores de estas APIs se fusionan con el input del usuario para la IA (contexto `[API Response Context ...]`) y en `collectedParameters.async_api_results.{apiId}`.
*   **Motor FSM Avanzado y Configurable**:
    *   Lógica principal en `config/states.json`.
    *   **Manejo de Estados Saltados**: Capacidad de ejecutar acciones (APIs, scripts) de estados intermedios omitidos si el usuario provee información adelantada.
    *   **Dependencias Configurables**: Las llamadas API y ejecución de scripts pueden definir dependencias de parámetros de usuario o resultados de otras APIs.
*   **Ejecución de Snippets de Código JS**:
    *   Permite ejecutar piezas de código JavaScript personalizadas (`config/scripts/`) como parte del flujo de un estado.
    *   Configurable en `config/states.json` bajo `payloadResponse.apiHooks.executeScript`.
    *   Resultados pueden ser asignados a parámetros de la conversación.
*   **Plantillas Dinámicas**: `payloadResponse` y `customInstructions` para IA procesadas por `templateProcessor.js` (pueden usar `{{sync_api_results...}}`, `{{async_api_results...}}`, `{{script_results...}}`).
*   **Persistencia (Redis) Mejorada**:
    *   Sesiones FSM (incl. `sync_api_results`, `pendingApiResponses`, `script_results`, historial de conversación).
    *   Expiración de sesiones configurada mediante `REDIS_SESSION_TTL`.
    *   Control de tamaño de streams (usando `MAXLEN`) en el script simulador de respuestas API (`SIMULATOR_STREAM_MAXLEN`).
*   **Interfaces**: API RESTful, Sockets UNIX, Asterisk ARI (ver `docs/ARI_Integration.md`).
*   **Logging**: `pino`.
*   **Definiciones de API**: En `config/api_definitions/` (URL, método, headers, plantillas, timeouts).

## Funcionalidad Detallada (Flujo Principal)

1.  **Entrada de Usuario**: Cliente envía texto (y opc. `waitForCorrelationId`).
2.  **`handleInputWithAI` (`src/index.js`)**:
    *   Carga sesión FSM (con `pendingApiResponses`, `sync_api_results`, `parameters`).
    *   **Procesa Respuestas Asíncronas Pendientes**: Lee de Redis Streams (bloqueante si `waitForCorrelationId`), combina datos/errores en `fullTextInputForAI` y `currentParameters.async_api_results`. Actualiza `pendingApiResponses`.
    *   Guarda sesión si hubo cambios por respuestas de streams.
    *   **Llama a IA**: Envía `fullTextInputForAI` a `aiService.js`.
    *   Recibe `aiIntent`, `aiParameters` de la IA y los valida.
3.  **`fsm.processInput(sessionId, aiIntent, aiParameters)`**:
    *   Fusiona `aiParameters` con `currentParameters` de la sesión.
    *   Determina estado objetivo (actual o nuevo por transición de `aiIntent`).
    *   **Ejecuta APIs Sincrónicas**: Si el estado objetivo tiene `apiHooks.synchronousCallSetup`:
        *   Llama `apiCallerService.makeRequestAndWait()` para cada `apiId`.
        *   Fusiona resultados en `currentParameters.sync_api_results.{apiId}`.
        *   Si hay error crítico, puede transicionar a un estado de error.
    *   **Lógica FSM Principal**: Determina `nextStateId` final y `finalNextStateConfig` usando `aiIntent` y `currentParameters` (que ahora incluye resultados de API síncronas).
    *   **Renderiza `payloadResponse`**: Para el `finalNextStateConfig` usando `currentParameters` (acceso a `{{sync_api_results...}}`, `{{async_api_results...}}`, `{{param}}`).
    *   **Inicia APIs Asíncronas**: Si `finalNextStateConfig` tiene `apiHooks.asynchronousCallDispatch`:
        *   Para cada `apiId`: genera `correlationId`, renderiza `response_stream_key`, guarda en `pendingApiResponses`, llama `apiCallerService.makeRequestAsync()`.
    *   Guarda sesión FSM actualizada.
    *   Devuelve resultado FSM (`nextStateId`, `renderedPayloadResponse`, `sessionData` completa).
4.  **`handleInputWithAI`**: Envía respuesta FSM al cliente.
5.  **(Proceso Externo/Simulador)**: El worker externo/simulador procesa la llamada HTTP real de `makeRequestAsync` y publica la respuesta en el Redis Stream correspondiente.

## Configuración y Ejecución

*   **Dependencias**: `axios`, `uuid`, y las anteriores.
*   **Nuevos Módulos**: `src/apiConfigLoader.js`, `src/apiCallerService.js` (ahora con métodos sync/async).
*   **Redis Streams**: Para respuestas de API asíncronas.
*   **Variables de Entorno**: Ver `.env.example` (timeouts API, config Redis Stream).

Para ejecutar la aplicación y el simulador:
```bash
npm start # Aplicación principal
# En otra terminal, para simular una respuesta de API:
# node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [jsonData]
node scripts/simulateApiResponder.js api_responses_stream:sessExample:corr123 sessExample corr123 your_api_id_here success 200 '{"key":"value"}'
```

## Documentación Detallada
Consulte `docs/CodebaseOverview.md` y `FSM_Documentation.md`.
