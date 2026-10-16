// What `--live` swaps for the scripted parts: the lead model and Jev's judge. The model is pi-ai's own catalog entry for openai/gpt-6-luna, with its price, so pi-ai fills each call's usage.cost
// and `--max-usd` meters real numbers. By default it is OpenAI's own endpoint on `OPENAI_API_KEY`; with `DEMO_MODEL_BASE_URL` only its baseUrl is overridden, to an OpenAI-compatible endpoint that
// holds its own credential (a gateway: any placeholder key is sent). The GitHub tools (`github.ts`, read-only GETs) are `LiveParts.tools`: on --live the entry's door dispatches to them, with its crossings, filing and receipts; the scripted
// fixtures in `job.ts` are `fakes.tools`, which a live run never reads (no tool here is declared `local: "fakes"`).
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner } from '@parcha/agentrun-jev';
import { githubTools } from './github.ts';
import type { LiveParts } from '../reference/index.ts';

export const MODEL = 'gpt-6-luna';

/** The provider for a gateway: pi-ai's openai catalog entry for `MODEL`, its baseUrl replaced, any placeholder key. Exported for the test that a response's usage is priced. */
export function brokerProvider(baseUrl: string) {
  const entry = openaiProvider().getModels().find((model) => model.id === MODEL);
  if (!entry) throw new Error(`pi-ai's openai catalog has no ${MODEL}`);
  return createProvider({
    id: 'openai', baseUrl,
    auth: { apiKey: { name: 'broker', resolve: async () => ({ auth: { apiKey: 'not-a-secret' }, source: 'broker' }) } },
    models: [{ ...entry, baseUrl }],
    api: openAIResponsesApi(),
  });
}

export function live({ env }: { env: NodeJS.ProcessEnv }): LiveParts {
  const catalog = createModels();
  const gateway = env.DEMO_MODEL_BASE_URL?.trim();
  catalog.setProvider(gateway ? brokerProvider(gateway) : openaiProvider());
  return {
    host: { models: { catalog, lead: { provider: 'openai', modelId: MODEL } }, decisions: { runJudge: createJevRunner() } },
    tools: githubTools(env),
    models: { lead: `openai/${MODEL}`, judge: 'jev-latest' },
  };
}
