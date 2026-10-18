// The parts of a live run: the lead, named by its provider and public model id as pi-ai's catalog names it, reached with
// the user's own key or through an OpenAI-compatible gateway (MODEL_BASE_URL and MODEL_API_KEY) that serves each model
// under its public id; and the browser the entry chose: Browserbase (its key pair), or with --local-chrome a Chrome on
// this machine (CHROME_PATH), whose profile lives in the run's scratch directory and goes with it.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { BrowserPlane, LiveParts } from '@parcha/agentrun-reference';
import spec from './demo.json' with { type: 'json' };

type PublicModel = { provider: string; modelId: string };
const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;

/** Each provider's key, and its lead when it is the only one a run has. */
const PROVIDERS: Record<string, { make: () => Provider; key: string; lead: string }> = {
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY', lead: 'gemini-3.8-flash' },
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY', lead: 'gpt-6-luna' },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY', lead: 'claude-haiku-5-5' },
};

const parse = (name: string): PublicModel => {
  const [provider, ...id] = name.split('/');
  if (!provider || !id.length || !PROVIDERS[provider]) throw new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${name} is not`);
  return { provider, modelId: id.join('/') };
};
/** The lead by default: one value in demo.json (`models.lead.default`). */
export const LEAD: PublicModel = parse(spec.models.lead.default);

/** The lead: the one named, else the default when a gateway serves it or its key is set, else the default of a provider whose key is set. */
export function chooseLead(env: NodeJS.ProcessEnv, named?: string): PublicModel {
  if (named) return parse(named);
  const has = (provider: string) => Boolean(env.MODEL_BASE_URL || env[PROVIDERS[provider]!.key]);
  if (has(LEAD.provider)) return LEAD;
  const provider = ['openai', 'anthropic', 'google'].find(has);
  if (!provider) throw new Error(`--live needs a model key: ${Object.values(PROVIDERS).map((each) => each.key).join(', ')}, or a gateway (MODEL_BASE_URL and MODEL_API_KEY).`);
  return { provider, modelId: PROVIDERS[provider]!.lead };
}

/** The lead's catalog: through the gateway when one is set (the Responses API for a model that speaks it, else chat completions), else the provider with its own key. */
function catalogOf(env: NodeJS.ProcessEnv, lead: PublicModel): Models {
  const catalog = createModels();
  const original = PROVIDERS[lead.provider]!.make();
  if (!env.MODEL_BASE_URL) {
    if (!env[PROVIDERS[lead.provider]!.key]) throw new Error(`--live with ${lead.provider} needs ${PROVIDERS[lead.provider]!.key}.`);
    catalog.setProvider(original as never);
    return catalog;
  }
  if (!env.MODEL_API_KEY) throw new Error('MODEL_BASE_URL needs MODEL_API_KEY (the gateway\'s credential).');
  const baseUrl = env.MODEL_BASE_URL;
  const apiKey = env.MODEL_API_KEY;
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

/** The browser of a live run: Browserbase, or a Chrome on this machine. The stagehand driver reads and drives the page. */
async function browserOf(kind: string, env: NodeJS.ProcessEnv): Promise<BrowserPlane | undefined> {
  if (kind !== 'chrome' && kind !== 'browserbase') return undefined;
  const { stagehandDriver } = await import('@parcha/pi-browser/driver/stagehand');
  if (kind === 'browserbase') {
    const { browserbaseProvider } = await import('@parcha/pi-browser/providers/browserbase');
    const provider = browserbaseProvider({ env });
    return { provider: () => provider, driver: stagehandDriver() };
  }
  const { cdpProvider } = await import('@parcha/pi-browser/providers/cdp');
  const provider = cdpProvider({ chrome: { executablePath: env.CHROME_PATH!, profileRoot: join(env.TMPDIR || tmpdir(), 'chrome') } });
  return { provider: () => provider, driver: stagehandDriver() };
}

/** The reference entry's live parts: the lead the flags name or the keys allow, and the browser the entry chose. */
export async function liveParts(context: { env: NodeJS.ProcessEnv; browser: string; models: { provider?: string; model?: string } }): Promise<LiveParts> {
  const { env, models } = context;
  const named = models.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models.model;
  const lead = chooseLead(env, named);
  const catalog = catalogOf(env, lead);
  const browser = await browserOf(context.browser, env);
  return {
    host: { models: { catalog, lead: { provider: lead.provider, modelId: lead.modelId } }, ...(browser ? { tools: { browser } as never } : {}) },
    models: { lead: publicName(lead), browser: context.browser },
  };
}
