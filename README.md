# Node.js FSM Service con Integración de IA y Simulación de API Externas

Este proyecto implementa una Máquina de Estados Finitos (FSM) utilizando Node.js, con una capa de procesamiento de Lenguaje Natural mediante IA y un mecanismo para simular la interacción con APIs externas asíncronas. Está diseñada para gestionar flujos de conversación complejos y puede ser integrada a través de API RESTful, sockets UNIX o Asterisk ARI.

## Características Principales

*   **Procesamiento de Entrada por IA**:
    *   Acepta texto plano como entrada del usuario.
    *   Utiliza un servicio de IA configurable (OpenAI, Google Gemini, Groq) para extraer `intent` y `parameters`.
    *   La IA es guiada por `config/aiPrompt.txt`.
    *   La respuesta JSON de la IA es validada (`config/aiResponseSchema.json`, `config/customAIResponseValidator.js`).
*   **Simulación de Llamadas a API Externas**:
    *   Los estados en `config/states.json` pueden definir un objeto `externalApiCall` en su `payloadResponse`.
    *   `fsm.js` "envía" una solicitud a una cola simulada en Redis (`fsm_api_request_queue`) cuando un estado con `externalApiCall` es procesado.
    *   Un script (`scripts/simulateApiResponder.js`) puede usarse para leer de esta cola y "responder" escribiendo datos en Redis (`api_response:{sessionId}:{correlationId}`).
    *   `src/index.js` (`handleInputWithAI`) verifica estas respuestas en Redis y las combina con la siguiente entrada de texto del usuario antes de enviarla a la IA.
*   **Motor de FSM Configurable**: Lógica de estados y transiciones en `config/states.json`.
*   **Respuestas Dinámicas**: `payloadResponse` procesado por `templateProcessor.js`.
*   **Persistencia de Sesión con Redis**: Almacena estado de conversación, parámetros y logs de IA/FSM/API simuladas.
*   **Múltiples Interfaces de Comunicación**: API RESTful, Sockets UNIX, Asterisk ARI.
*   **Logging Asíncrono**: Utiliza `pino`.
*   **Modularidad**: Incluye `src/aiService.js`, `src/jsonValidator.js`, `src/logger.js`, y otros módulos adaptados.

## Funcionalidad Detallada con Simulación de API

1.  **Entrada de Usuario**: Texto plano llega vía API, Socket o ARI.
2.  **Procesamiento por IA (Opcional: con contexto de API previa)**:
    *   `handleInputWithAI` en `src/index.js` primero verifica si hay una respuesta de una API simulada en Redis para la sesión actual.
    *   Si se encuentra, esta respuesta se concatena al texto actual del usuario (ej: `Texto del usuario [API Response Context: {...}]`).
    *   Este texto (potencialmente combinado) se envía al `aiService.js`.
    *   La IA extrae `intent` y `parameters`. La respuesta de la IA se valida.
3.  **Entrada a la FSM**: El JSON validado alimenta a `fsm.js`.
4.  **Procesamiento FSM (`src/fsm.js`)**:
    *   La FSM procesa la entrada y determina `nextStateId` y `payloadResponse`.
    *   Si el `payloadResponse` del estado alcanzado contiene una definición de `externalApiCall`:
        *   Se renderizan los parámetros y `correlationId` de `externalApiCall`.
        *   Se "envía" una solicitud simulada a la lista `fsm_api_request_queue` en Redis (de forma asíncrona).
    *   La sesión FSM se guarda asíncronamente en Redis.
5.  **Respuesta al Cliente**: La FSM devuelve su respuesta normal (`nextStateId`, `payloadResponse` procesado, etc.).
6.  **(Ciclo Asíncrono Simulado)**:
    *   El script `scripts/simulateApiResponder.js` (ejecutado separadamente) puede leer la solicitud de `fsm_api_request_queue`.
    *   El simulador genera una respuesta mock y la guarda en Redis en `api_response:{sessionId}:{correlationId}`.
    *   En la siguiente interacción del usuario, `handleInputWithAI` encontrará esta respuesta (paso 2).

## Escenario de Ejemplo con API Simulada

