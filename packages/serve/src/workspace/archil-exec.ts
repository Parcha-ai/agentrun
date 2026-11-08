// Workspace exec on an Archil disk: one serverless exec call (archil-disk.ts), scoped to the workspace's folder. Taken
// from pi-transport's box/archil-exec.ts, which has no caller: the call, its 300 s cut, the checkout of the folder with
// a queue, and the mapping of the exit and of the deadline. The rest (boxes, records, sweeps) is not.
//
// Archil runs one shell line in a fresh container, the disk mounted at /mnt/archil/work, after checking out the
// workspace's folder (checkoutPaths = [root]: no other client writes in it while the line runs; a second one waits
// up to queueMs). It answers once the line ended, stdout and stderr as text. The Workspace port wants argv, the whole
// environment, binary stdin and stdout, a deadline that kills everything the program started, and capped output, so
// the line this module writes:
// - walks to the cwd one folder at a time from the root, refusing a symbolic link on the way (a link made by an earlier
//   exec is the only kind the disk can hold; the file API makes none);
// - takes stdin from a file the caller put in the root (.agentrun-stdin-<hex>), moved into the container's /tmp first,
//   because a call's command line has a length limit and stdin has none;
// - runs the program as `env -i -- NAME=value… argv…` under GNU timeout, so nothing of the container's environment
//   leaks in, in timeout's process group, which is killed when the program ends or at its deadline;
// - drains stdout and stderr through FIFOs, keeping one byte past the cap of each (so a cut is seen) and discarding
//   the rest as it comes, so a noisy program never fills the container's temporary disk;
// - runs the program from a few lines of perl (perl-base is in every Debian and Ubuntu image) that write its raw wait
//   status, because through timeout a program killed by a signal and one that exits 128+n look the same;
// - answers a status line, then stdout as base64, and the program's stderr as the call's stderr.
// A backend without streaming: onOutput gets each stream once, whole, when the line has ended.
import type { ArchilDisk } from "./archil-disk.js";
import { type ExecResult, WorkspaceError } from "./workspace.js";

/** Archil cuts an exec call at 300 s: a longer deadline is refused. */
export const MAX_EXEC_MS = 300_000;
/** The program's own deadline at most, leaving the line 5 s to answer before the cut. */
export const COMMAND_MAX_MS = 295_000;
/** Where the disk is mounted in the container: /mnt/archil/<EXEC_MOUNT>. */
export const EXEC_MOUNT = "work";
/** How long an exec waits for another client's checkout of the folder. */
export const DEFAULT_QUEUE_MS = 60_000;
/** How long after the program's deadline this side stops waiting for a call that never answers (boot and mount
 *  included). */
const CALL_GRACE_MS = 60_000;
/** The name, in the root, of a call's stdin while it is on its way. */
export const STDIN_PREFIX = ".agentrun-stdin-";
const MARK = "agentrun-exec";

/** `text` in single quotes, for the shell. */
export const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

