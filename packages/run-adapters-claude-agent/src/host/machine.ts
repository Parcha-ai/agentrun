// The local session machine, written for AgentRun: where a session's Claude Agent CLI runs when the host runs it on its
// own box (an operator's machine, or a sandbox box the host runs in). Nothing here assumes where that is:
//  - the session gets private directories under its own directory (home, config, tmp, cache; mode 0700), and an empty
//    working directory (`work`), never the host's workspace;
//  - a child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its
//    homes, and the per-session proxy key). Nothing else is inherited, so no provider key, token, sign-in or another
//    session's state reaches it;
//  - each child runs in its own process group, which kill() and close() end whole, and dies with this process: started
//    with a watch on its parent (./host's parentWatched, inside the host's confinement), so a host that is SIGKILLed,
//    and runs no close, leaves no CLI behind;
//  - the model proxy (@parcha/agentrun-adapters/host, with the Anthropic policy) starts with the machine and stops with it.
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { parentWatched, startModelProxy, type ModelProxyHooks, type ModelProxyOptions, type ParentWatch } from "@parcha/agentrun-adapters/host";
import type { AcquireMachine, CacheDir, KillSignal, MachineSpawn, SessionMachine, SessionProcess } from "./process.js";
import { brandMachine } from "./process.js";
import { anthropicPolicy, type AnthropicPolicyOptions } from "./policy.js";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);
const DIRS: readonly CacheDir[] = ["home", "config", "tmp", "cache"];
const STDERR_TAIL = 8 * 1024;

/** A command and its arguments, as the machine starts it. */
export interface ChildCommand {
  command: string;
  args: string[];
}

/** The host's confinement of a child: the same command and arguments, started under the host's own (a
 *  `setpriv --no-new-privs` prefix, say). It may only add in front: what it returns must end with the command and its
 *  arguments unchanged, and it never sees or changes the child's environment. The prefix must exec the child in place
 *  (as setpriv does): a wrapper that forks and stays as the child's parent defeats the parent watch, since the death
 *  signal then follows the wrapper, not this process. */
export type ConfineChild = (child: Readonly<ChildCommand>) => ChildCommand;

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
    price?: ModelProxyOptions["price"];
    maxOutputTokens?: number;
    auth?: AnthropicPolicyOptions["auth"];
    log?: ModelProxyOptions["log"];
    fetch?: typeof fetch;
  };
  /** For tests: the process environment the allowlist reads. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The child's environment: the allowlist from `from`, then what the caller names. */
export function childEnv(from: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = from[name];
    if (typeof value === "string") env[name] = value;
  }
  return { ...env, ...extra };
}

/** A machine's child: started detached (its own process group), with the allowlisted environment. */
export interface MachineChild extends SessionProcess {
  readonly child: ChildProcess;
}

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export function confined(child: ChildCommand, confine: ConfineChild | undefined): ChildCommand {
  if (!confine) return child;
  const out = confine({ command: child.command, args: [...child.args] });
  const argv = [out?.command, ...(Array.isArray(out?.args) ? out.args : [])];
  const tail = argv.slice(argv.length - child.args.length - 1);
  const kept = argv.length > child.args.length + 1 && tail.length === child.args.length + 1 && tail.every((a, i) => a === (i === 0 ? child.command : child.args[i - 1]));
  if (typeof out?.command !== "string" || !argv.every((a) => typeof a === "string") || !kept) throw new Error("agentrun-claude-agent: the host's confinement must start the child's own command and arguments, after its own");
  return { command: out.command, args: out.args };
}

/** The command a child is started with: the child, watched by this process (it dies with it), under the host's
 *  confinement. The watch is inside the confinement, so it is set after any switch of user the prefix makes. */
export function launchCommand(child: ChildCommand, confine: ConfineChild | undefined, watch?: ParentWatch): ChildCommand {
  return confined(parentWatched(child, watch), confine);
}

