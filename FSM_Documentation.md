# Documento de Funcionamiento y Casos de Uso del Servicio FSM

## 1. Introducción al Servicio FSM

Este servicio de Máquina de Estados Finitos (FSM) está diseñado para gestionar flujos conversacionales complejos de manera estructurada y configurable. Su propósito principal es orquestar la lógica de una conversación entre un usuario y un sistema (por ejemplo, un agente virtual para agendamiento de citas), determinando el siguiente paso de la conversación, los datos que deben recolectarse y las acciones (APIs externas) que deben ejecutarse.

**Integración:**
El servicio FSM puede ser integrado de dos maneras principales:
*   **API RESTful (JSON):** A través de un endpoint HTTP que recibe y devuelve información en formato JSON. Es ideal para aplicaciones de chat, frontends web, o cualquier sistema que pueda realizar solicitudes HTTP.
*   **Asterisk ARI (Asterisk REST Interface):** Permite la integración con sistemas de telefonía basados en Asterisk, controlando el flujo de llamadas de voz.

**Componentes Clave:**
*   **Motor FSM (`src/fsm.js`):** El núcleo lógico que procesa las entradas, gestiona las transiciones entre estados y mantiene el estado de la sesión.
*   **Configuración de Estados (`config/states.json`):** Un archivo JSON externo que define todos los estados posibles de la conversación, las transiciones entre ellos, los parámetros requeridos/opcionales para cada estado, y los "ganchos" de API (`apiHooks`) a ejecutar en diferentes puntos del ciclo de vida de un estado.
*   **Redis (`src/redisClient.js`):** Utilizado como almacén de persistencia para las sesiones de conversación. Cada sesión activa tiene su estado actual y parámetros acumulados guardados en Redis, permitiendo conversaciones multivuelta y recuperación.

## 2. Arquitectura General

A continuación, se presenta un diagrama de la arquitectura general del sistema:

```mermaid
graph LR
    subgraph ClienteExApp [Aplicación Cliente Externa]
        direction LR
        C[Cliente UI / Chatbot / IVR]
    end

    subgraph ServicioFSM [Servicio FSM Node.js]
        direction TB
        API[Servidor API Express: POST /fsm/:sessionId]
        FSM[Motor FSM: fsm.js]
        CONF[Config Loader: configLoader.js]
        REDISC[Cliente Redis: redisClient.js]
        ARIC[Cliente ARI: ariClient.js] -- Optional --> ASTERISK[Servidor Asterisk]
    end

    subgraph Infraestructura
        direction TB
        STATES_JSON[config/states.json]
        REDIS_DB[Base de Datos Redis]
    end

    C --> API
    API --> FSM
    FSM --> CONF
    FSM --> REDISC
    CONF --> STATES_JSON
    REDISC --> REDIS_DB
    FSM --> ARIC

    style ClienteExApp fill:#dae8fc,stroke:#333,stroke-width:2px
    style ServicioFSM fill:#d5e8d4,stroke:#333,stroke-width:2px
    style Infraestructura fill:#ffe6cc,stroke:#333,stroke-width:2px
```

**Flujo de Datos Simplificado:**
1.  La **Aplicación Cliente Externa** envía una solicitud (HTTP JSON o evento ARI) al **Servicio FSM**.
2.  El **Servidor API** (o **Cliente ARI**) recibe la solicitud y la pasa al **Motor FSM**.
3.  El **Motor FSM** utiliza el **Config Loader** para obtener la definición del estado actual desde `config/states.json`.
4.  El **Motor FSM** interactúa con el **Cliente Redis** para leer y escribir el estado de la sesión en la **Base de Datos Redis**.
5.  El **Motor FSM** determina el siguiente estado, los parámetros a recolectar y los `apiHooks`.
6.  Esta información se devuelve a la **Aplicación Cliente Externa**.

## 3. Flujo de Interacción Típico

### Solicitud (JSON Entrante a la API)

