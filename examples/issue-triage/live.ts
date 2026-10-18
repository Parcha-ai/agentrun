// What `--live` swaps for the scripted parts: the lead model and Jev's judge. Both come the way the vision-agent example's do: with the user's own keys (`OPENAI_API_KEY` or `GEMINI_API_KEY` or
// `ANTHROPIC_API_KEY` for the lead, `TYPESAFE_API_KEY` for Jev), or through an OpenAI-compatible gateway (`VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`) that serves the lead under its public id and passes
// TypeSafe through at `/typesafe`; a take in a container reaches only that gateway and holds a placeholder key. The lead is pi-ai's own catalog entry (its price included, so `--max-usd` meters real
// numbers). The GitHub tools (`github.ts`, read-only GETs) are `LiveParts.tools`: on --live the entry's door dispatches to them, with its crossings, filing and receipts; the scripted fixtures in
// `job.ts` are `fakes.tools`, which a live run never reads (no tool here is declared `local: "fakes"`).
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner } from '@parcha/agentrun-jev';
import type { LiveParts } from '@parcha/agentrun-reference';
import spec from './demo.json' with { type: 'json' };
import { githubTools } from './github.ts';

export type PublicModel = { provider: string; modelId: string };
export const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;
const PROVIDERS: Record<string, { make: () => Provider; key: string }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY' },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY' },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY' },
};
const parse = (name: string): PublicModel => {
  const [provider, ...id] = name.split('/');
  if (!provider || !id.length || !PROVIDERS[provider]) throw new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${name} is not`);
  return { provider, modelId: id.join('/') };
};
/** The lead by default: one value in demo.json (`models.lead.default`). */
export const LEAD: PublicModel = parse(spec.models.lead.default);
/** Jev's price as TypeSafe lists it, per million input tokens. */
const JEV_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };

/** The catalog of a run's lead: through the gateway when one is set (the Responses API for a model that speaks it, else chat completions), else its provider with its own key. Exported for the test that a response's usage is priced. */
export function catalogOf(env: NodeJS.ProcessEnv, lead: PublicModel): Models {
  const catalog = createModels();
  const original = PROVIDERS[lead.provider]!.make();
  if (!env.VIDEO_MODEL_BASE_URL) {
    if (!env[PROVIDERS[lead.provider]!.key]) throw new Error(`--live with ${publicName(lead)} needs ${PROVIDERS[lead.provider]!.key}, or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY). SETUP-PROMPT.md says where to get one.`);
    catalog.setProvider(original as never);
    return catalog;
  }
  if (!env.VIDEO_MODEL_API_KEY) throw new Error("VIDEO_MODEL_BASE_URL needs VIDEO_MODEL_API_KEY (the gateway's credential).");
  const baseUrl = env.VIDEO_MODEL_BASE_URL;
  const apiKey = env.VIDEO_MODEL_API_KEY;
  const entry = original.getModels().find((each) => each.id === lead.modelId);
  if (!entry) throw new Error(`${lead.provider} has no model ${lead.modelId} in this build of pi-ai`);
  catalog.setProvider(createProvider({
    id: lead.provider, name: original.name, baseUrl,
    auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
    models: [{ ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl }] as never,
    api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
  }) as never);
  return catalog;
}

/** Jev's runner options: through the gateway's TypeSafe pass-through (`/typesafe`) when a gateway is set, else TYPESAFE_BASE_URL when set, else TypeSafe's own address. */
export function jevOptionsOf(env: NodeJS.ProcessEnv) {
  const baseURL = env.VIDEO_MODEL_BASE_URL ? `${env.VIDEO_MODEL_BASE_URL.replace(/\/v1\/?$/, '')}/typesafe` : env.TYPESAFE_BASE_URL || undefined;
  return { apiKey: env.TYPESAFE_API_KEY, pricing: JEV_PRICE, ...(baseURL ? { baseURL } : {}) };
}

export function live({ env, models }: { env: NodeJS.ProcessEnv; models?: { provider?: string; model?: string } }): LiveParts {
  if (!env.TYPESAFE_API_KEY && !env.OPENROUTER_API_KEY) throw new Error('--live needs TYPESAFE_API_KEY (typesafe.ai) or OPENROUTER_API_KEY: Jev judges the issues. With a gateway, any placeholder works.');
  const named = models?.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models?.model;
  const lead = named ? parse(named) : LEAD;
  const catalog = catalogOf(env, lead);
  return {
    host: { models: { catalog, lead: { provider: lead.provider, modelId: lead.modelId } }, decisions: { runJudge: (env.TYPESAFE_API_KEY ? createJevRunner(jevOptionsOf(env)) : createJevRunner()) as never } },
    tools: githubTools(env),
    models: { lead: publicName(lead), judge: 'jev-latest' },
  };
}
