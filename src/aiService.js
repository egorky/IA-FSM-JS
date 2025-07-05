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

async function getOpenAIResponse(textInput, prompt) {
  if (!openai) {
    throw new Error('OpenAI provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nOutput JSON:\n`;
  await logToRedis(`ai_input:openai:${Date.now()}`, { textInput, prompt: fullPrompt });

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

async function getGoogleGeminiResponse(textInput, prompt) {
  if (!genAI) {
    throw new Error('Google Gemini provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nRespond with a valid JSON object. Output JSON:\n`;
  // Gemini specific instructions for JSON output are now primarily handled by responseSchema.
  // The prompt should still guide towards a JSON structure.
  await logToRedis(`ai_input:google:${Date.now()}`, { textInput, prompt: fullPrompt });

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
    // For now, we rely on response.text() and then JSON.parse.
    const responseText = response.text();

    if (!responseText) {
      throw new Error('Google Gemini response text is empty, even with responseSchema.');
    }

    await logToRedis(`ai_output:google:${Date.now()}`, { response: responseText });
    const parsedResponse = JSON.parse(responseText);

    // Now, parse the parameters_json_string
    let finalParameters = {};
    if (parsedResponse.parameters_json_string) {
      try {
        finalParameters = JSON.parse(parsedResponse.parameters_json_string);
      } catch (e) {
        logger.warn({ err: e, parameters_json_string: parsedResponse.parameters_json_string },
          "Failed to parse parameters_json_string from Gemini response. Defaulting to empty parameters object.");
        // Keep finalParameters as {}
      }
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

async function getGroqResponse(textInput, prompt) {
  if (!groq) {
    throw new Error('Groq provider selected but API key not provided or client not initialized.');
  }
  const fullPrompt = `${prompt}\n\nInput Text: "${textInput}"\n\nOutput JSON:\n`;
  await logToRedis(`ai_input:groq:${Date.now()}`, { textInput, prompt: fullPrompt });

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

async function getAIResponse(textInput, promptContent) {
  if (!AI_PROVIDER) {
    logger.error('AI_PROVIDER environment variable is not set.');
    throw new Error('AI_PROVIDER environment variable is not set.');
  }
  if (!promptContent) {
    logger.error('Prompt content is empty or not loaded.');
    throw new Error('Prompt content is empty or not loaded.');
  }

  logger.info({ provider: AI_PROVIDER, textInputLength: textInput.length }, 'Requesting AI response');

  switch (AI_PROVIDER) {
    case 'openai':
      return getOpenAIResponse(textInput, promptContent);
    case 'google':
      return getGoogleGeminiResponse(textInput, promptContent);
    case 'groq':
      return getGroqResponse(textInput, promptContent);
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
