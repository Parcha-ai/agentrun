// The local session machine, written for AgentRun: where a session's Codex runs when the host runs it on its own box.
//  - The session gets private directories under its own directory (home, config, codex-home, tmp, cache; mode 0700),
//    and an empty working directory (`work`), never the host's workspace: a tool-less Codex has nothing to read there.
//  - A child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its homes,
//    and the per-session proxy key). Nothing else is inherited, so no provider key, token or host secret reaches it.
//  - A child's git stops at the session's directory (GIT_CEILING_DIRECTORIES), and the host may start every child under its
//    own confinement, in front of the command.
//  - Each child runs in its own process group, which kill() and close() end whole.
//  - The model proxy (@parcha/agentrun-adapters/host, with the Codex policy) starts with the machine and stops with it.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";
import { FileTail } from "@parcha/agentrun-adapters/process";
import type { AcquireMachine, CacheDir, CacheFile, KillSignal, MachineSpawn, MachineTail, SessionMachine, SessionProcess } from "./process.js";
import { brandMachine } from "./process.js";
import { startModelProxy, type ModelProxyHooks, type ModelProxyOptions } from "@parcha/agentrun-adapters/host";
import { codexPolicy } from "./policy.js";
import { UNWATCHED } from "../scripts.js";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);
const DIRS: readonly CacheDir[] = ["home", "config", "codex-home", "tmp", "cache"];
const STDERR_TAIL = 8 * 1024;

