// The local session machine, written for AgentRun: where a session's Claude Agent CLI runs when the host runs it on its
// own box (an operator's machine, or a sandbox box the host runs in). Nothing here assumes where that is. The machine
// itself is the kernel's (@parcha/agentrun-kernel/host, `openLocalMachine`): private directories, the allowlisted
// environment (so no provider key, token, sign-in or another session's state reaches a child), the git ceiling, the
// host's confinement, process groups ended whole, the parent watch (a child dies with this process, so a SIGKILLed host leaves none behind), and the model proxy. What is the Claude Agent CLI's own here:
//  - its private directories: home, config, tmp, cache (mode 0700), and an empty working directory (`work`), never the
//    host's workspace;
//  - the SDK's spawn hook adopts the child it starts (`start`), its raw streams, not a line protocol;
//  - the proxy serves the Anthropic policy, and says once per session what the provider did with a token count.
import { confined as kernelConfined, launchCommand as kernelLaunchCommand, openLocalMachine, startChild as kernelStartChild, type ChildCommand, type ConfineChild, type MachineChild, type ModelProxyHooks, type ModelProxyOptions, type ParentWatch } from "@parcha/agentrun-kernel/host";
import type { AcquireMachine, CacheDir, MachineSpawn, SessionMachine } from "./process.js";
import { brandMachine } from "./process.js";
import { anthropicPolicy, type AnthropicPolicyOptions } from "./policy.js";

export { childEnv, INHERITED_ENV } from "@parcha/agentrun-kernel/host";
export type { ChildCommand, ConfineChild, MachineChild } from "@parcha/agentrun-kernel/host";

const NAME = "agentrun-harness-claude";
const DIRS: readonly CacheDir[] = ["home", "config", "tmp", "cache"];

export interface LocalMachineOptions {
  /** The session's own directory. The machine makes its private directories in it. */
  dir: string;
  /** Start every child of the session (the CLI) under the host's confinement. */
  confine?: ConfineChild;
  /** How a child is tied to this process (default what the machine supports; tests force the shim). */
  parentWatch?: ParentWatch;
  /** The model proxy: the runner's hooks, the provider's price, and the session's tools and limits. */
  proxy: {
    hooks: ModelProxyHooks;
    tools: readonly string[];
    /** The CLI's own tools the session has (`Skill`, with skills), offered beside its tools. */
    builtins?: readonly string[];
    price?: ModelProxyOptions["price"];
    maxOutputTokens?: number;
    auth?: AnthropicPolicyOptions["auth"];
    /** Headers the host adds to every forwarded request (a gateway's spend tags). */
    headers?: ModelProxyOptions["headers"];
    log?: ModelProxyOptions["log"];
    fetch?: typeof fetch;
  };
  /** For tests: the process environment the allowlist reads. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export const confined = (child: ChildCommand, confine: ConfineChild | undefined): ChildCommand => kernelConfined(child, confine, NAME);

/** Start a child of the session: `env` beyond the allowlist, in its own process group, killed whole. Its git stops at
 *  `ceiling` (the session's directory). */
/** The command a child is started with: the child, watched by this process (it dies with it), under the host's
 *  confinement (the kernel's launchCommand). */
export const launchCommand = (child: ChildCommand, confine: ConfineChild | undefined, watch?: ParentWatch): ChildCommand => kernelLaunchCommand(child, confine, watch, NAME);

export const startChild = (options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string, ceiling?: string, confine?: ConfineChild, watch?: ParentWatch): MachineChild =>
  kernelStartChild(options, from, cwd, ceiling, confine, NAME, watch);

/** A local machine also lets its spawner adopt a child it started itself (the CLI, through the SDK's spawn hook). */
export interface LocalSessionMachine extends SessionMachine {
  /** The environment the allowlist reads. */
  readonly from: Readonly<Record<string, string | undefined>>;
  /** Start a child of the session, ended with it. */
  start(options: MachineSpawn): MachineChild;
}

/** A machine factory for sessions under `options.dir`: each acquire makes the directories and starts a proxy. */
export function localMachine(options: LocalMachineOptions): AcquireMachine {
  const from = options.env ?? process.env;
  return async ({ ctx, model }) => {
    if (!model) throw new Error(`${NAME}: the harness gave the machine no model route`);
    const route = model.options;
    // What the provider does with a token count (a free route it may not serve), said once per session, a status only.
    let counted = false;
    const local = await openLocalMachine<CacheDir>({
      name: NAME,
      dir: options.dir,
      dirs: DIRS,
      sessionId: ctx.runId,
      from,
      ...(options.confine ? { confine: options.confine } : {}),
      ...(options.parentWatch ? { parentWatch: options.parentWatch } : {}),
      proxy: {
        policy: anthropicPolicy({
          model: route.models.model,
          ...(route.models.smallModel ? { smallModel: route.models.smallModel } : {}),
          tools: options.proxy.tools,
          ...(options.proxy.builtins?.length ? { builtins: options.proxy.builtins } : {}),
          ...(options.proxy.maxOutputTokens ? { maxOutputTokens: options.proxy.maxOutputTokens } : {}),
          ...(options.proxy.auth ? { auth: options.proxy.auth } : {}),
          onThinkingDisabled: ({ model: main }) => options.proxy.log?.("claude-agent: thinking.disabled", { model: main }),
        }),
        hooks: options.proxy.hooks,
        model: route.models.model,
        origin: route.target,
        credential: async () => (await route.credential()) ?? "",
        ...(options.proxy.price ? { price: options.proxy.price } : {}),
        ...(options.proxy.headers ? { headers: options.proxy.headers } : {}),
        ...(options.proxy.log ? { log: options.proxy.log } : {}),
        onResponse: ({ path, status }) => {
          if (path !== "/v1/messages/count_tokens" || counted) return;
          counted = true;
          options.proxy.log?.("claude-agent: the provider answered count_tokens", { status });
        },
        ...(options.proxy.fetch ? { fetch: options.proxy.fetch } : {}),
      },
    });
    const machine: LocalSessionMachine = {
      sessionId: local.sessionId,
      root: local.root,
      dirs: local.dirs,
      signal: local.signal,
      modelUrl: local.modelUrl,
      modelKey: local.modelKey,
      notes: local.notes,
      from: local.from,
      start: local.start,
      spawn: async (spawnOptions) => local.start(spawnOptions),
      // A session with its built-ins off writes no files of its own to flush.
      fsync: local.fsync,
      close: local.close,
    };
    return brandMachine(machine);
  };
}