export type ExecJob = {
  /** The workspace's folder on the disk. */
  readonly root: string;
  /** The cwd's segments, below the root, already checked by relativeSegments. */
  readonly cwd: readonly string[];
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The stdin file's name in the root, when there is stdin. */
  readonly stdinName?: string;
  readonly timeoutMs: number;
  readonly maxOutput: number;
  readonly queueMs: number;
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

/** The shell line one exec call runs (POSIX sh; GNU timeout, perl, mkfifo, base64, head and mktemp in the image). */
export function execLine(job: ExecJob): string {
  const dir = `/mnt/archil/${EXEC_MOUNT}/${job.root}`;
  const cap = job.maxOutput + 1;
  // At least a millisecond: timeout reads 0 as no deadline at all.
  const seconds = (Math.max(1, Math.ceil(Math.min(job.timeoutMs, COMMAND_MAX_MS))) / 1000).toFixed(3);
  const lines = [
    `d=$(mktemp -d 2>/dev/null) || { echo '${MARK} notmp'; exit 0; }`,
    `s() { echo "${MARK} $1"; rm -rf -- "$d"; exit 0; }`,
    `{ command -v timeout && command -v perl && command -v mkfifo && command -v base64 && command -v head; } >/dev/null 2>&1 || s notools`,
    `cd -- ${quote(dir)} 2>/dev/null || s noroot`,
  ];
  for (const segment of job.cwd) {
    const name = quote(segment);
    lines.push(`[ -L ${name} ] && s link`, `[ -d ${name} ] || { [ -e ${name} ] && s notdir; s nocwd; }`, `cd -- ${name} 2>/dev/null || s nocwd`);
  }
  let input = "/dev/null";
  if (job.stdinName !== undefined) {
    lines.push(`mv -- ${quote(`${dir}/${job.stdinName}`)} "$d/in" 2>/dev/null || s nostdin`);
    input = `"$d/in"`;
  }
  const path = job.env.PATH;
  lines.push(`( ${path === undefined ? "unset PATH" : `PATH=${quote(path)}`}; command -v -- ${quote(job.argv[0]!)} ) >/dev/null 2>&1 || s noprog`);
  const assignments = Object.entries(job.env).map(([name, value]) => quote(`${name}=${value}`));
  // The drains first: each keeps cap+1 bytes and reads the rest away. timeout leads its own process group; the runner
  // sends the program's stderr to its FIFO, so timeout's notice that it sent a signal ("why") tells a deadline from a
  // program that exits 124 by itself, and the raw status ("status") tells a signal from an exit of 128+n.
  lines.push(
    `mkfifo "$d/o" "$d/e" 2>/dev/null || s notmp`,
    `{ head -c ${cap} >"$d/out"; cat >/dev/null; } <"$d/o" & r1=$!`,
    `{ head -c ${cap} >"$d/err"; cat >/dev/null; } <"$d/e" & r2=$!`,
    `LC_ALL=C timeout --verbose -k 1 ${seconds} perl -e '${RUNNER}' "$d/e" "$d/status" env -i -- ${[...assignments, ...job.argv.map(quote)].join(" ")} <${input} >"$d/o" 2>"$d/why" &`,
    `p=$!`,
    `wait "$p"; c=$?`,
    `kill -s KILL -- "-$p" 2>/dev/null`,
    // A drain still open after 2 s is held by something that left the group, or by a runner that never opened its FIFO.
    `( sleep 2; kill -s KILL $r1 $r2 ) >/dev/null 2>&1 & k=$!`,
    `wait $r1 $r2 2>/dev/null; kill -s KILL $k 2>/dev/null`,
    `t=0; grep -q 'sending signal' "$d/why" 2>/dev/null && t=1`,
    `w=-; [ -s "$d/status" ] && w=$(cat "$d/status")`,
    `echo "${MARK} ran $c $t $w"`,
    `base64 <"$d/out" | tr -d '\\n'`,
    `echo`,
    `cat "$d/err" >&2`,
    `rm -rf -- "$d"`,
  );
  return lines.join("\n");
}

type Status = "ran" | "noroot" | "link" | "notdir" | "nocwd" | "nostdin" | "noprog" | "notmp" | "notools";
const STATUS = new RegExp(`^${MARK} (ran|noroot|link|notdir|nocwd|nostdin|noprog|notmp|notools)(?: (\\d+) ([01]) (-|\\d+))?$`);

/** What the line answered, or undefined when it is not one of its answers. `signaled`: a signal ended the program
 *  (its raw wait status says so; with no status, the runner itself was killed, which only the deadline does). */
export function parseExec(stdout: string): { readonly status: Exclude<Status, "ran"> } | { readonly status: "ran"; readonly code: number; readonly timedOut: boolean; readonly signaled: boolean; readonly out: Uint8Array } | undefined {
  const newline = stdout.indexOf("\n");
  const head = STATUS.exec(newline === -1 ? stdout : stdout.slice(0, newline));
  if (head === null) return undefined;
  const status = head[1] as Status;
  if (status !== "ran") return { status };
  if (head[2] === undefined || newline === -1) return undefined;
  const encoded = stdout.slice(newline + 1).replace(/\n$/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const raw = head[4] === "-" ? undefined : Number(head[4]);
  return { status, code: Number(head[2]), timedOut: head[3] === "1", signaled: raw !== undefined && (raw & 127) !== 0, out: Buffer.from(encoded, "base64") };
}

const show = (segments: readonly string[]): string => JSON.stringify(segments.length === 0 ? "." : segments.join("/"));
const describe = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

/** `job` run by one exec call on `disk`. A nonzero exit is a result; what kept the program from running is an error. */
export async function archilExec(disk: ArchilDisk, job: ExecJob): Promise<ExecResult> {
  const path = job.cwd.join("/");
  let timer: NodeJS.Timeout | undefined;
  const deadline = Math.min(job.timeoutMs, COMMAND_MAX_MS) + CALL_GRACE_MS;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkspaceError("TIMEOUT", `the Archil exec did not answer in ${deadline} ms (it may still be running, holding the folder)`, { path })), deadline);
  });
  let answer;
  try {
    answer = await Promise.race([disk.exec({ mount: EXEC_MOUNT, checkoutPaths: [job.root], queueMs: job.queueMs, command: execLine(job) }), gaveUp]);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const status = (error as { status?: unknown })?.status;
    const why = status === 400 ? "Archil refused the exec (another client may hold the folder past the queue's wait)"
      : status === 401 || status === 403 ? "Archil refused the key, or the account's exec allowance is spent"
        : "the Archil exec failed";
    throw new WorkspaceError("UNAVAILABLE", `${why}: ${describe(error)}`, { path, cause: error });
  } finally {
    clearTimeout(timer);
  }
  const parsed = parseExec(answer.stdout);
  if (parsed === undefined) {
    throw new WorkspaceError("UNAVAILABLE", `the Archil exec answered something else than its line's (exit ${answer.exitCode}): ${describe(answer.stderr || answer.stdout)}`, { path });
  }
  switch (parsed.status) {
    case "ran": {
      const err = Buffer.from(answer.stderr, "utf8");
      const truncated = parsed.out.length > job.maxOutput || err.length > job.maxOutput;
      return {
        stdout: parsed.out.subarray(0, job.maxOutput),
        stderr: err.subarray(0, job.maxOutput).toString("utf8"),
        // null whenever a signal ended it: its own crash, or the deadline's kill.
        code: parsed.timedOut || parsed.signaled ? null : parsed.code,
        timedOut: parsed.timedOut,
        truncated,
      };
    }
    case "link": throw new WorkspaceError("ESCAPE", `${show(job.cwd)} has a symbolic link on the way, and a workspace follows none`, { path });
    case "nocwd": throw new WorkspaceError("NOT_FOUND", `${show(job.cwd)} is not there`, { path });
    case "notdir": throw new WorkspaceError("REFUSED", `${show(job.cwd)} is not a directory`, { path });
    case "noprog": throw new WorkspaceError("NOT_FOUND", `${JSON.stringify(job.argv[0])} is not a program here (PATH ${JSON.stringify(job.env.PATH ?? "")})`, { path });
    case "noroot": throw new WorkspaceError("UNAVAILABLE", `the workspace's folder ${job.root} is not on the disk`, { path });
    case "nostdin": throw new WorkspaceError("UNAVAILABLE", "the exec's stdin did not reach the container", { path });
    case "notmp": throw new WorkspaceError("UNAVAILABLE", "the exec's container has no temporary folder", { path });
    case "notools": throw new WorkspaceError("UNAVAILABLE", "the exec's image lacks timeout, base64 or head", { path });
  }
}
