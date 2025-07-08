// src/aiService.js
const OpenAI = require('openai');
const { GoogleGenAI, Type } = require('@google/genai'); // Corrected import name, added Type
const Groq = require('groq-sdk');
const redisClient = require('./redisClient');
const logger = require('./logger'); // Assuming pino logger is set up in logger.js

const AI_PROVIDER = process.env.AI_PROVIDER?.toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const AI_REQUEST_TIMEOUT = parseInt(process.env.AI_REQUEST_TIMEOUT, 10) || 10000; // 10 seconds default

let openai, genAI, groq;

if (AI_PROVIDER === 'openai' && OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else if (AI_PROVIDER === 'google' && GEMINI_API_KEY) {
  genAI = new GoogleGenAI({apiKey: GEMINI_API_KEY}); // Corrected instantiation
} else if (AI_PROVIDER === 'groq' && GROQ_API_KEY) {
  groq = new Groq({ apiKey: GROQ_API_KEY });
}

async function logToRedis(key, data) {
  try {
    // Log asynchronously without awaiting
    redisClient.set(key, JSON.stringify(data), 'EX', 3600) // Store for 1 hour
      .catch(err => logger.error({ err, key, data }, 'Error logging to Redis in aiService'));
  } catch (err) {
    logger.error({ err, key, data }, 'Synchronous error trying to log to Redis in aiService');
  }
}

async function getOpenAIResponse(textInput, prompt, sessionId) { // Added sessionId
  if (!openai) {
    throw new Error('OpenAI provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nOutput JSON:\n`;
  // logToRedis already includes textInput and fullPrompt. sessionId can be added if useful there too.
  // The new debug log will be in getAIResponse.

  try {
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: fullPrompt }],
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      response_format: { type: "json_object" },
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE) || 0.7,
    }, { timeout: AI_REQUEST_TIMEOUT });

    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('OpenAI response content is empty.');
    }
    await logToRedis(`ai_output:openai:${Date.now()}`, { response: responseContent });
    return JSON.parse(responseContent);
  } catch (error) {
    logger.error({ err: error, textInput, prompt }, 'Error getting response from OpenAI');
    await logToRedis(`ai_error:openai:${Date.now()}`, { error: error.message, textInput, prompt });
    throw error;
  }
}

async function getGoogleGeminiResponse(textInput, prompt, sessionId) { // Added sessionId
  if (!genAI) {
    throw new Error('Google Gemini provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nRespond with a valid JSON object. Output JSON:\n`;
  // Gemini specific instructions for JSON output are now primarily handled by responseSchema.
  // The prompt should still guide towards a JSON structure.
  // logToRedis already includes textInput and fullPrompt.

  try {
    const modelName = process.env.GEMINI_MODEL || "gemini-pro"; // e.g., "gemini-1.5-flash-latest" or "gemini-pro"

    const response = await genAI.models.generateContent({
      model: modelName,
      contents: [{role: "user", parts: [{text: fullPrompt}]}],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: { type: Type.STRING, description: "The user's determined intent." },
            parameters_json_string: { type: Type.STRING, description: "A JSON string representing the parameters object." }
          },
          required: ["intent", "parameters_json_string"]
        },
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.7,
        // topP: ..., // Other generation config if needed
        // topK: ...,
      }
    }, { timeout: AI_REQUEST_TIMEOUT });

    // When responseSchema is used, the response should ideally be directly parseable JSON.
    // The exact way to access it from the `response` object from `generateContent` needs care.
    // Based on some SDK examples, `response.text` might still be the way, or it might be nested.
    // Let's assume response.text() is the primary way as per documentation for schema usage.
    // If the API directly returns a JSON object in a specific field when schema is used, that would be better.
    // The generateContent directly returns the GenerateContentResponse object.
    // Accessing the content when responseSchema is used:
    let responseText = '';
    // The actual response object from generateContent is the result itself, not a nested .response
    if (response.candidates &&
        response.candidates.length > 0 &&
        response.candidates[0].content &&
        response.candidates[0].content.parts &&
        response.candidates[0].content.parts.length > 0 &&
        typeof response.candidates[0].content.parts[0].text === 'string' // Ensure text exists and is a string
    ) {
      responseText = response.candidates[0].content.parts[0].text;
    } else {
      logger.warn({responseObj: JSON.stringify(response, null, 2)}, "Unexpected Gemini response structure or empty text part when extracting text with responseSchema.");
      // If the primary path fails, we might not have a useful responseText.
      // Avoid calling .text() if it's not a function, which was the previous error.
      if (response && typeof response.text === 'function') { // Check if .text() method exists (it was causing error)
          // This path is unlikely to be hit if the above structure is the norm for schema responses,
          // but as a very defensive fallback.
          logger.warn("Attempting to call response.text() as a last resort for Gemini.");
          responseText = response.text(); // This was the line causing the previous error.
      }
      if (!responseText) { // If still no text
        throw new Error('Google Gemini response content is empty or in an unexpected format after attempting extraction.');
      }
    }

    await logToRedis(`ai_output:google:${Date.now()}`, { response: responseText });
    const parsedResponse = JSON.parse(responseText); // This assumes responseText is the stringified top-level JSON

    // Now, parse the parameters_json_string
    let finalParameters = {};
    if (parsedResponse && parsedResponse.parameters_json_string) {
      try {
        finalParameters = JSON.parse(parsedResponse.parameters_json_string);
      } catch (e) {
        logger.warn({ err: e, parameters_json_string: parsedResponse.parameters_json_string },
          "Failed to parse parameters_json_string from Gemini response. Defaulting to empty parameters object.");
        // Keep finalParameters as {}
      }
    } else {
        logger.warn({parsedResponseFromAI: parsedResponse},"Gemini response missing 'parameters_json_string' field.");
    }
    return { intent: parsedResponse.intent, parameters: finalParameters };

  } catch (error) {
    // If the error is an ApiError from Google, it might have a more specific JSON payload in its message
    if (error.name === 'ApiError' && error.message) {
        try {
            const errorJson = JSON.parse(error.message);
            logger.error({ err: errorJson, textInput, prompt }, 'Google Gemini API Error');
        } catch (e) {
            logger.error({ err: error, textInput, prompt }, 'Error getting response from Google Gemini (non-JSON error message)');
        }
    } else {
        logger.error({ err: error, textInput, prompt }, 'Error getting response from Google Gemini');
    }
    await logToRedis(`ai_error:google:${Date.now()}`, { error: error.message, textInput, prompt });
    throw error;
  }
}

