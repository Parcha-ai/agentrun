// The live run: the lead is a real model (Google's gemini-3.8-flash, thinking at medium, which the model returns readable), the daytona environment is a Daytona sandbox (Daytona's REST API,
// DAYTONA_API_KEY), the modal one a Modal sandbox (the modal SDK, which this repository does not install: `npm install --no-save modal@0.11.0`, with MODAL_TOKEN_ID and MODAL_TOKEN_SECRET), and the
// placer asks Jev at TypeSafe (TYPESAFE_API_KEY; TYPESAFE_BASE_URL for a proxy of your own). The lead is reached with GEMINI_API_KEY, or through an OpenAI-compatible gateway (VIDEO_MODEL_BASE_URL
// and VIDEO_MODEL_API_KEY) that serves it under its public id and passes TypeSafe through at `/typesafe/v1`. Each key stays in this process: none reaches a sandbox. Rates (demo.json `rates`, none) make a receipt per box.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { Models } from '@earendil-works/pi-ai';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import type { LiveParts } from '@parcha/agentrun-harness';
import type { BoxProvider } from '@parcha/pi-transport';
import { daytonaBoxes } from '@parcha/pi-transport/box/daytona';
import { type ModalSdk, modalBoxes } from '@parcha/pi-transport/box/modal';
import spec from './demo.json' with { type: 'json' };
import type { Hosting } from './tools.ts';

/** The Modal app the boxes are made in: Modal makes it when it is absent, and it stays on the account. */
export const MODAL_APP = 'agentrun-placed-frames';

/** The lead by its provider and public model id: one value in demo.json (`models.lead.default`). */
const [LEAD_PROVIDER = 'google', ...LEAD_ID] = spec.models.lead.default.split('/');
export const LEAD = { provider: LEAD_PROVIDER, modelId: LEAD_ID.join('/') };

/** pi-ai's models with TypeSafe: its own address, or `baseUrl` (TypeSafe's API, as a proxy of yours serves it: it ends where `/systemone` goes). */
export function jevModels(baseUrl?: string): Models {
  const models = createModels();
  const typesafe = typesafeProvider();
  const classify = typesafe.classify;
  if (!classify) throw new Error('this pi-ai has no TypeSafe classifier');
  models.setProvider(baseUrl ? createProvider({
    id: typesafe.id,
    name: `${typesafe.name}, through ${new URL(baseUrl).host}`,
    auth: typesafe.auth,
    models: (typesafe.getAllModels?.() ?? []).map((model) => ({ ...model, baseUrl })),
    classifiers: { 'typesafe-system-one': { classify: (model, context, options) => classify(model, context, options) } },
  }) : typesafe);
  return models;
}

/** The gateway's root: its base URL without the trailing /v1, where it passes other services through by name. */
const gatewayRoot = (env: NodeJS.ProcessEnv) => (env.VIDEO_MODEL_BASE_URL ?? '').replace(/\/v1\/?$/, '');

/** Where Jev is asked: through the gateway's TypeSafe pass-through when a gateway is set, else TYPESAFE_BASE_URL when set, else TypeSafe's own address. */
export const jevBaseUrl = (env: NodeJS.ProcessEnv): string | undefined => (env.VIDEO_MODEL_BASE_URL ? `${gatewayRoot(env)}/typesafe/v1` : env.TYPESAFE_BASE_URL?.trim() || undefined);

