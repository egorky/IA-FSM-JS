# Node.js FSM Service con Integración de IA y Llamadas API Asíncronas (vía Redis Streams)

Este proyecto implementa una Máquina de Estados Finitos (FSM) utilizando Node.js, con una capa de procesamiento de Lenguaje Natural mediante IA y un mecanismo para realizar llamadas a APIs externas de forma asíncrona, utilizando Redis Streams para la comunicación de respuestas.

## Características Principales

*   **Procesamiento de Entrada por IA**:
    *   Acepta texto de usuario (o JSON estructurado con texto en algunos casos).
    *   Utiliza un servicio de IA (`src/aiService.js`) configurable (OpenAI, Google Gemini, Groq) para extraer `intent` y `parameters`.
    *   La IA es guiada por `config/aiPrompt.txt`.
    *   La respuesta JSON de la IA es validada (`config/aiResponseSchema.json`, `config/customAIResponseValidator.js`).
*   **Llamadas a API Externas Asíncronas (Producción)**:
    *   Los estados en `config/states.json` pueden definir una lista `asyncApiCallsToTrigger` en su `payloadResponse`.
    *   Cada item define un `apiId` (de `config/api_definitions/`), `params` para la API, y opcionalmente `assignCorrelationIdTo` para guardar el `correlationId` en los parámetros de la FSM.
    *   `fsm.js` utiliza `uuid` para generar un `correlationId` único para cada llamada.
    *   `fsm.js` registra la información de la llamada API pendiente (incluyendo `correlationId` y la `response_stream_key` renderizada) en `sessionData.pendingApiResponses`.
    *   `apiCallerService.js` usa `axios` para realizar la llamada HTTP real de forma asíncrona (fire-and-forget desde la perspectiva de la FSM).
    *   **Un worker externo (no parte de este proyecto, pero simulado por `scripts/simulateApiResponder.js`) es responsable de tomar la respuesta de la API de terceros y publicarla en la `response_stream_key` (un Redis Stream) usando un formato JSON definido.**
*   **Consumo de Respuestas API vía Redis Streams**:
    *   `src/index.js` (`handleInputWithAI`):
        *   Si la entrada del cliente indica que espera una respuesta API (`waitForCorrelationId`), realiza una lectura bloqueante (`XREADGROUP ... BLOCK`) en el Redis Stream correspondiente.
        *   También verifica de forma no bloqueante otras respuestas pendientes en streams.
        *   Las respuestas (o errores/timeouts) de la API recuperadas del stream se combinan con la entrada de texto del usuario antes de enviarse a la IA.
        *   Los mensajes leídos se confirman (`XACK`).
*   **Motor de FSM Configurable**: Lógica de estados y transiciones en `config/states.json`.
*   **Respuestas Dinámicas**: `payloadResponse` procesado por `templateProcessor.js`.
*   **Persistencia de Sesión con Redis**: Almacena estado de conversación, parámetros (incluyendo `correlationId`s) y `pendingApiResponses`.
*   **Múltiples Interfaces de Comunicación**: API RESTful, Sockets UNIX, Asterisk ARI.
*   **Logging Asíncrono**: Utiliza `pino`.
*   **Definiciones de API Configurables**: En `config/api_definitions/` se definen URLs, métodos, headers, plantillas de body/query params, y timeouts por API.

## Funcionalidad Detallada con Llamadas API Asíncronas

1.  **Entrada de Usuario**: El cliente envía texto, opcionalmente indicando que espera una `waitForCorrelationId`.
2.  **`handleInputWithAI` (`src/index.js`)**:
    *   Carga la sesión FSM (que incluye `pendingApiResponses`).
    *   **Espera/Comprueba Respuestas de API en Redis Streams**:
        *   Si `waitForCorrelationId` está presente, bloquea (con timeout) en el stream especificado en `pendingApiResponses[waitForCorrelationId].responseStreamKey`.
        *   De lo contrario, o adicionalmente, verifica otros streams pendientes de forma no bloqueante.
        *   Si se recibe un mensaje del stream: se parsea, se combina su contenido (datos o error) con el texto del usuario, se hace `XACK`, y se elimina de `pendingApiResponses`.
    *   El texto (potencialmente combinado) se envía al `aiService.js`.
