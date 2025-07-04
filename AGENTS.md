# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js con IA

Este documento proporciona una guía para trabajar con el proyecto de Máquina de Estados Finitos (FSM) desarrollada en Node.js, ahora integrada con un servicio de IA para el procesamiento de entrada.

## Estructura del Proyecto Actualizada

El proyecto está organizado de la siguiente manera:

-   `package.json`: Define las dependencias del proyecto y los scripts principales.
    -   **Nuevas Dependencias Clave**: `openai`, `@google/generative-ai`, `groq-sdk` (para los proveedores de IA), `ajv` (para validación de esquemas JSON), `pino` (para logging).
    -   **Importante**: Las dependencias (`express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`, y las nuevas de IA y validación) **no se instalan automáticamente** por este agente. Se asume que estarán disponibles en el entorno de ejecución final.
-   `config/`: Contiene los archivos de configuración.
    -   `states.json`: Define la estructura de la máquina de estados (sin cambios en su estructura interna).
    -   `aiPrompt.txt`: (NUEVO) Contiene el prompt que se envía a la IA para guiar su respuesta.
    -   `aiResponseSchema.json`: (NUEVO) Esquema JSON para validar la estructura de la respuesta de la IA.
    -   `customAIResponseValidator.js`: (NUEVO) Permite validaciones personalizadas adicionales sobre la respuesta de la IA.
-   `src/`: Contiene el código fuente de la aplicación.
    -   `index.js`: Punto de entrada. Carga `dotenv`, inicializa todos los módulos, incluyendo el servicio de IA, cargadores de prompts/schemas, y el logger. Orquesta el flujo de entrada a través de la IA hacia la FSM.
    -   `logger.js`: (NUEVO) Configuración del logger `pino`.
    -   `aiService.js`: (NUEVO) Módulo para interactuar con diferentes proveedores de IA (OpenAI, Google Gemini, Groq). Maneja la selección del proveedor, la construcción de la solicitud a la IA y el logging de interacciones con la IA en Redis.
    -   `jsonValidator.js`: (NUEVO) Módulo para validar la respuesta JSON de la IA usando `ajv` y el esquema de `config/aiResponseSchema.json`.
    -   `configLoader.js`: Carga y valida `states.json`.
    -   `fsm.js`: Lógica central de la FSM. Ahora recibe `intent` y `parameters` del pipeline de IA. Su lógica interna de manejo de estados y `payloadResponse` (con `templateProcessor.js`) no cambia fundamentalmente, pero su logging se actualiza a `pino` y el guardado en Redis es asíncrono.
    -   `redisClient.js`: Cliente Redis. Usado para persistencia de sesión FSM y ahora también para logging de varias etapas del nuevo pipeline (entrada de texto, respuesta IA, entrada FSM, salida FSM).
    -   `apiServer.js`: Servidor API Express. Modificado para aceptar `text/plain` como entrada, pasarla al `handleInputWithAI` en `index.js`.
    -   `socketServer.js`: Servidor de Sockets UNIX. Modificado para aceptar un JSON `{ "sessionId": "xxx", "textInput": "user says something" }` y pasar `textInput` al `handleInputWithAI`.
    -   `ariClient.js`: Cliente Asterisk ARI. Modificado para enviar el habla del usuario (o DTMF interpretado) como `textInput` al `handleInputWithAI`.
    -   `templateProcessor.js`: Sin cambios fundamentales, sigue procesando `payloadResponse` de la FSM.

## Flujo General de la Aplicación Actualizado

1.  **Inicio (`src/index.js`)**: Carga configuraciones (FSM, IA prompt, esquema IA), inicializa logger, Redis, y los módulos de comunicación (API, Socket, ARI) pasándoles una función `handleInputWithAI`.
2.  **Recepción de Entrada (Texto Plano o Estructurado para Sockets/ARI)**:
    *   Las interfaces (`apiServer`, `socketServer`, `ariClient`) reciben la entrada del usuario.
    *   La API espera `text/plain`. El Socket Server espera un JSON con `textInput`. ARI puede recibir DTMF o transcripciones de voz que se convierten a `textInput`.
3.  **Llamada a `handleInputWithAI` (`src/index.js`)**:
    *   Registra el texto de entrada original en Redis.
    *   Llama a `src/aiService.js` con el `textInput` y el `aiPrompt.txt`.
4.  **Procesamiento por IA (`src/aiService.js`)**:
    *   Selecciona el proveedor de IA (OpenAI, Gemini, Groq) basado en `process.env.AI_PROVIDER`.
    *   Envía el `textInput` y el prompt al proveedor.
    *   Recibe una respuesta JSON de la IA (idealmente con `intent` y `parameters`).
    *   Registra la entrada y salida de la IA en Redis (de forma asíncrona).
5.  **Validación de Respuesta de IA (`src/jsonValidator.js` y `config/customAIResponseValidator.js`)**:
    *   El JSON de la IA se valida contra `config/aiResponseSchema.json`.
    *   Se ejecuta la validación personalizada de `config/customAIResponseValidator.js`.
    *   Si la validación falla, se usa una intención de fallback (ej: `ai_validation_error`).
6.  **Entrada a la FSM**:
    *   El JSON validado (o de fallback) se registra en Redis como `fsm_input`.
    *   Se llama a `fsm.processInput()` con el `sessionId`, `intent` y `parameters` derivados.
7.  **Procesamiento FSM (`src/fsm.js`)**:
    *   Determina `nextStateId`, procesa `payloadResponse` con `templateProcessor.js`.
    *   Actualiza y guarda la sesión FSM en Redis de forma asíncrona.
8.  **Respuesta al Cliente**:
    *   La respuesta de la FSM (`nextStateId`, `payloadResponse` procesado, etc.) se devuelve a la interfaz original.
    *   La respuesta final enviada al cliente también se registra en Redis.

## Consideraciones para el Desarrollo

*   **Configuración de IA**:
    *   El prompt en `config/aiPrompt.txt` es crucial para que la IA genere el JSON correcto.
    *   El esquema en `config/aiResponseSchema.json` asegura la estructura básica.
    *   El validador en `config/customAIResponseValidator.js` permite lógica más fina.
*   **Manejo de Errores de IA**: Si la IA falla o devuelve un formato incorrecto, el sistema debe manejarlo (actualmente usa intents de fallback).
*   **Logging**: Toda la aplicación ahora usa `pino` para logging estructurado y asíncrono.
*   **Variables de Entorno**: Se han añadido muchas variables nuevas para configurar los proveedores de IA, claves API, modelos, timeouts, logging y límites de payload. Consultar `.env.example`.
*   **No Instalar Dependencias**: Sigue aplicando. Las nuevas dependencias (`openai`, `@google/generative-ai`, `groq-sdk`, `ajv`, `pino`, `pino-pretty`) están listadas en `package.json` pero no se instalan.
*   **Flujo Asíncrono**: Muchas operaciones, especialmente el logging en Redis y el guardado de sesión FSM, son ahora "fire-and-forget" para no bloquear el hilo principal.

## Cómo Ejecutar (con `.env`)

Si las dependencias estuvieran instaladas, la aplicación se ejecutaría con:

```bash
npm start
```

O para desarrollo con recarga automática (si `nodemon` estuviera instalado):

```bash
npm run dev
```

Asegúrate de que una instancia de Redis esté accesible y, si `ENABLE_ARI` es `true`, que un servidor Asterisk con ARI configurado también lo esté.
La configuración de conexión para Redis y ARI se realiza mediante variables de entorno o valores por defecto en `redisClient.js` y `ariClient.js`.
El archivo `config/states.json` debe existir y ser válido.