1.  **Usuario (vía API)**: `POST /fsm/session123` con `text/plain`: `"Quiero ver doctores para cardiología."`
2.  **IA Service**: Procesa. Output: `{ "intent": "find_doctors", "parameters": { "medical_specialty": "cardiología" } }`.
3.  **FSM**:
    *   Input: `intent: "find_doctors"`, `parameters: { "medical_specialty": "cardiología" }`.
    *   Supongamos que transita al estado `3_get_specialty` (o uno similar que define un `externalApiCall` para buscar doctores).
    *   El `payloadResponse` de este estado tiene:
        ```json
        "externalApiCall": {
          "type": "fetch_doctors_for_specialty",
          "requestParams": { "specialty": "{{medical_specialty}}" },
          "correlationId": "fetch_docs_{{sessionId}}_{{current_time}}"
        }
        ```
    *   `fsm.js` renderiza esto y envía a `fsm_api_request_queue` en Redis: `{ "sessionId": "session123", "correlationId": "fetch_docs_session123_timestamp", "type": "fetch_doctors_for_specialty", "requestParams": { "specialty": "cardiología" } }`.
    *   FSM responde al cliente (ej: "Ok, buscando doctores para cardiología. ¿Algo más mientras tanto?").
4.  **Simulador (`scripts/simulateApiResponder.js`)**:
    *   Lee la solicitud de la cola.
    *   Genera una respuesta: `{ "doctors": [{"name": "Dr. House"}, {"name": "Dr. Strange"}] }`.
    *   Guarda en Redis en `api_response:session123:fetch_docs_session123_timestamp` el JSON anterior.
5.  **Siguiente interacción del Usuario**: `POST /fsm/session123` con `text/plain`: `"Sí, ¿cuáles encontró?"`
6.  **`handleInputWithAI` (`src/index.js`)**:
    *   Encuentra y recupera la respuesta de `api_response:session123:fetch_docs_session123_timestamp`. La elimina de Redis.
    *   Construye el texto para la IA: `"Sí, ¿cuáles encontró? [API Response Context: {\"doctors\":[{\"name\":\"Dr. House\"},{\"name\":\"Dr. Strange\"}]}]"`.
7.  **IA Service**: Procesa este texto combinado. Output esperado: `{ "intent": "query_doctor_results", "parameters": {} }` (la IA usa el contexto).
8.  **FSM**: Procesa esta nueva intención, y su `payloadResponse` puede usar los datos de `collectedParameters` (que ahora podrían incluir la respuesta de la API si se decidió guardarla ahí después de que la IA la procesó, o la IA podría haber extraído los nombres de los doctores directamente en `parameters`).

## Configuración y Ejecución

*   **Dependencias**: `express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`, `openai`, `@google/genai` (corregido de `@google/generative-ai`), `groq-sdk`, `ajv`, `pino`.
*   **Nuevos Scripts**: `scripts/simulateApiResponder.js` para simular respuestas de API.
*   **Variables de Entorno**: Ver `.env.example` para la lista completa, incluyendo configuración de IA y logging.

Para ejecutar la aplicación principal:
```bash
npm start
```
Para ejecutar el simulador de API (en otra terminal):
```bash
node scripts/simulateApiResponder.js
```

## Documentación Detallada del Código
Consulte `docs/CodebaseOverview.md` para más detalles.
---
*Nota: El manejo real de APIs externas asíncronas en producción requeriría un sistema de colas de mensajes más robusto (ej: RabbitMQ, Kafka) en lugar de la simulación con Redis.*## Estructura del Proyecto Actualizada

```
.
├── config/
│   ├── states.json                 # Define los estados y la lógica de la FSM
│   ├── aiPrompt.txt                # (NUEVO) Prompt para la IA
│   ├── aiResponseSchema.json       # (NUEVO) Esquema para validar la respuesta de la IA
│   └── customAIResponseValidator.js # (NUEVO) Validador JS personalizado para respuesta de IA
├── docs/
│   └── CodebaseOverview.md         # Este archivo
├── scripts/
│   └── simulateApiResponder.js     # (NUEVO) Script para simular respuestas de API externas
├── src/
│   ├── index.js                    # Punto de entrada de la aplicación, orquesta la inicialización
│   ├── logger.js                   # (NUEVO) Configuración del logger (Pino)
│   ├── aiService.js                # (NUEVO) Servicio para interactuar con proveedores de IA
│   ├── jsonValidator.js            # (NUEVO) Validador de JSON para respuestas de IA
│   ├── apiServer.js                # Servidor API Express, ahora maneja entrada de texto
│   ├── ariClient.js                # Cliente Asterisk ARI, adaptado para flujo con IA
│   ├── socketServer.js             # Servidor de Sockets UNIX, adaptado para flujo con IA
│   ├── configLoader.js             # Carga y valida states.json
│   ├── fsm.js                      # Lógica central de la FSM, recibe entrada de IA, simula triggers de API
│   ├── redisClient.js              # Cliente para interactuar con Redis (sesiones y logs IA/FSM/API)
│   └── templateProcessor.js        # Procesa `payloadResponse` de la FSM
├── .env.example                    # Ejemplo de variables de entorno (actualizado)
├── AGENTS.md                       # Instrucciones para agentes AI (actualizado)
├── FSM_Documentation.md            # Documentación general y casos de uso (actualizado)
├── package.json                    # Dependencias y scripts del proyecto (actualizado)
└── README.md                       # README principal del proyecto (actualizado)
```

