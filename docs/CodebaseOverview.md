# Visión General del Código Base - Servicio FSM

Este documento proporciona una explicación detallada de cada archivo principal y pieza de código dentro del proyecto del Servicio FSM.

## Estructura del Proyecto

```
.
├── config/
│   └── states.json       # Define los estados y la lógica de la FSM
├── docs/
│   └── CodebaseOverview.md # Este archivo
├── src/
│   ├── apiServer.js      # Servidor API Express para interactuar con la FSM
│   ├── ariClient.js      # Cliente para interactuar con Asterisk ARI
│   ├── configLoader.js   # Carga y valida states.json
│   ├── fsm.js            # Lógica central de la máquina de estados
│   ├── index.js          # Punto de entrada de la aplicación
│   └── redisClient.js    # Cliente para interactuar con Redis
├── .env.example          # Ejemplo de variables de entorno
├── AGENTS.md             # Instrucciones para agentes AI
├── FSM_Documentation.md  # Documentación general y casos de uso
├── package.json          # Dependencias y scripts del proyecto
└── README.md             # README principal del proyecto
```

## Archivos y Módulos

A continuación, se detalla cada componente principal:

### 1. `package.json`
   - **Propósito**: Este archivo es el manifiesto del proyecto Node.js. Define los metadatos del proyecto (nombre, versión, descripción, etc.), las dependencias necesarias para que la aplicación funcione (`dependencies`) y las dependencias utilizadas durante el desarrollo (`devDependencies`). También contiene `scripts` que facilitan tareas comunes como iniciar la aplicación.
   - **Scripts Principales**:
     - `start`: `node src/index.js` - Comando estándar para iniciar la aplicación. Ejecuta el punto de entrada `src/index.js` con Node.js.
     - `dev`: `nodemon src/index.js` - Inicia la aplicación utilizando `nodemon`. `nodemon` monitoriza los cambios en los archivos del proyecto y reinicia automáticamente el servidor, lo cual es muy útil durante el desarrollo para ver los cambios reflejados inmediatamente sin tener que parar y reiniciar el servidor manualmente.
     - `test`: `echo "Error: no test specified" && exit 1` - Es un placeholder estándar para el comando de pruebas. Actualmente, no hay pruebas automatizadas configuradas en el proyecto.
   - **Dependencias Clave** (`dependencies`):
     - `express` (`^4.17.1`): Un framework web minimalista y flexible para Node.js. Se utiliza en `src/apiServer.js` para crear el servidor HTTP que expone la FSM a través de una API RESTful. Maneja el enrutamiento, las solicitudes y respuestas HTTP.
     - `ioredis` (`^4.27.9`): Un cliente de Redis robusto y con todas las funciones para Node.js. Se utiliza en `src/redisClient.js` para conectar y ejecutar comandos contra una instancia de Redis, que se usa para almacenar el estado de las sesiones de la FSM.
     - `ari-client` (`^2.2.0`): La librería cliente oficial de JavaScript para la Asterisk REST Interface (ARI). Permite a las aplicaciones Node.js conectarse a Asterisk y controlar canales de llamadas, reproducir audio, recibir DTMF, etc. Se utiliza en `src/ariClient.js`.
     - `dotenv` (`^16.0.0`): Un módulo que carga variables de entorno desde un archivo `.env` (que debe estar en la raíz del proyecto) en `process.env`. Esto permite configurar la aplicación para diferentes entornos (desarrollo, producción) sin modificar el código. Se invoca al principio de `src/index.js`.
   - **Dependencias de Desarrollo** (`devDependencies`):
     - `nodemon` (`^2.0.12`): Como se mencionó antes, es una utilidad que monitoriza cambios en los archivos y reinicia automáticamente la aplicación Node.js. Solo se usa durante el desarrollo.

