// Workspace exec on an Archil disk: one serverless exec call (archil-disk.ts) that mounts the workspace's folder and
// its exec spill folder, and nothing else of the disk. Taken from pi-transport's box/archil-exec.ts, which has no
// caller: the call, its 300 s cut, the hold on the folder with a queue, and the mapping of the exit and of the deadline.
// The rest (boxes, records, sweeps) is not.
//
// Archil runs one shell line in a fresh container with two folders of the disk, each a mount's `subdirectory`, held for
// the line (no other client writes in them meanwhile; a second one waits up to queueMs):
// - /mnt/archil/work: the workspace's folder, where the program runs;
// - /mnt/archil/out: its spill folder, BESIDE it and never inside it (archil.ts spillFolderOf), which holds this call's
//   stdin and output files. The workspace's file calls are rooted at the folder, so they never meet them.
// The rest of the owner's disk (other runs, the learning folders) is not in the container at all. Archil answers once
// the line ended, stdout and stderr as text, and cuts that answer somewhere below 14 MB (measured live), so the
// program's output never rides in it: the line spills it to files that are read back through the file API.
// The Workspace port wants argv, the whole environment, binary stdin and stdout, a deadline that kills everything the
// program started, and capped output, so the line this module writes:
// - walks to the cwd one folder at a time from the mount, refusing a symbolic link on the way (only an exec can make
//   one; the file API makes none);
// - takes stdin from <out>/<name>.in, which the caller put there, because a call's command line has a length limit and
//   stdin has none;
// - runs the program as `env -i -- NAME=value… argv…` under GNU timeout, so nothing of the container's environment
//   leaks in, in timeout's process group, which is killed when the program ends or at its deadline;
// - drains stdout and stderr through FIFOs into <out>/<name>.out and <name>.err, keeping one byte past the cap of each
//   (so a cut is seen) and discarding the rest as it comes, so a noisy program never fills the disk;
// - runs the program from a few lines of perl (perl-base is in every Debian-family image) that write its raw wait
//   status, because through timeout a program killed by a signal and one that exits 128+n look the same;
// - answers, in stdout, ONE status line carrying a marker made for this call. Whatever else is in the call's stdout or
//   stderr (a platform's message) is not read.
// Then the output files are read back with ranged GETs, up to the cap; the caller deletes all three files on every path
// (archil.ts), and sweep() clears what a killed exec left.
// A backend without streaming: onOutput gets each stream once, whole, when the line has ended.
//
// Limit, stated (not measured): whether the wait for the folders' hold counts toward Archil's 300 s (a 290 s command
// was not cut, measured live).
import { randomBytes } from "node:crypto";
import type { ArchilDisk, ArchilImage } from "./archil-disk.js";
import { type ExecResult, WorkspaceError } from "./workspace.js";

/** Archil cuts an exec call at 300 s. */
export const MAX_EXEC_MS = 300_000;
/** The longest deadline a command may ask for: 5 s of the 300 are the line's own (its walk, its drains, its answer).
 *  Anything longer is refused, not cut. */
export const COMMAND_MAX_MS = 295_000;
/** Where the folder is mounted in the container: /mnt/archil/<EXEC_MOUNT>. */
export const EXEC_MOUNT = "work";
/** Where the spill folder is mounted in the container: /mnt/archil/<SPILL_MOUNT>. */
export const SPILL_MOUNT = "out";
/** How long an exec waits for another client's hold on the folders. */
export const DEFAULT_QUEUE_MS = 60_000;
/** How long after the program's deadline this side stops waiting for a call that never answers (boot and mount
 *  included). */
const CALL_GRACE_MS = 60_000;
const MOUNT_DIR = `/mnt/archil/${EXEC_MOUNT}`;
const SPILL_DIR = `/mnt/archil/${SPILL_MOUNT}`;

