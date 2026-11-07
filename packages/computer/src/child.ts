// The daemon as a child: for a vendor whose own agent is the computer's first process (Daytona's toolbox, E2B's envd),
// computerd goes in through the vendor's file upload and starts as a command that agent runs. These are the shell
// commands such a provider sends, exactly, and the read-back of the daemon it started: the same for every such vendor.
import { DAEMON_IN_COMPUTER, helloDrift, SOCKET_DIR, WORK } from "./drift.js";
import type { ComputerCapabilities, ComputerConnection } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CAPS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];

/** Root for what follows: the command's own user when it is root, else passwordless sudo, which the install checked. */
const ROOT = 'p=; [ "$(id -u)" = 0 ] || p="sudo -n"';

/** Installs the uploaded daemon root-owned and read-only to its user, makes its home and socket directory (init gives
 *  them to the daemon's user), and prints the installed binary's sha256. As root, or through passwordless sudo; else
 *  it says why. Every tool is in BusyBox and in coreutils alike: no privilege tool of the image's is relied on. */
const INSTALL_SCRIPT = [
	"# agentrun-computer: install",
	"s=$1; d=$2; h=$3; r=$4",
	'if [ "$(id -u)" = 0 ]; then p=; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then p="sudo -n"; else echo "the sandbox user $(id -un) is not root and has no passwordless sudo, so the daemon cannot be installed"; exit 3; fi',
	'$p mkdir -p "${d%/*}" "$h" "$r" && $p install -m 0755 -o 0 -g 0 "$s" "$d" || { echo "installing the daemon at $d failed"; exit 5; }',
	'rm -f "$s"',
	'echo "sha256 $($p sha256sum "$d" | cut -c1-64)"',
].join("\n");

/** Starts init, the long-lived command, as root in a clean environment from its home: `init --user` gives HOME and the
 *  socket's directory to the daemon's user, sets no_new_privs and empties every capability set on every thread, and
 *  becomes that user with no groups. Init holds every process and ends them at the deadline. A display, when given, is
 *  init's DISPLAY, the X display its screen and input methods drive; a maximum, when given, is the most deadline.extend
 *  may move the deadline to. */
const INIT_SCRIPT = [
	"# agentrun-computer: init",
	"d=$1; t=$2; w=$3; h=$4; r=$5; x=${6-}; m=${7-}",
	ROOT,
	`exec $p env -i PATH=${PATH} HOME="$h" AGENTRUN_COMPUTERD_SOCKET="$r/computerd.sock" \${x:+DISPLAY="$x"} sh -c 'cd "$HOME" && exec "$@"' sh "$d" init --deadline "$t" --user "$w" \${m:+--max-deadline "$m"}`,
].join("\n");

/** The bridge one connection runs: stdin and stdout to init's socket. As root, to reach a socket in a directory that is
 *  the daemon's user's alone; it only carries bytes, and the command's user is root or has passwordless sudo already. */
const STDIO_SCRIPT = ["# agentrun-computer: stdio", "d=$1; r=$2", ROOT, `exec $p env -i PATH=${PATH} AGENTRUN_COMPUTERD_SOCKET="$r/computerd.sock" "$d" stdio`].join("\n");

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const shellCommand = (script: string, args: readonly string[]) => ["sh", "-c", quote(script), "sh", ...args.map(quote)].join(" ");

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
export function childCommands({ staging = "", deadline = "", user = "1000:1000", display = "", maxDeadline = "" }: ChildCommandOptions = {}) {
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
 * no_new_privs, no groups), its working directory and binary. Each read is bounded by timeoutMs and the caller's signal.
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