async function getGroqResponse(textInput, prompt, sessionId) { // Added sessionId
  if (!groq) {
    throw new Error('Groq provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nOutput JSON:\n`;
  // logToRedis already includes textInput and fullPrompt.

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: fullPrompt }],
      model: process.env.GROQ_MODEL || 'mixtral-8x7b-32768', // Or llama2-70b-4096, etc.
      response_format: { type: "json_object" },
      temperature: parseFloat(process.env.GROQ_TEMPERATURE) || 0.7,
    }, { timeout: AI_REQUEST_TIMEOUT });

    const responseContent = chatCompletion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('Groq response content is empty.');
    }
    await logToRedis(`ai_output:groq:${Date.now()}`, { response: responseContent });
    return JSON.parse(responseContent);
  } catch (error) {
    logger.error({ err: error, textInput, prompt }, 'Error getting response from Groq');
    await logToRedis(`ai_error:groq:${Date.now()}`, { error: error.message, textInput, prompt });
    throw error;
  }
}

// Modified getAIResponse to accept sessionId for logging purposes
async function getAIResponse(textInput, promptContent, sessionId) {
  if (!AI_PROVIDER) {
    logger.error('AI_PROVIDER environment variable is not set.');
    throw new Error('AI_PROVIDER environment variable is not set.');
  }
  if (!promptContent) {
    logger.error('Prompt content is empty or not loaded.');
    throw new Error('Prompt content is empty or not loaded.');
  }

  // Log the full prompt details at DEBUG level, including sessionId
  // The actual textInput might be very long, consider truncating if logs become too verbose,
  // or rely on the Redis log for the full content. For now, logging full.
  logger.debug({
    sessionId: sessionId, // Include sessionId here
    provider: AI_PROVIDER,
    textInputToAI: textInput, // This is the `fullTextInputForAI` from index.js
    systemPromptToAI: promptContent // This is the content of `aiPrompt.txt`
  }, "Full prompt details being sent to AI provider.");

  // Log to Redis (this was already present in provider-specific functions, can be centralized or kept there)
  // For consistency, let's assume the provider-specific functions will call logToRedis with their specific `fullPrompt`
  // which includes the textInput and the system prompt combined.
  // Example: await logToRedis(`ai_input:${AI_PROVIDER}:${sessionId}:${Date.now()}`, { textInput, systemPrompt: promptContent });


  logger.info({ sessionId: sessionId, provider: AI_PROVIDER, textInputLength: textInput.length }, 'Requesting AI response');

  switch (AI_PROVIDER) {
    case 'openai':
      return getOpenAIResponse(textInput, promptContent, sessionId); // Pass sessionId
    case 'google':
      return getGoogleGeminiResponse(textInput, promptContent, sessionId); // Pass sessionId
    case 'groq':
      return getGroqResponse(textInput, promptContent, sessionId); // Pass sessionId
    default:
      logger.error(`Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
      throw new Error(`Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
  }
}

module.exports = {
  getAIResponse,
  // Export individual functions if needed for specific testing or direct use
  getOpenAIResponse,
  getGoogleGeminiResponse,
  getGroqResponse
};