/** `text` in single quotes, for the shell. */
export const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** A name for one exec's files in the spill folder: <name>.in, <name>.out, <name>.err. */
export const spillName = (): string => `x${randomBytes(8).toString("hex")}`;
/** The keys of one exec's files, in spill folder `folder`. */
export const spillKeys = (folder: string, name: string): { readonly in: string; readonly out: string; readonly err: string } =>
  ({ in: `${folder}/${name}.in`, out: `${folder}/${name}.out`, err: `${folder}/${name}.err` });

export type ExecJob = {
  /** The workspace's folder on the disk: the work mount's subdirectory. */
  readonly root: string;
  /** Its spill folder on the disk, beside it: the out mount's subdirectory. */
  readonly spill: string;
  /** This exec's files' name in the spill folder (spillName()). */
  readonly name: string;
  /** The cwd's segments, below the root, already checked by relativeSegments. */
  readonly cwd: readonly string[];
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Whether <spill>/<name>.in was put, as the program's stdin. */
  readonly stdin: boolean;
  readonly timeoutMs: number;
  readonly maxOutput: number;
  readonly queueMs: number;
  readonly image?: ArchilImage;
};

/** The program's runner: stderr to the file in its first argument, the program run, its raw wait status written to the
 *  file in its second, and the same exit a shell would give. No single quote in it: it rides in one. */
const RUNNER = [
  `open(STDERR, ">", shift) or exit 126;`,
  `my $s = shift;`,
  `system { $ARGV[0] } @ARGV;`,
  `my $w = $? == -1 ? 127 << 8 : $?;`,
  `if (open(my $f, ">", $s)) { print $f $w; close $f; }`,
  `exit($w & 127 ? 128 + ($w & 127) : $w >> 8);`,
].join(" ");

/** The shell line one exec call runs (POSIX sh; GNU timeout, perl, mkfifo, head and mktemp in the image). `mark` is
 *  this call's marker: the line's answer is found by it, whatever else the call's stdout holds. */
export function execLine(job: ExecJob, mark: string): string {
  const cap = job.maxOutput + 1;
  // At least a millisecond: timeout reads 0 as no deadline at all.
  const seconds = (Math.max(1, Math.ceil(Math.min(job.timeoutMs, COMMAND_MAX_MS))) / 1000).toFixed(3);
  const out = quote(`${SPILL_DIR}/${job.name}.out`);
  const err = quote(`${SPILL_DIR}/${job.name}.err`);
  const lines = [
    `d=$(mktemp -d 2>/dev/null) || { echo '${mark} notmp'; exit 0; }`,
    `s() { echo "${mark} $1"; rm -rf -- "$d"; exit 0; }`,
    `{ command -v timeout && command -v perl && command -v mkfifo && command -v head; } >/dev/null 2>&1 || s notools`,
    `[ -d ${quote(SPILL_DIR)} ] || s noroot`,
    `cd -- ${quote(MOUNT_DIR)} 2>/dev/null || s noroot`,
  ];
  for (const segment of job.cwd) {
    const name = quote(segment);
    lines.push(`[ -L ${name} ] && s link`, `[ -d ${name} ] || { [ -e ${name} ] && s notdir; s nocwd; }`, `cd -- ${name} 2>/dev/null || s nocwd`);
  }
  let input = "/dev/null";
  if (job.stdin) {
    input = quote(`${SPILL_DIR}/${job.name}.in`);
    lines.push(`[ -f ${input} ] || s nostdin`);
  }
  const path = job.env.PATH;
  lines.push(`( ${path === undefined ? "unset PATH" : `PATH=${quote(path)}`}; command -v -- ${quote(job.argv[0]!)} ) >/dev/null 2>&1 || s noprog`);
  const assignments = Object.entries(job.env).map(([name, value]) => quote(`${name}=${value}`));
  // The drains first: each keeps cap+1 bytes in its spill file and reads the rest away. timeout leads its own process
  // group; the runner sends the program's stderr to its FIFO, so timeout's notice that it sent a signal ("why") tells a
  // deadline from a program that exits 124 by itself, and the raw status ("status") tells a signal from an exit of 128+n.
  lines.push(
    `mkfifo "$d/o" "$d/e" 2>/dev/null || s notmp`,
    `{ head -c ${cap} >${out}; cat >/dev/null; } <"$d/o" & r1=$!`,
    `{ head -c ${cap} >${err}; cat >/dev/null; } <"$d/e" & r2=$!`,
    `LC_ALL=C timeout --verbose -k 1 ${seconds} perl -e '${RUNNER}' "$d/e" "$d/status" env -i -- ${[...assignments, ...job.argv.map(quote)].join(" ")} <${input} >"$d/o" 2>"$d/why" &`,
    `p=$!`,
    `wait "$p"; c=$?`,
    `kill -s KILL -- "-$p" 2>/dev/null`,
    // A drain still open after 2 s is held by something that left the group, or by a runner that never opened its FIFO.
    `( sleep 2; kill -s KILL $r1 $r2 ) >/dev/null 2>&1 & k=$!`,
    `wait $r1 $r2 2>/dev/null; kill -s KILL $k 2>/dev/null`,
    `t=0; grep -q 'sending signal' "$d/why" 2>/dev/null && t=1`,
    `w=-; [ -s "$d/status" ] && w=$(cat "$d/status")`,
    `echo "${mark} ran $c $t $w"`,
    `rm -rf -- "$d"`,
  );
  return lines.join("\n");
}

