# Visión General del Código Base - Servicio FSM con IA

Este documento proporciona una explicación detallada de cada archivo principal y pieza de código dentro del proyecto del Servicio FSM, ahora con integración de IA.

## Estructura del Proyecto Actualizada

```
.
├── config/
│   ├── states.json                 # Define los estados y la lógica de la FSM
│   ├── aiPrompt.txt                # (NUEVO) Prompt para la IA
│   ├── aiResponseSchema.json       # (NUEVO) Esquema para validar la respuesta de la IA
│   └── customAIResponseValidator.js # (NUEVO) Validador JS personalizado para respuesta de IA
├── docs/
│   └── CodebaseOverview.md         # Este archivo
├── src/
│   ├── index.js                    # Punto de entrada de la aplicación, orquesta la inicialización
│   ├── logger.js                   # (NUEVO) Configuración del logger (Pino)
│   ├── aiService.js                # (NUEVO) Servicio para interactuar con proveedores de IA
│   ├── jsonValidator.js            # (NUEVO) Validador de JSON para respuestas de IA
│   ├── apiServer.js                # Servidor API Express, ahora maneja entrada de texto
│   ├── ariClient.js                # Cliente Asterisk ARI, adaptado para flujo con IA
│   ├── socketServer.js             # Servidor de Sockets UNIX, adaptado para flujo con IA
│   ├── configLoader.js             # Carga y valida states.json
│   ├── fsm.js                      # Lógica central de la FSM, recibe entrada de IA
│   ├── redisClient.js              # Cliente para interactuar con Redis (sesiones y logs IA/FSM)
│   └── templateProcessor.js        # Procesa `payloadResponse` de la FSM (sin cambios mayores)
├── .env.example                    # Ejemplo de variables de entorno (actualizado)
├── AGENTS.md                       # Instrucciones para agentes AI (actualizado)
├── FSM_Documentation.md            # Documentación general y casos de uso (actualizado)
├── package.json                    # Dependencias y scripts del proyecto (actualizado)
└── README.md                       # README principal del proyecto (actualizado)
```

## Archivos y Módulos

A continuación, se detalla cada componente principal:

### 1. `package.json` (Actualizado)
   - **Propósito**: Manifiesto del proyecto.
   - **Dependencias Clave Adicionales**:
     - `openai`, `@google/generative-ai`, `groq-sdk`: SDKs para interactuar con los respectivos proveedores de IA.
     - `ajv`: Para la validación de esquemas JSON (usado en `jsonValidator.js`).
     - `pino`: Para logging estructurado y asíncrono.
   - **Dependencias de Desarrollo Adicionales**:
     - `pino-pretty`: Para formatear logs de `pino` en desarrollo.
   - Las dependencias originales (`express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`) permanecen.

### 2. Carpeta `config/` (Actualizada)
   - `states.json`: Sin cambios estructurales fundamentales. Sigue definiendo los estados, transiciones y `payloadResponse` de la FSM.
   - `aiPrompt.txt` (NUEVO):
     - **Propósito**: Contiene el texto del prompt que se envía al servicio de IA. Este prompt guía a la IA para que entienda el texto del usuario y devuelva un JSON estructurado con `intent` y `parameters`.
   - `aiResponseSchema.json` (NUEVO):
     - **Propósito**: Define un esquema JSON que se utiliza para validar la estructura de la respuesta JSON proveniente del servicio de IA. Asegura que la IA devuelva los campos esperados (como `intent` y `parameters`) con los tipos correctos.
   - `customAIResponseValidator.js` (NUEVO):
     - **Propósito**: Exporta una función `validateAIResponse(jsonResponse)` que permite implementar lógica de validación personalizada más allá de lo que el esquema JSON puede cubrir. Por ejemplo, verificar condicionalmente la presencia de ciertos parámetros basados en la `intent` detectada.

### 3. `src/index.js` (Actualizado)
   - **Propósito**: Punto de entrada principal. Ahora también orquesta la inicialización de los servicios de IA, carga el prompt de IA y el esquema de validación.
   - **Cambios Clave**:
     - Importa `aiService.js`, `jsonValidator.js`, `logger.js`, y `customAIResponseValidator.js`.
     - Carga el contenido de `config/aiPrompt.txt`.
     - Define una función `handleInputWithAI(sessionId, textInput, source)`:
       - Esta función es el nuevo punto central para procesar la entrada del usuario.
       - Llama a `aiService.getAIResponse()` para obtener el JSON estructurado de la IA.
       - Realiza la validación del JSON de la IA (esquema y personalizada).
       - Maneja fallos de la IA o de validación, posiblemente usando intents de fallback.
       - Pasa el `intent` y `parameters` resultantes a `fsm.processInput()`.
       - Orquesta el logging en Redis de las diferentes etapas (entrada de texto, E/S de IA, entrada a FSM, salida de FSM).
     - Pasa `handleInputWithAI` a `apiServer.js`, `socketServer.js`, y `ariClient.js` para que estas interfaces la utilicen.
     - Usa `logger.js` para todo el logging.

### 4. `src/logger.js` (NUEVO)
   - **Propósito**: Configura una instancia centralizada del logger `pino`.
   - **Funcionalidad**:
     - Permite logging estructurado.
     - Configura `pino-pretty` para logs legibles en desarrollo y JSON en producción.
     - El nivel de log (`LOG_LEVEL`) y el entorno (`NODE_ENV`) se configuran mediante variables de entorno.

