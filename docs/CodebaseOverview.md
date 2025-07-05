# Visión General del Código Base - FSM con IA, APIs Sincrónicas/Asíncronas, Scripts JS y Más

Este documento detalla la estructura y flujo del proyecto FSM, que ha sido extendido con capacidades avanzadas de IA, manejo de estados saltados, ejecución de scripts JS, dependencias configurables para acciones, y mejor gestión de datos.

## Estructura del Proyecto Clave

```
.
├── config/
│   ├── states.json                 # Lógica FSM. Incluye apiHooks para sync/async APIs y executeScript.
│   ├── aiPrompt.txt                # Prompt IA.
│   ├── aiResponseSchema.json       # Esquema validación IA.
│   ├── customAIResponseValidator.js # Validador JS personalizado IA.
│   ├── api_definitions/            # Definiciones de API externas.
│   │   └── (ej: fetch_user.json)
│   └── scripts/                    # Directorio para snippets de código JS ejecutables por la FSM.
│       └── (ej: example/testScript.js)
├── docs/
│   ├── CodebaseOverview.md         # Este archivo.
│   ├── ARI_Integration.md          # Documentación de la interfaz con Asterisk ARI.
│   └── FSM_Documentation.md        # Documentación general de la FSM.
├── scripts/
│   └── simulateApiResponder.js     # CLI para simular respuestas API a Redis Streams (ahora con MAXLEN).
├── src/
│   ├── index.js                    # Orquestador principal: maneja input, integra IA, FSM, Redis Streams.
│   ├── logger.js                   # Pino logger.
│   ├── aiService.js                # Interactúa con proveedores IA.
│   ├── jsonValidator.js            # Valida JSON de IA.
│   ├── apiConfigLoader.js          # Carga config/api_definitions/.
│   ├── apiCallerService.js         # Métodos makeRequestAndWait (sync) y makeRequestAsync (async).
│   ├── scriptExecutor.js           # Nuevo: Carga y ejecuta snippets de JS desde config/scripts/.
│   ├── configLoader.js             # Carga states.json, ahora con getAllStates().
│   ├── fsm.js                      # Motor FSM: lógica de transición, ejecución de APIs/scripts (con dependencias y manejo de estados saltados).
│   ├── redisClient.js              # Cliente Redis: manejo de sesiones, funciones Stream.
│   └── templateProcessor.js        # Procesa plantillas ({{...}}).
├── env.example                     # Variables de entorno (actualizado con REDIS_SESSION_TTL, SIMULATOR_STREAM_MAXLEN).
├── package.json                    # Dependencias.
└── README.md, AGENTS.md            # Documentación principal (actualizada).
```

## Módulos Detallados y Flujo

### 1. `package.json`
   - Dependencias principales: `axios` (llamadas HTTP), `uuid` (correlation IDs), `ioredis`, `pino`.

### 2. `config/api_definitions/` y `src/apiConfigLoader.js`
   - `api_definitions/`: Contiene archivos JSON por API, definiendo `apiId`, `url`, `method`, plantillas para `headers`, `body_template`, `query_params_template`, `timeout_ms`, y `response_stream_key_template`.
   - `apiConfigLoader.js`: Carga estas definiciones en memoria al inicio. Provee `getApiConfigById(apiId)`. Las APIs definidas aquí ahora pueden tener dependencias especificadas en `states.json`.

### 3. `src/scriptExecutor.js` (Nuevo)
   - Responsable de cargar y ejecutar de forma segura snippets de código JavaScript definidos en `config/scripts/`.
   - Las funciones de script (identificadas por `functionName` en la configuración) reciben `currentParameters`, `logger`, y `sessionId`.
   - Soporta scripts síncronos y asíncronos (controlado por `isAsync` en la configuración del script en `states.json`).
   - Los resultados pueden ser asignados a `currentParameters` usando la propiedad `assignResultTo` en la configuración del script. Si no se especifica `assignResultTo`, los resultados se guardan en `currentParameters.script_results[scriptId_o_filePath]`.

### 4. `src/apiCallerService.js`
   - `prepareRequestConfig()`: Función interna para procesar plantillas en URL, headers, body, query_params.
   - `makeRequestAndWait(apiId, sessionId, correlationId, params)`: Usado por `fsm.js` para APIs en `synchronousCallSetup`. Bloquea y devuelve la respuesta.
   - `makeRequestAsync(apiId, sessionId, correlationId, params)`: Usado por `fsm.js` para APIs en `asynchronousCallDispatch`. Es "fire-and-forget"; la respuesta se espera vía Redis Stream.

### 5. `src/redisClient.js`
   - Mantiene un cliente principal y un `subscriberClient` para operaciones bloqueantes de streams.
   - Funciones Stream: `xadd`, `xreadgroup`, `xack`, `xgroupCreate`.
   - `getClient()`: Expone el cliente ioredis subyacente, usado por `simulateApiResponder.js` para `XADD` con `MAXLEN`.
   - Manejo de conexión/desconexión y logging.