### 2. `config/states.json`
   - **Propósito**: Este archivo JSON es el corazón de la FSM. Define toda la lógica conversacional: los diferentes estados por los que puede pasar una interacción, las condiciones under las cuales se transita de un estado a otro, los parámetros que se deben recolectar en cada estado, y la información específica (payload) que la FSM debe devolver cuando se alcanza un nuevo estado. La externalización de esta lógica en un JSON permite modificar el comportamiento de la FSM sin necesidad de alterar el código JavaScript subyacente.
   - **Estructura Principal**:
     - `initialState`: (string) El ID del estado con el cual comenzará cada nueva sesión de la FSM. Este debe ser una de las claves definidas en el objeto `states`.
     - `states`: (object) Un objeto donde cada clave es un `stateId` (un identificador único y descriptivo para un estado, ej: `"1_welcome"`, `"2_get_id"`) y el valor es un objeto que detalla la configuración de ese estado específico.
       - `[stateId]`: (object) La definición de un estado individual.
         - `id`: (string) El identificador único del estado. Es redundante con la clave del objeto pero útil para referencia interna o si se convierte el objeto de estados en un array.
         - `description`: (string) Una descripción legible por humanos del propósito o la función de este estado en el flujo conversacional. Útil para entender la lógica del `states.json`.
         - `parameters`: (object, opcional) Define los parámetros de información que este estado está diseñado para recolectar o que son relevantes para su procesamiento.
           - `required`: (array de strings, opcional) Una lista de nombres de parámetros que son obligatorios para este estado. La FSM usará esta lista, por ejemplo, para determinar si se puede avanzar a un `defaultNextState` o para construir la lista de `parametersToCollect`.
           - `optional`: (array de strings, opcional) Una lista de nombres de parámetros que pueden ser recolectados en este estado pero no son estrictamente necesarios para su completitud.
         - `payloadResponse`: (object, opcional) Un objeto de formato libre definido por el usuario. **Los valores de tipo string dentro de este objeto pueden contener placeholders y llamadas a funciones predefinidas que serán procesadas por la FSM antes de devolver la respuesta.** (Ver documentación de `src/templateProcessor.js` para la sintaxis). Esto proporciona una gran flexibilidad, ya que la aplicación cliente puede recibir cualquier estructura de datos que necesite para ese estado particular, como:
           - `apiHooks`: (objeto, por convención) Podría contener sub-objetos o arrays para APIs a ser llamadas en diferentes momentos (`onEnterState`, `afterParametersCollected`, etc.).
           - `prompts`: (objeto o array) Textos o referencias a audios para mostrar/reproducir al usuario. Los strings aquí serán procesados por el `templateProcessor`.
           - `uiHints`: (objeto) Sugerencias para la interfaz de usuario (ej: tipo de input, botones a mostrar).
           - `tools`: (objeto o array) Herramientas o lógicas específicas que la aplicación cliente debe activar.
         - `transitions`: (array de objects, opcional) Una lista ordenada de posibles transiciones desde el estado actual a otros estados. La FSM las evalúa en el orden en que aparecen. La primera transición cuya condición se cumpla será la que se active.
           - `nextState`: (string) El `stateId` del estado al que se transitará si la `condition` de esta transición se cumple.
           - `condition`: (object, opcional) Define los criterios para que esta transición se active.
             - `intent`: (string, opcional) La transición se activa si la `intent` (intención) proporcionada en la solicitud a la FSM coincide exactamente con este valor. Las transiciones basadas en `intent` tienen prioridad sobre las basadas solo en parámetros.
             - `allParametersMet`: (boolean, opcional) Si es `true` (y no hay una `intent` que coincida primero), esta transición se considera si todos los parámetros definidos en la sección `parameters.required` del estado *actual* han sido recolectados (es decir, existen en `collectedParameters` y no son nulos o vacíos). Si `allParametersMet` es `false` y no hay `intent`, la transición se podría activar incondicionalmente (si es la primera en la lista) o bajo otras lógicas futuras. Por defecto, si una condición solo involucra parámetros, se asume `allParametersMet: true`.
         - `defaultNextState`: (string, opcional) Si ninguna de las `transitions` listadas se cumple (es decir, ninguna `intent` coincide y/o los parámetros requeridos para las transiciones condicionales no están completos), pero sí se han recolectado todos los parámetros definidos en `parameters.required` del estado *actual*, la FSM transitará a este `defaultNextState`. Esto es útil para flujos lineales donde, después de recolectar datos, se pasa al siguiente paso lógico a menos que una intención específica desvíe el flujo.
     - **Logging**: Los logs de este archivo son cruciales para entender el flujo de la FSM y los datos que se procesan.

