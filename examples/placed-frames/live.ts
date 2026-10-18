// The live run: the daytona environment is a Daytona sandbox (Daytona's REST API, DAYTONA_API_KEY), the modal one a Modal sandbox (the modal SDK, which this repository does not
// install: `npm install --no-save modal@0.11.0`, with MODAL_TOKEN_ID and MODAL_TOKEN_SECRET), and the placer asks Jev at TypeSafe (TYPESAFE_API_KEY; TYPESAFE_BASE_URL for a proxy
// of your own). Each key stays in this process: none reaches a sandbox. Rates (demo.json `rates`, off) make a receipt per box.
import type { Models } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import type { LiveParts } from '@parcha/agentrun-reference';
import type { BoxPrice } from '@parcha/pi-transport';
import { daytonaBoxes } from '@parcha/pi-transport/box/daytona';
import { type ModalSdk, modalBoxes } from '@parcha/pi-transport/box/modal';
import spec from './demo.json' with { type: 'json' };
import { frameTools } from './tools.ts';

/** The Modal app the boxes are made in: Modal makes it when it is absent, and it stays on the account. */
export const MODAL_APP = 'agentrun-placed-frames';

/** pi-ai's models with TypeSafe: its own address, or `baseUrl` (a proxy that passes TypeSafe's API through). */
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

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`--live needs ${name}: ${spec.keys.find((key) => key.env === name)?.why ?? ''} SETUP-PROMPT.md says where to get it.`);
  return value;
};

export const liveParts = async ({ env }: { env: NodeJS.ProcessEnv }): Promise<LiveParts> => {
  const daytona = { apiKey: need(env, 'DAYTONA_API_KEY'), snapshot: env.DAYTONA_SNAPSHOT?.trim() || undefined };
  need(env, 'MODAL_TOKEN_ID');
  need(env, 'MODAL_TOKEN_SECRET');
  need(env, 'TYPESAFE_API_KEY');
  // The SDK is the user's (`npm install --no-save modal@0.11.0`): a name in a variable, so nothing here depends on it.
  const sdk = 'modal';
  const { ModalClient } = (await import(sdk).catch(() => { throw new Error('--live needs the modal SDK: npm install --no-save modal@0.11.0'); })) as { ModalClient: new () => ModalSdk };
  const tools = frameTools({
    providers: () => ({
      daytona: daytonaBoxes({ apiKey: daytona.apiKey }),
      modal: modalBoxes(new ModalClient(), { appName: MODAL_APP }),
    }),
    specOf: (environment) => ({
      ...(environment.cpus === undefined ? {} : { cpus: environment.cpus }),
      ...(environment.image === undefined ? {} : { image: environment.image }),
      ...(environment.provider === 'daytona' && daytona.snapshot ? { snapshot: daytona.snapshot } : {}),
    }),
    models: jevModels(env.TYPESAFE_BASE_URL?.trim() || undefined),
    placer: 'jev',
    rates: spec.rates as readonly BoxPrice[] | null,
  });
  return { tools, models: { placer: 'typesafe/jev-latest', daytona: daytona.snapshot ? `snapshot ${daytona.snapshot}` : 'the default sandbox', modal: spec.placement.environments.find((each) => each.id === 'modal')?.image ?? 'the default image' } };
};
