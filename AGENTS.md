# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js con IA y Simulación de API

Este documento proporciona una guía para trabajar con el proyecto de Máquina de Estados Finitos (FSM) desarrollada en Node.js, integrado con un servicio de IA y un mecanismo de simulación de API externas.

## Estructura del Proyecto Actualizada

El proyecto está organizado de la siguiente manera:

-   `package.json`: Define las dependencias del proyecto y los scripts principales.
    -   Dependencias clave: `openai`, `@google/genai`, `groq-sdk`, `ajv`, `pino`, `express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`.
-   `config/`: Contiene los archivos de configuración.
    -   `states.json`: Define la estructura de la FSM.
        -   **Nuevo**: Los estados pueden incluir un objeto `externalApiCall` dentro de `payloadResponse` para definir llamadas a API simuladas (ver `src/fsm.js` y `docs/CodebaseOverview.md` para detalles de la estructura: `type`, `requestParams`, `correlationId`).
    -   `aiPrompt.txt`: Prompt para la IA. Actualizado para instruir a la IA sobre cómo usar el contexto de respuestas de API.
    -   `aiResponseSchema.json`: Esquema para validar la respuesta JSON de la IA.
    -   `customAIResponseValidator.js`: Validaciones personalizadas para la respuesta de la IA.
-   `src/`: Contiene el código fuente de la aplicación.
    -   `index.js`: Punto de entrada. Orquesta el flujo, incluyendo la verificación de respuestas de API simuladas en Redis antes de llamar a la IA, y pasa `handleInputWithAI` a los módulos de comunicación.
    -   `logger.js`: Configuración del logger `pino`.
    -   `aiService.js`: Módulo para interactuar con proveedores de IA.
    -   `jsonValidator.js`: Módulo para validar la respuesta JSON de la IA.
    -   `configLoader.js`: Carga `states.json`.
    -   `fsm.js`: Lógica central de la FSM.
        -   **Nuevo**: Verifica si un estado define `externalApiCall`. Si es así, renderiza sus parámetros y `correlationId` usando `templateProcessor.js` y luego "envía" una solicitud a una lista de Redis (`fsm_api_request_queue`) para simular una llamada a API externa.
    -   `redisClient.js`: Cliente Redis. Usado para sesiones FSM, logs, y ahora también para la cola de solicitudes de API simuladas (`fsm_api_request_queue`) y el almacenamiento de respuestas de API simuladas (claves `api_response:{sessionId}:{correlationId}`).
    -   `apiServer.js`, `socketServer.js`, `ariClient.js`: Módulos de interfaz, adaptados para usar `handleInputWithAI`.
    -   `templateProcessor.js`: Procesa plantillas en `payloadResponse` y ahora también en `externalApiCall`.
-   `scripts/`: (NUEVO)
    -   `simulateApiResponder.js`: (NUEVO) Script de utilidad para leer solicitudes de API simuladas de la cola de Redis y escribir respuestas simuladas en Redis.

## Flujo General de la Aplicación Actualizado (con Simulación de API)

1.  **Inicio (`src/index.js`)**: Carga configuraciones, inicializa módulos.
2.  **Recepción de Entrada**: Texto del usuario.
3.  **`handleInputWithAI` (`src/index.js`)**:
    *   **Comprobación de Respuesta de API Simulada**: Busca en Redis (`api_response:{sessionId}:*`) respuestas de API previas.
    *   Si se encuentra, la combina con el texto actual del usuario.
    *   Envía el texto (potencialmente combinado) a `src/aiService.js`.
4.  **Procesamiento IA (`src/aiService.js`)**: IA devuelve JSON (`intent`, `parameters`).
5.  **Validación de IA**: Se valida el JSON.
6.  **Entrada a FSM**: JSON validado a `fsm.processInput()`.
7.  **Procesamiento FSM (`src/fsm.js`)**:
    *   Determina `nextStateId`, `payloadResponse`.
    *   **Simulación de Trigger de API**: Si el estado define `externalApiCall`, una solicitud se añade a `fsm_api_request_queue` en Redis.
    *   Guarda sesión FSM en Redis.
8.  **Respuesta al Cliente**.
9.  **Ciclo Asíncrono Simulado con `scripts/simulateApiResponder.js`**:
    *   Lee de `fsm_api_request_queue`, genera respuesta mock, escribe en `api_response:{sessionId}:{correlationId}` en Redis.

## Consideraciones para el Desarrollo

*   **Simulación de API Externa**: La interacción con APIs externas es simulada usando Redis como intermediario para colas de solicitud y almacenamiento de respuestas. `scripts/simulateApiResponder.js` es esencial para probar este flujo.
*   **Contexto para la IA**: El prompt en `config/aiPrompt.txt` ha sido actualizado para guiar a la IA en el uso de datos de API que pueden ser prefijados al input del usuario por `handleInputWithAI`.
*   **Variables de Entorno**: Sin cambios importantes en esta iteración, pero el funcionamiento de `AI_PROVIDER` y las claves API sigue siendo relevante.
*   **No Instalar Dependencias**: Sigue aplicando.
*   **Logging**: Usar `logger.js` (pino).

## Cómo Ejecutar (con `.env` y Simulación de API)

1.  **Iniciar la Aplicación Principal**:
    ```bash
    npm start
    ```
2.  **Iniciar el Simulador de Respuestas de API (en otra terminal)**:
    ```bash
    node scripts/simulateApiResponder.js
    ```
Esto permite probar el flujo que incluye la simulación de llamadas y respuestas de API. Asegúrate de que Redis esté corriendo y accesible.
El archivo `config/states.json` debe existir y ser válido. Los archivos de configuración de IA (`aiPrompt.txt`, `aiResponseSchema.json`, `customAIResponseValidator.js`) también deben estar presentes.
