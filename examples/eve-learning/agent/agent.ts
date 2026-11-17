import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defineAgent } from 'eve';

// This model configuration belongs to the existing agent, not the AgentRun extension.
const provider = createOpenAICompatible({
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  includeUsage: true,
});
export default defineAgent({
  model: provider.chatModel(process.env.EVE_MODEL ?? 'anthropic/claude-haiku-4.5'),
  modelContextWindowTokens: 200_000,
  limits: {
    sessionUsage: ({ window }) => window.inputTokens >= 80_000 || window.outputTokens >= 4_000,
    sessionTimeoutMs: 30 * 60 * 1000,
  },
});
