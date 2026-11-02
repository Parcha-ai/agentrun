// The Claude Agent SDK's `spawnClaudeCodeProcess` on the session's local machine, written for AgentRun. The CLI runs on
// the machine the SDK runs on, so its transcript paths need no mapping; the hook's job is to start exactly the child the
// harness named, with exactly its environment:
//  - the command is the pinned binary (`executable`), nothing else;
//  - the SDK's env must be there, and hold only the variables the harness gave it (each with the harness's value) and the
//    SDK's own markers. Its `CLAUDE_CONFIG_DIR` is the harness's, or, on a resume, the `claude-resume-*` dir the SDK made
//    under this process's temporary dir, which may hold only the transcript (`projects/**`, regular files): a
//    credential or settings file in it is refused;
//  - the child starts through the machine (machine.ts): the allowlisted environment, its own process group, the session's
//    working directory, ended with the drive and with the machine.
// A child that can't start is reported to `onError` (the harness halts the drive) and as the process's `error` event.
import { EventEmitter } from "node:events";
import { lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { ClaudeAgentPinMismatch } from "./errors.js";
import type { LocalSessionMachine } from "./host/machine.js";
import { CLAUDE_AGENT_SDK_VERSION } from "./versions.js";
import type { SessionMachine, SessionProcess } from "./host/process.js";

/** The SDK's `SpawnOptions`, structurally. */
export interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** The SDK's `SpawnedProcess`, structurally. */
export interface SdkSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit" | "error", listener: (...args: any[]) => void): void;
  once(event: "exit" | "error", listener: (...args: any[]) => void): void;
  off(event: "exit" | "error", listener: (...args: any[]) => void): void;
}

/** The variables the SDK adds to the env it was given: its own markers, which the CLI reads. */
export const SDK_ENV_MARKERS: ReadonlySet<string> = new Set(["CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_READS_SESSION_STATE"]);

export interface SandboxSpawnOptions {
  /** The session's machine (branded: the harness checked it). */
  machine: SessionMachine;
  /** The pinned binary: the only command this spawns. */
  executable: string;
  /** The env the harness gave the SDK (`query()`'s `env`). */
  env: Readonly<Record<string, string>>;
  /** The drive's signal: aborting it kills the child. */
  signal: AbortSignal;
  /** The child could not be started. */
  onError: (err: unknown) => void;
  /** The child is running. */
  onSpawn?: (proc: SessionProcess) => void;
  /** A transcript mirror line that doesn't map. Locally every line maps, so this is never called. */
  onUnmapped?: (why: string) => void;
  /** Runs before the spawn. */
  prepare?: () => Promise<void> | void;
  isolatedCommands?: boolean;
}

/** Whether `path` is a resume dir the SDK made (a `claude-resume-*` directly under `os.tmpdir()`). */
export function isResumeDir(path: string): boolean {
  return resolve(dirname(path)) === resolve(tmpdir()) && basename(path).startsWith("claude-resume-");
}

/** Why a resume dir holds more than the transcript (`projects/**`, regular files), if it does. */
export function resumeProblem(dir: string): string | undefined {
  const walk = (rel: string): string | undefined => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = lstatSync(join(dir, path));
      if (!rel && path !== "projects") return `${path} is beside the transcript`;
      if (stat.isSymbolicLink()) return `${path} is a link`;
      if (stat.isDirectory()) {
        const inner = walk(path);
        if (inner) return inner;
      } else if (!stat.isFile()) return `${path} is not a regular file`;
    }
    return undefined;
  };
  try {
    return walk("");
  } catch (error) {
    return `it could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`;
  }
}

/** Why the SDK's spawn request is not the one the harness named, if it isn't. */
export function spawnProblem(request: SdkSpawnOptions, options: Pick<SandboxSpawnOptions, "executable" | "env">): string | undefined {
  if (request.command !== options.executable) return `the command ${JSON.stringify(String(request.command).slice(0, 120))} is not the pinned binary`;
  if (!request.env || typeof request.env !== "object") return "the SDK passed no env";
  for (const [name, value] of Object.entries(request.env)) {
    if (value === undefined || SDK_ENV_MARKERS.has(name)) continue;
    if (!(name in options.env)) return `the variable ${name.slice(0, 60)} is not one the harness gave`;
    if (name === "CLAUDE_CONFIG_DIR" && value !== options.env[name]) {
      if (!isResumeDir(value)) return "CLAUDE_CONFIG_DIR is neither the session's nor the SDK's resume dir";
      const problem = resumeProblem(value);
      if (problem) return `the resume dir holds more than the transcript: ${problem}`;
      continue;
    }
    if (value !== options.env[name]) return `the variable ${name.slice(0, 60)} does not have the harness's value`;
  }
  for (const name of Object.keys(options.env)) if (request.env[name] === undefined) return `the variable ${name.slice(0, 60)} is missing`;
  return undefined;
}

/** A process that never started: its streams are empty, and it reports `error` then `exit`. */
function failed(error: Error): SdkSpawnedProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  setImmediate(() => {
    events.emit("error", error);
    stdout.end();
    events.emit("exit", 1, null);
  });
  return {
    stdin: new PassThrough(),
    stdout,
    killed: false,
    exitCode: 1,
    signalCode: null,
    kill: () => false,
    on: (event, listener) => void events.on(event, listener),
    once: (event, listener) => void events.once(event, listener),
    off: (event, listener) => void events.off(event, listener),
  };
}

/** The spawn hook for the session's machine. */
export function sandboxSpawn(options: SandboxSpawnOptions): (request: SdkSpawnOptions) => SdkSpawnedProcess {
  return (request) => {
    const refuse = (why: string) => {
      const error = new Error(`agentrun-harness-claude: the CLI was not started: ${why}`);
      options.onError(error);
      return failed(error);
    };
    const machine = options.machine as Partial<LocalSessionMachine>;
    if (typeof machine.start !== "function") return refuse("the session's machine is not a local one");
    // The SDK says its own version to the CLI it starts: one that is not the pinned release starts nothing.
    const sdkVersion = request.env?.CLAUDE_AGENT_SDK_VERSION;
    if (sdkVersion !== undefined && sdkVersion !== CLAUDE_AGENT_SDK_VERSION) {
      const error = new ClaudeAgentPinMismatch("sdk_version", CLAUDE_AGENT_SDK_VERSION, String(sdkVersion).slice(0, 40));
      options.onError(error);
      return failed(error);
    }
    const problem = spawnProblem(request, options);
    if (problem) return refuse(problem);
    const env = Object.fromEntries(Object.entries(request.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    try {
      const proc = machine.start({ command: options.executable, args: request.args ?? [], env, cwd: options.machine.root, signal: AbortSignal.any([options.signal, request.signal]) });
      options.onSpawn?.(proc);
      return proc.child as unknown as SdkSpawnedProcess;
    } catch (error) {
      return refuse(String((error as Error)?.message ?? error).slice(0, 200));
    }
  };
}
