// The local session machine, written for AgentRun: where a session's Claude Agent CLI runs when the host runs it on its
// own box (an operator's machine, or a sandbox box the host runs in). Nothing here assumes where that is:
//  - the session gets private directories under its own directory (home, config, tmp, cache; mode 0700), and an empty
//    working directory (`work`), never the host's workspace;
//  - a child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its
//    homes, and the per-session proxy key). Nothing else is inherited, so no provider key, token, sign-in or another
//    session's state reaches it;
//  - each child runs in its own process group, which kill() and close() end whole;
//  - the model proxy (@parcha/agentrun-adapters/host, with the Anthropic policy) starts with the machine and stops with it.
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { startModelProxy, type ModelProxyHooks, type ModelProxyOptions } from "@parcha/agentrun-adapters/host";
import type { AcquireMachine, CacheDir, KillSignal, MachineSpawn, SessionMachine, SessionProcess } from "./process.js";
import { brandMachine } from "./process.js";
import { anthropicPolicy, type AnthropicPolicyOptions } from "./policy.js";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);
const DIRS: readonly CacheDir[] = ["home", "config", "tmp", "cache"];
const STDERR_TAIL = 8 * 1024;

export interface LocalMachineOptions {
  /** The session's own directory. The machine makes its private directories in it. */
  dir: string;
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

/** Start a child of the session: `env` beyond the allowlist, in its own process group, killed whole. */
export function startChild(options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string): MachineChild {
  const child = spawnChild(options.command, options.args ?? [], {
    cwd: options.cwd ?? cwd,
    env: childEnv(from, options.env),
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
      const proc = startChild(spawnOptions, from, root);
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
