# Node.js FSM Service con Integración de IA

Este proyecto implementa una Máquina de Estados Finitos (FSM) utilizando Node.js, ahora con una capa de procesamiento de Lenguaje Natural mediante IA para interpretar la entrada del usuario. Está diseñada para gestionar flujos de conversación complejos, como el agendamiento de citas, y puede ser integrada a través de una API RESTful, sockets UNIX o mediante Asterisk ARI para interacciones telefónicas.

## Características Principales

*   **Procesamiento de Entrada por IA**:
    *   Acepta texto plano como entrada del usuario.
    *   Utiliza un servicio de IA configurable (OpenAI, Google Gemini, Groq) para interpretar el texto y extraer la `intent` y los `parameters`.
    *   La IA es guiada por un prompt configurable (`config/aiPrompt.txt`).
    *   La respuesta JSON de la IA es validada contra un esquema (`config/aiResponseSchema.json`) y opcionalmente mediante una lógica de validación personalizada (`config/customAIResponseValidator.js`).
*   **Motor de FSM Configurable**: La lógica de los estados y transiciones (`config/states.json`) sigue siendo central una vez que la IA proporciona la entrada estructurada.
*   **Respuestas Dinámicas**: El `payloadResponse` de cada estado de la FSM sigue siendo procesado por `templateProcessor.js` (placeholders, funciones, JavaScript en sandbox con `isolated-vm`).
*   **Persistencia de Sesión con Redis**: Almacena el estado de la conversación y parámetros acumulados. Registra entradas y salidas de la IA y la FSM.
*   **Múltiples Interfaces de Comunicación**:
    *   **API RESTful**: `POST /fsm/:sessionId` ahora acepta `text/plain` en el cuerpo.
    *   **Sockets UNIX**: Acepta un JSON `{ "sessionId": "xxx", "textInput": "user says something" }`.
    *   **Asterisk ARI**: Adaptado para enviar el habla del usuario (o DTMF interpretado como texto) al servicio de IA.
*   **Logging Asíncrono**: Utiliza `pino` para un logging estructurado y eficiente.
*   **Modularidad**:
    *   `src/aiService.js`: Gestiona la interacción con los proveedores de IA.
    *   `src/jsonValidator.js`: Valida la respuesta JSON de la IA.
    *   `src/logger.js`: Configuración centralizada del logger.
    *   Otros módulos (`configLoader.js`, `fsm.js`, `redisClient.js`, `apiServer.js`, `ariClient.js`, `socketServer.js`, `index.js`) adaptados para el nuevo flujo.

## Funcionalidad Detallada

1.  **Entrada de Usuario**: El sistema recibe texto plano a través de una de sus interfaces (API, Socket, ARI).
2.  **Registro en Redis**: El texto de entrada original se registra en Redis.
3.  **Procesamiento por IA (`src/aiService.js`)**:
    *   El texto de entrada y el prompt (`config/aiPrompt.txt`) se envían al proveedor de IA configurado (OpenAI, Gemini o Groq).
    *   La IA responde con un JSON que debería contener `intent` y `parameters`.
    *   La respuesta cruda de la IA se registra en Redis.
4.  **Validación de Respuesta de IA**:
    *   El JSON de la IA se valida contra `config/aiResponseSchema.json` usando `ajv`.
    *   Opcionalmente, se ejecuta una validación adicional con `config/customAIResponseValidator.js`.
    *   Si la validación falla, se maneja el error (posiblemente usando una intención de fallback).
5.  **Entrada a la FSM**: El JSON validado (o un fallback) se convierte en la entrada (`intent` y `parameters`) para `fsm.js`. Este JSON de entrada a la FSM también se registra en Redis.
6.  **Procesamiento FSM (`src/fsm.js`)**:
    *   La FSM determina el `nextStateId` y el `payloadResponse` basándose en su configuración (`config/states.json`) y los datos de la sesión.
    *   El `payloadResponse` se procesa con `templateProcessor.js`.
    *   El estado de la sesión se actualiza en Redis de forma asíncrona.
7.  **Respuesta al Cliente**: La FSM devuelve el `nextStateId`, `parametersToCollect`, `payloadResponse` procesado, y `collectedParameters`.
8.  **Registro de Salida FSM**: La salida completa de la FSM se registra en Redis.

