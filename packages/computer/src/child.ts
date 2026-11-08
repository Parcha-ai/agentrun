// The daemon as a child: for a vendor whose own agent is the computer's first process (Daytona's toolbox, E2B's envd),
// computerd goes in through the vendor's file upload and starts as a command that agent runs. These are the shell
// commands such a provider sends, exactly, and the read-back of the daemon it started: the same for every such vendor.
import { DAEMON_IN_COMPUTER, helloDrift, SOCKET_DIR, WORK } from "./drift.js";
import { netDevInterfaces, ownNetworkDrift, TOOL_USER } from "./isolation.js";
import type { ComputerCapabilities, ComputerConnection } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

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
 *  them to the daemon's user), and prints the installed binary's sha256. As root, or through passwordless sudo; else
 *  it says why. The daemon's directory is made root's (0755) even when the image already had it, a stale entry at
 *  the daemon's path is removed first, and the whole path is held to `held` before and after; a path another user can
 *  change is refused with nothing installed. Every tool is in BusyBox and in coreutils alike: no privilege tool of the
 *  image's is relied on. */
const INSTALL_SCRIPT = [
	"# agentrun-computer: install",
	"s=$1; d=$2; h=$3; r=$4; b=${d%/*}",
	'if [ "$(id -u)" = 0 ]; then p=; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then p="sudo -n"; else echo "the sandbox user $(id -un) is not root and has no passwordless sudo, so the daemon cannot be installed"; exit 3; fi',
	HELD,
	'[ -d "${b%/*}" ] || $p mkdir -p -m 0755 "${b%/*}" || { echo "installing the daemon at $d failed"; exit 5; }',
	'held "${b%/*}" || exit 6',
	'[ ! -L "$b" ] || { echo "the daemon at $d is not root\'s alone: $b is a symbolic link"; exit 6; }',
	'$p mkdir -p "$b" "$h" "$r" && $p chown 0:0 "$b" && $p chmod 0755 "$b" && $p rm -f "$d" && $p install -m 0755 -o 0 -g 0 "$s" "$d" || { echo "installing the daemon at $d failed"; exit 5; }',
	'held "$d" || exit 6',
	'rm -f "$s"',
	'echo "sha256 $($p sha256sum "$d" | cut -c1-64)"',
].join("\n");

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
	uid: string;
	gid: string;
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
	const found = helloDrift(connection.hello, { version: expected.version, kind: expected.kind, groups: expected.groups, arch: expected.arch });
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
	if (uids.length !== 4 || uids.some((id) => id !== expected.uid)) found.push(`daemon user: declared uid ${expected.uid}, read back ${show(fields.get("Uid"))}`);
	if (gids.length !== 4 || gids.some((id) => id !== expected.gid)) found.push(`daemon group: declared gid ${expected.gid}, read back ${show(fields.get("Gid"))}`);
	if ((fields.get("Groups") ?? "") !== "") found.push(`daemon groups: declared none, read back ${show(fields.get("Groups"))}`);
	if (fields.get("NoNewPrivs") !== "1") found.push(`daemon no_new_privs: declared 1, read back ${show(fields.get("NoNewPrivs"))}`);
	for (const set of CAPS) {
		const value = fields.get(set);
		if (value === undefined || !/^0+$/.test(value)) found.push(`daemon ${set}: declared no capabilities, read back ${show(value)}`);
	}
	if (fields.get("Seccomp") !== "2") found.push(`daemon seccomp: declared 2 (the filter that refuses vsock and io_uring), read back ${show(fields.get("Seccomp"))}`);
	const net = await connection.client.call("files.read", { path: "/proc/self/net/dev" }, { signal: bounded() });
	if (!net.ok) return fail(net.error.code === "aborted" && !signal?.aborted ? "timeout" : net.error.code, `reading the daemon's /proc/self/net/dev: ${net.error.message}`);
	found.push(...ownNetworkDrift(netDevInterfaces(Buffer.from(net.value.data, "base64").toString("utf8"))));
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
