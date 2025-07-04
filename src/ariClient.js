const Ari = require('ari-client');
const { loadStateConfig } = require('./configLoader');
const logger = require('./logger');
const redisClient = require('./redisClient');

const ARI_APP_NAME = process.env.ARI_APP_NAME || 'fsm-ari-app';
const ARI_USERNAME = process.env.ARI_USERNAME || 'ariuser';
const ARI_PASSWORD = process.env.ARI_PASSWORD || 'aripass';
const ARI_URL = process.env.ARI_URL || 'http://localhost:8088';

let ariClientInstance = null; // Renamed to avoid conflict
let aiInputHandlerAri; // Placeholder for the AI input handler

// Store active channels and their associated speech recognition objects if using external ASR
const activeChannels = new Map();

async function playPrompt(channel, promptTextOrSound) {
  if (!promptTextOrSound) return;
  try {
    // Basic heuristic: if it contains 'sound:' or 'recording:', assume it's a media URI
    // Otherwise, it might be text for a TTS engine (not implemented here, would require one)
    if (promptTextOrSound.startsWith('sound:') || promptTextOrSound.startsWith('recording:')) {
      logger.info({ channelId: channel.id, media: promptTextOrSound }, 'ARI: Playing sound.');
      await channel.play({ media: promptTextOrSound });
    } else {
      // Placeholder for TTS. For now, just log it.
      logger.info({ channelId: channel.id, ttsText: promptTextOrSound }, 'ARI: TTS prompt (not played, TTS engine needed).');
      // Example: await channel.play({ media: `sound:tts-prefix-${promptTextOrSound}`}); // If TTS generates files
    }
  } catch (playError) {
    logger.error({ err: playError, channelId: channel.id, prompt: promptTextOrSound }, 'ARI: Error playing prompt.');
  }
}

async function processAriLogic(sessionId, fsmResult, channel) {
  logger.info({ sessionId, nextState: fsmResult.nextStateId }, 'ARI: Processing FSM result.');

  // 1. Act on payloadResponse (e.g., play sounds, TTS)
  if (fsmResult.payloadResponse) {
    // Example: if payloadResponse has a "prompt" field, play it.
    // This needs to be adapted to your specific payloadResponse structure.
    if (fsmResult.payloadResponse.greeting) {
      await playPrompt(channel, fsmResult.payloadResponse.greeting);
    }
    if (fsmResult.payloadResponse.prompts && fsmResult.payloadResponse.prompts.main) {
      await playPrompt(channel, fsmResult.payloadResponse.prompts.main);
    } else if (fsmResult.payloadResponse.finalMessage) {
      await playPrompt(channel, fsmResult.payloadResponse.finalMessage);
       // If it's a final message, consider hanging up or waiting for user to hangup.
       if (!fsmResult.parametersToCollect || fsmResult.parametersToCollect.required.length === 0) {
        logger.info({sessionId}, "ARI: Final message played, no more params to collect. Hanging up channel.");
        // await channel.hangup().catch(e => logger.error({err: e, sessionId}, "Error hanging up channel after final message"));
        // For now, let the call continue, user might hangup. Or implement explicit hangup state.
       }
    }
    // Add more logic here to interpret other parts of payloadResponse
  }

  // 2. If parameters are needed, prepare for input (e.g., start ASR, listen for DTMF)
  if (fsmResult.parametersToCollect && fsmResult.parametersToCollect.required.length > 0) {
    const firstRequiredParam = fsmResult.parametersToCollect.required[0];
    logger.info({ sessionId, param: firstRequiredParam }, `ARI: Need to collect parameter '${firstRequiredParam}'.`);
    // This is where you would typically:
    // - Play a prompt asking for this parameter (e.g., "Please say your ID number")
    // - Start listening for DTMF: channel.on('ChannelDtmfReceived', dtmfHandler);
    // - Or, more complex: bridge to an ASR application or use ARI external media for streaming.
    // For this example, we'll assume DTMF or some other event will trigger a new text input.
    // A more complete IVR would require detailed state management for input gathering here.
    // For now, we just log. The actual input will come from a subsequent event.
    await playPrompt(channel, `Please provide ${firstRequiredParam.replace(/_/g, ' ')}.`);
  } else {
    logger.info({ sessionId }, 'ARI: No more parameters to collect for this state.');
  }
}


async function handleStasisStart(event, channel) {
  logger.info({ channelId: channel.id, app: ARI_APP_NAME }, `ARI: Call entering Stasis app`);
  activeChannels.set(channel.id, { channel }); // Store channel

  const sessionId = channel.id;

  try {
    await channel.answer();
    logger.info({ channelId: sessionId }, `ARI: Channel answered.`);

    // Initial interaction: send a "welcome" or "empty" text to AI to get the first FSM state.
    // Or, if you have a specific "call_start" intent:
    // const initialFsmInput = { intent: "call_start", parameters: { caller_id: channel.caller.number }};
    // const fsmInitialResult = await fsm.processInput(sessionId, initialFsmInput.intent, initialFsmInput.parameters);

    // For AI-first approach, send a generic input or observed data
    const initialTextForAI = `New call started from ${channel.caller?.number || 'unknown'}.`;
    // Log initial "text" to Redis
    redisClient.set(`ari_initial_text:${sessionId}:${Date.now()}`, JSON.stringify({textInput: initialTextForAI}), 'EX', 3600)
        .catch(err => logger.error({err, sessionId}, "Failed to log ARI initial text to Redis"));

    const fsmResult = await aiInputHandlerAri(sessionId, initialTextForAI, 'ari-stasis-start');
    await processAriLogic(sessionId, fsmResult, channel);

  } catch (error) {
    logger.error({ err: error, channelId: sessionId }, 'ARI: Error in StasisStart.');
    try {
      await channel.hangup();
    } catch (hangupError) {
      logger.error({ err: hangupError, channelId: sessionId }, 'ARI: Error trying to hangup channel during StasisStart error.');
    }
  }
}

