// The box a harness process runs in, as the kernel sees it: a spec of what the box may reach, the record that names a
// box on disk before it runs, and the two operations, start and reap. Written for AgentRun.
//
// A box is the standard isolation (bubblewrap on Linux): the harness runs as the server's own uid inside its own user,
// pid, mount and network namespaces, and sees only what the spec binds. Its exit code and its output are never evidence
// of anything: only the kernel's own count (the processes in the box's pid namespace, or its cgroup's population) says
// a box is empty.
import type { ChildProcess } from "node:child_process";

/** What a box may reach. Everything else of the host is absent inside it. */
export interface BoxSpec {
  /** The one directory the machine lent this session and built it from (its base): the workspace and every home lie at
   *  or under it, resolved. Under serve's data root, the server's home or a CLI's config, a box binds nothing else
   *  writable. It is never bound itself. */
  session: string;
  /** Bound read-write at its own host path, which is the box's working directory (--chdir), and at /workspace too. */
  workspace: string;
  /** The harness's homes (per-run directories, never the server's $HOME), each bound read-write at its own path. */
  homes: Record<string, string>;
  /** Read-only, at their own paths, beside the system allowlist: node and the pinned CLIs. */
  readOnly: readonly string[];
  /** The model front's Unix socket, bound at /run/agentrun/model.sock. */
  modelSocket: string;
  /** The forwarder's loopback port in the box (the forwarder is the caller's to start). */
  modelPort: number;
  /** The egress proxy's Unix socket, bound at /run/agentrun/egress.sock; absent when the box has no egress. */
  egressSocket?: string;
  egressPort?: number;
  /** The box's whole environment: --clearenv, then one --setenv each. Nothing is inherited. */
  env: Record<string, string>;
  /** On a shared server: the run's cgroup v2, a path under the delegated subtree. */
  cgroup?: string;
}

/** A box as it is recorded on disk: its id and cgroup before it starts, then its pid 1, that pid's start time (clock
 *  ticks since boot, /proc/<pid>/stat field 22) and its pid namespace (`pid:[<inode>]`). */
export interface BoxRecord {
  id: string;
  cgroup?: string;
  pid?: number;
  startTime?: string;
  pidns?: string;
  /** The run process that wrote the record (its pid and start time): a record nobody could count clears only once its
   *  writer is gone. */
  writer: { pid: number; startTime: string };
}

/** Where a box's record goes. `ahead` is synchronous (the file and its directory are synced before it returns) and runs
 *  before the spawn; `started` runs while bwrap waits, and no process of the harness runs until it resolves. */
export interface BoxRecorder {
  ahead(record: BoxRecord): void;
  started(record: BoxRecord): Promise<void>;
}

/** A started box: the bwrap process (its stdio is the harness's), and its record, complete once `ready` resolves. */
export interface BoxedChild {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrTail(): string;
  alive(): boolean;
  /** Ends the box: SIGKILL to its pid 1 (start time checked), which takes every process of its namespace with it. */
  kill(): void;
  /** The record so far: the id and cgroup at once, the pid, start time and pid namespace once `ready` resolves. */
  readonly record: BoxRecord;
  /** Resolves once the pid is recorded and the box released; rejects (bwrap killed, the harness never ran) when bwrap
   *  could not start or `started` failed. */
  readonly ready: Promise<BoxRecord>;
}

/** What a reap found, by the kernel's own count: the processes left in the recorded pid namespace, or the cgroup's.
 *  `none`: the record names neither a pid nor a cgroup, so there was nothing to count (a crash before the pid was
 *  known; --die-with-parent ends such a box with its parent). */
export interface Reaped {
  empty: boolean;
  left: number;
  by: "pidns" | "cgroup" | "none";
}

export type Isolation =
  | { mode: "bwrap" | "seatbelt" | "provider"; cgroup: boolean }
  /** Only from AGENTRUN_BOX=unsandboxed, the operator's setting. */
  | { mode: "unsandboxed" }
  | { mode: "unavailable"; error: BoxErrorCode; detail: string };

export type BoxErrorCode =
  | "bwrap_missing" | "bwrap_setuid" | "bwrap_userns_denied" | "box_probe_failed"
  /** The start probe's box did not finish within its deadline from the spawn, and was killed. */
  | "box_probe_timeout"
  | "box_refused" | "box_record_failed" | "box_start_failed"
  /** A start while the session's last box is live, being reaped, or was not confirmed empty. */
  | "box_busy"
  /** A reap whose own count was not 0. */
  | "box_not_empty";

export interface Box {
  readonly isolation: Isolation;
  start(spec: BoxSpec, child: { command: string; args: string[] }, record: BoxRecorder): BoxedChild;
  reap(record: BoxRecord): Promise<Reaped>;
}

/** A box refused or failed, with its named cause. */
export class BoxError extends Error {
  readonly code: BoxErrorCode;
  /** For `box_not_empty`: the box, and what its reap left. */
  readonly record?: BoxRecord;
  readonly left?: number;
  constructor(code: BoxErrorCode, message: string, options?: { cause?: unknown; record?: BoxRecord; left?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BoxError";
    this.code = code;
    if (options?.record) this.record = options.record;
    if (options?.left !== undefined) this.left = options.left;
  }
}
