# Visión General del Código Base - FSM con IA, APIs Sincrónicas/Asíncronas, Scripts JS y Más

Este documento detalla la estructura y flujo del proyecto FSM, que ha sido extendido con capacidades avanzadas de IA, manejo de estados saltados, ejecución de scripts JS, dependencias configurables para acciones, y mejor gestión de datos, incluyendo un sistema de autenticación centralizado para APIs.

## Estructura del Proyecto Clave

```
.
├── config/
│   ├── states.json                 # Lógica FSM. Incluye stateLogic con onEntry, awaitsUserInputParameters.
│   ├── aiPrompt.txt                # Prompt IA.
│   ├── aiResponseSchema.json       # Esquema validación IA.
│   ├── customAIResponseValidator.js # Validador JS personalizado IA.
│   ├── api_definitions/            # Definiciones de API externas (ahora con sección opcional `authentication`).
│   │   ├── api_generate_system_token.json # Ejemplo de API para generar tokens
│   │   └── api_get_protected_data.json    # Ejemplo de API que usa autenticación
│   ├── auth_profiles/              # Nuevo: Perfiles de autenticación reutilizables.
│   │   └── defaultBearerAuth.json    # Ejemplo de perfil para Bearer Tokens
│   └── scripts/                    # Directorio para snippets de código JS.
│       ├── auth/                   # Scripts para la lógica de autenticación
│       │   ├── manageToken.js
│       │   ├── cacheNewToken.js
│       │   └── setActiveToken.js
│       └── prompt_formatters/
│           └── city_prompts.js
├── docs/
│   ├── CodebaseOverview.md         # Este archivo.
│   ├── ARI_Integration.md          # Documentación de la interfaz con Asterisk ARI.
│   ├── StateConfiguration.md       # Nuevo: Detalle de la configuración de estados.
│   ├── ActionDefinitionsDetail.md  # Nuevo: Detalle de la definición de APIs, Scripts y Perfiles de Auth.
│   └── FSM_Documentation.md        # Documentación general de la FSM.
├── scripts/
│   └── simulateApiResponder.js     # CLI para simular respuestas API a Redis Streams (con MAXLEN).
├── src/
│   ├── index.js                    # Orquestador principal.
│   ├── logger.js                   # Pino logger.
│   ├── aiService.js                # Interactúa con proveedores IA.
│   ├── jsonValidator.js            # Valida JSON de IA.
│   ├── apiConfigLoader.js          # Carga config/api_definitions/.
│   ├── authProfileLoader.js        # Nuevo: Carga config/auth_profiles/.
│   ├── authService.js              # Nuevo: Gestiona la obtención y caché de tokens de autenticación.
│   ├── apiCallerService.js         # Métodos makeRequestAndWait/Async. Integra AuthService.
│   ├── scriptExecutor.js           # Carga y ejecuta snippets de JS.
│   ├── configLoader.js             # Carga states.json.
│   ├── fsm.js                      # Motor FSM: lógica de transición, ejecución de acciones con dependencias.
│   ├── redisClient.js              # Cliente Redis: sesiones, streams, caché de tokens.
│   └── templateProcessor.js        # Procesa plantillas ({{...}}).
├── env.example                     # Variables de entorno.
├── package.json                    # Dependencias.
└── README.md, AGENTS.md            # Documentación principal.
```

## Módulos Detallados y Flujo

### 1. `package.json`
   - Dependencias principales: `axios`, `uuid`, `ioredis`, `pino`.

### 2. `config/api_definitions/` y `src/apiConfigLoader.js`
   - `api_definitions/`: Archivos JSON por API. Ahora pueden incluir una sección `authentication` que referencia un `authProfileId` y define `tokenPlacement` (cómo usar el token).
   - `apiConfigLoader.js`: Carga estas definiciones. La función `getApiConfigById()` ahora devuelve un mapa de todas las configuraciones si no se pasa un ID.

### 3. `config/auth_profiles/` y `src/authProfileLoader.js` (Nuevos)
   - `auth_profiles/`: Directorio con perfiles de autenticación JSON (ej. para Bearer Tokens). Cada perfil especifica cómo generar/obtener un token (`tokenGenerationDetails` que referencia una `apiId`) y cómo cachearlo (`tokenCacheSettings`).
   - `authProfileLoader.js`: Carga estos perfiles.

### 4. `src/authService.js` (Nuevo)
   - Lógica central para la gestión de tokens:
     - `getValidToken(authProfileId, currentParameters, sessionData, sessionIdForLog)`:
       - Carga el perfil de autenticación.
       - Verifica la caché de Redis para un token válido.
       - Si no hay token válido, llama a la API generadora de tokens (definida en el perfil) usando `apiCallerService.makeRequestAndWait()`.
       - Extrae el token y su información de expiración de la respuesta.
       - Guarda el nuevo token en la caché de Redis con un TTL apropiado.
       - Devuelve el token (`{ tokenValue, tokenType }`).

### 5. `src/apiCallerService.js` (Actualizado)
   - `makeRequestAndWait()` y `makeRequestAsync()` ahora aceptan `sessionData`.
   - Antes de construir la configuración final de `axios` con `prepareRequestConfig()`:
     - Verifican si la `apiConfig` tiene una sección `authentication`.
     - Si es así, llaman a `authService.getValidToken()`.
     - Si se obtiene un token, se añade a la `requestConfig` (ej. cabecera `Authorization: Bearer <token>`) según `tokenPlacement`.
     - Si no se obtiene un token para una API que lo requiere, `makeRequestAndWait` devuelve un error estructurado (`isAuthError: true`); `makeRequestAsync` actualmente despacha la llamada sin token (lo que probablemente causará un fallo en el servidor API).
   - `prepareRequestConfig()` ahora también recibe `sessionData` por si las plantillas de la API de token necesitaran acceder a ella (aunque es menos común).