// Example DTMF handler (needs to be registered on the channel object)
async function handleDtmfReceived(event, channel) {
  const digit = event.digit;
  const sessionId = channel.id;
  logger.info({ channelId: sessionId, digit }, `ARI: DTMF digit received: ${digit}`);

  const channelData = activeChannels.get(sessionId);
  if (!channelData) return;

  // Accumulate DTMF or process immediately. This is a simplified example.
  // A real IVR would accumulate digits until a terminator (#) or timeout.
  // Let's assume a single digit is a complete input for simplicity of AI interaction.
  const textInput = `User pressed DTMF: ${digit}`; // Or accumulated DTMF string.

  // Log DTMF "text" to Redis
  redisClient.set(`ari_dtmf_input:${sessionId}:${Date.now()}`, JSON.stringify({textInput}), 'EX', 3600)
    .catch(err => logger.error({err, sessionId}, "Failed to log ARI DTMF input to Redis"));

  try {
    const fsmResult = await aiInputHandlerAri(sessionId, textInput, 'ari-dtmf');
    await processAriLogic(sessionId, fsmResult, channel);
  } catch (error) {
    logger.error({ err: error, channelId: sessionId, dtmf: digit }, 'ARI: Error processing DTMF input via FSM.');
  }
}


async function handleStasisEnd(event, channel) {
  logger.info({ channelId: channel.id, app: ARI_APP_NAME }, `ARI: Call leaving Stasis app`);
  activeChannels.delete(channel.id); // Clean up
  // Optional: Log call end to Redis or clean up session
  redisClient.set(`ari_call_end:${channel.id}:${Date.now()}`, JSON.stringify({status: 'ended'}), 'EX', 3600*24)
    .catch(err => logger.error({err, channelId: channel.id}, "Failed to log ARI call end to Redis"));
}

async function connectAri(handler) {
  if (typeof handler !== 'function') {
    logger.fatal('CRITICAL: connectAri called without a valid AI input handler.');
    process.exit(1);
  }
  aiInputHandlerAri = handler;

  if (ariClientInstance) {
    return ariClientInstance;
  }

  try {
    loadStateConfig();
    logger.info({ url: ARI_URL, user: ARI_USERNAME }, 'ARI: Attempting to connect...');
    const client = await Ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD);
    logger.info(`ARI: Connected to Asterisk on ${ARI_URL}`);
    ariClientInstance = client;

    client.on('StasisStart', (event, channel) => {
      // Register DTMF handler for this specific channel
      channel.on('ChannelDtmfReceived', (dtmfEvent, dtmfChannel) => {
        handleDtmfReceived(dtmfEvent, dtmfChannel);
      });
      handleStasisStart(event, channel);
    });
    client.on('StasisEnd', handleStasisEnd);

    client.on('error', (err) => {
      logger.error({ err }, 'ARI: Client-level error.');
      ariClientInstance = null; // Reset for reconn
      setTimeout(() => connectAri(aiInputHandlerAri), 5000); // Reconnect after 5s
    });

    client.on('close', () => {
      logger.info('ARI: Connection to Asterisk closed.');
      ariClientInstance = null;
      if (process.env.ENABLE_ARI !== 'false') { // Only reconnect if ARI is supposed to be enabled
        setTimeout(() => connectAri(aiInputHandlerAri), 5000);
      }
    });

    await client.start(ARI_APP_NAME);
    logger.info(`ARI: Stasis app "${ARI_APP_NAME}" registered and listening.`);
    return client;

  } catch (err) {
    logger.error({ err }, `ARI: Failed to connect or start Stasis app.`);
    ariClientInstance = null;
    if (process.env.ENABLE_ARI !== 'false') {
      logger.info('ARI: Retrying connection in 10 seconds...');
      setTimeout(() => connectAri(aiInputHandlerAri), 10000);
    }
    // Do not throw here if main startup should continue with other modules
  }
}

async function closeAri() {
  if (ariClientInstance) {
    logger.info('ARI: Closing connection to Asterisk...');
    try {
      // Stop the Stasis app. This might not be strictly necessary if client.close() handles it.
      // await ariClientInstance.applications.unsubscribe({applicationName: ARI_APP_NAME});
      await ariClientInstance.close();
      logger.info('ARI: Connection to Asterisk closed.');
    } catch (err) {
      logger.error({ err }, 'ARI: Error during close.');
    } finally {
      ariClientInstance = null;
    }
  }
}

module.exports = {
  connectAri,
  closeAri,
};
