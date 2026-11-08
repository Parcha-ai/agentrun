// The Workspace: the one way serve touches a run's files, or an agent's learning folder. One Workspace is scoped to ONE
// root folder and takes paths relative to it only (paths.ts). Two backends answer it: Local (a folder on this machine,
// local.ts) and, next, Archil (the owner's disk through its file API and serverless exec). Nothing on main uses it yet:
// the writers move onto it in one cutover.
//
// Rules every backend keeps:
// - Every write is durable on return: write, append, mkdir and remove return only once what they did would survive a
//   crash of the machine. write is atomic too: a reader, or a crash, sees the old file or the new one, never half.
// - A path is relative, normalized, and never leaves the root: an absolute path, "..", ".", an empty segment, a NUL or a
//   backslash is ESCAPE, and so is a symbolic link anywhere on the way, the last part included. Nothing is followed.
// - The port does not serialize. Two calls on one path race as two processes would; callers own their ordering (the
//   learning queue keeps one per agent, with git's update-ref compare-and-swap as its fence).

import type { Computer, MountSpec, Processes } from "./attach.js";

/** Why a workspace call failed. */
export type WorkspaceErrorCode =
  /** The path, or the program exec was asked to run, is not there. */
  | "NOT_FOUND"
  /** The path would leave the root: absolute, "..", a bad segment, or a symbolic link on the way. Nothing was touched. */
  | "ESCAPE"
  /** More than the call allows (a read past READ_MAX). */
  | "TOO_LARGE"
  /** The call ran past its deadline. exec reports its own deadline as `timedOut`, not as this. */
  | "TIMEOUT"
  /** The backend cannot answer: the root is gone, the disk is full or read-only, an I/O error. */
  | "UNAVAILABLE"
  /** The call is not allowed on what is there: a directory read as a file, a non-empty directory removed without
   *  `recursive`, a bad regex, or a method this backend does not have yet. */
  | "REFUSED"
  /** Something is in the way: a file where a directory has to be made. */
  | "EXISTS";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /** The relative path the call was about, when there is one. */
  readonly path: string | undefined;
  constructor(code: WorkspaceErrorCode, message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceError";
    this.code = code;
    this.path = options?.path;
  }
}

export const isWorkspaceError = (error: unknown, code?: WorkspaceErrorCode): error is WorkspaceError =>
  error instanceof WorkspaceError && (code === undefined || error.code === code);

/** One entry of a directory. Only files and directories are listed: a symbolic link, a pipe or a socket is left out. */
export type Entry = { readonly name: string; readonly kind: "file" | "dir"; readonly size: number };

/** One line grep found. `line` counts from 1; `text` is the line, cut at GREP_LINE_MAX characters. */
export type GrepMatch = { readonly path: string; readonly line: number; readonly text: string };

/** What grep found, and whether it stopped early: at `max` matches, or at its time cap. */
export type GrepResult = { readonly matches: readonly GrepMatch[]; readonly truncated: false | "max" | "time" };

export type GrepOptions = {
  /** The file or directory searched, relative to the root (default: the whole root). */
  readonly path?: string;
  /** Only files whose path matches: `*`, `**` and `?`. A glob with no "/" is matched against the file's name, one with
   *  a "/" against its path from the root. */
  readonly glob?: string;
  /** The most matches returned (default and ceiling GREP_MAX). */
  readonly max?: number;
  /** How long it searches before it stops and returns what it has, truncated "time" (default and ceiling
   *  GREP_TIME_MS). The deadline holds whatever the regex does: the search is stopped, not asked. */
  readonly timeMs?: number;
};

