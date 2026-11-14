// The scripts the shared machine-host adapter (./provider.ts) sends into a machine, exactly, and the read-back of the
// daemon it started: the same for every vendor. A child host (the vendor's own agent is the machine's first process:
// E2B's envd, Daytona's toolbox) gets the daemon through its upload, installs it, and starts init detached (start);
// a pid1 host's machine runs the entrypoint as its main process, which waits for the daemon and becomes init. Every
// connection runs stdio. Each is one argv, `sh -c '<script>' sh <args>`; shellCommand gives it as one string for a
// vendor whose exec takes a shell line.
import { DAEMON_IN_COMPUTER, helloDrift, SOCKET_DIR, WORK } from "../drift.js";
import { readOwnNetwork, TOOL_USER } from "../isolation.js";
import type { ComputerCapabilities, ComputerConnection } from "../provider.js";
import { fail, ok, type Result } from "../result.js";

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CAPS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];

/** Root for what follows: the command's own user when it is root, else passwordless sudo, which the install checked. */
const ROOT = 'p=; [ "$(id -u)" = 0 ] || p="sudo -n"';

/** Whether the daemon at d is root's alone: the binary and every directory above it owned by root and writable by no
 *  group or other user (and so no symbolic link, no ACL). Else a user who could rename an entry on the path could put
 *  another binary there, which init and every bridge would run as root. Only root can change an owner or a mode, so a
 *  path that holds once holds until root changes it. Prints why it does not, and fails. `ls -ldn` is in BusyBox and
 *  coreutils alike; a trailing `.` (an SELinux label) is allowed, a `+` (an ACL) is not. */
const HELD = 'held() { x=$1; while :; do set -- $(ls -ldn "$x" 2>/dev/null); case "$1" in ?????[!w]??[!w]?|?????[!w]??[!w]?.) ;; *) false ;; esac && [ "$3" = 0 ] || { echo "the daemon at $d is not root\'s alone: $x is ${1:-missing}, owner ${3:-none}"; return 1; }; [ "$x" = / ] && return 0; x=${x%/*}; x=${x:-/}; done; }';

/** Installs the uploaded daemon root-owned and read-only to its user, makes its home and socket directory (init gives
 *  them to the daemon's user), and prints who installed it and the installed binary's sha256. As root, or through passwordless sudo; else
 *  it says why. The daemon's directory is made root's (0755) even when the image already had it, a stale entry at
 *  the daemon's path is removed first, and the whole path is held to `held` before and after; a path another user can
 *  change is refused with nothing installed. Every tool is in BusyBox and in coreutils alike: no privilege tool of the
 *  image's is relied on. */
const INSTALL_SCRIPT = [
	"# agentrun-computer: install",
	// a: when set, the binary goes in beside its path and is moved into place last, so a pid1 entrypoint waiting for the
	// path never starts one half written; e: when set too, the sha256 it must read before it is moved, so the entrypoint
	// never starts one that is not the daemon uploaded; n: when set too, this create's nonce, written to the marker beside
	// the daemon once it is in place, so the entrypoint starts the daemon this create installed and never one the image
	// had there. (Not x: held() assigns x.)
	"s=$1; d=$2; h=$3; r=$4; a=${5-}; e=${6-}; n=${7-}; b=${d%/*}; t=$d; [ -z \"$a\" ] || t=$d.part",
	'if [ "$(id -u)" = 0 ]; then p=; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then p="sudo -n"; else echo "the sandbox user $(id -un) is not root and has no passwordless sudo, so the daemon cannot be installed"; exit 3; fi',
	HELD,
	'[ -d "${b%/*}" ] || $p mkdir -p -m 0755 "${b%/*}" || { echo "installing the daemon at $d failed"; exit 5; }',
	'held "${b%/*}" || exit 6',
	'[ ! -L "$b" ] || { echo "the daemon at $d is not root\'s alone: $b is a symbolic link"; exit 6; }',
	'$p mkdir -p "$b" "$h" "$r" && $p chown 0:0 "$b" && $p chmod 0755 "$b" && $p rm -f "$d" "$t" "$d.installed" && $p install -m 0755 -o 0 -g 0 "$s" "$t" || { echo "installing the daemon at $d failed"; exit 5; }',
	'if [ -n "$a" ] && [ -n "$e" ]; then w=$($p sha256sum "$t" | cut -c1-64); [ "$w" = "$e" ] || { echo "sha256 $w"; echo "the daemon written to $t reads sha256 $w, not $e, so it is not moved into place"; $p rm -f "$t"; exit 7; }; fi',
	'[ "$t" = "$d" ] || $p mv -f "$t" "$d" || { echo "installing the daemon at $d failed"; exit 5; }',
	'held "$d" || exit 6',
	`[ -z "$n" ] || { printf '%s\\n' "$n" | $p tee "$d.installed" >/dev/null; } || { echo "installing the daemon at $d failed: its marker was not written"; exit 5; }`,
	'rm -f "$s"',
	// Who installed it: the sandbox user's uid and name, and "sudo" when through passwordless sudo (installerOf).
	'echo "installer $(id -u) $(id -un 2>/dev/null || echo unnamed)${p:+ sudo}"',
	'echo "sha256 $($p sha256sum "$d" | cut -c1-64)"',
].join("\n");