### 3. `src/index.js`
   - **Propósito**: Este archivo es el punto de entrada principal de la aplicación Node.js. Es responsable de inicializar y coordinar los diferentes módulos del servicio, como la carga de la configuración de estados, la conexión a Redis, y el inicio condicional del servidor API y del cliente ARI. También maneja el cierre ordenado de la aplicación.
   - **Componentes Principales**:
     - **Carga de `dotenv`**: Al principio del archivo, `require('dotenv').config();` carga las variables de entorno definidas en un archivo `.env` en la raíz del proyecto, haciéndolas disponibles a través de `process.env`.
     - **Importación de Módulos**: Importa los módulos necesarios: `apiServer`, `redisClient`, `ariClient`, y `configLoader`.
     - **`main()` (async function)**:
       - Es la función principal que orquesta el arranque de la aplicación.
       - Imprime los valores de `process.env.ENABLE_API` y `process.env.ENABLE_ARI` para depuración.
       - Llama a `loadStateConfig()` para cargar y validar la configuración de la FSM.
       - Llama a `redisClient.connect()` para establecer la conexión con Redis.
       - Verifica `process.env.ENABLE_API`: Si no es `"false"`, llama a `startApiServer()` para iniciar el servidor Express. Informa si el módulo API está deshabilitado.
       - Verifica `process.env.ENABLE_ARI`: Si no es `"false"`, llama a `connectAri()` para iniciar la conexión con Asterisk ARI. Informa si el módulo ARI está deshabilitado.
       - Verifica `process.env.ENABLE_SOCKET_SERVER` y `process.env.FSM_SOCKET_PATH`: Si están configurados para habilitar el servidor de sockets, lo inicia.
       - Registra un mensaje indicando si la aplicación se inició correctamente (con al menos un módulo activo) o una advertencia si todos los módulos de interfaz están deshabilitados.
       - Captura errores fatales durante la inicialización, intenta cerrar las conexiones abiertas (API, ARI, Socket, Redis) y termina el proceso.
     - **`shutdown(signal)` (async function)**:
       - Diseñada para manejar el cierre ordenado de la aplicación cuando se reciben señales del sistema como `SIGINT` (Ctrl+C) o `SIGTERM`.
       - Intenta cerrar la conexión ARI (si estaba habilitada) llamando a `closeAri()`.
       - Cierra la conexión a Redis llamando a `redisClient.quit()`.
       - Imprime un mensaje de cierre y termina el proceso.
     - **Manejadores de Señales y Excepciones**:
       - `process.on('SIGINT', ...)` y `process.on('SIGTERM', ...)`: Registran la función `shutdown` para estas señales, permitiendo un cierre limpio.
       - `process.on('uncaughtException', ...)`: Captura excepciones no manejadas en ninguna otra parte del código. Registra el error y termina el proceso para evitar un estado inconsistente.
       - `process.on('unhandledRejection', ...)`: Captura rechazos de promesas no manejados. Registra el error y la razón, y termina el proceso.
     - **Ejecución de `main()`**: La función `main()` se llama al final del script para iniciar la aplicación.

### 4. `src/configLoader.js`
   - **Propósito**: Este módulo es responsable de cargar el archivo de configuración de estados (`config/states.json`), parsearlo de JSON a un objeto JavaScript, realizar validaciones básicas sobre su estructura y mantenerlo disponible para el resto de la aplicación (principalmente para el motor FSM). Utiliza un patrón singleton simple para asegurar que el archivo solo se lea y parse una vez.
   - **Constantes**:
     - `STATE_CONFIG_PATH`: Construye la ruta absoluta al archivo `config/states.json`.
     - `stateConfiguration`: Variable (inicialmente `null`) que almacena la configuración parseada para evitar lecturas repetidas del archivo.
   - **Funciones Exportadas**:
     - `loadStateConfig()`:
       - Si `stateConfiguration` ya tiene datos, los devuelve inmediatamente.
       - Verifica si `STATE_CONFIG_PATH` existe. Si no, lanza un error.
       - Lee el contenido del archivo, lo parsea con `JSON.parse()`.
       - **Validaciones**:
         - Asegura que `initialState` exista y sea un string.
         - Asegura que `states` exista, sea un objeto y no esté vacío.
         - Asegura que el `initialState` definido exista como una clave dentro del objeto `states`.
         - Itera sobre cada estado definido en `states`:
           - Si un estado tiene `payloadResponse`, valida que sea un objeto.
           - Emite advertencias (`console.warn`) si encuentra los campos obsoletos `apiHooks` (fuera de `payloadResponse`) o `apisToCall` en la definición de un estado, indicando que serán ignorados.
       - Si todo es correcto, almacena la configuración parseada en `stateConfiguration` y la devuelve.
       - Si ocurre algún error durante la lectura, parseo o validación, lo registra en consola y lo relanza, lo que típicamente detendrá la aplicación si ocurre durante el inicio (manejado en `src/index.js`).
     - `getStateById(stateId)`:
       - Llama a `loadStateConfig()` (asegurando que la configuración esté cargada).
       - Devuelve el objeto de configuración para el `stateId` específico, o `undefined` si no se encuentra.
     - `getInitialStateId()`:
       - Llama a `loadStateConfig()`.
       - Devuelve el valor de `initialState` de la configuración.