export interface LocalMachineOptions {
  /** The session's own directory. The machine makes its private directories in it and deletes only those. */
  dir: string;
  /** Start every child of the session (Codex) under the host's confinement. */
  confine?: ConfineChild;
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

/** A command and its arguments, as the machine starts it. */
export interface ChildCommand {
  command: string;
  args: string[];
}

/** The host's confinement of a child: the same command and arguments, started under the host's own (a
 *  `setpriv --no-new-privs` prefix, say). It may only add in front: what it returns must end with the command and its
 *  arguments unchanged, and it never sees or changes the child's environment. */
export type ConfineChild = (child: Readonly<ChildCommand>) => ChildCommand;

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export function confined(child: ChildCommand, confine: ConfineChild | undefined): ChildCommand {
  if (!confine) return child;
  const out = confine({ command: child.command, args: [...child.args] });
  const argv = [out?.command, ...(Array.isArray(out?.args) ? out.args : [])];
  const tail = argv.slice(argv.length - child.args.length - 1);
  const kept = argv.length > child.args.length + 1 && tail.length === child.args.length + 1 && tail.every((a, i) => a === (i === 0 ? child.command : child.args[i - 1]));
  if (typeof out?.command !== "string" || !argv.every((a) => typeof a === "string") || !kept) throw new Error("agentrun-codex: the host's confinement must start the child's own command and arguments, after its own");
  return { command: out.command, args: out.args };
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

/** A path inside `base`, from a relative one; anything that would leave it throws. */
function inside(base: string, rel: string): string {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.includes("\0")) throw new Error(`agentrun-codex: ${JSON.stringify(String(rel).slice(0, 80))} is not a relative path`);
  const path = normalize(join(base, rel));
  if (!path.startsWith(base + sep)) throw new Error(`agentrun-codex: ${JSON.stringify(rel.slice(0, 80))} leaves the session's directory`);
  return path;
}

/** Start a child of the session. Its git stops at `ceiling` (the session's directory): it never looks for a repository
 *  above the session, in a parent the model could write, whose branch and remote would otherwise reach the records. */
function start(options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string, ceiling: string, confine?: ConfineChild): SessionProcess {
  const run = confined({ command: options.command, args: options.args ?? [] }, confine);
  const child = spawnChild(run.command, run.args, {
    cwd: options.cwd ?? cwd,
    env: { ...childEnv(from, options.env), GIT_CEILING_DIRECTORIES: ceiling },
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
  const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  return {
    send: (line) => {
      if (done || !child.stdin!.writable) return false;
      return child.stdin!.write(`${JSON.stringify(line)}\n`) || true;
    },
    end: () => child.stdin!.end(),
    lines: () => reader[Symbol.asyncIterator]() as unknown as AsyncIterable<string> & AsyncIterator<string>,
    exited,
    stderrTail: () => stderr,
    alive: () => !done,
    kill,
  };
}

/** A machine factory for sessions under `options.dir`: each acquire makes the directories fresh and starts a proxy. */
export function localMachine(options: LocalMachineOptions): AcquireMachine {
  const from = options.env ?? process.env;
  return async ({ ctx, model }) => {
    if (!model) throw new Error("agentrun-codex: the harness gave the machine no model route");
    const base = normalize(options.dir);
    if (!isAbsolute(base)) throw new Error("agentrun-codex: the session directory must be an absolute path");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dirs = Object.fromEntries(DIRS.map((d) => [d, join(base, d)])) as Record<CacheDir, string>;
    const root = join(base, "work");
    for (const dir of [...Object.values(dirs), root]) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const key = randomBytes(32).toString("base64url");
    const route = model.options;
    // The code-mode `exec` the model proxy's latest answer carried: set while the answer passes, before Codex has it.
    let announced: string | undefined;
    let open = 0;
    const proxy = await startModelProxy({
      policy: codexPolicy({
        model: route.models.model,
        tools: options.proxy.tools,
        ...(options.proxy.maxOutputTokens ? { maxOutputTokens: options.proxy.maxOutputTokens } : {}),
        announce: {
          // The cost is liveness, not safety: after an overlap a never call is declined until the next single answer, which the model's
          // next wait or exec gives.
          // A second answer that starts while one is open (a background call beside the turn) makes every tie ambiguous until both have
          // ended: which of them carried which exec cannot be told. A failed watch, likewise, stands for an exec not seen.
          response: () => {
            open += 1;
            announced = open > 1 ? UNWATCHED : undefined;
          },
          exec: (callId) => void (announced = open > 1 || announced === UNWATCHED ? UNWATCHED : callId),
          failed: () => void (announced = UNWATCHED),
          end: () => void (open = Math.max(0, open - 1)),
        },
      }),
      hooks: options.proxy.hooks,
      model: route.models.model,
      origin: route.target,
      credential: async () => (await route.credential()) ?? "",
      ...(options.proxy.price ? { price: options.proxy.price } : {}),
      ...(options.proxy.log ? { log: options.proxy.log } : {}),
      ...(options.proxy.fetch ? { fetch: options.proxy.fetch } : {}),
    }, key);
    const lost = new AbortController();
    const children = new Set<SessionProcess>();
    let closed = false;

    const machine: SessionMachine = {
      sessionId: ctx.runId,
      root,
      dirs,
      signal: lost.signal,
      modelUrl: proxy.url,
      modelKey: key,
      announcedExec: () => announced,
      notes: [],
      spawn: async (spawnOptions) => {
        if (closed) throw new Error("agentrun-codex: the session machine is closed");
        const proc = start(spawnOptions, from, root, base, options.confine);
        children.add(proc);
        void proc.exited.then(() => children.delete(proc));
        return proc;
      },
      files: {
        upload: async (dir: CacheDir, files: readonly CacheFile[]) => {
          for (const file of files) {
            const path = inside(dirs[dir], file.path);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, file.bytes, { mode: file.mode ?? 0o600 });
          }
        },
        wipe: async () => {
          for (const dir of Object.values(dirs)) {
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true, mode: 0o700 });
          }
        },
      },
      tail: async (dir: CacheDir, path: string, tailOptions = {}): Promise<MachineTail> => {
        const file = inside(dirs[dir], path);
        const tail = new FileTail(file, tailOptions.offset ?? 0);
        return {
          get offset() { return tail.offset; },
          read: () => {
            // Only the file Codex wrote: a link put in its place is not followed.
            try {
              if (lstatSync(file).isSymbolicLink()) throw new Error(`agentrun-codex: ${path} is a link`);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
            return tail.read();
          },
          // A local file is read to its end on every read.
          sync: async () => {},
          close: () => {},
        };
      },
      // A tool-less session writes no files of its own to flush.
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