export type ExecOptions = {
  /** The directory it runs in, relative to the root (default: the root). Checked as every path is. */
  readonly cwd?: string;
  /** The whole environment: nothing is inherited, so no HOME and no PATH unless they are here. */
  readonly env: Readonly<Record<string, string>>;
  /** Bytes for its stdin (default: none, stdin at end of file). */
  readonly stdin?: Uint8Array;
  /** The deadline. At it, the whole process group is killed and `timedOut` is true. */
  readonly timeoutMs: number;
  /** The most bytes kept of stdout, and of stderr, each (default EXEC_OUTPUT_MAX). Past it the rest is read and
   *  dropped, and `truncated` is true. */
  readonly maxOutput?: number;
  /** Each piece of output as it comes, within the cap: what it is given, joined per stream, is the result's stdout
   *  and stderr. A backend that cannot stream calls it once per stream, at the end, with everything. An error it
   *  throws is ignored. */
  readonly onOutput?: (chunk: { readonly stream: "stdout" | "stderr"; readonly data: Uint8Array }) => void;
};

export type ExecResult = {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  /** Its exit code, or null when a signal ended it (the deadline's kill included). */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** stdout or stderr went past `maxOutput`, and was cut. */
  readonly truncated: boolean;
};

/** The most bytes one read returns (a read asking for more, or of a bigger file with no `length`, is TOO_LARGE). */
export const READ_MAX = 64 * 1024 * 1024;
/** grep's default and its ceiling on matches. */
export const GREP_MAX = 1000;
/** How long one grep searches before it returns what it has (truncated "time"). */
export const GREP_TIME_MS = 10_000;
/** A file bigger than this is skipped by grep. */
export const GREP_FILE_MAX = 8 * 1024 * 1024;
/** The most characters of one matching line grep returns. */
export const GREP_LINE_MAX = 500;
/** exec's default cap on stdout, and on stderr, each. */
export const EXEC_OUTPUT_MAX = 16 * 1024 * 1024;

/** A run's folder, or an agent's learning folder: every path is relative to its root. */
export interface Workspace {
  /** The bytes of file `path`, or `length` of them from `offset` (a range past the end gives what is there). */
  read(path: string, range?: { readonly offset?: number; readonly length?: number }): Promise<Uint8Array>;
  /** File `path` replaced by `data` (a string is UTF-8), atomically and durably; its parent directories made. An
   *  existing file keeps its mode. */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** `data` added at the end of file `path`, durably; the file and its parents made when absent. A backend may split
   *  a large append into several (a disk API that takes a bounded size per call), so a reader during it can see part
   *  of `data` at the end; once it returns, all of it is there, in order. */
  append(path: string, data: Uint8Array | string): Promise<void>;
  /** The files and directories in directory `dir` ("" or "." for the root), sorted by name. */
  list(dir: string): Promise<Entry[]>;
  /** Directory `dir` made, with its parents (mkdir -p); one already there is fine. */
  mkdir(dir: string): Promise<void>;
  /** Lines matching the regex `pattern` (JavaScript syntax), in files under `options.path`, binary files skipped. */
  grep(pattern: string, options?: GrepOptions): Promise<GrepResult>;
  /** `path` removed: a file, an empty directory, or with `recursive` a whole tree (a link inside it is removed, never
   *  followed). Absent is NOT_FOUND unless `force`. The root itself is never removed. */
  remove(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  /** `argv` run (a program and its arguments, not a shell line: bash is ["bash", "-lc", line]) in its own process
   *  group, stdin and stdout as bytes. Nothing it starts outlives it: when it exits, or at the deadline, the group is
   *  killed. A nonzero exit is a result, not an error; a program that is not there is NOT_FOUND. */
  exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult>;
  /** Background programs: the computer's process calls, which the background tools make through the Workspace. With
   *  no computer attached, every call is REFUSED in words (attach.ts BACKGROUND_REFUSAL). */
  readonly process: Processes;
  /** What a computer mounts at /workspace to hold this Workspace's folder: the caller puts it in the computer's spec. */
  mountSpec(): Promise<MountSpec>;
  /** This Workspace inside `computer`, once the computer's read-back shows it mounts mountSpec() at /workspace: file
   *  calls and exec go to the computer, and `process` is the computer's (attach.ts). */
  attach(computer: Computer): Promise<Workspace>;
}
