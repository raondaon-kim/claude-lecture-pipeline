import Anthropic from '@anthropic-ai/sdk';

/**
 * Create a new Anthropic client.
 * @param {string} apiKey
 * @returns {Anthropic}
 */
export function createClaudeClient(apiKey) {
  return new Anthropic({ apiKey });
}

/**
 * Call Claude with forced tool use and return the parsed tool input.
 * @param {{client: Anthropic, model: string, system: string, userMessage: string, toolName: string, inputSchema: object, maxTokens?: number}} options
 * @returns {Promise<object>}
 */
export async function claudeToolCall({ client, model, system, userMessage, toolName, inputSchema, maxTokens = 4096 }) {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      {
        name: toolName,
        description: `Structured output for ${toolName}`,
        input_schema: inputSchema
      }
    ],
    tool_choice: { type: 'tool', name: toolName }
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Response truncated (max_tokens=${maxTokens}) for ${toolName}. Increase maxTokens or reduce input size.`);
  }

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock) {
    throw new Error(`No tool_use block in response for ${toolName}`);
  }

  return toolBlock.input;
}
