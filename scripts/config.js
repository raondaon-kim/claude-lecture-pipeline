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
 * Return an environment variable or undefined (no throw).
 * @param {string} key
 * @returns {string|undefined}
 */
export function getOptionalEnv(key) {
  return process.env[key] || undefined;
}

/**
 * Load and validate runtime configuration.
 * elevenlabsApiKey is optional — if missing, edge-tts will be used as fallback.
 * @returns {{openaiApiKey: string, anthropicApiKey: string, googleApiKey: string, elevenlabsApiKey?: string}}
 */
export function loadConfig() {
  return {
    openaiApiKey: getRequiredEnv('OPENAI_API_KEY'),
    anthropicApiKey: getRequiredEnv('ANTHROPIC_API_KEY'),
    googleApiKey: getRequiredEnv('GOOGLE_API_KEY'),
    elevenlabsApiKey: getOptionalEnv('ELEVENLABS_API_KEY')
  };
}