### 5. `src/aiService.js` (NUEVO)
   - **Propósito**: Encapsula la lógica para interactuar con los diferentes proveedores de IA.
   - **Funcionalidad**:
     - Inicializa los clientes de SDK para OpenAI, Google Gemini y Groq basándose en las variables de entorno (`AI_PROVIDER` y las claves API correspondientes).
     - Expone una función principal `getAIResponse(textInput, promptContent)` que:
       - Selecciona el proveedor de IA configurado.
       - Construye el mensaje/prompt completo para la IA.
       - Realiza la llamada a la API del proveedor de IA.
       - Espera una respuesta JSON y la parsea.
       - Incluye timeouts configurables para las solicitudes a la IA.
     - Realiza logging asíncrono de la entrada enviada a la IA y la salida recibida de la IA hacia Redis.
     - Maneja errores específicos de cada proveedor.

### 6. `src/jsonValidator.js` (NUEVO)
   - **Propósito**: Valida la respuesta JSON obtenida del `aiService.js`.
   - **Funcionalidad**:
     - Carga el esquema desde `config/aiResponseSchema.json` al iniciar.
     - Utiliza la librería `ajv` para compilar el esquema y validar objetos JSON contra él.
     - Expone una función `validateJson(jsonResponse)` que devuelve un objeto `{ isValid: boolean, errors: object[] | null }`.
     - Registra los resultados de la validación usando `logger.js`.

### 7. `src/configLoader.js`
   - **Propósito**: Carga y valida `config/states.json`. (Sin cambios funcionales mayores, pero ahora usa `logger.js`).
   - **Validaciones**: Sigue validando la estructura de `states.json`, `initialState`, etc. Usa `logger.js` para los mensajes.

### 8. `src/redisClient.js`
   - **Propósito**: Encapsula la interacción con Redis. (Sin cambios funcionales mayores, pero ahora usa `logger.js`).
   - **Uso Extendido**: Además de las sesiones FSM, ahora se utiliza para registrar de forma asíncrona:
     - Texto de entrada original del usuario.
     - Solicitud enviada a la IA.
     - Respuesta recibida de la IA.
     - JSON de entrada (intent/parameters) para la FSM.
     - Salida completa de la FSM.

### 9. `src/fsm.js` (Actualizado)
   - **Propósito**: Lógica central de la FSM. La forma en que procesa estados, transiciones y `payloadResponse` no cambia fundamentalmente.
   - **Cambios Clave**:
     - Ahora recibe `intent` y `parameters` que han sido pre-procesados por la capa de IA.
     - Todo el logging interno se reemplaza por llamadas a `logger.js`.
     - El guardado de la sesión en Redis (`redisClient.set`) se realiza de forma asíncrona (sin `await` en la ruta crítica de `processInput`) utilizando una función helper `saveSessionAsync` para no bloquear.

### 10. `src/templateProcessor.js`
    - **Propósito**: Procesa los strings de plantilla en `payloadResponse`. (Sin cambios funcionales mayores, pero usa `logger.js` para errores).

### 11. `src/apiServer.js` (Actualizado)
    - **Propósito**: Servidor API Express.
    - **Cambios Clave**:
      - Ahora espera `Content-Type: text/plain` para el endpoint `POST /fsm/:sessionId`. El cuerpo de la solicitud es el texto del usuario.
      - Utiliza `express.text()` para parsear este tipo de cuerpo y `express.json()` para otros, con límites de payload configurables.
      - Llama a la función `handleInputWithAI` (proporcionada por `index.js`) para procesar el texto.
      - La respuesta JSON de la FSM (obtenida de `handleInputWithAI`) se devuelve al cliente.
      - Logging actualizado a `logger.js`.
      - Registra la salida final de la FSM para esta interfaz en Redis.

### 12. `src/socketServer.js` (Actualizado)
    - **Propósito**: Servidor de sockets UNIX.
    - **Cambios Clave**:
      - Ahora espera que el cliente envíe un objeto JSON con los campos `sessionId` y `textInput`.
      - Extrae `textInput` y lo pasa a la función `handleInputWithAI` (proporcionada por `index.js`).
      - La respuesta JSON de la FSM se devuelve al cliente a través del socket.
      - Logging actualizado a `logger.js`.
      - Registra la salida final de la FSM para esta interfaz en Redis.

### 13. `src/ariClient.js` (Actualizado)
    - **Propósito**: Cliente para Asterisk ARI.
    - **Cambios Clave**:
      - Cuando se recibe una nueva llamada (`StasisStart`) o entrada DTMF, se construye un `textInput` apropiado (ej: "Nueva llamada de X", "DTMF presionado: 123").
      - Este `textInput` se pasa a la función `handleInputWithAI` (proporcionada por `index.js`).
      - La respuesta de la FSM se utiliza para decidir las acciones ARI (ej: reproducir audios del `payloadResponse`, solicitar más información basada en `parametersToCollect`).
      - Se incluye una lógica básica para `playPrompt` y un esqueleto para `handleDtmfReceived`.
      - Logging actualizado a `logger.js`.
      - Registra entradas y salidas relevantes de ARI/FSM en Redis.

### 14. `.env.example` (Actualizado)
    - **Propósito**: Archivo de ejemplo para variables de entorno.
    - **Nuevas Variables**:
        - `LOG_LEVEL`, `NODE_ENV`: Para configurar `pino`.
        - `API_JSON_PAYLOAD_LIMIT`, `API_TEXT_PAYLOAD_LIMIT`: Para configurar límites de Express.
        - `AI_PROVIDER`: Para seleccionar entre `openai`, `google`, `groq`.
        - `AI_REQUEST_TIMEOUT`: Timeout para llamadas a la IA.
        - Claves API específicas del proveedor: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`.
        - Configuraciones de modelo y temperatura para cada proveedor: `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, etc.

---
*Fin del documento.*