/** Who ran install, from its output's `installer <uid> <name>[ sudo]` line, in words; undefined when it has none. */
export function installerOf(output: string): string | undefined {
	const found = /^installer (\d+) (\S+)( sudo)?$/m.exec(output);
	if (found === null) return undefined;
	const [, uid, name, sudo] = found;
	return `the daemon was installed by ${name} (uid ${uid})${sudo ? ", through passwordless sudo" : ", as root"}`;
}

/** Starts init, the long-lived command, as root in a clean environment from its home: `init --user` gives HOME and the
 *  socket's directory to the daemon's user, sets no_new_privs and empties every capability set on every thread, and
 *  becomes that user with no groups. `--own-network` first cuts init and its programs off from the vendor's agent beside
 *  them (Daytona's toolbox, E2B's envd), which runs commands as root for whoever reaches it: a network of their own,
 *  their loopback alone, no vsock, no other process of their uid (src/isolation.ts). Init holds every process and ends
 *  them at the deadline. A display, when given, is init's DISPLAY, the X display its screen and input methods drive; a
 *  maximum, when given, is the most deadline.extend may move the deadline to. */
const INIT_SCRIPT = [
	"# agentrun-computer: init",
	// The display is v, not x: held() assigns x, and runs before the exec that reads it.
	"d=$1; t=$2; w=$3; h=$4; r=$5; v=${6-}; m=${7-}",
	HELD,
	'held "$d" >&2 || exit 6',
	ROOT,
	`exec $p env -i PATH=${PATH} HOME="$h" AGENTRUN_COMPUTERD_SOCKET="$r/computerd.sock" \${v:+DISPLAY="$v"} sh -c 'cd "$HOME" && exec "$@"' sh "$d" init --deadline "$t" --user "$w" --own-network \${m:+--max-deadline "$m"}`,
].join("\n");

/** The bridge one connection runs: stdin and stdout to init's socket. As root, to reach a socket in a directory that is
 *  the daemon's user's alone; it only carries bytes, and the command's user is root or has passwordless sudo already.
 *  Like init, it runs the daemon only when its path is root's alone (`held`), so a computer attached from an older
 *  install is checked too. */
const STDIO_SCRIPT = ["# agentrun-computer: stdio", "d=$1; r=$2", HELD, 'held "$d" >&2 || exit 6', ROOT, `exec $p env -i PATH=${PATH} AGENTRUN_COMPUTERD_SOCKET="$r/computerd.sock" "$d" stdio`].join("\n");

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
/** One string for a shell: `sh -c '<script>' sh '<arg>' ...`, every word quoted. */
export const shellCommand = (script: string, args: readonly string[]) => ["sh", "-c", quote(script), "sh", ...args.map(quote)].join(" ");
/** One argv as one shell line, every word but a plain one ("sh", "-c") single-quoted: for a vendor whose exec takes a line. */
export const shellLine = (argv: readonly string[]) => argv.map((word) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : quote(word))).join(" ");
const argvOf = (script: string, args: readonly string[]): string[] => ["sh", "-c", script, "sh", ...args];

/** Where start leaves what init writes, root's alone: the words a create that never hears the daemon gives back. */
export const INIT_LOG = `${SOCKET_DIR}-init.log`;

