// The local session machine, written for AgentRun: where a session's Codex runs when the host runs it on its own box.
//  - The session gets private directories under its own directory (home, config, codex-home, tmp, cache; mode 0700),
//    and an empty working directory (`work`), never the host's workspace: a tool-less Codex has nothing to read there.
//  - A child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its homes,
//    and the per-session proxy key). Nothing else is inherited, so no provider key, token or host secret reaches it.
//  - Each child runs in its own process group, which kill() and close() end whole.
//  - The model proxy (proxy.ts) starts with the machine and stops with it.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";
import { FileTail } from "@parcha/agentrun-adapters/process";
import type { AcquireMachine, CacheDir, CacheFile, KillSignal, MachineSpawn, MachineTail, SessionMachine, SessionProcess } from "./process.js";
import { brandMachine } from "./process.js";
import { startModelProxy, type ModelProxyOptions } from "./proxy.js";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);
const DIRS: readonly CacheDir[] = ["home", "config", "codex-home", "tmp", "cache"];
const STDERR_TAIL = 8 * 1024;

export interface LocalMachineOptions {
  /** The session's own directory. The machine makes its private directories in it and deletes only those. */
  dir: string;
  /** The model proxy's hooks and limits; its route comes from the harness. */
  proxy: Omit<ModelProxyOptions, "route">;
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

/** A path inside `base`, from a relative one; anything that would leave it throws. */
function inside(base: string, rel: string): string {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.includes("\0")) throw new Error(`agentrun-codex: ${JSON.stringify(String(rel).slice(0, 80))} is not a relative path`);
  const path = normalize(join(base, rel));
  if (!path.startsWith(base + sep)) throw new Error(`agentrun-codex: ${JSON.stringify(rel.slice(0, 80))} leaves the session's directory`);
  return path;
}

function start(options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string): SessionProcess {
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
    const proxy = await startModelProxy({ ...options.proxy, route: model.options }, key);
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
      notes: [],
      spawn: async (spawnOptions) => {
        if (closed) throw new Error("agentrun-codex: the session machine is closed");
        const proc = start(spawnOptions, from, root);
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