### 5. `src/redisClient.js`
   - **Propósito**: Este módulo encapsula toda la lógica de interacción con el servidor Redis. Proporciona una interfaz simplificada para conectar, obtener, establecer y eliminar datos, además de manejar la configuración de la conexión y los eventos del cliente Redis. Su objetivo es abstraer los detalles de la librería `ioredis` del resto de la aplicación.
   - **Configuración**:
     - Lee las variables de entorno para la conexión a Redis:
       - `REDIS_HOST` (defecto: `'127.0.0.1'`)
       - `REDIS_PORT` (defecto: `6379`)
       - `REDIS_PASSWORD` (opcional)
       - `REDIS_DB` (opcional, defecto: `0`)
     - Mantiene una única instancia del cliente `ioredis` (`client`) y una promesa de conexión (`connectionPromise`) para gestionar el estado de la conexión.
   - **Funciones Exportadas**:
     - `connect()`:
       - Establece la conexión con el servidor Redis si aún no existe un cliente.
       - Configura manejadores de eventos para `connect`, `error`, `close`, y `reconnecting` para registrar el estado de la conexión y manejar errores básicos.
       - Devuelve una promesa que se resuelve cuando la conexión está lista o se rechaza si hay un error inicial.
       - `ioredis` maneja internamente una cola de comandos, por lo que las operaciones pueden ser llamadas incluso antes de que el evento `connect` se dispare, pero esta función provee una forma de asegurar la conexión inicial.
     - `get(key)`: (async)
       - Obtiene el valor asociado a una `key` de Redis.
       - Si el cliente no está conectado, intenta conectar llamando a `connect()` internamente (como fallback).
       - Devuelve el valor (string o `null` si la clave no existe).
     - `set(key, value, mode, duration)`: (async)
       - Establece un `value` (string) para una `key` en Redis.
       - Si el cliente no está conectado, intenta conectar.
       - Opcionalmente, puede tomar `mode` (ej: `'EX'` para expiración en segundos) y `duration` (el tiempo para la expiración). Esto es utilizado por `src/fsm.js` para el TTL de las sesiones.
       - Devuelve la respuesta del comando SET de Redis (generalmente `'OK'`).
     - `del(key)`: (async)
       - Elimina una `key` (y su valor asociado) de Redis.
       - Si el cliente no está conectado, intenta conectar.
       - Devuelve el número de claves eliminadas.
     - `quit()`: (async)
       - Cierra la conexión con el servidor Redis de forma ordenada.
       - Resetea las variables `client` y `connectionPromise`.
       - Importante para liberar recursos al apagar la aplicación.
     - `getClient()`:
       - Devuelve la instancia cruda del cliente `ioredis`. Esto podría ser útil para funcionalidades más avanzadas de Redis no cubiertas por las funciones de utilidad (ej: Pub/Sub, transacciones complejas), aunque actualmente no se usa directamente fuera de este módulo.