/**
 * Starts init detached from the call that starts it: in a session of its own (setsid), its output to the log, its stdin
 * none, so the vendor's call ends at once and nothing of it holds init. As root, or through passwordless sudo.
 */
const START_SCRIPT = ["# agentrun-computer: start", "l=$1; shift", ROOT, `exec $p sh -c 'exec >"$0" 2>&1 </dev/null; setsid "$@" &' "$l" "$@"`].join("\n");

/**
 * Takes others' access off every path unix socket the vendor's patterns ($@, each a shell pattern with no space) name,
 * as root: what init does itself under /run (daemon/internal/isolate CloseSystemSockets), for a vendor's socket
 * elsewhere. The owner's and group's access stays, so the vendor's own service keeps its socket; the computer's user
 * is neither. A link is never followed. Prints `closed <path>` for each socket it closed and `failed <path>` for one
 * it could not; any failure fails the script, and create then refuses the computer.
 */
const SOCKETS_SCRIPT = [
	"# agentrun-computer: sockets",
	ROOT,
	"failed=0",
	'for g in "$@"; do',
	"\tfor s in $g; do",
	'\t\t[ -S "$s" ] && [ ! -L "$s" ] || continue',
	'\t\tif $p chmod o-rwx "$s"; then echo "closed $s"; else echo "failed $s"; failed=1; fi',
	"\tdone",
	"done",
	"exit $failed",
].join("\n");

/** The sockets the sockets script closed, from its `closed <path>` lines. */
export function closedSocketsOf(output: string): string[] {
	return output.split("\n").flatMap((line) => (line.startsWith("closed ") ? [line.slice("closed ".length).trim()] : []));
}

/** The last words init wrote to its log, as root; nothing when it wrote none. */
const LOG_SCRIPT = ["# agentrun-computer: log", "l=$1", ROOT, '$p tail -c 2000 "$l" 2>/dev/null || true'].join("\n");

/**
 * A pid1 machine's main process: waits, bounded, for the daemon this create installed to be moved into place executable
 * (the marker beside it, `<daemon>.installed`, holds this create's nonce: a daemon the image had at the path, or one an
 * earlier install left, has none, or another, and is never started), then becomes it with exec, so init is the machine's main process and the machine ends when init does. It starts init as start does a
 * child's: from its home (HOME, and the working directory), with the display, when given, as its DISPLAY. POSIX sh and
 * tools in BusyBox and coreutils alike; `date +%s` bounds the wait however long a sleep takes. An Archil computer's
 * (`--gate <path>` before init's arguments) also waits for the gate, which root makes once the run's folder is mounted;
 * a gate there before it starts (an image that holds one) is not this computer's, and goes first.
 */
const ENTRYPOINT_SCRIPT = [
	"# agentrun-computer: entrypoint",
	// The display is v, as in init's script; empty for a computer with no screen. n is this create's nonce.
	"d=$1; w=$2; h=$3; v=$4; n=$5; shift 5",
	'g=; if [ "${1-}" = --gate ]; then g=$2; shift 2; rm -f "$g"; fi',
	"end=$(( $(date +%s) + $w ))",
	// Ours: the daemon executable, and the marker install writes after the move holding this create's nonce.
	'ours() { [ -f "$d" ] && [ -x "$d" ] && [ -n "$n" ] && [ "$(cat "$d.installed" 2>/dev/null)" = "$n" ]; }',
	'until ours && { [ -z "$g" ] || [ -f "$g" ]; }; do',
	'\tif [ "$(date +%s)" -gt "$end" ]; then',
	'\t\tif ours; then echo "agentrun-computer: the Archil mount was not made within $w s ($g is not there), so this computer ends" >&2',
	'\t\telse echo "agentrun-computer: the daemon did not arrive at $d within $w s, so this computer ends" >&2; fi',
	"\t\texit 3",
	"\tfi",
	"\tsleep 0.2 2>/dev/null || sleep 1",
	"done",
	'export HOME="$h"',
	'cd "$h" || { echo "agentrun-computer: init\'s home $h cannot be entered, so this computer ends" >&2; exit 4; }',
	'if [ -n "$v" ]; then export DISPLAY="$v"; else unset DISPLAY; fi',
	'exec "$d" "$@"',
].join("\n");

