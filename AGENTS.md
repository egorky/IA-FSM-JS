# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js con IA y Llamadas API Asíncronas

Este documento proporciona una guía para trabajar con el proyecto de Máquina de Estados Finitos (FSM) desarrollada en Node.js, integrado con un servicio de IA y un mecanismo para realizar llamadas API asíncronas reales usando Redis Streams para la gestión de respuestas.

## Estructura del Proyecto Actualizada

-   `package.json`: Dependencias actualizadas para incluir `axios` (para llamadas HTTP) y `uuid` (para `correlationId`s).
-   `config/`:
    -   `states.json`:
        -   **Nuevo**: Puede incluir un array `asyncApiCallsToTrigger` dentro de `payloadResponse`. Cada objeto en el array define:
            -   `apiId` (string): ID que coincide con una definición en `config/api_definitions/`.
            -   `params` (object): Parámetros para la plantilla de la API, usando `{{variables}}`.
            -   `assignCorrelationIdTo` (string, opcional): Si se provee, el `correlationId` generado se guardará en `sessionData.parameters` con esta clave.
    -   `aiPrompt.txt`: Guía a la IA, incluyendo cómo usar contexto de respuestas API.
    -   `aiResponseSchema.json`, `customAIResponseValidator.js`: Para validación de IA.
    -   `api_definitions/` (NUEVO Directorio):
        -   Contiene archivos JSON (uno por API) que definen: `apiId`, `url`, `method`, `headers` (plantilla), `body_template` (plantilla, para POST/PUT), `query_params_template` (plantilla, para GET), `timeout_ms`, y `response_stream_key_template` (plantilla para el nombre del Redis Stream donde se espera la respuesta).
-   `src/`:
    -   `index.js`:
        -   `handleInputWithAI`: Orquesta el flujo.
            -   Si la entrada del cliente indica `waitForCorrelationId` (o se detectan `pendingApiResponses` en sesión), intenta leer del Redis Stream correspondiente (`XREADGROUP ... BLOCK`).
            -   Combina respuestas de API (o errores/timeouts del stream) con el texto del usuario para la IA.
            -   Maneja la creación de grupos de consumidores de Redis Stream (`ensureStreamGroupExists`).
            -   Hace `XACK` de los mensajes procesados del stream.
    -   `logger.js`: Configuración de `pino`.
    -   `aiService.js`: Interactúa con proveedores de IA.
    -   `jsonValidator.js`: Valida JSON de la IA.
    -   `apiConfigLoader.js` (NUEVO): Carga definiciones de API desde `config/api_definitions/`.
    -   `apiCallerService.js` (NUEVO): Usa `axios` para realizar llamadas HTTP asíncronas (fire-and-forget). No escribe directamente en el stream de respuesta; eso es responsabilidad de un worker externo (simulado por `scripts/simulateApiResponder.js`).
    -   `configLoader.js`: Carga `states.json`.
    -   `fsm.js`:
        -   Procesa `asyncApiCallsToTrigger`: genera `correlationId` con `uuid`, renderiza `response_stream_key_template`, almacena info de llamada pendiente en `sessionData.pendingApiResponses[correlationId]`, y llama a `apiCallerService.makeRequest()`.
    -   `redisClient.js`: Cliente Redis.
        -   **Nuevo**: Incluye funciones para operaciones de Redis Streams (`xadd`, `xreadgroup`, `xack`, `xgroupCreate`) y maneja un cliente separado (`subscriberClient`) para operaciones bloqueantes.
    -   `apiServer.js`, `socketServer.js`, `ariClient.js`: Módulos de interfaz.
    -   `templateProcessor.js`: Procesa plantillas en `payloadResponse`, `asyncApiCallsToTrigger.params`, y plantillas de definición de API.
-   `scripts/`:
    -   `simulateApiResponder.js`: Script de utilidad.
        -   **Modificado**: Ya no sondea una cola de solicitudes. Ahora es una herramienta CLI para **añadir manualmente una respuesta (o error/timeout) a un Redis Stream específico**.
        -   Uso: `node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [customDataJsonString]`
        -   Usa `redisClient.xadd()` para escribir el mensaje formateado en el stream.