La aplicación externa contacta a la FSM a través de su API.
*   **Endpoint:** `POST /fsm/:sessionId`
    *   `:sessionId` es un identificador único para la conversación (ej: ID de usuario, ID de canal de chat, ID de llamada).
*   **Cuerpo (Body) de la Solicitud:**
    ```json
    {
      "intent": "opcional_intencion_del_usuario_o_sistema",
      "parameters": {
        "nombre_parametro_1": "valor_recolectado_1",
        "nombre_parametro_2": "valor_recolectado_2"
      }
    }
    ```
    *   `intent` (opcional): Una cadena que representa la intención del usuario (ej: "agendar_cita", "request_human_agent") o una intención generada por el sistema (ej: "id_invalid_system_detected" después de una validación fallida).
    *   `parameters` (opcional): Un objeto que contiene los parámetros que la aplicación externa ha recolectado desde la última interacción. Para la primera interacción de una sesión, este objeto puede estar vacío o no incluirse.

### Proceso Interno de la FSM

Al recibir una solicitud, el motor FSM realiza los siguientes pasos:
1.  **Recuperar/Inicializar Sesión:** Usa el `sessionId` para buscar una sesión existente en Redis. Si no existe, crea una nueva sesión, estableciendo el estado actual al `initialState` definido en `config/states.json` y un objeto de parámetros vacío.
2.  **Fusionar Parámetros:** Combina los `parameters` recibidos en la solicitud actual con los parámetros ya acumulados en la sesión de Redis. Los nuevos valores sobrescriben los antiguos si las claves son las mismas.
3.  **Cargar Configuración del Estado:** Obtiene la definición completa del estado actual (`currentStateId` de la sesión) desde la configuración cargada de `config/states.json`.
4.  **Evaluar Transición:**
    *   Primero, verifica si la `intent` recibida coincide con alguna condición de `intent` en las `transitions` del estado actual. Las transiciones por intención tienen prioridad.
    *   Si no hay transición por intención, evalúa otras transiciones basadas en si todos los `parameters.required` del estado actual han sido recolectados (`allParametersMet: true`).
    *   Si ninguna transición específica coincide pero todos los parámetros requeridos están completos, se usa el `defaultNextState` (si está definido).
    *   Si no hay cambio de estado, el `nextStateId` será el mismo que el `currentStateId`.
5.  **Determinar `nextStateId`:** El resultado del paso anterior es el ID del siguiente estado.
6.  **Identificar `parametersToCollect`:** Para el `nextStateId` determinado, la FSM consulta su definición en `config/states.json` y construye el objeto `parametersToCollect`. Este objeto contendrá:
    *   `required`: Un array de IDs de parámetros que son obligatorios para el *nuevo* estado y que *aún no existen* en la sesión acumulada o tienen valores nulos/vacíos.
    *   `optional`: Un array de IDs de parámetros opcionales para el *nuevo* estado que *aún no existen* en la sesión.
7.  **Obtener `apiHooks`:** Se recupera el objeto `apiHooks` de la definición del `nextStateId`. Este objeto especifica qué APIs externas deberían ser llamadas en diferentes puntos del ciclo de vida de este nuevo estado (ej: `onEnterState`, `beforeCollectingParameters`, `afterParametersCollected`).
8.  **Actualizar y Guardar Sesión:** El estado de la sesión en Redis se actualiza con el nuevo `currentStateId` (que ahora es el `nextStateId`), y la colección completa y actualizada de `parameters`. El historial de estados también se actualiza.

### Respuesta (JSON Saliente de la API)

