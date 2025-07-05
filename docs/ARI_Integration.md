# Integración con Asterisk ARI (Asterisk REST Interface)

Este documento describe las variables de entrada y salida esperadas para la integración entre la aplicación FSM/IA y un cliente Asterisk ARI (`ariClient.js`).

## Flujo General

1.  Una llamada llega a Asterisk y es dirigida a una aplicación Stasis controlada por `ariClient.js`.
2.  `ariClient.js` maneja los eventos de la llamada (ej. inicio de llamada, entrada de DTMF, fin de la grabación de voz).
3.  Cuando se requiere lógica de negocio o procesamiento de la entrada del usuario, `ariClient.js` invoca a la aplicación FSM/IA (probablemente a través de una función en `src/index.js`).
4.  La aplicación FSM/IA procesa la entrada, actualiza su estado, y devuelve una estructura de respuesta.
5.  `ariClient.js` interpreta esta respuesta para ejecutar acciones en Asterisk (reproducir audio, esperar nueva entrada, transferir la llamada, colgar, etc.).

## Variables de Entrada (Desde ARI hacia la Aplicación FSM/IA)

Estas son las variables que `ariClient.js` debe proporcionar al llamar a la lógica FSM/IA.

| Variable                | Tipo      | Obligatoria | Descripción                                                                                                | Ejemplo                                   |
| ----------------------- | --------- | ----------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `sessionId`             | `String`  | Sí          | Identificador único de la sesión FSM, usualmente el `channelId` de Asterisk o un UUID asociado a la llamada. | `"asterisk-163948392.123"`                |
| `userInputText`         | `String`  | Condicional | Texto transcrito de la voz del usuario (del ASR). Obligatorio a menos que sea el inicio de la llamada o solo DTMF. | `"Quiero agendar una cita."`              |
| `initialCall`           | `Boolean` | No          | `true` si es la primera interacción de la FSM para esta sesión. Default: `false`.                           | `true`                                    |
| `dtmfInput`             | `String`  | No          | Dígitos DTMF ingresados por el usuario.                                                                    | `"1234#"`                                 |
| `callerIdNumber`        | `String`  | No          | Número de identificación del llamante (ANI).                                                               | `"5551234567"`                            |
| `callerIdName`          | `String`  | No          | Nombre asociado al número del llamante.                                                                    | `"John Doe"`                              |
| `channelLanguage`       | `String`  | No          | Idioma de la llamada (ej. "es-MX"). Default al configurado en la app.                                      | `"es-MX"`                                 |
| `waitForCorrelationId`  | `String`  | No          | ID de correlación si ARI espera una respuesta de API asíncrona específica.                                 | `"corr789xyz"`                            |

## Variables de Salida (Desde la Aplicación FSM/IA hacia ARI)

La aplicación FSM/IA devuelve un objeto. La parte más relevante para ARI es el campo `payloadResponse`, que es el `renderedPayloadResponse` del estado final de la FSM para el turno actual.

**Objeto Principal de Respuesta de la FSM:**
```javascript
// Estructura devuelta por fsm.processInput()
// {
//   nextStateId: "estado_actual_o_siguiente",
//   currentStateConfig: { ...config del estado al inicio del ciclo... },
//   nextStateConfig: { ...config del estado al final del ciclo... },
//   parametersToCollect: { required: [], optional: [] },
//   payloadResponse: { /* Ver detalles abajo */ },
//   sessionData: { ...datos completos de la sesión... },
// }
```

**Detalle de `payloadResponse` para ARI:**

| Campo en `payloadResponse` | Tipo     | Descripción                                                                                                                               | Ejemplo de Acción ARI                                                                                                |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `prompts.main`             | `String` | Texto principal a ser reproducido al usuario (TTS).                                                                                       | `Playback` (después de TTS) / `Say`.                                                                                 |
| `prompts.reprompt`         | `String` | (Opcional) Prompt alternativo para reintentos por no entrada.                                                                             | Usar en segundo intento de `Playback/Say`.                                                                           |
| `prompts.error`            | `String` | (Opcional) Prompt para errores de no coincidencia o fallos.                                                                               | `Playback/Say` en caso de error.                                                                                     |
| `uiHints`                  | `Object` | (Opcional) Pistas para la recolección de entrada: `inputType` ("voice"/"dtmf"), `dtmfMaxDigits`, `dtmfTermChar`, `voiceTimeoutMs`, etc.     | Configurar operación de lectura de Asterisk (`Record` con ASR, `Read` para DTMF).                                      |
| `transferTo`               | `String` o `Object` | (Opcional) Especifica si se debe transferir la llamada y a dónde.                                                                         | Ejecutar transferencia (`Bridge`, `Originate`+`Bridge`).                                                             |
| `hangup`                   | `Boolean`| (Opcional) `true` si la llamada debe terminarse. Default `false`.                                                                         | `Hangup` el canal.                                                                                                   |
| `collectInput`             | `Boolean`| (Opcional) `true` si se debe esperar nueva entrada del usuario. Default `true` (a menos que `hangup` o `transferTo` estén presentes).     | Determina si se activa la recolección de entrada (voz/DTMF).                                                         |
| `variablesToSet`           | `Object` | (Opcional) Pares clave-valor de variables de canal de Asterisk a establecer.                                                              | Iterar y establecer cada variable en el canal.                                                                       |

**Otros campos del objeto principal de respuesta FSM (informativos para ARI):**

*   **`nextStateId` (String)**: ID del estado actual de la FSM. Útil para logging/debugging en ARI.
*   **`parametersToCollect` (Object)**: `{ required: [], optional: [] }`. Parámetros que la FSM espera. Útil para logging o configuración avanzada de ASR.

Esta documentación debería ayudar a clarificar la interfaz entre `ariClient.js` y el núcleo de la aplicación FSM/IA.