## Escenario de Ejemplo: Agendamiento de Cita con IA

1.  **Usuario (vía API)**: `POST /fsm/session123` con `Content-Type: text/plain` y cuerpo: `"Quiero una cita con el cardiólogo para mañana a las 3 PM. Soy Ana."`
2.  **IA Service**: Procesa el texto con el prompt. Responde (idealmente):
    ```json
    {
      "intent": "schedule_appointment",
      "parameters": {
        "medical_specialty": "cardiólogo",
        "appointment_date": "mañana",
        "appointment_time": "3 PM",
        "caller_name": "Ana"
      }
    }
    ```
3.  **Validación**: El JSON de la IA pasa la validación de esquema y personalizada.
4.  **FSM Input**: `intent: "schedule_appointment"`, `parameters: { "medical_specialty": "cardiólogo", ... }`.
5.  **FSM**: Transita al estado correspondiente (ej: `2_get_patient_id` si la edad ya fue recolectada o no es el primer paso). Supongamos que es `1_welcome_and_age` y la IA no extrajo `patient_age`.
    *   `config/states.json` para `1_welcome_and_age` tiene `payloadResponse: { "greeting": "Hola {{default(caller_name, 'estimado usuario')}}, bienvenido. Hoy es {{current_date}}. Para continuar, ¿podrías decirme tu edad?" }`
    *   Respuesta FSM: `nextStateId: "1_welcome_and_age"`, `parametersToCollect: { required: ["patient_age"] }`, `payloadResponse: { "greeting": "Hola Ana, bienvenido. Hoy es AAAA-MM-DD. Para continuar, ¿podrías decirme tu edad?" }`, `collectedParameters: { "medical_specialty": "cardiólogo", ... }`.
6.  La aplicación cliente (o el propio IVR en caso de ARI) usa el `payloadResponse` para interactuar con el usuario y recolectar la edad.

## Configuración y Ejecución

*   **Dependencias**: `express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`, `openai`, `@google/generative-ai`, `groq-sdk`, `ajv`, `pino`. Ver `package.json`.
*   **Configuraciones Principales**:
    *   `config/states.json`: Definición de la FSM.
    *   `config/aiPrompt.txt`: Prompt para guiar a la IA.
    *   `config/aiResponseSchema.json`: Esquema para validar el JSON de la IA.
    *   `config/customAIResponseValidator.js`: Lógica de validación personalizada para el JSON de la IA.
*   **Servicios Externos**: Redis, y el proveedor de IA elegido (OpenAI, Google Cloud, Groq). Si `ENABLE_ARI="true"`, un servidor Asterisk.
*   **Variables de Entorno (`.env.example`)**:
    *   Además de las variables anteriores para habilitar módulos, puertos, Redis y ARI, se han añadido:
        *   `LOG_LEVEL`, `NODE_ENV`: Para la configuración de logging con Pino.
        *   `API_JSON_PAYLOAD_LIMIT`, `API_TEXT_PAYLOAD_LIMIT`: Límites de tamaño para las solicitudes API.
        *   `AI_PROVIDER`: Para seleccionar el proveedor de IA (`openai`, `google`, `groq`).
        *   `AI_REQUEST_TIMEOUT`: Timeout para las llamadas a la IA.
        *   `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`: Para OpenAI.
        *   `GEMINI_API_KEY`, `GEMINI_MODEL`: Para Google Gemini.
        *   `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TEMPERATURE`: Para Groq.
    *   Copie `.env.example` a `.env` y configure las claves API y otros parámetros.

Para ejecutar (asumiendo que las dependencias están instaladas y los servicios configurados):

```bash
npm start
```

## Documentación Detallada del Código

Para una explicación más profunda de cada archivo, módulo y función principal, consulta el documento [docs/CodebaseOverview.md](docs/CodebaseOverview.md).

## Nota Importante

Este proyecto fue desarrollado con la restricción de **no instalar dependencias** directamente en el entorno de desarrollo del agente AI. Solo se han registrado en `package.json`. La instalación y configuración completa del entorno de ejecución (Node.js, Redis, Asterisk, y las `npm install`) es responsabilidad del usuario final.