3.  **Procesamiento por IA (`src/aiService.js`)**: IA devuelve JSON (`intent`, `parameters`).
4.  **Validación de IA**: Se valida el JSON.
5.  **Entrada a FSM**: El JSON validado alimenta a `fsm.js`. Los parámetros de la FSM ahora pueden incluir datos de API o `correlationId`s.
6.  **Procesamiento FSM (`src/fsm.js`)**:
    *   Determina `nextStateId` y `payloadResponse`.
    *   Si el `payloadResponse` del estado contiene `asyncApiCallsToTrigger`:
        *   Para cada llamada API definida:
            *   Genera un `correlationId` (usando `uuid`). Si `assignCorrelationIdTo` está definido, este ID se guarda en los parámetros de la FSM.
            *   Renderiza la `response_stream_key_template` (de `config/api_definitions/`) y los `params` de la API.
            *   Almacena la info de la llamada pendiente (incluyendo `responseStreamKey` y `apiId`) en `sessionData.pendingApiResponses[correlationId]`.
            *   Llama a `apiCallerService.makeRequest()` para despachar la llamada HTTP real (asíncrona, fire-and-forget).
    *   La sesión FSM (con `pendingApiResponses` actualizado) se guarda asíncronamente en Redis.
7.  **Respuesta al Cliente**: La FSM devuelve su respuesta (`nextStateId`, `payloadResponse` procesado, etc.). El cliente puede usar `correlationId`s (si se expusieron en `payloadResponse` o parámetros) para luego indicar `waitForCorrelationId`.
8.  **(Proceso Externo/Simulador)**:
    *   Un sistema externo (o `scripts/simulateApiResponder.js` para pruebas) realiza la llamada a la API de terceros.
    *   Al recibir la respuesta (o error/timeout), este sistema externo formatea un mensaje JSON (según el formato definido) y lo añade (`XADD`) al `responseStreamKey` correspondiente.
    *   Este mensaje será recogido por `handleInputWithAI` en una futura interacción (paso 2a).

## Configuración y Ejecución

*   **Dependencias**: `express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`, `openai`, `@google/genai`, `groq-sdk`, `ajv`, `pino`, `axios`, `uuid`.
*   **Nuevos Módulos**: `src/apiConfigLoader.js`, `src/apiCallerService.js`.
*   **Nuevas Configuraciones**: Directorio `config/api_definitions/` con JSONs por API.
*   **Redis Streams**: Usados para comunicar respuestas de API de vuelta a la aplicación. Se crean grupos de consumidores automáticamente.
*   **Variables de Entorno**: Ver `.env.example`. Nuevas variables como `REDIS_STREAM_CONSUMER_GROUP`, `REDIS_STREAM_CONSUMER_NAME_PREFIX`, `REDIS_STREAM_XREAD_BLOCK_MS_PER_ITEM`, `REDIS_STREAM_XREAD_BLOCK_WAIT_MS`.

Para ejecutar la aplicación principal:
```bash
npm start
```
Para simular un worker que responde a las llamadas API y publica en Redis Streams (en otra terminal):
```bash
# Ejemplo: node scripts/simulateApiResponder.js <responseStreamKey> <sessionId> <correlationId> <apiId> [status] [httpCode] [jsonData]
node scripts/simulateApiResponder.js api_responses_stream:sessTest:corrTest sessTest corrTest fetch_doctor_availability success 200 '{"doctors": ["Dr. Sim"]}'
```

## Documentación Detallada del Código
Consulte `docs/CodebaseOverview.md` para más detalles.
---
*Nota: Este sistema ahora realiza llamadas HTTP reales. El script `simulateApiResponder.js` es para simular la parte que *recibe la respuesta de la API de terceros y la escribe en el Redis Stream*. No simula la llamada HTTP en sí misma que hace `apiCallerService.js`.*