La FSM responde a la aplicación externa con la siguiente estructura JSON:
```json
{
  "sessionId": "valor_del_sessionId_procesado",
  "currentStateId": "id_del_estado_despues_del_procesamiento",
  "nextStateId": "id_del_estado_al_que_se_transito", // Generalmente igual a currentStateId
  "parametersToCollect": {
    "required": ["param_a_pedir_al_usuario_1", "param_a_pedir_2"],
    "optional": ["param_opcional_a_pedir_1"]
  },
  "apiHooks": {
    "onEnterState": ["api_id_a_llamar_al_entrar_al_estado", "otra_api_al_entrar"],
    "beforeCollectingParameters": ["api_id_a_llamar_antes_de_pedir_params"],
    "afterParametersCollected": ["api_id_a_llamar_despues_de_recibir_params"]
    // Otros hooks definidos en states.json para este estado (pueden ser arrays vacíos)
  },
  "collectedParameters": {
    "nombre_parametro_1": "valor_recolectado_1", // De la entrada actual
    "parametro_acumulado_previamente": "valor_previo_de_la_sesion",
    "nombre_parametro_2": "valor_recolectado_2" // De la entrada actual
    // Todos los parámetros acumulados en la sesión hasta el momento
  }
}
```
*   `sessionId`: El mismo ID de sesión de la solicitud.
*   `currentStateId` / `nextStateId`: El ID del estado en el que la FSM se encuentra ahora, después de procesar la entrada.
*   `parametersToCollect`: Indica a la aplicación externa qué información necesita solicitar al usuario a continuación.
*   `apiHooks`: Guía a la aplicación externa sobre qué APIs debe invocar y en qué momento conceptual del procesamiento del estado actual. La FSM *no* llama a estas APIs.
*   `collectedParameters`: Proporciona una vista completa de todos los datos recolectados para esta sesión hasta el momento, lo cual puede ser útil para la aplicación externa (ej: para mostrar un resumen al usuario).

## 4. Casos de Ejemplo Detallados

(Usando el `config/states.json` con `apiHooks` previamente definido)

### Caso 1: Agendamiento Exitoso (Flujo Lineal)

**Paso 1: Inicio de la conversación**
*   **App Externa -> FSM (POST /fsm/session123):**
    ```json
    // Primera interacción, sin intent ni parámetros previos
    {}
    ```
*   **FSM -> App Externa:**
    ```json
    {
      "sessionId": "session123",
      "currentStateId": "1_welcome_and_age",
      "nextStateId": "1_welcome_and_age",
      "parametersToCollect": { "required": ["patient_age"], "optional": ["caller_name"] },
      "apiHooks": {
        "onEnterState": ["api_log_interaction_start"],
        "beforeCollectingParameters": ["api_fetch_age_prompt_variations"],
        "afterParametersCollected": ["api_check_age_eligibility", "api_log_age_provided"]
      },
      "collectedParameters": {}
    }
    ```
    *   *App Externa ahora*: Llama `api_log_interaction_start`. Llama `api_fetch_age_prompt_variations`. Presenta bienvenida y pide edad (y opcionalmente nombre).

**Paso 2: Usuario provee la edad**
*   **App Externa -> FSM (POST /fsm/session123):**
    ```json
    {
      "parameters": { "patient_age": 30 }
    }
    ```
*   *App Externa antes de llamar a FSM*: Ya llamó `api_check_age_eligibility` y `api_log_age_provided` (del `afterParametersCollected` del estado anterior). Supongamos que `api_check_age_eligibility` fue exitosa y no generó una `intent` de inelegibilidad.
*   **FSM -> App Externa:**
    ```json
    {
      "sessionId": "session123",
      "currentStateId": "2_get_patient_id",
      "nextStateId": "2_get_patient_id",
      "parametersToCollect": { "required": ["patient_id_number"], "optional": ["id_document_type"] },
      "apiHooks": {
        "onEnterState": ["api_log_enter_get_id_state"],
        "beforeCollectingParameters": ["api_verify_id_prerequisites", "api_get_id_input_instructions"],
        "afterParametersCollected": ["api_validate_id_format", "api_log_id_provided"]
      },
      "collectedParameters": { "patient_age": 30 }
    }
    ```
    *   *App Externa ahora*: Llama APIs de `onEnterState` y `beforeCollectingParameters` para el estado `2_get_patient_id`. Pide el número de identificación.

**... y así sucesivamente hasta la confirmación.**

