// The models of a live run, each named by its provider and its public model id as pi-ai's catalog names it. The lead takes
// images but is never shown one (the run's limits say so); the eyes look. A run reaches the models with the user's own keys, or
// through an OpenAI-compatible gateway of the host's (APOLLO_MODEL_BASE_URL and APOLLO_MODEL_API_KEY) that serves each model under
// its public id; the catalog's entry (its input, prices and limits) is kept, and only the address and the credential change.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { ModelRef } from '@earendil-works/pi-durable';

/** A model by its provider and public id: what every receipt, line and screen names. */
export type PublicModel = { provider: string; modelId: string };
export const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;

/** The lead writes; the eyes read; the weak eyes are the model the eyes bench measured dropping digits from identifiers. */
export const LEAD: PublicModel = { provider: 'openai', modelId: 'gpt-6-luna' };
export const EYES: PublicModel = { provider: 'google', modelId: 'gemini-3.7-flash' };
export const WEAK_EYES: PublicModel = { provider: 'openai', modelId: 'gpt-6-luna' };

const PROVIDERS: Record<string, { make: () => Provider; key: string }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY' },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY' },
};

/** Each named model through the gateway: the catalog's entry, sent to the gateway's OpenAI Responses API when the model speaks it
 *  (a reasoning model with tools needs it), else to its chat completions. */
function throughGateway(wanted: readonly PublicModel[], baseUrl: string, apiKey: string): Provider[] {
  return [...new Set(wanted.map((model) => model.provider))].map((id) => {
    const original = PROVIDERS[id]?.make();
    if (!original) throw new Error(`no provider ${id} here (${Object.keys(PROVIDERS).join(', ')})`);
    const entries = wanted.filter((model) => model.provider === id).map((model) => {
      const entry = original.getModels().find((each) => each.id === model.modelId);
      if (!entry) throw new Error(`${id} has no model ${model.modelId} in this build of pi-ai`);
      return { ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl };
    });
    return createProvider({
      id, name: original.name, baseUrl,
      auth: { apiKey: { name: 'the host\'s model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the host\'s model gateway' }) } },
      models: entries as never, api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
    }) as Provider;
  });
}

/** The catalog of a run's models; the first is the lead. With a gateway in the environment every request goes there and no
 *  provider key is read; without one each provider's own key is, and a missing key says which. */
export function liveModels(env: NodeJS.ProcessEnv, models: readonly PublicModel[]): { catalog: Models; lead: ModelRef } {
  const catalog = createModels();
  const gateway = env.APOLLO_MODEL_BASE_URL;
  if (gateway) {
    if (!env.APOLLO_MODEL_API_KEY) throw new Error('APOLLO_MODEL_BASE_URL needs APOLLO_MODEL_API_KEY (the gateway\'s credential) in the environment.');
    for (const provider of throughGateway(models, gateway, env.APOLLO_MODEL_API_KEY)) catalog.setProvider(provider as never);
  } else {
    for (const id of new Set(models.map((model) => model.provider))) {
      const provider = PROVIDERS[id];
      if (!provider) throw new Error(`no provider ${id} here (${Object.keys(PROVIDERS).join(', ')})`);
      if (!env[provider.key]) throw new Error(`--live with ${id} models needs ${provider.key} in the environment.`);
      catalog.setProvider(provider.make() as never);
    }
  }
  for (const model of models) if (!catalog.getModel(model.provider, model.modelId)) throw new Error(`no model ${publicName(model)} in the catalog`);
  return { catalog, lead: { provider: models[0]!.provider, modelId: models[0]!.modelId } };
}
