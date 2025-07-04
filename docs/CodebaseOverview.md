# Visión General del Código Base - Servicio FSM con IA y Simulación de API

Este documento proporciona una explicación detallada de cada archivo principal y pieza de código dentro del proyecto del Servicio FSM, ahora con integración de IA y simulación de llamadas a API externas.

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
│   └── templateProcessor.js        # Procesa `payloadResponse` de la FSM y `externalApiCall`
├── .env.example                    # Ejemplo de variables de entorno (actualizado)
├── AGENTS.md                       # Instrucciones para agentes AI (actualizado)
├── FSM_Documentation.md            # Documentación general y casos de uso (actualizado)
├── package.json                    # Dependencias y scripts del proyecto (actualizado)
└── README.md                       # README principal del proyecto (actualizado)
```

## Archivos y Módulos

A continuación, se detalla cada componente principal:

### 1. `package.json` (Actualizado)
   - Mantiene las dependencias anteriores y añade `openai`, `@google/genai`, `groq-sdk`, `ajv`, `pino`, y `pino-pretty`.

### 2. Carpeta `config/` (Actualizada)
   - `states.json`:
     - **Nuevo**: Puede contener un objeto `externalApiCall` dentro de `payloadResponse` de un estado. Este objeto define:
       - `type` (string): Un identificador para el tipo de llamada API (ej: "fetch_doctors_for_specialty").
       - `requestParams` (object): Parámetros a enviar en la llamada API simulada. Puede usar variables de plantilla (ej: `{ "specialty": "{{medical_specialty}}" }`).
       - `correlationId` (string): Un ID para rastrear la solicitud/respuesta. Puede usar variables de plantilla (ej: `"corr_{{sessionId}}_{{current_time}}"`).
   - `aiPrompt.txt`: Prompt para la IA. Actualizado para instruir a la IA sobre cómo considerar el contexto de respuestas de API si se incluye en el texto de entrada.
   - `aiResponseSchema.json`: Esquema para validar el JSON de la IA.
   - `customAIResponseValidator.js`: Validador JS personalizado para la respuesta de la IA.

### 3. `src/index.js` (Actualizado)
   - **Cambios Clave en `handleInputWithAI(sessionId, textInput, source)`**:
     - **Comprobación de Respuestas de API Simuladas**: Antes de llamar a `aiService.getAIResponse`, llama a una nueva función interna `checkForAndCombineApiResponse(sessionId, currentText)`.
       - `checkForAndCombineApiResponse`: Usa `redisClient.getClient().scan()` para buscar claves en Redis que coincidan con el patrón `api_response:{sessionId}:*`.
       - Si encuentra una clave, recupera el JSON de respuesta de la API simulada, la elimina de Redis para evitar reprocesamiento.
       - Combina el texto original del usuario con la respuesta de la API formateada como: `Texto del usuario\n\n[API Response Context: {JSON de la respuesta API}]`.
     - El texto (potencialmente combinado) se pasa a `aiService.getAIResponse`.
     - Se registra el texto combinado en Redis (`ai_actual_input:...`).
     - El resto del flujo (validación, llamada a FSM, logging de FSM I/O) permanece similar pero opera sobre los datos potencialmente enriquecidos.

### 4. `src/logger.js`
   - Configuración de `pino`.

### 5. `src/aiService.js`
   - Interactúa con proveedores de IA. Sin cambios funcionales mayores en esta iteración.

### 6. `src/jsonValidator.js`
   - Valida la respuesta JSON de la IA. Sin cambios funcionales mayores en esta iteración.

### 7. `src/configLoader.js`
   - Carga `config/states.json`. Usa `logger.js`.

### 8. `src/redisClient.js` (Actualizado)
   - **Uso Extendido para Simulación de API**:
     - `LPUSH` a `fsm_api_request_queue`: Usado por `fsm.js` para "enviar" solicitudes de API simuladas.
     - `RPOP` de `fsm_api_request_queue`: Usado por `scripts/simulateApiResponder.js` para leer estas solicitudes.
     - `SETEX` para `api_response:{sessionId}:{correlationId}`: Usado por `scripts/simulateApiResponder.js` para guardar respuestas simuladas.
     - `GET` y `DEL` para `api_response:{sessionId}:{correlationId}`: Usado por `src/index.js` para consumir estas respuestas.
     - `SCAN`: Usado por `src/index.js` para buscar claves de respuesta de API.

### 9. `src/fsm.js` (Actualizado)
   - **Cambios Clave en `processInput()`**:
     - Después de determinar `nextStateConfig` y renderizar `payloadResponse` con `processTemplate`:
       - Verifica si `nextStateConfig.payloadResponse.externalApiCall` está definido.
       - Si existe, se realiza una copia profunda de este objeto.
       - Los campos `requestParams` (si es un objeto) y `correlationId` (si es un string) dentro de `externalApiCall` se procesan con `processTemplate` usando `currentParameters` para resolver cualquier variable de plantilla.
       - Se construye un objeto `apiRequest` con `sessionId`, `correlationId` renderizado (con fallback a uno generado con timestamp), `type`, `requestParams` renderizados, y un `timestamp`.
       - Se llama a una nueva función `sendApiRequestAsync(apiRequest)` que hace `LPUSH` del `apiRequest` (serializado a JSON) a la lista `fsm_api_request_queue` en Redis de forma asíncrona.
   - Logging actualizado a `logger.js`.
   - Guardado de sesión sigue siendo asíncrono.

### 10. `src/templateProcessor.js` (Actualizado)
    - **Uso Extendido**: Su función `processTemplate` ahora también es utilizada por `fsm.js` para renderizar los campos dentro del objeto `externalApiCall` (específicamente `requestParams` y `correlationId`).

### 11. `src/apiServer.js`, `src/socketServer.js`, `src/ariClient.js` (Actualizados)
    - Delegan el procesamiento de entrada a `handleInputWithAI` de `src/index.js`. Sin cambios funcionales mayores en esta iteración más allá de lo ya implementado para el flujo de IA.

### 12. `.env.example` (Actualizado)
    - Sin cambios directos en esta iteración, pero las variables existentes para Redis son usadas por el nuevo mecanismo de simulación.

### 13. `scripts/simulateApiResponder.js` (NUEVO)
    - **Propósito**: Script independiente para simular un respondedor de API externo.
    - **Funcionalidad**:
        - Carga variables de `.env`.
        - Conecta a Redis.
        - Entra en un bucle de sondeo (`pollQueue`) que periódicamente (cada `POLLING_INTERVAL_MS`):
            - Intenta `RPOP` una solicitud de la lista `fsm_api_request_queue`.
            - Si obtiene una solicitud:
                - Parsea el JSON.
                - Basado en el campo `type` de la solicitud (ej: `fetch_doctors_for_specialty`), genera una respuesta JSON mock.
                - Incluye el `correlationId` y `sessionId` originales en la respuesta o al guardarla.
                - Guarda la respuesta JSON en Redis usando una clave como `api_response:{sessionId}:{correlationId}` con un TTL (`RESPONSE_TTL_SECONDS`).
        - Incluye manejo básico de errores y cierre ordenado.

---
*Fin del documento.*
