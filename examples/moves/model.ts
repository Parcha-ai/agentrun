// What `--live` swaps for the scripted lead: the three nodes and the 8 threads run on Anthropic's claude-sonnet-5-5 at the thinking each node asks for (medium, job.ts). The model
// key is read once, from the variable the process was started with, and removed from `process.env`: the client holds it in a closure, so no tool, child process or command of this
// process can inherit it. The same goes for the Modal token pair the threads' sandboxes are made with. On this machine the key comes from the runner (a child's environment, never an
// argument); on the Modal VM, from the Modal Secret the launcher copies into the instance's environment by name.
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { dirname } from 'node:path';
import type { LiveParts } from '@parcha/agentrun-harness';
import { ledgerPath, modalProvider } from './boxes.ts';
import { MODEL } from './config.ts';
import { movesExtensions } from './tools.ts';

export const KEY_ENV = 'ANTHROPIC_API_KEY';
/** The Modal app the threads' sandboxes (and the VM) live in. */
export const APP = 'agentrun-moves';
/** Model calls one process may make: the node turns plus the 8 threads' turns, with room. */
export const MAX_CALLS = 120;
/** Tokens one answer may hold, its thinking included. */
export const MAX_OUTPUT_TOKENS = 8192;

type Api = ReturnType<typeof anthropicMessagesApi>;

/** The model's API with each call counted: one past `max` is sent with its signal already aborted, so it ends at once with an error and reaches no server. */
export function boundedApi(inner: Api, max = MAX_CALLS, maxOutputTokens = MAX_OUTPUT_TOKENS): Api & { calls(): number } {
  let calls = 0;
  const bound = <O extends { maxTokens?: number; signal?: AbortSignal }>(options: O | undefined): O => {
    calls += 1;
    const capped = { ...options, maxTokens: Math.min(options?.maxTokens ?? maxOutputTokens, maxOutputTokens) } as O;
    return calls > max ? { ...capped, signal: AbortSignal.abort(new Error(`the live part's cap of ${max} model calls in one process was reached`)) } : capped;
  };
  return { ...inner, stream: (model, context, options) => inner.stream(model, context, bound(options)), streamSimple: (model, context, options) => inner.streamSimple(model, context, bound(options)), calls: () => calls };
}

/** Take a variable out of the environment: its value, and gone from `process.env` (and from the `env` the harness handed over). */
function take(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  delete env[name];
  delete process.env[name];
  return value;
}

export function live({ env }: { env: NodeJS.ProcessEnv }): LiveParts {
  const key = take(env, KEY_ENV);
  const runLabel = take(env, 'MOVES_RUN') ?? 'moves';
  const modal = { id: take(env, 'MODAL_TOKEN_ID'), secret: take(env, 'MODAL_TOKEN_SECRET') };
  if (!key) throw new Error(`--live needs ${KEY_ENV} in this process's environment (the runner's, or the Modal Secret's on the VM)`);
  const anthropic = anthropicProvider() as Provider;
  const entry = anthropic.getModels().find((model) => model.id === MODEL.modelId);
  if (!entry) throw new Error(`anthropic has no model ${MODEL.modelId} in this build of pi-ai`);
  const catalog = createModels({ authContext: { env: async (name: string) => (name === KEY_ENV ? key : undefined), fileExists: async () => false } });
  catalog.setProvider(createProvider({ id: anthropic.id, name: anthropic.name, baseUrl: anthropic.baseUrl, auth: anthropic.auth, models: [{ ...entry, maxTokens: MAX_OUTPUT_TOKENS }], api: boundedApi(anthropicMessagesApi()) } as never) as never);
  // The threads' sandboxes are Modal's, made with this process's own token; a process that holds no token (this machine's) cannot make one, and the threads node is only ever run on the VM.
  const { session, thread } = movesExtensions({
    provider: async (workspace) => {
      if (!modal.id || !modal.secret) throw new Error('this process holds no Modal token, so it cannot make the threads\' sandboxes');
      return modalProvider(APP, modal.id, modal.secret, ledgerPath(dirname(workspace)));
    },
    labels: { run: runLabel },
  });
  const handOver = (args: Record<string, unknown>) => ({ to: String(args.to) });
  return {
    host: { models: { catalog, lead: { provider: MODEL.provider, modelId: MODEL.modelId } }, tools: { extensions: [session, thread] } as never },
    tools: { hand_over: handOver, hand_back: handOver },
    models: { lead: `${MODEL.provider}/${MODEL.modelId}` },
  };
}
