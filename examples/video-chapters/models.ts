// The models of a live run, each named by its provider and public model id as pi-ai's catalog names it. The lead writes the code;
// the eyes look. Google's eyes take a video window as it is, sound included; any other eyes take images only, and the agent cuts
// frames for them. A run reaches the models with the user's own keys, or through an OpenAI-compatible gateway
// (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY) that serves each model under its public id.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { modelsEyes } from '@parcha/pi-vision/durable';
import type { LiveParts } from '../reference/index.ts';

export type PublicModel = { provider: string; modelId: string };
export const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;

export const LEAD: PublicModel = { provider: 'openai', modelId: 'gpt-6-luna' };
export const EYES: PublicModel = { provider: 'google', modelId: 'gemini-3.8-flash' };

/** Each provider's key, the lead and the eyes it gives when it is the one a run has, and whether its eyes take video. */
export const PROVIDERS: Record<string, { make: () => Provider; key: string; lead: string; eyes: string; video: boolean }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY', lead: 'gpt-6-luna', eyes: 'gpt-6-sol', video: false },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY', lead: 'gemini-3.8-flash', eyes: 'gemini-3.8-flash', video: true },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY', lead: 'claude-haiku-5-5', eyes: 'claude-haiku-5-5', video: false },
};

const parse = (name: string): PublicModel => {
  const [provider, ...id] = name.split('/');
  if (!provider || !id.length || !PROVIDERS[provider]) throw Object.assign(new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${name} is not`), { code: 'MODEL_NAME' });
  return { provider, modelId: id.join('/') };
};

/** The lead and the eyes: those named, else the defaults when a gateway serves them or their providers' keys are set, else the
 *  defaults of the providers whose keys are set (the lead's first, the eyes' preferring Google, whose eyes take video). */
export function chooseModels(env: NodeJS.ProcessEnv, named: { lead?: string; eyes?: string } = {}): { lead: PublicModel; eyes: PublicModel } {
  const has = (provider: string) => Boolean(env.VIDEO_MODEL_BASE_URL || env[PROVIDERS[provider]!.key]);
  const keyed = Object.keys(PROVIDERS).filter(has);
  const pick = (name: string | undefined, fallback: PublicModel, role: 'lead' | 'eyes', order: readonly string[]) => {
    if (name) return parse(name);
    if (has(fallback.provider)) return fallback;
    const provider = order.find((id) => keyed.includes(id));
    if (!provider) throw Object.assign(new Error(`--live needs a model key in the environment: ${Object.values(PROVIDERS).map((each) => each.key).join(', ')}, or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY). SETUP-PROMPT.md says where to get one.`), { code: 'KEYS_MISSING' });
    return { provider, modelId: PROVIDERS[provider]![role] };
  };
  return { lead: pick(named.lead, LEAD, 'lead', ['openai', 'anthropic', 'google']), eyes: pick(named.eyes, EYES, 'eyes', ['google', 'openai', 'anthropic']) };
}

/** Each named model through the gateway: the catalog's entry, sent to the gateway's Responses API when the model speaks it, else
 *  to its chat completions. */
function throughGateway(wanted: readonly PublicModel[], baseUrl: string, apiKey: string): Provider[] {
  return [...new Set(wanted.map((model) => model.provider))].map((id) => {
    const original = PROVIDERS[id]!.make();
    const entries = wanted.filter((model) => model.provider === id).map((model) => {
      const entry = original.getModels().find((each) => each.id === model.modelId);
      if (!entry) throw new Error(`${id} has no model ${model.modelId} in this build of pi-ai`);
      return { ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl };
    });
    return createProvider({
      id, name: original.name, baseUrl,
      auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
      models: entries as never, api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
    }) as Provider;
  });
}

/** The catalog of a run's models; the first is the lead. With a gateway every request goes there and no provider key is read. */
export function liveModels(env: NodeJS.ProcessEnv, models: readonly PublicModel[]): { catalog: Models; lead: ModelRef } {
  const catalog = createModels();
  if (env.VIDEO_MODEL_BASE_URL) {
    if (!env.VIDEO_MODEL_API_KEY) throw new Error('VIDEO_MODEL_BASE_URL needs VIDEO_MODEL_API_KEY (the gateway\'s credential) in the environment.');
    for (const provider of throughGateway(models, env.VIDEO_MODEL_BASE_URL, env.VIDEO_MODEL_API_KEY)) catalog.setProvider(provider as never);
  } else {
    for (const id of new Set(models.map((model) => model.provider))) {
      if (!env[PROVIDERS[id]!.key]) throw new Error(`--live with ${id} models needs ${PROVIDERS[id]!.key} in the environment.`);
      catalog.setProvider(PROVIDERS[id]!.make() as never);
    }
  }
  return { catalog, lead: { provider: models[0]!.provider, modelId: models[0]!.modelId } };
}

/** The reference entry's live parts: the models the flags name, else the defaults the keys allow; the eyes take video when their
 *  provider's do. */
export function liveParts(context: { env: NodeJS.ProcessEnv; models: { provider?: string; model?: string; eyesModel?: string } }): LiveParts {
  const { env, models } = context;
  const lead = models.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models.model;
  const chosen = chooseModels(env, { ...(lead ? { lead } : {}), ...(models.eyesModel ? { eyes: models.eyesModel } : {}) });
  const { catalog, lead: ref } = liveModels(env, [chosen.lead, chosen.eyes]);
  const eyes = modelsEyes(catalog as never, chosen.eyes, { thinking: 'low', accepts: { video: PROVIDERS[chosen.eyes.provider]!.video } });
  if (!eyes) throw new Error(`${publicName(chosen.eyes)} takes no images, so it cannot be the eyes`);
  return { host: { models: { catalog, lead: ref } }, models: { lead: publicName(chosen.lead), eyes: publicName(chosen.eyes) }, vision: () => ({ eyes }) };
}
