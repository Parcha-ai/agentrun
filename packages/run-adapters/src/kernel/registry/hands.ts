// The run's hands, as the registry's tools reach them: Workspace(run) on the host's side (a folder on this machine, the
// run's Archil disk, or an attached computer), given to each call. The kernel never knows which.
import { constants } from "node:os";
import type { ToolImage } from "../../types.js";

/** How one exec ended: its exit code, or the signal that ended it (exitCode null), and whether its timeout did. */
export type ExecResult = { readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean };

/** The exit code a shell would report: the code, or 128 + n for signal n (any signal the system names); undefined when
 *  it is not known. */
export function exitCodeOf(result: ExecResult): number | undefined {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === null) return undefined;
  const n = (constants.signals as Readonly<Record<string, number | undefined>>)[`SIG${result.signal.replace(/^SIG/, "")}`];
  return n === undefined ? undefined : 128 + n;
}

/** A process the computer runs, as the background tools read it: its argv (which marks a background one), whether it
 *  runs, how it ended, when it started, and whether it has a terminal. */
export type ProcessInfo = {
  readonly handle: string;
  readonly argv: readonly string[];
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly pty: boolean;
};

/** The computer's processes, as the five background tools use them, and nothing more. A refusal throws an error with a
 *  `code` ("not_found", "invalid", "denied", ...) and the computer's words. Paths are the run's folder's. */
export type Processes = {
  /** Starts `argv` in `cwd`; its stdout and stderr go to `log` (the first 16 MiB, made never through a link); the
   *  process runs until it and its group (on a terminal, its session) have ended, and what leaves the group is kept. */
  start(spec: { readonly argv: readonly string[]; readonly cwd: string; readonly log: string; readonly waitGroup: true; readonly orphans: "keep"; readonly stdin?: true; readonly pty?: { readonly cols: number; readonly rows: number } }): Promise<{ handle: string; pid: number }>;
  /** At most `maxBytes` of its log from `offset`, the log's size, and whether output past the cap was dropped. A read
   *  past the end is refused ("invalid"). */
  read(handle: string, range: { readonly offset: number; readonly maxBytes: number }): Promise<{ data: Uint8Array; size: number; capped: boolean }>;
  write(handle: string, input: { readonly data?: Uint8Array; readonly close?: true }): Promise<void>;
  /** The signal to its group; on a terminal, INT to its foreground job. `note`: what the computer adds to say. */
  signal(handle: string, name: "TERM" | "INT" | "KILL"): Promise<{ note?: string }>;
  list(): Promise<readonly ProcessInfo[]>;
};

/** What a host tool does with the run's files and shell. */
export type Hands = {
  /** The longest one exec may run, in seconds: 600 locally and on a computer, 295 on Archil's exec. */
  readonly maxExecS: number;
  stat(path: string): Promise<{ kind: "file" | "dir" | "link"; size: number; mtimeMs: number } | undefined>;
  read(path: string, range?: { offset?: number; length?: number }): Promise<Uint8Array>;
  /** Durable when it returns. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<readonly { name: string; kind: "file" | "dir" | "link"; size: number }[]>;
  grep(pattern: string, path: string, options?: { glob?: string; ignoreCase?: boolean; maxMatches?: number }): Promise<string>;
  /** `command` run by the run's shell (`bash -c`, a fixed minimal env) in the run's folder, stdin /dev/null, for at most
   *  `timeoutS`: its exit code, or the signal that ended it, and whether the timeout did. An abort throws. */
  exec(command: string, options: { timeoutS: number; onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void }, signal?: AbortSignal): Promise<ExecResult>;
  /** The attached computer's processes; absent with no computer, where the background tools are refused. */
  readonly processes?: Processes;
};

/** A tool's answer: the text the model reads (and its images), with details for the run's timeline. A failure is an
 *  answer too: `error` holds its words, apart from the output, so what the call printed before it failed is kept. The
 *  host shows `[text, error, ...diagnostics' messages].join("\n\n")`. Only an abort throws. */
export type ToolAnswer = {
  readonly text: string;
  readonly error?: string;
  readonly images?: readonly ToolImage[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly diagnostics?: readonly { readonly severity: "info" | "warn" | "error"; readonly code?: string; readonly message: string }[];
};

/** One call's world: the run's hands, the call's signal, where output streamed while it runs goes, and (passed through,
 *  unread by the kernel) the call's model, whose image limits a host's read may use. */
export type ToolCall = { readonly hands: Hands; readonly signal?: AbortSignal; output?(chunk: string): void; readonly model?: unknown };

/** An executor's failure as an answer: an abort (the call's signal aborted) throws; any other error is its words. */
export async function answerOf(call: ToolCall, run: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
  try {
    return await run();
  } catch (error) {
    if (call.signal?.aborted) throw call.signal.reason ?? error;
    return { text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** A host tool's run. */
export type Executor = (args: unknown, call: ToolCall) => Promise<ToolAnswer>;

/** What the host gives the registry, by tool name: read, write and edit, and bash's own run, which the registry bounds. */
export type HostExecutors = Readonly<Partial<Record<"read" | "write" | "edit" | "bash", Executor>>>;