type Status = "ran" | "noroot" | "link" | "notdir" | "nocwd" | "nostdin" | "noprog" | "notmp" | "notools";

/** Linux's signal names by number (the container's numbering, whatever this machine's is). */
const LINUX_SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL",
  10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 16: "SIGSTKFLT", 17: "SIGCHLD",
  18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU", 23: "SIGURG", 24: "SIGXCPU", 25: "SIGXFSZ",
  26: "SIGVTALRM", 27: "SIGPROF", 28: "SIGWINCH", 29: "SIGIO", 30: "SIGPWR", 31: "SIGSYS",
};

/** What the line answered: the LAST line carrying `mark` in the call's stdout (the line answers last, so a line the
 *  program printed before it cannot stand in for it), or undefined when there is none. */
export function parseExec(stdout: string, mark: string): { readonly status: Exclude<Status, "ran"> } | {
  readonly status: "ran"; readonly code: number; readonly timedOut: boolean; readonly signal: string | undefined;
} | undefined {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(`${mark} `));
  if (line === undefined) return undefined;
  const head = new RegExp(`^${mark} (ran|noroot|link|notdir|nocwd|nostdin|noprog|notmp|notools)(?: (\\d+) ([01]) (-|\\d+))?$`).exec(line);
  if (head === null) return undefined;
  const status = head[1] as Status;
  if (status !== "ran") return { status };
  if (head[2] === undefined) return undefined;
  const raw = head[4] === "-" ? undefined : Number(head[4]);
  const signal = raw !== undefined && (raw & 127) !== 0 ? LINUX_SIGNALS[raw & 127] ?? `signal ${raw & 127}` : undefined;
  return { status, code: Number(head[2]), timedOut: head[3] === "1", signal };
}

const show = (segments: readonly string[]): string => JSON.stringify(segments.length === 0 ? "." : segments.join("/"));
const describe = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

/** Spill file `key` read back, at most `cap` + 1 bytes (one past the cap, so a cut is seen); empty when it is not
 *  there or holds nothing. */
async function readSpill(disk: ArchilDisk, key: string, cap: number): Promise<Uint8Array> {
  try {
    const answer = await disk.getRange(key, `bytes=0-${cap}`);
    if (answer.status === 416) return new Uint8Array(0);
    return answer.body;
  } catch (error) {
    if ((error as { status?: unknown })?.status === 404) return new Uint8Array(0);
    throw error;
  }
}

/** `job` run by one exec call on `disk`. A nonzero exit is a result; what kept the program from running is an error.
 *  The spill files are the caller's to delete (on every path). */
