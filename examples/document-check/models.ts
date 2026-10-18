// The models of a live run: the lead, which writes the code, named by its provider and public model id as pi-ai's
// catalog names it; and Jev, which answers the typed questions about each page. The lead is reached with its provider's
// key, or through an OpenAI-compatible gateway (DEMO_MODEL_BASE_URL and DEMO_MODEL_API_KEY) that serves it under its
// public id (its Responses API when the model speaks it, else its chat completions); Jev with TYPESAFE_API_KEY, or OPENROUTER_API_KEY through OpenRouter.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner, jevProviderFromEnv } from '@parcha/agentrun-jev';
import type { LiveParts } from '../reference/index.ts';

export type PublicModel = { provider: string; modelId: string };
export const LEAD: PublicModel = { provider: 'openai', modelId: 'gpt-6-luna' };
/** Jev's list price, from TypeSafe's pricing (jev-1.14.0): $0.042 per million input tokens, output free. */
export const JEV_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };

const PROVIDERS: Record<string, { make: () => Provider; key: string; lead: string }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY', lead: 'gpt-6-luna' },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY', lead: 'claude-haiku-5-5' },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY', lead: 'gemini-3.8-flash' },
};

/** The lead: the one named (`provider/id`), else the default when a gateway serves it or its key is set, else the
 *  default of the first provider whose key is set. */
export function chooseLead(env: NodeJS.ProcessEnv, named?: string): PublicModel {
  if (named) {
    const [provider, ...id] = named.split('/');
    if (!provider || !id.length || !PROVIDERS[provider]) throw Object.assign(new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${named} is not`), { code: 'MODEL_NAME' });
    return { provider, modelId: id.join('/') };
  }
  if (env.DEMO_MODEL_BASE_URL || env[PROVIDERS[LEAD.provider]!.key]) return LEAD;
  const provider = Object.keys(PROVIDERS).find((id) => env[PROVIDERS[id]!.key]);
  if (!provider) throw Object.assign(new Error(`--live needs a model key in the environment: ${Object.values(PROVIDERS).map((each) => each.key).join(', ')}, or a gateway (DEMO_MODEL_BASE_URL and DEMO_MODEL_API_KEY). README.md says where to get one.`), { code: 'KEYS_MISSING' });
  return { provider, modelId: PROVIDERS[provider]!.lead };
}

/** The reference entry's live parts: the lead in its own catalog, and Jev for `vision.judge`. */
export function liveParts(context: { env: NodeJS.ProcessEnv; models: { provider?: string; model?: string } }): LiveParts {
  const { env, models } = context;
  if (!env.TYPESAFE_API_KEY && !env.OPENROUTER_API_KEY) throw Object.assign(new Error('--live needs a Jev key: TYPESAFE_API_KEY (console.typesafe.ai), or OPENROUTER_API_KEY for Jev through OpenRouter.'), { code: 'KEYS_MISSING' });
  const lead = chooseLead(env, models.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models.model);
  const catalog = createModels();
  const original = PROVIDERS[lead.provider]!.make();
  if (env.DEMO_MODEL_BASE_URL) {
    if (!env.DEMO_MODEL_API_KEY) throw new Error('DEMO_MODEL_BASE_URL needs DEMO_MODEL_API_KEY (the gateway\'s credential) in the environment.');
    const entry = original.getModels().find((each) => each.id === lead.modelId);
    if (!entry) throw new Error(`${lead.provider} has no model ${lead.modelId} in this build of pi-ai`);
    const baseUrl = env.DEMO_MODEL_BASE_URL;
    const apiKey = env.DEMO_MODEL_API_KEY;
    catalog.setProvider(createProvider({
      id: lead.provider, name: original.name, baseUrl,
      auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
      models: [{ ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl }] as never,
      api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
    }) as never);
  } else {
    if (!env[PROVIDERS[lead.provider]!.key]) throw new Error(`--live with ${lead.provider}/${lead.modelId} needs ${PROVIDERS[lead.provider]!.key} in the environment.`);
    catalog.setProvider(original as never);
  }
  // Jev is the host's judge seam: `vision.judge` reaches it there, held to the demo's caps and priced.
  return {
    host: { models: { catalog, lead: { provider: lead.provider, modelId: lead.modelId } }, decisions: { runJudge: createJevRunner({ provider: jevProviderFromEnv(env), pricing: JEV_PRICE }) } },
    models: { lead: `${lead.provider}/${lead.modelId}`, judge: 'jev-1.14.0' },
  };
}