**Paso N: Confirmación Final**
*   Supongamos que se llega al estado `7_confirmation_and_closing` después de que `api_book_appointment_slot` (del `afterParametersCollected` del estado `6_get_appointment_time`) fue exitosa y la app externa envió `intent: "appointment_booked_success"`.
*   **FSM -> App Externa:**
    ```json
    {
      "sessionId": "session123",
      "currentStateId": "7_confirmation_and_closing",
      "nextStateId": "7_confirmation_and_closing",
      "parametersToCollect": { "required": [], "optional": [] }, // Nada más que pedir
      "apiHooks": {
        "onEnterState": ["api_send_confirmation_message", "api_log_interaction_complete"],
        "beforeCollectingParameters": [],
        "afterParametersCollected": []
      },
      "collectedParameters": { /* todos los datos de la cita */ }
    }
    ```
    *   *App Externa ahora*: Llama `api_send_confirmation_message` y `api_log_interaction_complete`. Muestra confirmación y finaliza.

### Caso 2: Agendamiento Fallido (Ej: Slot de Hora No Disponible)

*   **Contexto**: La conversación está en el estado `6_get_appointment_time`. El usuario ha proporcionado una hora.
*   **App Externa**:
    1.  Recibió `apiHooks.afterParametersCollected: ["api_book_appointment_slot"]` del estado `6_get_appointment_time`.
    2.  Llama a `api_book_appointment_slot` con la hora proporcionada.
    3.  La API `api_book_appointment_slot` falla, indicando que el slot no está disponible.
*   **App Externa -> FSM (POST /fsm/sessionXYZ):**
    ```json
    {
      "intent": "appointment_slot_unavailable", // Intención basada en el fallo de la API
      "parameters": { "appointment_time": "3:00 PM" } // Parámetro que se intentó usar
    }
    ```
*   **FSM (evaluando `6_get_appointment_time` con `intent: "appointment_slot_unavailable"`) -> App Externa:**
    ```json
    {
      "sessionId": "sessionXYZ",
      "currentStateId": "6_retry_appointment_time", // Transición a estado de reintento
      "nextStateId": "6_retry_appointment_time",
      "parametersToCollect": { "required": ["appointment_time"], "optional": [] }, // Pedir hora de nuevo
      "apiHooks": {
        "onEnterState": ["api_log_time_retry_event", "api_fetch_alternative_slots"],
        "beforeCollectingParameters": [],
        "afterParametersCollected": ["api_book_appointment_slot"] // De nuevo, intentar reservar
      },
      "collectedParameters": { /* ...otros datos..., "appointment_time": "3:00 PM" */ }
    }
    ```
    *   *App Externa ahora*: Llama APIs de `onEnterState` (ej: para informar al usuario que la hora no está disponible y quizás sugerir alternativas basadas en `api_fetch_alternative_slots`). Luego, pide una nueva hora.

### Caso 3: Derivación a Agente Humano (Cambio de Intención)

*   **Contexto**: La conversación está en el estado `3_get_specialty`. La FSM acaba de pedir la especialidad.
*   **Usuario dice**: "Quiero hablar con una persona".
*   **App Externa** (interpreta la frase del usuario como una intención de transferir) **-> FSM (POST /fsm/sessionABC):**
    ```json
    {
      "intent": "request_human_agent",
      "parameters": {} // No se recogieron nuevos parámetros relevantes para la especialidad
    }
    ```
*   **FSM (evaluando `3_get_specialty` con `intent: "request_human_agent"`) -> App Externa:**
    ```json
    {
      "sessionId": "sessionABC",
      "currentStateId": "99_transfer_to_human", // Transición directa por intención
      "nextStateId": "99_transfer_to_human",
      "parametersToCollect": { "required": [], "optional": [] },
      "apiHooks": {
        "onEnterState": ["api_initiate_transfer_to_human_agent", "api_log_transfer_request"],
        "beforeCollectingParameters": [],
        "afterParametersCollected": []
      },
      "collectedParameters": { /* parámetros acumulados hasta antes de pedir especialidad */ }
    }
    ```
    *   *App Externa ahora*: Llama `api_initiate_transfer_to_human_agent` y `api_log_transfer_request`. Procede con la transferencia al agente humano. Los `collectedParameters` pueden pasarse al agente humano para darle contexto.