### 6. `src/scriptExecutor.js`
   - Ejecuta scripts de `config/scripts/`.
   - Los scripts reciben `currentParameters`, `logger`, `sessionId`.
   - Interpreta retornos estructurados de scripts: `{ status: "SUCCESS" | "ERROR" | "FORCE_TRANSITION", output, message, errorCode, transitionDetails }`.

### 7. `src/redisClient.js`
   - Usado para sesiones FSM, streams de respuestas API asíncronas, y ahora también por `AuthService` para cachear tokens de autenticación.

### 8. `config/states.json` y `src/configLoader.js`
   - **`states.json`**:
     - Cada estado ahora tiene un objeto `stateLogic` que contiene:
       - `awaitsUserInputParameters` (opcional): Parámetros que la IA debe extraer para este estado.
       - `onEntry` (Array de Objetos de Acción, opcional): Acciones (API o Script) a ejecutar al entrar.
         - Cada acción define: `label` (opcional), `type`, `id`, `executionMode` ("SYNCHRONOUS" o "ASYNCHRONOUS"), `ignoreIfOutputExists` (opcional), `runIfCondition` (opcional, para ejecución condicional), y campos específicos (ej. `filePath`, `functionName`, `assignResultTo` para scripts; `consumesParameters` opcional para scripts).
       - `dataRequirementsForPrompt` (Array de Strings, opcional): Parámetros críticos para los prompts/customInstructions del estado.
   - **`configLoader.js`**: Carga `states.json`. `getAllStates()` provee todas las configuraciones de estado.

### 9. `src/fsm.js` (`processInput` Refactorizado)
   - **Gestión de Sesión**: `initializeOrRestoreSession` inicializa `conversationHistory`.
   - **Flujo de Procesamiento Principal**:
     1.  **Determinar Estado Objetivo (`candidateNextStateId`)**: Basado en `intent` y `awaitsUserInputParameters` del estado actual.
     2.  **Recopilar Acciones `onEntry` y por `dataRequirementsForPrompt`**:
         - Se reúnen las acciones `onEntry` de los estados a procesar (saltados + candidato).
         - Se analizan los prompts/customInstructions del `candidateNextStateConfig` para identificar `{{params}}` necesarios. Si un `param` falta y una API lo produce, se añade una acción API síncrona para obtenerlo.
     3.  **Planificar y Ejecutar Acciones Síncronas (usando Grafo y Orden Topológico)**:
         - `buildSyncActionGraph()`: Crea un grafo de dependencias para las acciones síncronas (APIs y Scripts). Las dependencias se basan en `consumesParameters` (de `api_definitions/` o de la acción de script) y `producesParameters` (de `api_definitions/`) o `assignResultTo` (de scripts). Identifica tareas irresolubles por `USER_INPUT` faltante.
         - `topologicalSort()`: Ordena las tareas resolubles. Detecta ciclos.
         - Se ejecutan las tareas en orden. `executeSingleAction()` maneja la llamada real a API (vía `apiCallerService`) o script (vía `scriptExecutor`), y actualiza `currentParameters` con los resultados.
         - `runIfCondition` se verifica antes de intentar ejecutar una acción.
     4.  **Despachar Acciones Asíncronas `onEntry`**: Se despachan si sus dependencias se cumplen. `waitForResultConfig` se guarda en `pendingApiResponses`.
     5.  **Transición Final y `onTransition` Actions**: Se actualiza el estado de la sesión. Se ejecutan acciones `onTransition` del estado origen.
     6.  **Renderizar `payloadResponse`**: Del estado final, usando `currentParameters` actualizados.
   - **Funciones Clave**: `extractTemplateParams`, `getActionDependencies`, `executeSingleAction`, `buildSyncActionGraph`, `topologicalSort`.

### 10. `src/index.js` (`handleInputWithAI`)
   - **Construcción del Prompt para IA**:
     - Recupera `customInstructions` del estado FSM actual (de `sessionData.currentStateId`), las renderiza con `sessionData.parameters`, y las antepone al `userInputText` antes de llamar a `aiService.getAIResponse`.
     - (Recomendación pendiente de implementar por el usuario): Añadir historial de conversación y parámetros recolectados al prompt.
   - **Manejo de `waitForResult` (Lógica a implementar por el usuario en `index.js`):**
     - Al inicio, antes de llamar a la IA, `index.js` debería iterar `sessionData.pendingApiResponses`.
     - Para las que tengan `waitForResultConfig.point === "BEFORE_AI_PROMPT_NEXT_TURN"`, realizar `XREADGROUP` bloqueante.
     - Procesar la respuesta o el `onTimeoutFallback`, actualizando `currentParameters`.
     - Guardar la sesión antes de construir el prompt de IA.
   - Pasa `sessionId` a `aiService.getAIResponse`.
   - (Recomendación pendiente de implementar por el usuario): Poblar `sessionData.conversationHistory`.

### 11. `config/aiPrompt.txt` y `scripts/simulateApiResponder.js` y `env.example`
   - Sin cambios funcionales directos en `aiPrompt.txt`, pero se beneficia del prompt más rico.
   - `simulateApiResponder.js` usa `MAXLEN`.
   - `env.example` incluye `REDIS_SESSION_TTL`, `SIMULATOR_STREAM_MAXLEN`.

---
*Fin del documento.*
