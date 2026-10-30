// The local session machine, written for AgentRun: where a session's Codex runs when the host runs it on its own box.
// The machine itself is the kernel's (@parcha/agentrun-kernel/host, `openLocalMachine`): private directories, the
// allowlisted environment, the git ceiling, the host's confinement, process groups ended whole, and the model proxy.
// What is Codex's own here:
//  - its private directories: home, config, codex-home, tmp, cache (mode 0700), and an empty working directory (`work`),
//    never the host's workspace: a tool-less Codex has nothing to read there;
//  - its children speak app-server's line protocol, one JSON value per line;
//  - the proxy serves the Codex policy.
import { createInterface } from "node:readline";
import { confined as kernelConfined, openLocalMachine, type ChildCommand, type ConfineChild, type MachineBox, type MachineChild, type ModelProxyHooks, type ModelProxyOptions } from "@parcha/agentrun-kernel/host";
import type { AcquireMachine, CacheDir, SessionMachine, SessionProcess } from "./process.js";
import { brandMachine } from "./process.js";
import { codexPolicy } from "./policy.js";

export { childEnv, INHERITED_ENV } from "@parcha/agentrun-kernel/host";
export type { ChildCommand, ConfineChild, MachineBox } from "@parcha/agentrun-kernel/host";

const NAME = "agentrun-harness-codex";
const DIRS: readonly CacheDir[] = ["home", "config", "codex-home", "tmp", "cache"];

export interface LocalMachineOptions {
  /** The session's own directory. The machine makes its private directories in it and deletes only those. */
  dir: string;
  /** Start every child of the session (Codex) under the host's confinement. */
  confine?: ConfineChild;
  /** The host's box for Codex, or `unsandboxed` where the operator said there is none. Absent: none, and Codex's own
   *  tools stay off. */
  box?: MachineBox | "unsandboxed";
  /** The model proxy: the runner's hooks, the provider's price, and the session's tools and limits; its route comes
   *  from the harness. */
  proxy: {
    hooks: ModelProxyHooks;
    tools: readonly string[];
    price?: ModelProxyOptions["price"];
    maxOutputTokens?: number;
    log?: ModelProxyOptions["log"];
    fetch?: typeof fetch;
  };
  /** For tests: the process environment the allowlist reads. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export const confined = (child: ChildCommand, confine: ConfineChild | undefined): ChildCommand => kernelConfined(child, confine, NAME);

/** A child as app-server's line protocol: one JSON value per line out, lines in. */
function lineChannel(proc: MachineChild): SessionProcess {
  const { child } = proc;
  const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  return {
    send: (line) => {
      if (!proc.alive() || !child.stdin!.writable) return false;
      return child.stdin!.write(`${JSON.stringify(line)}\n`) || true;
    },
    end: () => child.stdin!.end(),
    lines: () => reader[Symbol.asyncIterator]() as unknown as AsyncIterable<string> & AsyncIterator<string>,
    exited: proc.exited,
    stderrTail: proc.stderrTail,
    alive: proc.alive,
    kill: proc.kill,
  };
}

/** A machine factory for sessions under `options.dir`: each acquire makes the directories fresh and starts a proxy. */
export function localMachine(options: LocalMachineOptions): AcquireMachine {
  const from = options.env ?? process.env;
  return async ({ ctx, model }) => {
    if (!model) throw new Error(`${NAME}: the harness gave the machine no model route`);
    const route = model.options;
    const local = await openLocalMachine<CacheDir>({
      name: NAME,
      dir: options.dir,
      dirs: DIRS,
      sessionId: ctx.runId,
      from,
      ...(options.confine ? { confine: options.confine } : {}),
      ...(options.box ? { box: options.box } : {}),
      proxy: {
        policy: codexPolicy({ model: route.models.model, tools: options.proxy.tools, ...(options.proxy.maxOutputTokens ? { maxOutputTokens: options.proxy.maxOutputTokens } : {}) }),
        hooks: options.proxy.hooks,
        model: route.models.model,
        origin: route.target,
        credential: async () => (await route.credential()) ?? "",
        ...(options.proxy.price ? { price: options.proxy.price } : {}),
        ...(options.proxy.log ? { log: options.proxy.log } : {}),
        ...(options.proxy.fetch ? { fetch: options.proxy.fetch } : {}),
      },
    });
    const machine: SessionMachine = {
      sessionId: local.sessionId,
      root: local.root,
      dirs: local.dirs,
      signal: local.signal,
      modelUrl: local.modelUrl,
      modelKey: local.modelKey,
      notes: local.notes,
      ...(local.isolation ? { isolation: local.isolation } : {}),
      spawn: async (spawnOptions) => lineChannel(local.start(spawnOptions)),
      files: local.files,
      tail: local.tail,
      fsync: local.fsync,
      close: local.close,
    };
    return brandMachine(machine);
  };
}