### 6. `src/fsm.js`
   - **Propósito**: Este archivo contiene la lógica central y el motor de la Máquina de Estados Finitos (FSM). Es responsable de gestionar el ciclo de vida de las sesiones de conversación, procesar las entradas del usuario (o del sistema), determinar las transiciones de estado basadas en la configuración (`config/states.json`), y persistir el estado de la sesión en Redis.
   - **Dependencias**:
     - `src/configLoader`: Para obtener las definiciones de los estados.
     - `src/redisClient`: Para guardar y recuperar datos de la sesión.
   - **Constantes**:
     - `FSM_SESSION_PREFIX`: (`'fsm_session:'`) Prefijo utilizado para las claves de sesión en Redis, ayudando a organizar los datos.
   - **Funciones Exportadas**:
     - `initializeOrRestoreSession(sessionId)`: (async function)
       - **Propósito**: Inicializa una nueva sesión de FSM para un `sessionId` dado o restaura una sesión existente desde Redis.
       - **Lógica**:
         1. Construye la `sessionKey` para Redis usando `FSM_SESSION_PREFIX` y el `sessionId`.
         2. Intenta obtener datos de sesión de Redis usando `redisClient.get(sessionKey)`.
         3. Si se encuentran datos:
            - Parsea la cadena JSON (obtenida de Redis) a un objeto de sesión.
            - Devuelve el objeto de sesión restaurado.
         4. Si no se encuentran datos (nueva sesión):
            - Obtiene el `initialStateId` desde `configLoader.getInitialStateId()`.
            - Crea un objeto `initialSession` con:
              - `currentStateId`: El `initialStateId`.
              - `parameters`: Un objeto vacío `{}` para los parámetros recolectados.
              - `history`: Un array con el `initialStateId` como primer elemento.
            - Lee la variable de entorno `REDIS_SESSION_TTL`.
            - Guarda `initialSession` en Redis (serializada como JSON) usando `redisClient.set()`.
              - Si `REDIS_SESSION_TTL` es un entero positivo, se usa como TTL (expiración en segundos) para la clave en Redis.
              - Registra en consola si la sesión se guardó con o sin TTL.
            - Devuelve el objeto `initialSession`.
     - `processInput(sessionId, intent, inputParameters)`: (async function)
       - **Propósito**: Es la función principal que procesa una interacción para una sesión FSM dada. Determina el siguiente estado, qué parámetros necesitan ser recolectados, y qué `payloadResponse` debe ser devuelto.
       - **Parámetros**:
         - `sessionId`: (string) El ID de la sesión actual.
         - `intent`: (string, opcional) La intención detectada del usuario o sistema.
         - `inputParameters`: (object, opcional) Un objeto con los parámetros recolectados en la interacción actual.
       - **Lógica Detallada**:
         1. Llama a `initializeOrRestoreSession(sessionId)` para obtener los datos de la sesión actual (o inicializar una nueva).
         2. **Manejo de Intención por Defecto**: Si la `intent` de entrada es "falsy" (undefined, null, vacía) y la variable de entorno `process.env.DEFAULT_INTENT` está definida, se utiliza el valor de `DEFAULT_INTENT` como `effectiveIntent`. Se registra un mensaje si esto ocurre.
         3. Fusiona `inputParameters` (de la solicitud actual) con `sessionData.parameters` (los parámetros ya acumulados en la sesión). Los nuevos parámetros tienen precedencia. El resultado se almacena en `currentParameters` (este objeto `currentParameters` es el que se pasará al `templateProcessor`).
         4. Obtiene la configuración del estado actual (`currentStateConfig`) usando `getStateById(sessionData.currentStateId)`. Si no se encuentra, lanza un error.
         5. **Evaluación de Transiciones** (para determinar `nextStateId`, usando `effectiveIntent`):
            - Inicializa `nextStateId = null` y `matchedTransition = false`.
            - **Prioridad 1: Transiciones por Intención**: Usa `effectiveIntent` para buscar una transición coincidente.
            - **Prioridad 2: Transiciones por Parámetros Completos**: Si no hay transición por intención, y una transición no especifica `intent`, se evalúa si los parámetros requeridos están completos.
            - **Prioridad 3: `defaultNextState`**: Si no hay transiciones específicas y los parámetros requeridos están completos.
            - **Sin Cambio de Estado**: Si no se encuentra `nextStateId`.
         6. **Log de Transición**: Si `currentStateId !== nextStateId`, se registra un mensaje `FSM Info` indicando la transición.
         7. **Actualización de Sesión en Redis**: Actualiza `sessionData` (estado, parámetros, historial) y la guarda en Redis con el TTL configurado.
         8. Obtiene la configuración del nuevo estado (`nextStateConfig`).
         9. **Determinación de `parametersToCollect`** para el `nextStateConfig` basado en `currentParameters`.
         10. **Procesamiento del `payloadResponse`**: Usa `templateProcessor.js` con `nextStateConfig.payloadResponse` y `currentParameters`.
         11. **Construción de la Respuesta**: Devuelve el objeto con `nextStateId`, `parametersToCollect`, `payloadResponse` (procesado), y `sessionData` (con todos los parámetros fusionados).
            - **Prioridad 1: Transiciones por Intención**: Si se proporcionó una `intent` y el `currentStateConfig` tiene `transitions`, itera sobre ellas. Si una transición tiene una `condition.intent` que coincide con la `intent` de entrada, se usa el `nextState` de esa transición y `matchedTransition` se pone a `true`.
            - **Prioridad 2: Transiciones por Parámetros Completos**: Si no hubo coincidencia por intención (`!matchedTransition`) y hay `transitions`, itera sobre ellas. Para cada transición:
              - Si `transition.condition.allParametersMet` es `true` (o no está definida, asumiéndose `true`), verifica si todos los parámetros en `currentStateConfig.parameters.required` existen en `currentParameters` (y no son nulos/vacíos). Si es así, se usa el `nextState` de esa transición y `matchedTransition` se pone a `true`.
              - También maneja el caso `allParametersMet: false` sin `intent` (transición incondicional si no es por parámetros).
            - **Prioridad 3: `defaultNextState`**: Si no hubo coincidencia por las transiciones anteriores (`!matchedTransition`) y el `currentStateConfig` tiene un `defaultNextState`, verifica si todos los `currentStateConfig.parameters.required` están en `currentParameters`. Si es así, se usa `defaultNextState`.
            - **Sin Cambio de Estado**: Si `nextStateId` sigue siendo `null`, se establece al `currentStateId` (la FSM permanece en el mismo estado).
         5. **Actualización de Sesión en Redis**:
            - Actualiza `sessionData.currentStateId` al `nextStateId` determinado.
            - Actualiza `sessionData.parameters` con la fusión completa de `currentParameters`.
            - Si hubo un cambio de estado (`nextStateId !== currentStateId`), añade `nextStateId` al `sessionData.history`.
            - Lee `REDIS_SESSION_TTL` y guarda `sessionData` (serializada como JSON) en Redis usando `redisClient.set()`, aplicando el TTL si es válido y positivo. Registra si se usó TTL.
         6. Obtiene la configuración del nuevo estado (`nextStateConfig`) usando `getStateById(nextStateId)`. Si no se encuentra, lanza un error.
         7. **Determinación de `parametersToCollect`**:
            - Obtiene los `parameters.required` y `parameters.optional` del `nextStateConfig`.
            - Filtra estos para incluir solo aquellos que *no* están presentes en `currentParameters` (o son nulos/vacíos). El resultado es un objeto `{ required: [...], optional: [...] }`.
         8. **Procesamiento del `payloadResponse`**:
            - Si `nextStateConfig.payloadResponse` existe, se llama a `processTemplate(nextStateConfig.payloadResponse, currentParameters)` (del módulo `templateProcessor`) para realizar la sustitución de placeholders y la ejecución de funciones predefinidas.
            - El resultado es `renderedPayloadResponse`. Se manejan errores durante este procesamiento, devolviendo el payload original en caso de fallo del templating.
         9. **Construción de la Respuesta**:
            - Devuelve un objeto con:
              - `nextStateId`: El ID del estado al que se ha transitado.
              - `currentStateConfig`: La configuración del estado desde el que se partió.
              - `nextStateConfig`: La configuración del estado al que se llegó.
              - `parametersToCollect`: El objeto calculado en el paso anterior.
              - `payloadResponse`: El `renderedPayloadResponse` (el payload procesado).
              - `sessionData`: El objeto completo de la sesión actualizada, que incluye `currentStateId`, el historial y, crucialmente, `parameters` (que contiene la fusión de todos los parámetros recolectados).

