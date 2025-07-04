# Documento de Funcionamiento y Casos de Uso del Servicio FSM con IA y Llamadas API Asíncronas (Redis Streams)

## 1. Introducción al Servicio FSM con IA

Este servicio de Máquina de Estados Finitos (FSM) integra procesamiento de lenguaje natural mediante IA y un mecanismo robusto para **realizar llamadas a APIs externas de forma asíncrona, utilizando Redis Streams** para la comunicación y espera de respuestas.

**Flujo General:**
1.  La entrada del usuario (texto, o JSON con texto y opcionalmente un `waitForCorrelationId`) llega a una interfaz (API, Socket, ARI).
2.  `src/index.js` (`handleInputWithAI`) gestiona la interacción:
    *   Carga la sesión FSM, que puede contener `pendingApiResponses` (llamadas API previas aún sin respuesta).
    *   Si se especifica `waitForCorrelationId` (o para otras respuestas pendientes de forma no bloqueante), **escucha en un Redis Stream específico** (definido en `sessionData.pendingApiResponses[correlationId].responseStreamKey`) usando `XREADGROUP ... BLOCK`.
    *   Cuando llega una respuesta de API por el stream (o hay timeout), se combina con el texto del usuario.
    *   Este texto combinado se envía al `src/aiService.js`.
3.  El `aiService.js` obtiene `intent` y `parameters` de la IA.
4.  La respuesta de la IA se valida.
5.  El `src/fsm.js` procesa el `intent` y `parameters`:
    *   Determina el siguiente estado y `payloadResponse`.
    *   Si el estado define `asyncApiCallsToTrigger` en su `payloadResponse`:
        *   Para cada API a llamar:
            *   Genera un `correlationId` único (`uuid`).
            *   Renderiza la `response_stream_key_template` (de `config/api_definitions/`) para saber a qué stream escuchar la respuesta.
            *   Almacena el `correlationId`, `apiId`, y `responseStreamKey` renderizada en `sessionData.pendingApiResponses`.
            *   Llama a `src/apiCallerService.js` para **despachar la llamada HTTP real de forma asíncrona** (usando `axios`).
    *   Guarda la sesión FSM actualizada en Redis.
6.  La respuesta de la FSM se devuelve al cliente.
7.  **Un proceso externo** (que idealmente recibe la respuesta de la API de terceros) es responsable de:
    *   Formatear un mensaje JSON (con `correlationId`, `status`, `data`/`error`, etc.).
    *   Escribir (`XADD`) este mensaje al `responseStreamKey` (Redis Stream) que la aplicación principal está escuchando. (Para pruebas, `scripts/simulateApiResponder.js` hace esto).

**Componentes Clave para API Asíncronas:**
*   **`config/api_definitions/`**: (NUEVO) Directorio con archivos JSON que definen cada API externa (URL, método, headers, plantillas de body/query, timeout, `response_stream_key_template`).
*   **`src/apiConfigLoader.js`**: (NUEVO) Carga y cachea las definiciones de API.
*   **`src/apiCallerService.js`**: (NUEVO) Realiza las llamadas HTTP asíncronas usando `axios`. No espera la respuesta.
*   **`src/fsm.js` (Actualizado)**: Identifica `asyncApiCallsToTrigger`, genera `correlationId`s, registra llamadas pendientes en la sesión, y delega la llamada HTTP a `apiCallerService.js`.
*   **`src/index.js` (`handleInputWithAI`) (Actualizado)**: Escucha en Redis Streams (`XREADGROUP`) las respuestas de las APIs pendientes, las combina con la entrada del usuario para la IA.
*   **`src/redisClient.js` (Actualizado)**: Añade funciones para interactuar con Redis Streams (`xadd`, `xreadgroup`, `xack`, `xgroupCreate`) y gestiona un cliente Redis separado para operaciones bloqueantes.
*   **`scripts/simulateApiResponder.js` (Actualizado)**: Ahora es una utilidad CLI para añadir manualmente una respuesta a un Redis Stream específico, simulando el worker externo.

## 2. Arquitectura General con API Asíncronas y Redis Streams

