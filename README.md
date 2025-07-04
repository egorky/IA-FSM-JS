# Node.js FSM Service para Agendamiento Virtual

Este proyecto implementa una Máquina de Estados Finitos (FSM) utilizando Node.js. Está diseñada para gestionar flujos de conversación, como el agendamiento de citas, y puede ser integrada a través de una API RESTful o mediante Asterisk ARI para interacciones telefónicas.

## Características Principales

*   **Motor de FSM Configurable y Flexible en Respuestas**: La lógica de los estados, transiciones y parámetros a recolectar se define en `config/states.json`. Cada estado puede definir un objeto `payloadResponse` de formato libre. La FSM procesa los strings dentro de este `payloadResponse` para:
    *   Sustituir placeholders de parámetros (ej: `{{caller_name}}`).
    *   Sustituir placeholders de fecha/hora (ej: `{{current_date}}`).
    *   Ejecutar un conjunto de funciones predefinidas seguras (ej: `{{toUpperCase(param)}}`).
    *   **Opcionalmente, ejecutar snippets de JavaScript en un sandbox seguro** (usando `isolated-vm`) mediante la sintaxis `{{sandbox_js: /* código */ }}`. Esta funcionalidad solo está activa si `isolated-vm` está correctamente instalado y cargado.
    Esto permite que la aplicación cliente reciba contenido dinámico y listo para usar (ej: prompts para TTS).
*   **Persistencia de Sesión**: Utiliza Redis para almacenar el estado actual de cada conversación (`currentStateId`) y todos los parámetros acumulados (`collectedParameters`). Cada sesión se identifica con un `sessionId` y tiene un TTL configurable.
*   **Interfaz API RESTful**: Expone un endpoint (`POST /fsm/:sessionId`). Acepta `intent` y `parameters` nuevos. Devuelve el `nextStateId`, los `parametersToCollect` para el nuevo estado, el `payloadResponse` (ya procesado con sustituciones y/o ejecución de JS) definido para ese `nextStateId`, y la totalidad de `collectedParameters` (fusión de los parámetros de sesión y los nuevos).
*   **Integración con Asterisk ARI**: Incluye un módulo para conectar con Asterisk ARI. La FSM puede así guiar flujos de llamadas, con el `payloadResponse` procesado proveyendo la información y textos listos para acciones ARI.
*   **Manejo de Intenciones**: Las intenciones del usuario o del sistema pueden dirigir el flujo a estados diferentes, independientemente de la recolección de parámetros.
*   **Modularidad**: El código está estructurado en módulos con responsabilidades claras:
    *   Carga de configuración (`configLoader.js`)
    *   Lógica de la FSM (`fsm.js`)
    *   Cliente Redis (`redisClient.js`)
    *   Servidor API (`apiServer.js`)
    *   Cliente ARI (`ariClient.js`)
    *   Punto de entrada (`index.js`)

## Funcionalidad Detallada

Cuando una interacción ocurre (ya sea una solicitud API o un evento en una llamada ARI):

1.  Se identifica o crea una **sesión** para el usuario/llamada, almacenada en Redis.
2.  Se provee el **estado actual** (recuperado de la sesión), la **intención** del usuario (si la hay) y los **parámetros** que se hayan podido recoger en la última interacción.
3.  La **FSM procesa** esta entrada:
    *   Evalúa si la intención actual implica una transición a un flujo diferente.
    *   Si no hay una intención prioritaria, verifica si los parámetros recolectados cumplen las condiciones para avanzar al siguiente estado definido.
    *   Actualiza el estado de la sesión en Redis (importante: `sessionData.parameters` ahora contiene la fusión de los parámetros de sesión anteriores y los parámetros recién llegados en la solicitud).
    *   Procesa el `payloadResponse` del estado de destino**: Sustituye placeholders de parámetros, fecha/hora, ejecuta funciones predefinidas y, si está habilitado y se usa la sintaxis `{{sandbox_js:...}}`, ejecuta código JavaScript en un sandbox.
4.  La FSM **devuelve**:
    *   `nextStateId`: Identificador del nuevo estado de la conversación.
    *   `parametersToCollect`: Un objeto indicando qué parámetros son `required` y `optional` para el nuevo estado, y que aún no han sido proporcionados.
    *   `payloadResponse`: El objeto `payloadResponse` (definido en `config/states.json`) **después de haber sido completamente procesado por el `templateProcessor.js`**.
    *   `collectedParameters`: Un objeto con **todos** los parámetros acumulados durante la sesión, incluyendo los que se recibieron en la solicitud actual y los que ya estaban en Redis.

