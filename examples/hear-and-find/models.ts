// The models of a live run, each named by its provider and public model id as pi-ai's catalog names it: the lead writes
// the code, the eyes watch a window with its sound (Google's take video; any other eyes take frames), Jev judges frames and
// draws the box (TypeSafe's, with TYPESAFE_API_KEY), and Scribe v2 on fal writes what is said (FAL_KEY). A run reaches the
// lead and the eyes with the user's own keys, or through an OpenAI-compatible gateway (VIDEO_MODEL_BASE_URL and
// VIDEO_MODEL_API_KEY) that serves each model under its public id; such a gateway may also pass fal's queue through at
// its root (`/fal-queue`), which takes its key as a bearer token.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner } from '@parcha/agentrun-jev';
import { modelsEyes } from '@parcha/pi-vision/durable';
import { falTranscriber } from '@parcha/pi-vision/transcribers';
import type { LiveParts } from '../reference/index.ts';

export type PublicModel = { provider: string; modelId: string };
export const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;

/** Each provider's key, its lead and eyes when it is the only one a run has, and whether its eyes take video. */
export const PROVIDERS: Record<string, { make: () => Provider; key: string; lead: string; eyes: string; video: boolean }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY', lead: 'gpt-6-luna', eyes: 'gpt-6-sol', video: false },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY', lead: 'gemini-3.8-flash', eyes: 'gemini-3.8-flash', video: true },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY', lead: 'claude-haiku-5-5', eyes: 'claude-haiku-5-5', video: false },
};
export const LEAD: PublicModel = { provider: 'openai', modelId: 'gpt-6-luna' };
export const EYES: PublicModel = { provider: 'google', modelId: 'gemini-3.8-flash' };
/** Jev's price as TypeSafe lists it, per million input tokens. */
const JEV_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };

const parse = (name: string): PublicModel => {
  const [provider, ...id] = name.split('/');
  if (!provider || !id.length || !PROVIDERS[provider]) throw new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${name} is not`);
  return { provider, modelId: id.join('/') };
};

/** The lead and the eyes: those named, else the defaults when a gateway serves them or their keys are set, else the
 *  defaults of the providers whose keys are set (the eyes preferring Google's, which take video). */
export function chooseModels(env: NodeJS.ProcessEnv, named: { lead?: string; eyes?: string } = {}): { lead: PublicModel; eyes: PublicModel } {
  const has = (provider: string) => Boolean(env.VIDEO_MODEL_BASE_URL || env[PROVIDERS[provider]!.key]);
  const pick = (name: string | undefined, fallback: PublicModel, role: 'lead' | 'eyes', order: readonly string[]) => {
    if (name) return parse(name);
    if (has(fallback.provider)) return fallback;
    const provider = order.find(has);
    if (!provider) throw new Error(`--live needs a model key: ${Object.values(PROVIDERS).map((each) => each.key).join(', ')}, or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY). SETUP-PROMPT.md says where to get one.`);
    return { provider, modelId: PROVIDERS[provider]![role] };
  };
  return { lead: pick(named.lead, LEAD, 'lead', ['openai', 'anthropic', 'google']), eyes: pick(named.eyes, EYES, 'eyes', ['google', 'openai', 'anthropic']) };
}

/** The catalog of a run's models: through the gateway when one is set (the Responses API for a model that speaks it, else
 *  chat completions), else each provider with its own key. */
function catalogOf(env: NodeJS.ProcessEnv, models: readonly PublicModel[]): Models {
  const catalog = createModels();
  for (const id of new Set(models.map((model) => model.provider))) {
    const original = PROVIDERS[id]!.make();
    if (!env.VIDEO_MODEL_BASE_URL) {
      if (!env[PROVIDERS[id]!.key]) throw new Error(`--live with ${id} models needs ${PROVIDERS[id]!.key}.`);
      catalog.setProvider(original as never);
      continue;
    }
    if (!env.VIDEO_MODEL_API_KEY) throw new Error('VIDEO_MODEL_BASE_URL needs VIDEO_MODEL_API_KEY (the gateway\'s credential).');
    const baseUrl = env.VIDEO_MODEL_BASE_URL;
    const apiKey = env.VIDEO_MODEL_API_KEY;
    const entries = models.filter((model) => model.provider === id).map((model) => {
      const entry = original.getModels().find((each) => each.id === model.modelId);
      if (!entry) throw new Error(`${id} has no model ${model.modelId} in this build of pi-ai`);
      return { ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl };
    });
    catalog.setProvider(createProvider({
      id, name: original.name, baseUrl,
      auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
      models: entries as never, api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
    }) as never);
  }
  return catalog;
}

/** Scribe v2 on fal: fal's own queue with FAL_KEY, else the gateway's pass-through with its key as a bearer token. */
export function transcriberOf(env: NodeJS.ProcessEnv) {
  if (env.FAL_KEY) return falTranscriber({ apiKey: () => env.FAL_KEY });
  if (env.VIDEO_MODEL_BASE_URL && env.VIDEO_MODEL_API_KEY) return falTranscriber({ apiKey: () => env.VIDEO_MODEL_API_KEY, queueUrl: `${env.VIDEO_MODEL_BASE_URL.replace(/\/v1\/?$/, '')}/fal-queue`, auth: 'bearer' });
  throw new Error('--live needs FAL_KEY (fal.ai, for Scribe v2), or a gateway that passes fal\'s queue through (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY).');
}

/** The reference entry's live parts: the lead and eyes the flags name or the keys allow, Jev, and the transcriber. */
export function liveParts(context: { env: NodeJS.ProcessEnv; models: { provider?: string; model?: string; eyesModel?: string } }): LiveParts {
  const { env, models } = context;
  if (!env.TYPESAFE_API_KEY) throw new Error('--live needs TYPESAFE_API_KEY (typesafe.ai) for Jev, which scores frames and draws the box.');
  const lead = models.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models.model;
  const chosen = chooseModels(env, { ...(lead ? { lead } : {}), ...(models.eyesModel ? { eyes: models.eyesModel } : {}) });
  const catalog = catalogOf(env, [chosen.lead, chosen.eyes]);
  const eyes = modelsEyes(catalog as never, chosen.eyes, { thinking: 'low', accepts: { video: PROVIDERS[chosen.eyes.provider]!.video } });
  if (!eyes) throw new Error(`${publicName(chosen.eyes)} takes no images, so it cannot be the eyes`);
  const transcriber = transcriberOf(env);
  const jev = { judge: createJevRunner({ apiKey: env.TYPESAFE_API_KEY, pricing: JEV_PRICE }) };
  return {
    host: { models: { catalog, lead: { provider: chosen.lead.provider, modelId: chosen.lead.modelId } } },
    models: { lead: publicName(chosen.lead), eyes: publicName(chosen.eyes), jev: 'typesafe/jev-1.14.0', transcriber: `fal/${transcriber.model}` },
    vision: () => ({ eyes, jev, transcriber }),
  };
}