```mermaid
graph TD
    subgraph ClienteExApp [Aplicación Cliente Externa]
        direction LR
        C[Cliente UI / Chatbot / IVR] -- 1. Texto Usuario (opc. waitForCorrelationId) --> IFACE[API / Socket / ARI Handler]
    end

    subgraph ServicioFSM_IA [Servicio FSM Node.js con IA]
        direction TB
        IFACE --> IDX[index.js: handleInputWithAI]

        subgraph RedisDB [Redis]
            direction TB
            STREAMS[API Response Streams<br>response_stream_key:sessId:corrId]
            SESSIONS[Sesiones FSM<br>(incl. pendingApiResponses)]
            LOGS_IA_FSM[Logs Varios]
        end

        IDX -- 2. Carga Sesión (con pendingApiResponses) --> SESSIONS
        IDX -- 3. XREADGROUP en STREAMS (espera si waitForCorrelationId) --> STREAMS
        STREAMS -- 4. Mensaje API (o timeout) --> IDX
        IDX -- 5. XACK --> STREAMS
        IDX -- 6. Texto Usuario + Datos API (opc.) --> AISVC[AI Service]
        AISVC -- Prompt --> AIPROV[Proveedor IA Externo]
        AIPROV -- JSON crudo --> AISVC
        AISVC -- JSON crudo --> VALIDATOR[Validador IA]
        VALIDATOR -- 7. JSON validado (intent, params) --> FSM[Motor FSM]

        FSM -- Definición Estados/asyncApiCallsToTrigger --> STATES_JSON[config/states.json]
        FSM -- Definición API --> APIDEFS[config/api_definitions/]
        FSM -- 8. Llama a apiCallerService --> APICALLER[apiCallerService.js]
        APICALLER -- 9. Despacha HTTP real (async) --> EXT_API[API Externa de Terceros]
        FSM -- 10. Actualiza pendingApiResponses y guarda Sesión --> SESSIONS
        FSM -- 11. Respuesta FSM --> IFACE
        IFACE -- Respuesta JSON Final --> C
    end

    subgraph WorkerExterno_o_Simulador [Worker Externo / Simulador]
        EXT_API -- 12. Respuesta HTTP --> WORKER[Proceso Externo o scripts/simulateApiResponder.js]
        WORKER -- 13. XADD Mensaje Formateado a STREAMS --> STREAMS
    end

    style ClienteExApp fill:#dae8fc,stroke:#333,stroke-width:2px
    style ServicioFSM_IA fill:#d5e8d4,stroke:#333,stroke-width:2px
    style WorkerExterno_o_Simulador fill:#ffe6cc,stroke:#333,stroke-width:2px
```

## 3. Flujo de Interacción Típico con API Asíncrona Real (usando Redis Streams)

### Solicitud Inicial del Usuario

*   **App Externa (API)** `POST /fsm/session789` con `Content-Type: text/plain`:
    ```
    "Necesito los horarios del Dr. Smith para mañana."
    ```
    (El cliente no espera ninguna API en esta primera interacción).

### Proceso Interno (Ciclo 1)

1.  **`handleInputWithAI` (index.js)**:
    *   Carga sesión para `session789`. No hay `pendingApiResponses` o `waitForCorrelationId`.
    *   Texto para IA: `"Necesito los horarios del Dr. Smith para mañana."`
2.  **`aiService.js`**:
    *   Salida Esperada de IA: `{"intent": "get_doctor_schedule", "parameters": {"doctor_name": "Dr. Smith", "schedule_date": "mañana"}}`