/** The lead's catalog: Google with its own key, or the gateway (the Responses API for a model that speaks it, else chat completions) serving it under its public id. */
export function leadCatalog(env: NodeJS.ProcessEnv): Models {
  const catalog = createModels();
  const original = googleProvider() as unknown as Provider;
  if (!env.VIDEO_MODEL_BASE_URL) {
    if (!env.GEMINI_API_KEY) throw new Error(`--live needs GEMINI_API_KEY for ${LEAD.provider}/${LEAD.modelId}, or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY). SETUP-PROMPT.md says where to get one.`);
    catalog.setProvider(original as never);
    return catalog;
  }
  if (!env.VIDEO_MODEL_API_KEY) throw new Error('VIDEO_MODEL_BASE_URL needs VIDEO_MODEL_API_KEY (the gateway\'s credential).');
  const baseUrl = env.VIDEO_MODEL_BASE_URL;
  const apiKey = env.VIDEO_MODEL_API_KEY;
  const entry = original.getModels().find((each) => each.id === LEAD.modelId);
  if (!entry) throw new Error(`${LEAD.provider} has no model ${LEAD.modelId} in this build of pi-ai`);
  catalog.setProvider(createProvider({
    id: LEAD.provider, name: original.name, baseUrl,
    auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
    models: [{ ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl }] as never,
    api: { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() } as never,
  }) as never);
  return catalog;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`--live needs ${name}: ${spec.keys.find((key) => 'env' in key && key.env === name)?.why ?? ''} SETUP-PROMPT.md says where to get it.`);
  return value;
};

/** The live providers: Daytona sandboxes (Daytona's REST API) and Modal sandboxes (the user's own Modal SDK), by their environment's id. The host taps them and records every sandbox a tool makes on them. */
export async function liveProviders(env: NodeJS.ProcessEnv): Promise<Record<string, BoxProvider>> {
  const daytona = { apiKey: need(env, 'DAYTONA_API_KEY'), apiUrl: env.DAYTONA_API_URL?.trim() || undefined, target: env.DAYTONA_TARGET?.trim() || undefined };
  need(env, 'MODAL_TOKEN_ID');
  need(env, 'MODAL_TOKEN_SECRET');
  // The SDK is the user's (`npm install --no-save modal@0.11.0`): a name in a variable, so nothing here depends on it.
  const sdk = 'modal';
  const { ModalClient } = (await import(sdk).catch(() => { throw new Error('--live needs the modal SDK: npm install --no-save modal@0.11.0'); })) as { ModalClient: new () => ModalSdk };
  return {
    daytona: daytonaBoxes({ apiKey: daytona.apiKey, ...(daytona.apiUrl ? { apiUrl: daytona.apiUrl } : {}), ...(daytona.target ? { target: daytona.target } : {}) }),
    modal: modalBoxes(new ModalClient(), { appName: MODAL_APP }),
  };
}

/** The live hosting the tools run on, over the providers the host tapped: what each environment's boxes are made with, and Jev as the placer. No rates: the host's receipts name none. */
export function hostingOf(env: NodeJS.ProcessEnv, providers: Record<string, BoxProvider>): Hosting {
  const snapshot = env.DAYTONA_SNAPSHOT?.trim() || undefined;
  return {
    providers: () => providers,
    specOf: (environment) => ({
      ...(environment.cpus === undefined ? {} : { cpus: environment.cpus }),
      ...(environment.image === undefined ? {} : { image: environment.image }),
      ...(environment.provider === 'daytona' && snapshot ? { snapshot } : {}),
    }),
    models: jevModels(jevBaseUrl(env)),
    placer: 'jev',
  };
}

/** The live parts: the lead's models only. The sandboxes' providers and the tools over them are `DemoOptions.providers` and `providerExtensions` (run.ts), which is how the host records every sandbox. */
export const liveParts = async ({ env }: { env: NodeJS.ProcessEnv }): Promise<LiveParts> => {
  need(env, 'DAYTONA_API_KEY');
  need(env, 'MODAL_TOKEN_ID');
  need(env, 'MODAL_TOKEN_SECRET');
  need(env, 'TYPESAFE_API_KEY');
  const catalog = leadCatalog(env);
  const snapshot = env.DAYTONA_SNAPSHOT?.trim();
  return {
    host: { models: { catalog, lead: LEAD } } as never,
    models: { lead: `${LEAD.provider}/${LEAD.modelId}`, placer: 'typesafe/jev-latest', daytona: snapshot ? `snapshot ${snapshot}` : 'the default sandbox', modal: spec.placement.environments.find((each) => each.id === 'modal')?.image ?? 'the default image' },
  };
};