### 7. `src/templateProcessor.js`
   - **Propósito**: Este módulo es responsable de procesar strings de plantillas, reemplazando placeholders con valores de parámetros, valores de fecha/hora actuales, y ejecutando un conjunto de funciones de transformación predefinidas y seguras.
   - **Funciones Clave**:
     - `resolveArgument(arg, parameters)`: Función interna que determina si un argumento para una función de plantilla es un literal o una referencia a un parámetro en `parameters`.
     - `PREDEFINED_FUNCTIONS`: Objeto que mapea nombres de funciones (ej: `default`, `toUpperCase`, `toLowerCase`, `capitalize`, `formatNumber`, `add`, `subtract`) a sus implementaciones. Estas funciones operan sobre los argumentos resueltos.
     - `renderString(text, parameters)`:
       - Procesa un único string.
       - Realiza sustituciones en orden: primero fecha/hora (`{{current_date}}`, etc.), luego funciones (`{{funcName(arg1, ...)}}`), y finalmente placeholders de parámetros (`{{paramName}}`).
       - El parser de funciones es básico y utiliza expresiones regulares para extraer el nombre de la función y sus argumentos.
       - Maneja errores durante la ejecución de funciones predefinidas, devolviendo un string de error.
     - `processTemplate(template, parameters)`: (Exportada)
       - Función principal que maneja recursivamente la estructura de la plantilla.
       - Si la plantilla es un string, llama a `renderString`.
       - Si es un array, aplica `processTemplate` a cada elemento.
       - Si es un objeto, aplica `processTemplate` a cada valor de propiedad.
       - Devuelve la estructura de la plantilla con todos los strings procesados.
   - **Sintaxis Soportada**:
     - Placeholders de parámetros: `{{paramName}}` (resuelve a `parameters[paramName]`, o `''` si no existe).
     - Placeholders de fecha/hora: `{{current_date}}`, `{{current_time}}`, `{{current_datetime}}`.
     - Funciones predefinidas: `{{funcName(arg1, 'literal', 123, true, paramRef)}}`.