## Flujo General de la Aplicación con API Asíncronas y Redis Streams

1.  **Entrada de Usuario**: Cliente envía texto (y opcionalmente `waitForCorrelationId`).
2.  **`handleInputWithAI` (`index.js`)**:
    *   Carga sesión FSM (con `pendingApiResponses`).
    *   **Espera/Comprueba Respuestas de API en Stream**: Si `waitForCorrelationId` o hay `pendingApiResponses`, usa `XREADGROUP` (con `BLOCK` si `waitForCorrelationId`) en el `responseStreamKey` correspondiente.
    *   Procesa el mensaje del stream (éxito/error/timeout), lo combina con texto de usuario para la IA. Hace `XACK`. Actualiza `pendingApiResponses`.
    *   Envía texto (combinado) a `aiService.js`.
3.  **Procesamiento IA**: IA devuelve JSON (`intent`, `parameters`).
4.  **Validación IA**.
5.  **Entrada a FSM**: JSON validado a `fsm.processInput()`.
6.  **Procesamiento FSM (`fsm.js`)**:
    *   Determina `nextStateId`, `payloadResponse`.
    *   Si hay `asyncApiCallsToTrigger`:
        *   Genera `correlationId` (con `uuid`).
        *   Renderiza `response_stream_key` (de la config de API).
        *   Guarda `apiId`, `responseStreamKey` en `sessionData.pendingApiResponses[correlationId]`.
        *   Llama a `apiCallerService.makeRequest()` (esto hace la llamada HTTP real de forma asíncrona).
    *   Guarda sesión FSM en Redis.
7.  **Respuesta al Cliente**: La FSM devuelve su respuesta.
8.  **(Proceso Externo / Simulación con `simulateApiResponder.js`)**:
    *   Un sistema externo (o el script `simulateApiResponder.js` ejecutado manualmente) es responsable de:
        1.  Recibir la respuesta de la API de terceros (después de que `apiCallerService` la llamó).
        2.  Formatear un mensaje JSON según la estructura definida.
        3.  Usar `XADD` para escribir este mensaje en el `responseStreamKey` (ej: `api_responses_stream:sessionId:correlationId`) que la aplicación está escuchando.

## Consideraciones para el Desarrollo

*   **Llamadas HTTP Reales**: `apiCallerService.js` ahora intenta hacer llamadas HTTP reales con `axios`.
*   **Redis Streams para Respuestas**: La aplicación *consume* respuestas de API desde Redis Streams. Un *proceso externo* (o el script `simulateApiResponder.js` para pruebas) es quien *escribe* en estos streams.
*   **`correlationId` y `response_stream_key_template`**: Son claves para el sistema. El `correlationId` enlaza la solicitud con la respuesta. El `response_stream_key_template` (en `config/api_definitions/`) define a qué stream escuchar para una respuesta de API particular, renderizado con `sessionId` y `correlationId`.
*   **`pendingApiResponses` en Sesión**: `fsm.js` añade entradas aquí cuando dispara una llamada API. `index.js` (`handleInputWithAI`) las consume y elimina cuando llega una respuesta por el stream.
*   **Grupos de Consumidores de Stream**: `index.js` crea (si no existen) y usa grupos de consumidores para leer de los streams de respuesta, permitiendo un procesamiento más robusto de mensajes.

## Cómo Ejecutar (con `.env` y Simulación de API)

1.  **Iniciar la Aplicación Principal**: `npm start`
2.  **Simular una Respuesta de API (cuando la FSM haya disparado una llamada y esté esperando)**:
    Ejecutar en otra terminal, reemplazando los placeholders:
    ```bash
    node scripts/simulateApiResponder.js <response_stream_key_completo> <sessionId> <correlationId> <apiId_llamada> success 200 '{"mensaje_de_api":"datos exitosos"}'
    ```
    (El `<response_stream_key_completo>` se ve en los logs de FSM cuando marca una API como pendiente).

Asegúrate de que Redis esté corriendo. Revisa `.env.example` para nuevas variables de entorno como `REDIS_STREAM_CONSUMER_GROUP`, `REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM`, `REDIS_STREAM_XREAD_BLOCK_WAIT_MS`.
