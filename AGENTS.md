# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js con IA y Gestión de API Sincrónica/Asíncrona

Este documento guía el trabajo con el proyecto FSM, que ahora incluye procesamiento IA y un manejo diferenciado para llamadas API síncronas y asíncronas (estas últimas usando Redis Streams).

## Estructura del Proyecto Clave

-   `package.json`: Incluye `axios` y `uuid`.
-   `config/`:
    -   `states.json`:
        -   `payloadResponse.apiHooks.synchronousCallSetup`: Array de `apiId`s. El servidor FSM las llama y **espera** la respuesta en el mismo turno. Resultados en `collectedParameters.sync_api_results.{apiId}`.
        -   `payloadResponse.apiHooks.asynchronousCallDispatch`: Array de `apiId`s. El servidor FSM las llama (fire-and-forget). Respuestas se esperan en un **próximo turno** vía Redis Streams y se acceden como `collectedParameters.async_api_results.{apiId}` o contexto para IA.
        -   (Nota: `onEnterState`, `beforeCollectingParameters`, `afterParametersCollected` en `apiHooks` podrían considerarse para lógica de cliente o server-side simple no bloqueante que no devuelve datos cruciales para el turno actual).
    -   `aiPrompt.txt`: Guía a la IA para usar `sync_api_results` (si se pasan en `customInstructions`) y `[API Response Context...]` (de llamadas asíncronas previas).
    -   `api_definitions/`: JSONs por API (`apiId`, `url`, `method`, plantillas de `headers`/`body`/`query_params`, `timeout_ms`, `response_stream_key_template`).
-   `src/`:
    -   `index.js` (`handleInputWithAI`):
        -   Orquesta el flujo: carga sesión, procesa respuestas de Redis Stream pendientes (de llamadas asíncronas previas), llama a IA, luego llama a `fsm.processInput`.
    -   `apiConfigLoader.js`: Carga definiciones de `config/api_definitions/`.
    -   `apiCallerService.js`:
        -   `makeRequestAndWait()`: Para llamadas síncronas (bloqueante, devuelve datos/error).
        -   `makeRequestAsync()`: Para llamadas asíncronas (no bloqueante, respuesta vía Redis Stream por worker externo).
    -   `fsm.js` (`processInput`):
        -   **Fase 1 (Pre-IA/Pre-Usuario Prompt)**: Ejecuta APIs en `synchronousCallSetup` del estado objetivo, guarda resultados en `currentParameters.sync_api_results`.
        -   **Fase 2 (Lógica FSM principal)**: Determina estado final basado en intent (de IA) y `currentParameters` (que incluye resultados síncronos).
        -   **Fase 3 (Renderizado)**: Genera `payloadResponse` para el usuario usando `currentParameters`.
        -   **Fase 4 (Despacho Asíncrono)**: Ejecuta APIs en `asynchronousCallDispatch` del estado final, registrando en `pendingApiResponses`.
    -   `redisClient.js`: Funciones para Redis Streams (`xreadgroup`, `xack`, etc.) y cliente subscriber.
-   `scripts/simulateApiResponder.js`: CLI para `XADD` manualmente respuestas/errores a Redis Streams para simular workers externos.

## Flujo de Datos Resumido

1.  **Entrada Usuario** -> `handleInputWithAI`.
2.  `handleInputWithAI`: Procesa respuestas de **Redis Stream** (de llamadas asíncronas previas), las combina con input usuario -> Texto para IA.
3.  **IA**: `intent`, `parameters`.
4.  `handleInputWithAI` -> `fsm.processInput(intent, params_ia, params_sesion_con_data_stream)`.
5.  `fsm.processInput`:
    a.  Ejecuta APIs de `synchronousCallSetup` (bloqueante), actualiza `currentParameters.sync_api_results`.
    b.  Lógica de transición FSM (usa `intent_ia`, `params_ia`, `params_sesion_con_data_stream_y_sync_api_results`).
    c.  Renderiza `payloadResponse` para el usuario.
    d.  Despacha APIs de `asynchronousCallDispatch` (no bloqueante), actualiza `pendingApiResponses`.
    e.  Guarda sesión.
6.  `fsm.processInput` devuelve resultado -> `handleInputWithAI` -> Respuesta al Cliente.
7.  **Worker Externo (o `simulateApiResponder.js`)**: Procesa llamada HTTP de `asynchronousCallDispatch`, escribe respuesta en Redis Stream.

## Consideraciones Clave

*   **Sincrónico vs. Asincrónico**: `synchronousCallSetup` bloquea el flujo del turno actual hasta que las APIs responden; sus datos se usan *ahora*. `asynchronousCallDispatch` no bloquea; sus datos son para el *futuro*.
*   **Namespacing de Parámetros**:
    *   Usuario/IA: `{{param}}`
    *   Sincrónico (mismo turno): `{{sync_api_results.api_id.campo}}`
    *   Asincrónico (turno previo, procesado de stream): `{{async_api_results.api_id.campo}}` (si `handleInputWithAI` los guarda así) o la IA los extrae de `[API Response Context...]`.
*   **`customInstructions` para IA**: Pueden usar `{{sync_api_results...}}` porque `fsm.js` ejecuta estas APIs *antes* de que `handleInputWithAI` construya el prompt final para la IA basado en el `payloadResponse` (que incluye `customInstructions` renderizadas).

Revisar `.env.example` para timeouts, config de streams, etc. El script `simulateApiResponder.js` es crucial para probar el flujo asíncrono.