/**
 * Where a pid1 Archil computer's entrypoint waits for root's word that the run's folder is mounted: beside the daemon,
 * in the directory install makes root's alone before root makes the gate, so no other user can make it early. (A path
 * under /run would hang on an image without /run, or one whose /run another user can write.)
 */
export const ARCHIL_GATE = `${DAEMON_IN_COMPUTER.slice(0, DAEMON_IN_COMPUTER.lastIndexOf("/"))}/archil-mounted`;

/** The scripts the adapter runs, each one argv (see the file's head). */
export interface HostedCommands {
	install: string[];
	/** child: init's start, detached; it answers once init is started. */
	start: string[];
	/** child: the vendor's sockets (HostFacts.vendorSockets) closed to others, run before start; none when it names none. */
	sockets?: string[];
	stdio: string[];
	log: string[];
	/** pid1: the machine's command. */
	entrypoint: string[];
}

/**
 * The adapter's commands for one computer. Init's flags are the child's (childCommands) for both modes: --own-network
 * always, the display and the most deadline.extend may move the deadline to when given. waitS bounds a pid1 entrypoint's
 * wait for the daemon (and gate, for an Archil computer); with atomic, install moves the daemon into place last, and only
 * once it reads sha256, when given, then writes nonce, when given, to the marker the entrypoint waits for. vendorSockets
 * (HostFacts') gives a child its sockets command.
 */
export function hostedCommands({
	staging = "",
	deadline = "",
	user = TOOL_USER,
	display = "",
	maxDeadline = "",
	atomic = false,
	waitS = 600,
	gate,
	sha256 = "",
	nonce = "",
	vendorSockets = [],
}: ChildCommandOptions & { atomic?: boolean; waitS?: number; gate?: string; sha256?: string; nonce?: string; vendorSockets?: readonly string[] } = {}): HostedCommands {
	const init = [DAEMON_IN_COMPUTER, deadline, user, WORK, SOCKET_DIR];
	if (display !== "" || maxDeadline !== "") init.push(display, maxDeadline);
	const initArgs = ["init", "--deadline", deadline, "--user", user, "--own-network", ...(maxDeadline === "" ? [] : ["--max-deadline", maxDeadline])];
	return {
		install: argvOf(INSTALL_SCRIPT, [staging, DAEMON_IN_COMPUTER, WORK, SOCKET_DIR, ...(atomic ? ["1", sha256, nonce] : [])]),
		start: argvOf(START_SCRIPT, [INIT_LOG, ...argvOf(INIT_SCRIPT, init)]),
		stdio: argvOf(STDIO_SCRIPT, [DAEMON_IN_COMPUTER, SOCKET_DIR]),
		log: argvOf(LOG_SCRIPT, [INIT_LOG]),
		...(vendorSockets.length === 0 ? {} : { sockets: argvOf(SOCKETS_SCRIPT, vendorSockets) }),
		entrypoint: argvOf(ENTRYPOINT_SCRIPT, [DAEMON_IN_COMPUTER, String(waitS), WORK, display, nonce, ...(gate === undefined ? [] : ["--gate", gate]), ...initArgs]),
	};
}

export interface ChildCommandOptions {
	/** Where the vendor's upload left the daemon. */
	staging?: string;
	/** Init's deadline, an ISO time. */
	deadline?: string;
	/** Who the daemon becomes, uid:gid in numbers. */
	user?: string;
	/** The X display init's screen and input methods drive (its DISPLAY); none for a computer with no screen. */
	display?: string;
	/** The most deadline.extend may move the deadline to, an ISO time; none, and the deadline cannot move. */
	maxDeadline?: string;
}

/**
 * The three shell commands a child-daemon provider sends into a computer, exactly: install (the upload moved into place,
 * its sha256 printed), init (long-lived) and stdio (one per connection). Each is one string for a shell, `sh -c` with
 * every argument quoted.
 */
export function childCommands({ staging = "", deadline = "", user = TOOL_USER, display = "", maxDeadline = "" }: ChildCommandOptions = {}) {
	const init = [DAEMON_IN_COMPUTER, deadline, user, WORK, SOCKET_DIR];
	if (display !== "" || maxDeadline !== "") init.push(display, maxDeadline);
	return {
		install: shellCommand(INSTALL_SCRIPT, [staging, DAEMON_IN_COMPUTER, WORK, SOCKET_DIR]),
		init: shellCommand(INIT_SCRIPT, init),
		stdio: shellCommand(STDIO_SCRIPT, [DAEMON_IN_COMPUTER, SOCKET_DIR]),
	};
}

