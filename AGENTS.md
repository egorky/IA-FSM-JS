# Instrucciones para Agentes AI sobre el Proyecto FSM Node.js

Este documento proporciona una guía para trabajar con el proyecto de Máquina de Estados Finitos (FSM) desarrollada en Node.js.

## Estructura del Proyecto

El proyecto está organizado de la siguiente manera:

-   `package.json`: Define las dependencias del proyecto y los scripts principales.
    -   **Importante**: Las dependencias listadas (`express`, `ioredis`, `ari-client`, `dotenv`, `isolated-vm`) **no se instalan automáticamente** como parte de las tareas de este agente. Se asume que estarán disponibles en el entorno de ejecución final.
-   `config/`: Contiene los archivos de configuración.
    -   `states.json`: Define la estructura de la máquina de estados. Cada estado incluye:
        -   `id`, `description`.
        -   `parameters`: Con `required` y `optional`.
        -   `payloadResponse`: Un objeto de formato libre. Los strings dentro de este objeto son procesados por `src/templateProcessor.js` para sustituir placeholders (`{{param}}`, `{{current_date}}`), ejecutar funciones predefinidas (ej: `{{toUpperCase(param)}}`), y **opcionalmente ejecutar JavaScript en sandbox (`{{sandbox_js: ... }}`)** antes de ser devueltos por la FSM.
        -   `transitions`: Para definir los siguientes estados basados en condiciones.
        -   `defaultNextState`.
-   `src/`: Contiene el código fuente de la aplicación.
    -   `index.js`: Punto de entrada. Carga `dotenv`, inicializa módulos (incluyendo intento de carga de `isolated-vm`).
    -   `configLoader.js`: Carga y valida `states.json`.
    -   `fsm.js`: Lógica central de la FSM. Procesa el `payloadResponse` usando `templateProcessor.js`.
    -   `redisClient.js`: Cliente Redis.
    -   `apiServer.js`: Servidor API Express.
    -   `ariClient.js`: Cliente Asterisk ARI.
    -   `templateProcessor.js`: **Módulo clave** responsable de procesar strings en `payloadResponse` (placeholders, funciones predefinidas, y opcionalmente `sandbox_js` con `isolated-vm` si está cargado).

## Flujo General de la Aplicación

1.  **Inicio (`src/index.js`)**: Similar a antes, con la advertencia de que `isolated-vm` podría no cargarse si hay problemas de compilación o instalación.

2.  **Interacción (Modo API / Socket / ARI)**:
    *   La solicitud llega a `fsm.js`.
    *   `fsm.js` determina el `nextStateId` y obtiene el `payloadResponse` crudo del `config/states.json`.
    *   **Paso de Procesamiento**: `fsm.js` pasa el `payloadResponse` crudo y los `collectedParameters` a `templateProcessor.js`.
    *   `templateProcessor.js` procesa el `payloadResponse`:
        *   Sustituye `{{current_date}}`, `{{current_time}}`, `{{current_datetime}}`.
        *   Si `isolated-vm` está disponible, ejecuta cualquier código en `{{sandbox_js: ... }}`.
        *   Ejecuta funciones predefinidas `{{funcName(...)}}`.
        *   Sustituye placeholders de parámetros `{{paramName}}`.
    *   `fsm.js` devuelve el `payloadResponse` ya procesado/renderizado.
    *   `apiServer.js` (o `socketServer.js` o `ariClient.js`) envía esta respuesta procesada al cliente.

## Consideraciones para el Desarrollo

*   **Procesamiento de Plantillas (`payloadResponse`)**:
    *   Los strings dentro de `payloadResponse` en `config/states.json` ahora son dinámicos.
    *   **Sintaxis Soportada**:
        *   Parámetros: `{{paramName}}`.
        *   Fecha/Hora: `{{current_date}}`, `{{current_time}}`, `{{current_datetime}}`.
        *   Funciones Predefinidas: `{{funcName(arg1, 'literal', ...)}}`. Ver `PREDEFINED_FUNCTIONS` en `templateProcessor.js` para la lista actual.
        *   JavaScript en Sandbox: `{{sandbox_js: /* código JS */ }}`. Este código tiene acceso a una variable `collectedParameters`. Solo funciona si `isolated-vm` está cargado.
    *   **Orden de Procesamiento**: Fecha/Hora -> `sandbox_js` -> Funciones Predefinidas -> Parámetros Simples.
    *   Este procesamiento ocurre dentro de `fsm.js` vía `templateProcessor.js`. El cliente recibe el `payloadResponse` ya renderizado.
*   **JavaScript en Sandbox (`isolated-vm`)**:
    *   La dependencia `isolated-vm` se ha añadido a `package.json`. Recuerda que este agente no la instalará.
    *   `templateProcessor.js` intenta cargar `isolated-vm`. Si falla, la funcionalidad `{{sandbox_js:...}}` se deshabilita y se emite una advertencia.
    *   El código en `sandbox_js` se ejecuta con límites de memoria y tiempo.
    *   Considera la seguridad y el rendimiento al usar esta característica.
*   **Parámetros Acumulados**: Se mantiene igual: `collectedParameters` siempre contiene la fusión completa.
*   **No Instalar Dependencias**: Se mantiene (excepto `dotenv` e `isolated-vm` que ahora están registradas).
*   **Pruebas**: Se mantiene.
*   **Variables de Entorno**:
    *   El proyecto ahora utiliza la librería `dotenv` para cargar automáticamente las variables de entorno desde un archivo `.env` ubicado en la raíz del proyecto.
    *   Se proporciona un archivo `.env.example` como plantilla. Los desarrolladores deben copiar este archivo a `.env` y ajustar los valores para su entorno local. `dotenv` ha sido añadido como una dependencia en `package.json`.
    *   Variables clave incluyen `ENABLE_API`, `ENABLE_ARI`, `ENABLE_SOCKET_SERVER`, `FSM_SOCKET_PATH`, `REDIS_SESSION_TTL`, y `DEFAULT_INTENT`.
    *   Otras variables configuran la conexión a Redis (`REDIS_HOST`, `REDIS_PORT`, etc.) y Asterisk ARI (`ARI_URL`, `ARI_APP_NAME`, etc.).
    *   Consulta `.env.example` para la lista completa. `src/index.js` carga estas variables al inicio.
*   **Intención por Defecto**: Si no se provee una `intent` en la solicitud a la FSM y la variable de entorno `DEFAULT_INTENT` está configurada, la FSM usará ese valor como la intención para la evaluación de transiciones.
*   **Interfaces de Comunicación**: La FSM puede ser contactada vía API HTTP, socket UNIX (si está habilitado y configurado), o indirectamente a través de ARI.
*   **Manejo de Sesiones**: Las sesiones de la FSM se identifican por un `sessionId` y se persisten en Redis, con un TTL configurable mediante `REDIS_SESSION_TTL`. El `sessionId` es proporcionado en la URL para la API, como parte del mensaje JSON para sockets, y es el ID del canal para ARI.
*   **Documentación Detallada del Código**: Para una comprensión profunda de cada módulo, incluyendo `src/socketServer.js`, consulta [docs/CodebaseOverview.md](docs/CodebaseOverview.md).

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