## Flujo General de la Aplicación Actualizado (con Simulación de API)

1.  **Inicio (`src/index.js`)**: Carga configuraciones, inicializa logger, Redis, y módulos de comunicación.
2.  **Recepción de Entrada**: Texto del usuario llega a una interfaz.
3.  **`handleInputWithAI` (`src/index.js`)**:
    *   **Comprobación de Respuesta de API Simulada**: Antes de llamar a la IA, verifica si hay una respuesta de API simulada en Redis (claves `api_response:{sessionId}:{correlationId}`).
    *   Si se encuentra, la respuesta de la API se combina con el texto del usuario actual.
    *   El texto (potencialmente combinado) se envía a `src/aiService.js`.
4.  **Procesamiento por IA (`src/aiService.js`)**:
    *   La IA procesa el texto y devuelve un JSON con `intent` y `parameters`.
5.  **Validación de Respuesta de IA**: El JSON se valida.
6.  **Entrada a la FSM**: El JSON validado se pasa a `fsm.processInput()`.
7.  **Procesamiento FSM (`src/fsm.js`)**:
    *   Determina `nextStateId` y `payloadResponse`.
    *   **Simulación de Trigger de API**: Si el `payloadResponse` del estado actual contiene una definición `externalApiCall`:
        *   Renderiza los `requestParams` y `correlationId` usando `templateProcessor.js`.
        *   "Envía" una solicitud simulada a una lista en Redis (`fsm_api_request_queue`) de forma asíncrona. Esta solicitud incluye `sessionId`, `correlationId`, `type`, y los `requestParams` renderizados.
    *   La sesión FSM se guarda asíncronamente en Redis.
8.  **Respuesta al Cliente**: La FSM devuelve su respuesta normal.
9.  **(Ciclo Asíncrono Simulado con `scripts/simulateApiResponder.js`)**:
    *   Este script (ejecutado por separado) lee de `fsm_api_request_queue`.
    *   Genera una respuesta mock basada en el `type` de la solicitud.
    *   Guarda la respuesta mock en Redis en una clave `api_response:{sessionId}:{correlationId}` con un TTL.
    *   Esta respuesta estará disponible para la siguiente interacción del usuario en el paso 3a.

## Consideraciones para el Desarrollo

*   **Simulación de API Externa**:
    *   La nueva estructura `externalApiCall` en `config/states.json` permite definir cuándo y cómo un estado debe "llamar" a una API externa.
    *   `fsm.js` simula el envío de estas solicitudes a una cola en Redis (`fsm_api_request_queue`).
    *   `scripts/simulateApiResponder.js` es una herramienta de desarrollo para simular la llegada de respuestas de estas APIs, escribiéndolas en claves específicas en Redis (`api_response:{sessionId}:{correlationId}`).
    *   `handleInputWithAI` en `src/index.js` ahora busca estas respuestas en Redis y las combina con la entrada del usuario para la IA, permitiendo a la IA tener contexto de operaciones asíncronas previas.
*   **Flujo de Datos para la IA**: La IA ahora puede recibir no solo el texto directo del usuario, sino también un contexto adicional de respuestas de API simuladas, lo que debería permitir conversaciones más ricas y contextuales. El prompt en `config/aiPrompt.txt` ha sido actualizado para guiar a la IA en el uso de este contexto.
*   **Redis para Simulación**: Redis se usa tanto para la cola de solicitudes de API simuladas como para almacenar las respuestas simuladas.
*   **`correlationId`**: Es crucial para asociar respuestas de API con las solicitudes originales y la sesión correcta.

## Cómo Ejecutar (con `.env` y Simulación de API)

1.  **Iniciar la Aplicación Principal**:
    ```bash
    npm start
    ```
2.  **Iniciar el Simulador de Respuestas de API (en otra terminal)**:
    ```bash
    node scripts/simulateApiResponder.js
    ```
Esto permitirá que el flujo completo, incluyendo la simulación de llamadas y respuestas de API, sea probado.

---

*El resto del documento (Secciones de Configuración de IA, Manejo de Errores, Logging, Variables de Entorno, No Instalar Dependencias, Flujo Asíncrono) permanece relevante y fue actualizado en la iteración anterior.*