### 6. `config/states.json` y `src/configLoader.js`
   - **`states.json`**:
     - `payloadResponse.apiHooks`: Contiene `synchronousCallSetup`, `asynchronousCallDispatch`, y el nuevo `executeScript`.
     - Cada acción dentro de estos arrays (API o script) ahora es un objeto que puede incluir:
       - `apiId` (para APIs) o `scriptId`, `filePath`, `functionName` (para scripts).
       - `dependsOn` (opcional): Un objeto que especifica `parameters` (requeridos del usuario/IA) y/o `apiResults` (IDs de otras APIs cuyos resultados son necesarios). La acción solo se ejecuta si se cumplen estas dependencias.
     - `executeScript` (detalles):
       - `scriptId`: Identificador lógico.
       - `filePath`: Ruta relativa al script desde `config/scripts/` (ej. `subfolder/myScript.js`).
       - `functionName`: Nombre de la función a ejecutar dentro del archivo script.
       - `assignResultTo` (opcional): Clave para guardar el resultado del script en `currentParameters`.
       - `isAsync` (opcional, default `false`): Si el script devuelve una Promesa.
     - Plantillas `{{...}}` en `payloadResponse` pueden acceder a `{{sync_api_results...}}`, `{{async_api_results...}}`, y resultados de scripts (ej. `{{clave_asignada}}` o `{{script_results.scriptId.data}}`).
   - **`configLoader.js`**:
     - Añadida la función `getAllStates()` que devuelve el objeto de todos los estados. Usada por `fsm.js` para la lógica de estados saltados.

### 7. `src/fsm.js` (`processInput` significativamente refactorizado)
   - **Gestión de Sesión**:
     - `initializeOrRestoreSession`: Ahora también inicializa `sessionData.conversationHistory = []` para almacenar el historial de interacciones.
     - `saveSessionAsync`: Utiliza `REDIS_SESSION_TTL` (de `env.example`) para la expiración de la sesión en Redis.
   - **Flujo de Procesamiento Principal**:
     1.  **Determinación Preliminar del Estado Objetivo**: Se calcula un `candidateNextStateId` basado en el `intent` actual y los `currentParameters`.
     2.  **Procesamiento de Estados Saltados (`getSkippedStates`)**:
         - Si `candidateNextStateId` no es una transición directa desde el estado actual, `getSkippedStates` intenta identificar los estados intermedios (saltados).
         - Utiliza `getAllStatesConfig()` para acceder a la configuración de todos los estados y realizar un pathfinding básico.
         - Para cada estado saltado identificado, se ejecutan secuencialmente:
           - Sus `synchronousCallSetup` (vía `executeApiHook`).
           - Sus `executeScript` (vía `executeScriptHook`).
           - Sus `asynchronousCallDispatch` (vía `executeApiHook`).
         - Todas estas ejecuciones respetan las cláusulas `dependsOn`.
     3.  **Ejecución de Acciones del Estado Objetivo**:
         - Se ejecutan los `synchronousCallSetup` del `candidateNextStateConfig`.
         - Se ejecutan los `executeScript` del `candidateNextStateConfig`.
     4.  **Transición Final y Renderizado**:
         - Se confirma el `finalNextStateId` (actualmente el `candidateNextStateId`).
         - Se actualiza `sessionData.currentStateId` y el historial de estados.
         - Se renderiza el `payloadResponse` para el `finalNextStateConfig`, usando los `currentParameters` actualizados (que incluyen resultados de APIs síncronas y scripts).
     5.  **Despacho Asíncrono del Estado Final**:
         - Se ejecutan los `asynchronousCallDispatch` del `finalNextStateConfig`.
   - **Funciones Auxiliares Clave**:
     - `areDependenciesMet(dependsOn, currentParameters, sessionId)`: Verifica si las dependencias de una acción (API o script) se cumplen.
     - `executeApiHook(hookType, hookConfigArray, ...)`: Encapsula la lógica para ejecutar arrays de definiciones de API síncronas o asíncronas, incluyendo el chequeo de dependencias.
     - `executeScriptHook(scriptHookConfigArray, ...)`: Encapsula la lógica para ejecutar arrays de definiciones de script, chequeando dependencias y asignando resultados.
   - **Parámetro `userInputText`**: `processInput` ahora acepta `userInputText`. Aunque la FSM no lo usa directamente para poblar `conversationHistory`, lo hace disponible para que el orquestador (`index.js`) pueda hacerlo.

### 8. `src/index.js` (`handleInputWithAI` - Cambios Conceptuales Implicados por las nuevas funcionalidades)
   - **Construcción del Prompt para IA**:
     - Antes de llamar a `aiService.getAIResponse`, `index.js` es responsable de construir un `fullTextInputForAI` más completo. Este debería incluir:
       - El texto del usuario actual (`userInput`).
       - Contexto de respuestas de API asíncronas del ciclo anterior (ej. `[API Response Context...]`).
       - Un historial formateado de la conversación (de `sessionData.conversationHistory`).
       - Una representación de los parámetros ya recolectados (de `sessionData.parameters`, filtrando namespaces internos).
       - Las `customInstructions` del `payloadResponse` del estado FSM anterior (ya renderizadas).
   - **Poblado de `conversationHistory`**:
     - Después de que `fsm.processInput` devuelve su resultado, y antes de enviar la respuesta final al cliente, `index.js` debería:
       - Tomar el `userInputText` original.
       - Tomar el prompt principal enviado al usuario (ej. `renderedPayloadResponse.prompts.main`).
       - Añadir este par `{userInput: userInputText, aiOutput: promptPrincipal}` a `sessionData.conversationHistory`.
       - Guardar la sesión actualizada en Redis.
   - **Paso de `userInputText` a FSM**: `index.js` debe pasar el `userInputText` a `fsm.processInput`.

### 9. `config/aiPrompt.txt`
   - No se modifica directamente, pero su efectividad se ve reforzada por el prompt más contextualizado que `index.js` debería construir (con historial, parámetros recolectados, etc.).

### 10. `scripts/simulateApiResponder.js`
   - Actualizado para usar `MAXLEN ~ <count>` en la llamada `XADD` a Redis, ayudando a controlar el tamaño de los streams para fines de simulación. La longitud máxima es configurable mediante la variable de entorno `SIMULATOR_STREAM_MAXLEN`.

### 11. `env.example`
   - Actualizado para incluir `REDIS_SESSION_TTL` y `SIMULATOR_STREAM_MAXLEN`.

---
*Fin del documento.*