export interface DaemonExpected {
	version: string;
	/** The uid and gid it runs as; with neither, any one user that is not root (a spec named it, and attach reads it back). */
	uid?: string;
	gid?: string;
	arch: string;
	kind: ComputerCapabilities["kind"];
	groups: ComputerCapabilities["groups"];
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

/**
 * What the daemon reports of itself, read back through it: hello, its credentials (no capability in any set,
 * no_new_privs, no groups, a seccomp filter), its network (its own loopback alone, from its /proc/self/net/dev), its
 * working directory and binary. Each read is bounded by timeoutMs and the caller's signal.
 */
export async function daemonDrift(connection: ComputerConnection, expected: DaemonExpected, timeoutMs: number, signal?: AbortSignal): Promise<Result<string[]>> {
	// childCommands starts init with --own-network: hello must say which fence holds its programs.
	const found = helloDrift(connection.hello, { version: expected.version, kind: expected.kind, groups: expected.groups, arch: expected.arch, fence: true });
	const bounded = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
	const status = await connection.client.call("files.read", { path: "/proc/self/status" }, { signal: bounded() });
	if (!status.ok) return fail(status.error.code === "aborted" && !signal?.aborted ? "timeout" : status.error.code, `reading the daemon's /proc/self/status: ${status.error.message}`);
	const fields = new Map<string, string>();
	for (const line of Buffer.from(status.value.data, "base64").toString("utf8").split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const ids = (name: string) => (fields.get(name) ?? "").split(/\s+/).filter(Boolean);
	const uids = ids("Uid");
	const gids = ids("Gid");
	// With no user expected, the one it runs as: every id of the four the same, and uid not root.
	const uid = expected.uid ?? (uids[0] === "0" ? undefined : uids[0]);
	const gid = expected.gid ?? gids[0];
	if (uids.length !== 4 || uid === undefined || uids.some((id) => id !== uid)) found.push(`daemon user: declared ${expected.uid === undefined ? "one uid that is not root" : `uid ${expected.uid}`}, read back ${show(fields.get("Uid"))}`);
	if (gids.length !== 4 || gid === undefined || gids.some((id) => id !== gid)) found.push(`daemon group: declared ${expected.gid === undefined ? "one gid" : `gid ${expected.gid}`}, read back ${show(fields.get("Gid"))}`);
	if ((fields.get("Groups") ?? "") !== "") found.push(`daemon groups: declared none, read back ${show(fields.get("Groups"))}`);
	if (fields.get("NoNewPrivs") !== "1") found.push(`daemon no_new_privs: declared 1, read back ${show(fields.get("NoNewPrivs"))}`);
	for (const set of CAPS) {
		const value = fields.get(set);
		if (value === undefined || !/^0+$/.test(value)) found.push(`daemon ${set}: declared no capabilities, read back ${show(value)}`);
	}
	if (fields.get("Seccomp") !== "2") found.push(`daemon seccomp: declared 2 (the filter that refuses vsock and io_uring), read back ${show(fields.get("Seccomp"))}`);
	// Its own network, as its user sees it: the live interfaces lo alone, and none it could bring up (computerd probe).
	const net = await readOwnNetwork(connection.client, timeoutMs, bounded());
	if (!net.ok) return fail(net.error.code === "aborted" && !signal?.aborted ? "timeout" : net.error.code, net.error.message);
	found.push(...net.value);
	for (const [path, want, what] of [
		["/proc/self/cwd", WORK, "working directory"],
		["/proc/self/exe", DAEMON_IN_COMPUTER, "binary"],
	] as const) {
		const stat = await connection.client.call("files.stat", { path }, { signal: bounded() });
		if (!stat.ok) return fail(stat.error.code === "aborted" && !signal?.aborted ? "timeout" : stat.error.code, `reading the daemon's ${path}: ${stat.error.message}`);
		if (stat.value.target !== want) found.push(`daemon ${what}: declared ${want}, read back ${show(stat.value.target)}`);
	}
	return ok(found);
}
