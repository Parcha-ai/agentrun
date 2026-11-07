// The box a harness process runs in, as the kernel names it: the record that names a box on disk before it runs, what a
// reap found, and the error a box is refused or fails with. Written for AgentRun.
//
// A box is the standard isolation (bubblewrap on Linux): the harness runs as the server's own uid inside its own user,
// pid, mount and network namespaces, and sees only what the spec binds. Its exit code and its output are never evidence
// of anything: only the kernel's own count (the processes in the box's pid namespace, or its cgroup's population) says
// a box is empty.

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

/** What a reap found, by the kernel's own count: the processes left in the recorded pid namespace, or the cgroup's.
 *  `none`: the record names neither a pid nor a cgroup, so there was nothing to count (a crash before the pid was
 *  known; --die-with-parent ends such a box with its parent). */
export interface Reaped {
  empty: boolean;
  left: number;
  by: "pidns" | "cgroup" | "none";
}

export type BoxErrorCode =
  | "bwrap_missing" | "bwrap_setuid" | "bwrap_userns_denied" | "box_probe_failed"
  | "box_refused" | "box_record_failed" | "box_start_failed"
  /** A start while the session's last box is live, being reaped, or was not confirmed empty. */
  | "box_busy"
  /** A reap whose own count was not 0. */
  | "box_not_empty";

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