## Escenario de Ejemplo: Agendamiento de Cita

1.  **Inicio**: El usuario interactúa. La FSM se inicializa en el estado "1\_welcome\_and\_age".
    *   `config/states.json` para `1_welcome_and_age` tiene `payloadResponse: { "greeting": "Hola {{default(caller_name, 'estimado usuario')}}, bienvenido. Hoy es {{current_date}}." }`
    *   Respuesta FSM: `nextStateId: "1_welcome_and_age"`, `parametersToCollect: { required: ["patient_age"] }`, `payloadResponse: { "greeting": "Hola estimado usuario, bienvenido. Hoy es AAAA-MM-DD." }`, `collectedParameters: {}`.
2.  **Usuario provee edad y nombre**: `caller_name: "Ana"`, `patient_age: 30`.
    *   Entrada FSM: `intent: null`, `parameters: { "caller_name": "Ana", "patient_age": 30 }`.
    *   `config/states.json` para `2_get_patient_id` tiene `payloadResponse: { "prompts": { "main": "Gracias, {{capitalize(caller_name)}}. Por favor, ingrese su número de identificación."}}}`
    *   Respuesta FSM: `nextStateId: "2_get_patient_id"`, `parametersToCollect: { required: ["patient_id_number"] }`, `payloadResponse: { "prompts": { "main": "Gracias, Ana. Por favor, ingrese su número de identificación." } }`, `collectedParameters: { "caller_name": "Ana", "patient_age": 30 }`.
3.  **Uso de `sandbox_js`**: Supongamos que el estado `7_confirmation_and_closing` tiene:
    `"dynamicGreeting": "{{sandbox_js: return 'Saludo dinámico para ' + collectedParameters.caller_name + '!';}}"`
    *   Respuesta FSM (para ese campo): `payloadResponse: { ..., "dynamicGreeting": "Saludo dinámico para Ana!", ...}`.

## Configuración y Ejecución

*   **Dependencias**: `express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm` (listadas en `package.json`).
*   **Configuración de Estados**: Definida en `config/states.json`.
*   **Servicios Externos**: Requiere una instancia de Redis accesible. Si se usa ARI (y `ENABLE_ARI="true"`), un servidor Asterisk configurado para ARI.
*   **Variables de Entorno**:
    *   El proyecto utiliza la librería `dotenv` para cargar automáticamente variables de entorno desde un archivo `.env` ubicado en la raíz del proyecto.
    *   Se proporciona un archivo `.env.example` como plantilla. Copie este archivo a `.env` y modifique los valores según su configuración local.
    *   **Variables Clave en `.env`**:
        *   `ENABLE_API`: Controla si se inicia el servidor API (`true` por defecto).
    *   `ENABLE_ARI`: Controla si se inicia la conexión ARI (`true` por defecto).
    *   `ENABLE_SOCKET_SERVER`: Controla si se inicia el servidor de sockets UNIX (`true` por defecto).
    *   `DEFAULT_INTENT`: Intención que se asume si no se proporciona ninguna en la solicitud (ej: `intent_schedule_appointment`). Dejar vacío para no asumir ninguna.
    *   `PORT`: Puerto para el servidor API (defecto: 3000, relevante si `ENABLE_API="true"`).
    *   `FSM_SOCKET_PATH`: Ruta del archivo para el socket UNIX (defecto: `/tmp/fsm_service.sock`, relevante si `ENABLE_SOCKET_SERVER="true"`).
    *   `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`: Para la conexión a Redis.
    *   `REDIS_SESSION_TTL`: Tiempo de vida (en segundos) para las sesiones en Redis (ej: 3600 para 1 hora; 0 o vacío para sin expiración).
    *   `ARI_APP_NAME`, `ARI_USERNAME`, `ARI_PASSWORD`, `ARI_URL`: Para la conexión ARI (relevante si `ENABLE_ARI="true"`).

Para ejecutar (asumiendo que las dependencias están instaladas y los servicios configurados):

```bash
npm start
```

## Documentación Detallada del Código

Para una explicación más profunda de cada archivo, módulo y función principal, consulta el documento [docs/CodebaseOverview.md](docs/CodebaseOverview.md).

## Nota Importante

Este proyecto fue desarrollado con la restricción de **no instalar dependencias** directamente en el entorno de desarrollo del agente AI. Solo se han registrado en `package.json`. La instalación y configuración completa del entorno de ejecución (Node.js, Redis, Asterisk, y las `npm install`) es responsabilidad del usuario final.
