import 'dotenv/config';

/**
 * Return an environment variable or throw with a clear message.
 * @param {string} key
 * @returns {string}
 */
export function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

/**
 * Load and validate runtime configuration.
 * @returns {{openaiApiKey: string, anthropicApiKey: string, googleApiKey: string, elevenlabsApiKey: string}}
 */
export function loadConfig() {
  return {
    openaiApiKey: getRequiredEnv('OPENAI_API_KEY'),
    anthropicApiKey: getRequiredEnv('ANTHROPIC_API_KEY'),
    googleApiKey: getRequiredEnv('GOOGLE_API_KEY'),
    elevenlabsApiKey: getRequiredEnv('ELEVENLABS_API_KEY')
  };
}