export async function archilExec(disk: ArchilDisk, job: ExecJob): Promise<ExecResult> {
  const path = job.cwd.join("/");
  const mark = `agentrun-exec-${randomBytes(6).toString("hex")}`;
  let timer: NodeJS.Timeout | undefined;
  const deadline = Math.min(job.timeoutMs, COMMAND_MAX_MS) + CALL_GRACE_MS;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkspaceError("TIMEOUT", `the Archil exec did not answer in ${deadline} ms (it may still be running, holding the folder)`, { path })), deadline);
  });
  let answer;
  const started = Date.now();
  try {
    const request = {
      mounts: { [EXEC_MOUNT]: job.root, [SPILL_MOUNT]: job.spill }, queueMs: job.queueMs, command: execLine(job, mark),
      ...(job.image === undefined ? {} : { image: job.image }),
    };
    answer = await Promise.race([disk.exec(request), gaveUp]);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const status = (error as { status?: unknown })?.status;
    // A 400 is a mount Archil refused (a folder missing, or held by another client past the queue's wait): its own
    // words say which.
    const why = status === 400 ? "Archil refused to mount the exec's folders"
      : status === 401 || status === 403 ? "Archil refused the key, or the account's exec allowance is spent"
        : "the Archil exec failed";
    throw new WorkspaceError("UNAVAILABLE", `${why}: ${describe(error)}`, { path, cause: error });
  } finally {
    clearTimeout(timer);
  }
  // The status line is the program's own word as much as the line's (it runs as the same user), but not the clock: a
  // deadline is believed only if the call lasted that long.
  const lasted = Date.now() - started;
  const parsed = parseExec(answer.stdout, mark);
  if (parsed === undefined) {
    throw new WorkspaceError("UNAVAILABLE", `the Archil exec's answer does not hold its line's (exit ${answer.exitCode}): ${describe(answer.stderr || answer.stdout)}`, { path });
  }
  switch (parsed.status) {
    case "ran": {
      const keys = spillKeys(job.spill, job.name);
      let out: Uint8Array;
      let err: Uint8Array;
      try {
        [out, err] = await Promise.all([readSpill(disk, keys.out, job.maxOutput), readSpill(disk, keys.err, job.maxOutput)]);
      } catch (error) {
        throw new WorkspaceError("UNAVAILABLE", `the Archil exec ran, but its output could not be read back: ${describe(error)}`, { path, cause: error });
      }
      const truncated = out.length > job.maxOutput || err.length > job.maxOutput;
      const timedOut = parsed.timedOut && lasted >= Math.min(job.timeoutMs, COMMAND_MAX_MS);
      return {
        stdout: out.subarray(0, job.maxOutput),
        stderr: Buffer.from(err.subarray(0, job.maxOutput)).toString("utf8"),
        // null whenever a signal ended it: its own, or the deadline's kill. The signal is said in Node's naming
        // ("SIGSEGV"), null when it exited on its own; at the deadline, whatever signal ended it.
        code: timedOut || parsed.signal !== undefined ? null : parsed.code,
        signal: parsed.signal ?? null,
        timedOut,
        truncated,
      };
    }
    case "link": throw new WorkspaceError("ESCAPE", `${show(job.cwd)} has a symbolic link on the way, and a workspace follows none`, { path });
    case "nocwd": throw new WorkspaceError("NOT_FOUND", `${show(job.cwd)} is not there`, { path });
    case "notdir": throw new WorkspaceError("REFUSED", `${show(job.cwd)} is not a directory`, { path });
    case "noprog": throw new WorkspaceError("NOT_FOUND", `${JSON.stringify(job.argv[0])} is not a program here (PATH ${JSON.stringify(job.env.PATH ?? "")})`, { path });
    case "noroot": throw new WorkspaceError("UNAVAILABLE", `the workspace's folder ${job.root} or its spill folder was not mounted`, { path });
    case "nostdin": throw new WorkspaceError("UNAVAILABLE", "the exec's stdin did not reach the container", { path });
    case "notmp": throw new WorkspaceError("UNAVAILABLE", "the exec's container has no temporary folder", { path });
    case "notools": throw new WorkspaceError("UNAVAILABLE", "the exec's image lacks timeout, perl, mkfifo or head", { path });
  }
}
