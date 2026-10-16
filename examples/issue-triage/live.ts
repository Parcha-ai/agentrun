// What `--live` swaps for the scripted parts: the lead model and Jev's judge. The model is pi-ai's own catalog entry for openai/gpt-6-luna, with its price, and only its baseUrl
// overridden to the scoped broker (an OpenAI-compatible endpoint that takes any placeholder key and adds its own credential), so pi-ai fills each call's usage.cost and `--max-usd`
// meters real numbers. The GitHub tools (`github.ts`) are the live effect door's; they move here as `LiveParts.tools` when the entry has it (see the note in `job.ts`).
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner } from '@parcha/agentrun-jev';
import type { LiveParts } from '../reference/index.ts';

export const BROKER = 'http://127.0.0.1:9421/v1';
export const MODEL = 'gpt-6-luna';

/** The provider: pi-ai's openai catalog entry for `MODEL`, its baseUrl replaced. Exported for the test that a response's usage is priced. */
export function brokerProvider(baseUrl: string = BROKER) {
  const entry = openaiProvider().getModels().find((model) => model.id === MODEL);
  if (!entry) throw new Error(`pi-ai's openai catalog has no ${MODEL}`);
  return createProvider({
    id: 'openai', baseUrl,
    auth: { apiKey: { name: 'broker', resolve: async () => ({ auth: { apiKey: 'not-a-secret' }, source: 'broker' }) } },
    models: [{ ...entry, baseUrl }],
    api: openAIResponsesApi(),
  });
}

export function live(): LiveParts {
  const catalog = createModels();
  catalog.setProvider(brokerProvider());
  return {
    host: { models: { catalog, lead: { provider: 'openai', modelId: MODEL } }, decisions: { runJudge: createJevRunner() } },
    models: { lead: `openai/${MODEL}`, judge: 'jev-latest' },
  };
}