/** Start a child of the session: `env` beyond the allowlist, in its own process group, killed whole, and ended when
 *  this process ends. Its git stops at `ceiling` (the session's directory): it never looks for a repository above the
 *  session, in a parent the model could write. */
export function startChild(options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string, ceiling?: string, confine?: ConfineChild, watch?: ParentWatch): MachineChild {
  const run = launchCommand({ command: options.command, args: options.args ?? [] }, confine, watch);
  const child = spawnChild(run.command, run.args, {
    cwd: options.cwd ?? cwd,
    env: { ...childEnv(from, options.env), ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}) },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.stdin!.on("error", () => {});
  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (err) => {
      stderr = (stderr + `\n${String(err.message)}`).slice(-STDERR_TAIL);
      done = true;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
  });
  const kill = (signal: KillSignal = "SIGTERM") => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* gone */ }
    }
  };
  if (options.signal) {
    if (options.signal.aborted) kill("SIGKILL");
    else options.signal.addEventListener("abort", () => kill("SIGKILL"), { once: true });
  }
  return { child, exited, stderrTail: () => stderr, alive: () => !done, kill };
}

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
    if (!model) throw new Error("agentrun-claude-agent: the harness gave the machine no model route");
    const base = normalize(options.dir);
    if (!isAbsolute(base)) throw new Error("agentrun-claude-agent: the session directory must be an absolute path");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dirs = Object.fromEntries(DIRS.map((d) => [d, join(base, d)])) as Record<CacheDir, string>;
    const root = join(base, "work");
    for (const dir of [...Object.values(dirs), root]) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const route = model.options;
    const key = randomBytes(32).toString("base64url");
    // What the provider does with a token count (a free route it may not serve), said once per session, a status only.
    let counted = false;
    const proxy = await startModelProxy({
      policy: anthropicPolicy({
        model: route.models.model,
        ...(route.models.smallModel ? { smallModel: route.models.smallModel } : {}),
        tools: options.proxy.tools,
        ...(options.proxy.maxOutputTokens ? { maxOutputTokens: options.proxy.maxOutputTokens } : {}),
        ...(options.proxy.auth ? { auth: options.proxy.auth } : {}),
        onThinkingDisabled: ({ model: main }) => options.proxy.log?.("claude-agent: thinking.disabled", { model: main }),
      }),
      hooks: options.proxy.hooks,
      model: route.models.model,
      origin: route.target,
      credential: async () => (await route.credential()) ?? "",
      ...(options.proxy.price ? { price: options.proxy.price } : {}),
      ...(options.proxy.log ? { log: options.proxy.log } : {}),
      onResponse: ({ path, status }) => {
        if (path !== "/v1/messages/count_tokens" || counted) return;
        counted = true;
        options.proxy.log?.("claude-agent: the provider answered count_tokens", { status });
      },
      ...(options.proxy.fetch ? { fetch: options.proxy.fetch } : {}),
    }, key);
    const lost = new AbortController();
    const children = new Set<MachineChild>();
    let closed = false;
    const start = (spawnOptions: MachineSpawn): MachineChild => {
      if (closed) throw new Error("agentrun-claude-agent: the session machine is closed");
      const proc = startChild(spawnOptions, from, root, base, options.confine, options.parentWatch);
      children.add(proc);
      void proc.exited.then(() => children.delete(proc));
      return proc;
    };

    const machine: LocalSessionMachine = {
      sessionId: ctx.runId,
      root,
      dirs,
      signal: lost.signal,
      modelUrl: proxy.url,
      modelKey: key,
      notes: [],
      from,
      start,
      spawn: async (spawnOptions) => start(spawnOptions),
      // A session with its built-ins off writes no files of its own to flush.
      fsync: async () => {},
      close: async () => {
        if (closed) return;
        closed = true;
        for (const proc of children) proc.kill("SIGKILL");
        await Promise.all([...children].map((p) => p.exited));
        lost.abort();
        await proxy.close();
      },
    };
    return brandMachine(machine);
  };
}