### Caso 4: Error de Validación de Parámetro (Ej: Cédula Inválida por API externa)

*   **Contexto**: La FSM está en el estado `2_get_patient_id`, y ha pedido la cédula. El usuario la ingresa.
*   **App Externa**:
    1.  Recibió `apiHooks.afterParametersCollected: ["api_validate_id_format", "api_log_id_provided"]` del estado `2_get_patient_id`.
    2.  Recolecta la cédula del usuario, ej: "123".
    3.  Llama a `api_validate_id_format` con "123". Esta API determina que "123" es inválida.
*   **App Externa -> FSM (POST /fsm/sessionDEF):**
    ```json
    {
      "intent": "id_invalid_system_detected", // Intención generada por la app externa
      "parameters": { "patient_id_number": "123" }
    }
    ```
*   **FSM (evaluando `2_get_patient_id` con `intent: "id_invalid_system_detected"`) -> App Externa:**
    ```json
    {
      "sessionId": "sessionDEF",
      "currentStateId": "2_get_patient_id_retry_invalid",
      "nextStateId": "2_get_patient_id_retry_invalid",
      "parametersToCollect": { "required": ["patient_id_number"], "optional": ["id_document_type"] },
      "apiHooks": {
        "onEnterState": ["api_log_id_retry_event"],
        "beforeCollectingParameters": ["api_get_id_input_retry_instructions"],
        "afterParametersCollected": ["api_validate_id_format", "api_log_id_provided_after_retry"]
      },
      "collectedParameters": { /* ...otros datos..., "patient_id_number": "123" */ }
    }
    ```
    *   *App Externa ahora*: Llama APIs de `onEnterState` y `beforeCollectingParameters` para el estado de reintento (ej: para informar al usuario del error y volver a pedir la cédula).

## 5. Manejo de `apiHooks` por la Aplicación Externa

Es crucial entender que **la FSM no ejecuta las APIs listadas en `apiHooks`**. Simplemente las especifica. La aplicación cliente externa es responsable de:

1.  **Recibir la Respuesta de la FSM:** Parsear el JSON y extraer `nextStateId`, `parametersToCollect`, y `apiHooks`.
2.  **Ejecutar APIs `onEnterState`:** Si el array `apiHooks.onEnterState` contiene IDs de API, la aplicación externa debe invocarlas. Estas son típicamente para logging, inicialización o para obtener datos que se mostrarán antes de pedir nuevos parámetros.
3.  **Ejecutar APIs `beforeCollectingParameters`:** Si `apiHooks.beforeCollectingParameters` tiene APIs, invocarlas. Podrían ser para preparar dinámicamente las preguntas o instrucciones para el usuario.
4.  **Solicitar Datos al Usuario:** Basándose en el contenido de `parametersToCollect` (tanto `required` como `optional`), interactuar con el usuario para obtener la información necesaria.
5.  **Ejecutar APIs `afterParametersCollected`:** Una vez que el usuario ha proporcionado los datos (o algunos de ellos), si `apiHooks.afterParametersCollected` contiene APIs, la aplicación externa debe invocarlas. Estas APIs a menudo realizan validaciones sobre los datos recién ingresados o ejecutan acciones basadas en ellos (como `api_book_appointment_slot`).
    *   El resultado de estas APIs puede influir en la siguiente llamada a la FSM (ej: generando una `intent` como `id_invalid_system_detected` o `appointment_slot_unavailable`).
6.  **Enviar Siguiente Solicitud a la FSM:** Construir un nuevo JSON con los nuevos `parameters` recolectados y cualquier `intent` que se haya derivado de la interacción del usuario o de los resultados de las llamadas a las APIs en el paso anterior.

Este ciclo se repite hasta que la conversación alcanza un estado final (un estado sin más transiciones o `defaultNextState`).
