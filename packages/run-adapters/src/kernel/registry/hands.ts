// The run's hands, as the registry's tools reach them: Workspace(run) on the host's side (a folder on this machine, the
// run's Archil disk, or an attached computer), given to each call. The kernel never knows which.
import type { ToolImage } from "../../types.js";

/** How one exec ended: its exit code, or the signal that ended it (exitCode null), and whether its timeout did. */
export type ExecResult = { readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean };

/** The exit code a shell would report: the code, or 128 + n for signal n; undefined when it is not known. */
export function exitCodeOf(result: ExecResult): number | undefined {
  if (result.exitCode !== null) return result.exitCode;
  const n = result.signal === null ? undefined : SIGNAL_NUMBERS[result.signal.replace(/^SIG/, "")];
  return n === undefined ? undefined : 128 + n;
}
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { HUP: 1, INT: 2, QUIT: 3, ABRT: 6, KILL: 9, PIPE: 13, ALRM: 14, TERM: 15 };

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
};

/** A tool's answer: the text the model reads (and its images), with details for the run's timeline. A failure throws. */
export type ToolAnswer = {
  readonly text: string;
  readonly images?: readonly ToolImage[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly diagnostics?: readonly { readonly severity: "info" | "warn" | "error"; readonly code?: string; readonly message: string }[];
};

/** One call's world: the run's hands, the call's signal, and where output streamed while it runs goes. */
export type ToolCall = { readonly hands: Hands; readonly signal?: AbortSignal; output?(chunk: string): void };

/** A host tool's run. */
export type Executor = (args: unknown, call: ToolCall) => Promise<ToolAnswer>;

/** What the host gives the registry, by tool name: read, write and edit, and bash's own run, which the registry bounds. */
export type HostExecutors = Readonly<Partial<Record<"read" | "write" | "edit" | "bash", Executor>>>;