### 8. `src/socketServer.js`
   - **Propósito**: Este módulo implementa un servidor de sockets de dominio UNIX (UNIX Domain Socket) para permitir la comunicación con la FSM desde otros procesos que se ejecutan en la misma máquina. Ofrece una alternativa de comunicación de baja latencia a la API HTTP para casos de uso locales.
   - **Dependencias**:
     - `net`: Módulo incorporado de Node.js para la creación de servidores y clientes de red (incluyendo sockets UNIX).
     - `fs`: Módulo incorporado de Node.js para interactuar con el sistema de archivos (usado para eliminar el archivo de socket).
   - **Variables Globales del Módulo**:
     - `server`: Almacena la instancia del servidor `net.Server`.
   - **Funciones Exportadas**:
     - `startSocketServer(socketPath, fsmProcessInputCallback)`:
       - **Propósito**: Crea, configura e inicia el servidor de sockets UNIX.
       - **Parámetros**:
         - `socketPath`: (string) La ruta del sistema de archivos donde se creará el socket (ej: `/tmp/fsm.sock`).
         - `fsmProcessInputCallback`: (function) Una referencia a la función `fsm.processInput` que será llamada para procesar los datos recibidos.
       - **Lógica**:
         1. Verifica si `socketPath` está definido; si no, registra un error y no inicia.
         2. **Limpieza del Socket Antiguo**: Si ya existe un archivo en `socketPath`, intenta eliminarlo usando `fs.unlinkSync()` para prevenir errores `EADDRINUSE`.
         3. **Creación del Servidor**: Crea una instancia de `net.createServer()`. El callback de creación recibe un objeto `socket` por cada cliente que se conecta.
         4. **Manejo de Conexión de Cliente (`socket`)**:
            - `socket.on('data', async (data) => ...)`:
              - Cuando se reciben datos, los convierte a string.
              - Intenta parsear la cadena como JSON. Se espera que el cliente envíe un objeto JSON con `sessionId`, `intent` (opcional), y `parameters` (opcional).
              - **Logging (Diferido)**: Registra el JSON de solicitud parseado en formato "pretty print" usando `process.nextTick()` para no bloquear.
              - Valida que `request.sessionId` exista.
              - Llama a `fsmProcessInputCallback` (que es `fsm.processInput`) con los datos de la solicitud.
              - Serializa la respuesta de la FSM a JSON y la escribe de vuelta al socket (`socket.write(JSON.stringify(response) + '\\n')`). Se añade un newline como delimitador simple de mensajes. La respuesta se envía inmediatamente.
              - **Logging (Diferido)**: Registra la respuesta JSON de la FSM (después de enviarla) en formato "pretty print" usando `process.nextTick()`.
              - **Manejo de Errores (por mensaje)**: Si hay un error al parsear o procesar, construye una respuesta JSON de error, la envía al cliente, y luego la registra en "pretty print" de forma diferida.
            - `socket.on('end', () => ...)`: Registra cuando un cliente se desconecta.
            - `socket.on('error', (err) => ...)`: Registra errores específicos del socket de un cliente (evitando loguear `ECONNRESET` que son comunes).
         5. **Manejo de Errores del Servidor (`server.on('error', ...)`**: Registra errores del propio objeto servidor (ej: `EADDRINUSE`).
         6. **Inicio de Escucha (`server.listen(socketPath, ...)`**: El servidor comienza a escuchar en la ruta del socket especificada.
         7. **Limpieza en Salida (`process.on('exit', ...)`**: Registra un manejador para el evento `exit` del proceso para intentar llamar a `stopSocketServer` como un fallback (la limpieza principal la maneja `index.js`).
     - `stopSocketServer(socketPath)`: (devuelve Promise)
       - **Propósito**: Cierra ordenadamente el servidor de sockets y elimina el archivo de socket del sistema de archivos.
       - **Lógica**:
         1. Si el `server` existe, llama a `server.close()`.
         2. En el callback de `server.close()`, o si el servidor no estaba definido pero `socketPath` sí, intenta eliminar el archivo de socket de `socketPath` usando `fs.unlinkSync()`.
         3. Resetea la variable `server` a `null`.
         4. Devuelve una promesa que se resuelve cuando el proceso de cierre ha terminado.

### 8. `src/apiServer.js`
    - **Propósito**: Este módulo es responsable de exponer la funcionalidad de la FSM a través de una API RESTful utilizando el framework Express. Permite que aplicaciones externas interactúen con la FSM enviando solicitudes HTTP con formato JSON.
    - **Dependencias**:
     - `express`: Para la creación del servidor y manejo de rutas.
     - `src/fsm`: Para acceder a la lógica de procesamiento de la FSM.
     - `src/configLoader`: Para cargar la configuración de estados al inicio (aunque `fsm.js` también lo hace, es una buena práctica asegurar la carga temprana).
   - **Configuración**:
     - Utiliza `express.json()` como middleware para parsear automáticamente los cuerpos de las solicitudes JSON.
     - Lee la variable de entorno `PORT` para determinar en qué puerto escuchar (defecto: `3000`).
   - **Funciones y Endpoints**:
     - `startApiServer()`:
       - **Propósito**: Inicia el servidor API Express.
       - **Lógica**:
         1. Llama a `loadStateConfig()` para asegurar que la configuración de la FSM esté cargada y validada antes de que el servidor empiece a aceptar solicitudes. Si la carga falla, la aplicación termina (manejado por `loadStateConfig` y `index.js`).
         2. Llama a `app.listen(PORT, ...)` para que el servidor Express comience a escuchar en el puerto configurado.
         3. Registra un mensaje en consola indicando que el servidor está escuchando.
     - `POST /fsm/:sessionId`:
       - **Propósito**: Es el endpoint principal para interactuar con la FSM.
       - **Parámetros de URL**: `:sessionId` - El identificador único de la sesión de conversación.
       - **Cuerpo de la Solicitud (JSON)**: Espera un objeto con `intent` (opcional) y `parameters` (opcional, objeto).
       - **Lógica**:
         1. Extrae `sessionId` de `req.params` y `intent`, `parameters` de `req.body`.
         2. **Logging (Diferido)**: Registra la URL de la solicitud y el cuerpo JSON de entrada (`req.body`) en formato "pretty print" usando `process.nextTick()` para no bloquear la respuesta.
         3. Valida que `sessionId` esté presente; si no, responde con un error 400.
         4. Llama a `fsm.processInput(sessionId, intent, parameters)` para que el motor FSM procese la solicitud.
         5. Construye un `responseObject` con los datos devueltos por `fsm.processInput()`.
         6. Envía `responseObject` al cliente inmediatamente.
         7. **Logging (Diferido)**: Registra el `responseObject` (JSON de salida) en formato "pretty print" usando `process.nextTick()`.
         8. **Manejo de Errores**:
            - Captura errores de `fsm.processInput()`.
            - Si el error es por configuración no encontrada o estado no existente, responde con un 404.
            - Si el error es por Redis no conectado, responde con un 503.
            - Para otros errores, responde con un 500.
            - Registra el error en la consola del servidor.
     - `GET /health`:
       - **Propósito**: Un endpoint simple de health check para verificar que el servidor API está funcionando.
       - **Respuesta**: Devuelve un JSON con `status: 'UP'` y un timestamp.
   - **Exportaciones**: Exporta `startApiServer` (para ser usada por `index.js`) y `app` (la instancia de Express, útil para pruebas).

### 8. `src/ariClient.js`
   - **Propósito**: Este módulo maneja la integración con Asterisk a través de la Asterisk REST Interface (ARI). Permite que la FSM controle el flujo de llamadas telefónicas, respondiendo a eventos de Asterisk y ejecutando acciones sobre los canales de llamada.
   - **Dependencias**:
     - `ari-client`: La librería cliente para ARI.
     - `src/fsm`: Para interactuar con el motor FSM.
     - `src/configLoader`: Para asegurar la carga de configuración.
   - **Configuración**:
     - Lee variables de entorno para la conexión ARI:
       - `ARI_APP_NAME` (defecto: `'fsm-ari-app'`)
       - `ARI_USERNAME` (defecto: `'ariuser'`)
       - `ARI_PASSWORD` (defecto: `'aripass'`)
       - `ARI_URL` (defecto: `'http://localhost:8088'`)
     - Mantiene una instancia del cliente ARI (`ariClient`).
   - **Funciones Principales**:
     - `connectAri()`: (async function)
       - **Propósito**: Establece la conexión con el servidor ARI y registra la aplicación Stasis.
       - **Lógica**:
         1. Si ya existe un `ariClient`, lo devuelve.
         2. Llama a `loadStateConfig()`.
         3. Llama a `Ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD)` para conectar.
         4. Registra manejadores de eventos del cliente ARI:
            - `StasisStart`: Llama a `handleStasisStart` cuando una nueva llamada entra a la aplicación Stasis.
            - `StasisEnd`: Llama a `handleStasisEnd` cuando una llamada en la aplicación Stasis termina.
            - `error`: Maneja errores de conexión o runtime, intenta reconectar tras un delay.
            - `close`: Maneja el cierre de la conexión.
         5. Llama a `ariClient.start(ARI_APP_NAME)` para registrar la aplicación en Asterisk y empezar a recibir eventos para esa aplicación.
         6. Maneja errores durante la conexión inicial, con reintentos.
     - `handleStasisStart(event, channel)`: (async function)
       - **Propósito**: Maneja el inicio de una llamada en la aplicación Stasis. Es el punto de entrada para la lógica FSM en el contexto de una llamada.
       - **Lógica**:
         1. Usa `channel.id` como `sessionId` para la FSM.
         2. Llama a `fsm.processInput(sessionId, null, {})` para obtener el estado inicial/actual de la FSM para esta llamada.
         3. Responde el canal (`channel.answer()`).
         4. **Procesa `currentFsmState.payloadResponse`**:
            - Registra el `payloadResponse` completo en la consola.
            - Incluye ejemplos comentados de cómo se podrían extraer y usar datos específicos del `payloadResponse` (ej: `apiHooks.onEnterState` para setear variables de canal, o `prompts.main` para reproducir un audio). La interpretación y acción sobre `payloadResponse` es específica de la aplicación IVR.
         5. **Procesa `currentFsmState.parametersToCollect`**:
            - Si hay parámetros requeridos, registra un ejemplo de cómo se podría reproducir un prompt para el primer parámetro.
            - Si no hay parámetros que recolectar, podría reproducir un mensaje informativo basado en la descripción del estado.
         6. **Nota Importante**: Destaca que esta función es un esqueleto y que se necesitarían más manejadores (ej: para DTMF) para una interacción completa, los cuales a su vez llamarían a `fsm.processInput` con los datos recolectados.
         7. Maneja errores y intenta colgar la llamada si ocurre un problema grave.
     - `handleStasisEnd(event, channel)`: (async function)
       - **Propósito**: Maneja el evento de finalización de una llamada en Stasis.
       - **Lógica**: Registra que la llamada ha finalizado. Podría incluir lógica de limpieza de sesión si fuera necesario.
     - `closeAri()`: (async function)
       - **Propósito**: Cierra la conexión con el servidor ARI de forma ordenada.
       - **Lógica**: Llama a `ariClient.close()` si el cliente existe.
   - **Exportaciones**: Exporta `connectAri` y `closeAri`.

---
*Fin del documento.*