3.  **Validación**: Pasa.
4.  **Entrada a FSM**: `intent: "get_doctor_schedule"`, `parameters: {...}`.
5.  **`fsm.processInput` (fsm.js)**:
    *   FSM transita a un estado `fetch_schedule_for_doctor`.
    *   Este estado tiene en `payloadResponse.asyncApiCallsToTrigger`:
        ```json
        [{
          "apiId": "fetch_doctor_availability", // Definido en config/api_definitions/
          "params": { "doctorName": "{{doctor_name}}", "date": "{{schedule_date}}" },
          "assignCorrelationIdTo": "pendingScheduleCorrelationId" // FSM guardará el ID aquí
        }]
        ```
    *   `fsm.js`:
        *   Genera `correlationId_1 = uuidv4()`.
        *   Guarda `pendingScheduleCorrelationId: "correlationId_1"` en `sessionData.parameters`.
        *   Renderiza `response_stream_key` desde la config de `fetch_doctor_availability` (ej: `api_responses_stream:session789:correlationId_1`).
        *   Almacena en `sessionData.pendingApiResponses[correlationId_1] = { apiId: "fetch_doctor_availability", responseStreamKey: "api_responses_stream:session789:correlationId_1", ... }`.
        *   Llama a `apiCallerService.makeRequest("fetch_doctor_availability", "session789", "correlationId_1", {doctorName: "Dr. Smith", date: "mañana"})`.
            *   `apiCallerService` hace el `GET https://api.example.com/doctors/availability/...` (asíncrono).
    *   La FSM responde al cliente (antes de que la API externa termine):
        ```json
        {
          // ... sessionId, currentStateId: "fetch_schedule_for_doctor" ...
          "payloadResponse": { "prompt": "Estoy consultando los horarios del Dr. Smith para mañana. Un momento por favor." },
          "collectedParameters": { /*...,*/ "pendingScheduleCorrelationId": "correlationId_1" }
        }
        ```
        (El cliente ahora sabe que hay una operación pendiente asociada con `correlationId_1`).

### Respuesta de API Externa y Siguiente Interacción del Usuario

1.  **Worker Externo / Simulador**:
    *   La llamada a `https://api.example.com/...` (hecha por `apiCallerService`) finalmente responde (ej: `{"slots": ["10:00", "14:00"]}`).
    *   El worker externo recibe esta respuesta.
    *   Formatea el mensaje: `{"correlationId": "correlationId_1", "sessionId": "session789", ..., "status": "success", "data": {"slots": ["10:00", "14:00"]}, ...}`.
    *   Escribe este mensaje (`XADD`) al Redis Stream: `api_responses_stream:session789:correlationId_1`.
2.  **App Externa (Cliente)**: Después de un tiempo o una acción del usuario, envía nueva entrada, indicando que espera la respuesta:
    `POST /fsm/session789` con `Content-Type: application/json` y cuerpo:
    ```json
    {
      "userInput": "Ok", // Usuario podría no decir nada, o "listo", etc.
      "waitForCorrelationId": "correlationId_1"
    }
    ```

### Proceso Interno (Ciclo 2 - con Respuesta de API)

1.  **`handleInputWithAI` (index.js)**:
    *   Recibe `userInput: "Ok"` y `waitForCorrelationId: "correlationId_1"`.
    *   Carga sesión `session789`, ve `pendingApiResponses["correlationId_1"]`.
    *   Realiza `XREADGROUP ... BLOCK` en `api_responses_stream:session789:correlationId_1`.
    *   Recibe el mensaje del stream: `{"correlationId": "correlationId_1", ..., "data": {"slots": ["10:00", "14:00"]}, ...}`.
    *   Hace `XACK` del mensaje. Elimina `correlationId_1` de `pendingApiResponses`.
    *   Texto para IA: `Ok\n\n[API Response Context for 'fetch_doctor_availability' (ID: correlationId_1): {"slots":["10:00","14:00"]}]`
2.  **`aiService.js`**:
    *   La IA procesa el texto combinado. Salida esperada: `{"intent": "present_schedule_options", "parameters": {"available_slots_from_context": ["10:00", "14:00"]}}` (o la IA podría extraer los slots directamente).
3.  **Validación**: Pasa.
4.  **Entrada a FSM**: `intent: "present_schedule_options"`, `parameters: {"available_slots_from_context": ["10:00", "14:00"]}`.
5.  **`fsm.processInput` (fsm.js)**:
    *   FSM transita a un estado `display_schedule_options`.
    *   `payloadResponse` usa `{{available_slots_from_context}}` para mostrar las opciones.
    *   Responde al cliente: `{"payloadResponse": {"prompt": "El Dr. Smith tiene citas disponibles a las 10:00 y 14:00. ¿Cuál prefiere?"}}`.
    *   ... y el ciclo continúa.

*El resto del documento (secciones 4 y 5 sobre Casos de Ejemplo y `apiHooks`) debe interpretarse con este nuevo flujo asíncrono y la directiva `asyncApiCallsToTrigger` en mente. Los `apiHooks` siguen siendo para que el cliente final ejecute APIs, mientras `asyncApiCallsToTrigger` es para que *este servicio* llame a APIs de terceros.*
