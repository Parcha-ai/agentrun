// A program the computer's user runs reaches none of the vendor's own agent, whose ports each provider declares
// (capabilities().vendorAgentPorts), and no outside address, sees its own loopback alone, and finds nothing listening in
// its own network but computerd: computerd init --own-network at work. And it can write nothing root runs.
import { DAEMON_IN_COMPUTER, SOCKET_DIR } from "../../drift.js";
import { EGRESS_PROXY_SOCKET } from "../../hosted/network.js";
import { ARCHIL_HELPER, ARCHIL_SYNC_SOCKET } from "../../mount-archil.js";
import type { ComputerClient } from "../../protocol.js";
import type { Case, CaseContext } from "../types.js";

/**
 * The unix sockets a program of the computer's user may connect to: the computer's own, computerd's, the Archil sync
 * socket (which only syncs) and, under network open or a list, the egress proxy's (which reaches the public internet
 * alone, as the spec's network asked). A network namespace does not cut a path socket, and every program in the
 * namespace reaches an abstract name (@...), so any other socket is a door out.
 */
export const OWN_SOCKETS: readonly string[] = [`${SOCKET_DIR}/computerd.sock`, ARCHIL_SYNC_SOCKET, EGRESS_PROXY_SOCKET];

/**
 * The outside the case also probes: a public IP literal on 443, and a DNS name on 443, which a program could reach only
 * through a resolver and a route its own network does not have.
 */
export const OUTSIDE_TARGETS = ["1.1.1.1:443", "example.com:443"];

interface ProbeLine {
	interfaces?: unknown;
	quiet?: unknown;
	raised?: unknown;
	sockets?: unknown;
	listeners?: unknown;
	results?: Array<{ target?: unknown; outcome?: unknown; detail?: unknown }>;
}

/**
 * The isolation check, on the computer `client` reaches (the case's own by default): computerd's probe, run as the
 * computer's user, sees its own loopback alone, and is refused at the vendor's agent's declared ports on 127.0.0.1 and
 * ::1 and at OUTSIDE_TARGETS; and the unix sockets it connects to, paths and abstract names (the probe's own listing,
 * --sockets), are the computer's own (OWN_SOCKETS, and a desktop's display) alone, each recorded with its type; and every TCP and UDP
 * listener in its own network is computerd's (assertOnlyComputerdListens: today, none listens). A probe that reports no
 * socket list or no listener list, or a search it could not finish, fails the check in words. The Archil case mount.archil-isolated-durable runs the same check on an Archil computer.
 */
export async function assertIsolated(t: CaseContext, client?: ComputerClient): Promise<void> {
	const ports = t.provider.capabilities().vendorAgentPorts ?? [];
	t.assert(ports.every((port) => Number.isSafeInteger(port) && port > 0 && port < 65536), `the declared ports ${JSON.stringify(ports)} are TCP ports`);
	const agent = ports.flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`]); // key-gate: loopback-rule the computer's own loopbacks, where the vendor's agent listens and its programs must be refused
	const targets = [...agent, ...OUTSIDE_TARGETS];
	const ran = await t.exec([DAEMON_IN_COMPUTER, "probe", "--sockets", ...targets.flatMap((target) => ["--connect", target])], { timeoutMs: t.patience }, client);
	t.equal(ran.exitCode, 0, `the probe's exit code (stderr: ${ran.err.trim()})`);
	let probe: ProbeLine;
	try {
		probe = JSON.parse(ran.out) as ProbeLine;
	} catch {
		return t.assert(false, `the probe wrote what is not its report: ${ran.out.slice(0, 200)}`);
	}
	t.deepEqual(probe.interfaces, ["lo"], "the live interfaces (up or addressed) a program of the computer's user sees: its own loopback alone");
	// A kernel's fallback tunnels, down with no address, are quiet: recorded. One a program could bring up is a way out.
	const quiet = Array.isArray(probe.quiet) ? probe.quiet.map(String) : [];
	if (quiet.length > 0) t.observe(`quiet interfaces (down, no address) a program of the computer's user sees: ${quiet.join(", ")}`);
	const raised = Array.isArray(probe.raised) ? probe.raised.map(String) : [];
	t.assert(raised.length === 0, `a program of the computer's user brought up ${raised.join(", ")}, which no program of its own network may`);
	// Every target's outcome, in one line of the report, before any is asserted: a passing run shows what was tried too.
	const outcome = (target: string) => {
		const result = probe.results?.find((one) => one.target === target);
		return result === undefined ? "no result" : `${String(result.outcome)}${result.detail === undefined || result.detail === "" ? "" : ` (${String(result.detail)})`}`;
	};
	t.observe(`probe, as the computer's user: ${targets.map((target) => `${target} ${outcome(target)}`).join("; ")}`);
	for (const target of targets) {
		const result = probe.results?.find((one) => one.target === target);
		const what = agent.includes(target) ? "the vendor's agent" : "the outside";
		t.equal(result?.outcome, "refused", `a program of the computer's user, to ${what} at ${target} (${String(result?.detail ?? "no result")})`);
	}
	// The unix sockets: paths, which no network namespace cuts, and the abstract names of the user's own namespace.
	// computerd's own listing, so no image can lack it. Each with the type that connected (stream, dgram, seqpacket); a
	// search it could not finish proves nothing, and fails.
	const search = probe.sockets as { sockets?: unknown; incomplete?: unknown } | undefined;
	if (search === null || typeof search !== "object" || !Array.isArray(search.sockets) || !Array.isArray(search.incomplete)) {
		return t.assert(false, "the probe reported no list of the unix sockets a program can connect to (a computerd too old for probe --sockets), so the socket fence could not run");
	}
	const found = search.sockets.map((one) => ({ path: String((one as { path?: unknown }).path), type: String((one as { type?: unknown }).type) }));
	t.observe(`unix sockets a tool can connect to: ${found.map(({ path, type }) => `${path} (${type})`).join(", ") || "none"}`);
	const incomplete = search.incomplete.map(String);
	t.assert(incomplete.length === 0, `the probe could not search every place a socket may be, so the socket fence is unproven: ${incomplete.join("; ")}`);
	// A desktop's tools draw on its display: the X server of the display its hello names, on its path and on the same
	// name as an abstract one, is the computer's own too.
	const own = [...OWN_SOCKETS];
	if (t.provider.capabilities().kind === "desktop") {
		const display = await displaySocket(client ?? t.client);
		if (display !== undefined) own.push(display, `@${display}`);
		else t.observe("the desktop's display socket: not known (its hello names no display of the form :N)");
	}
	const other = found.filter(({ path }) => !own.includes(path)).map(({ path, type }) => `${path} (${type})`);
	t.assert(other.length === 0, `a program of the computer's user connects to unix sockets that are not the computer's own (${own.join(", ")}): ${other.join(", ")}`);
	assertOnlyComputerdListens(t, probe.listeners);
}

/**
 * The TCP and UDP listeners in the network of the computer's user (the probe's listing, --sockets, from /proc/net/tcp,
 * tcp6, udp and udp6 of its own namespace) are computerd's alone: each held by a process that runs computerd's own
 * program, as the probe ties a socket's inode to the descriptors of the processes /proc shows it. Computerd listens on
 * nothing there today: init's one TCP listener, the egress relay (--egress), is a Docker computer's, which takes no
 * --own-network, and the Archil relay and sync server run as root beside the fence, in the vendor's network. So the rule
 * now is that nothing listens. Init's own descriptors are not the probe's to read (it drops to the programs' uid
 * non-dumpable), so a listener init opened there would fail here, named, until the probe ties it. A listing the probe did
 * not report, or a table it could not read, fails in words.
 */
function assertOnlyComputerdListens(t: CaseContext, reported: unknown): void {
	const search = reported as { listeners?: unknown; incomplete?: unknown } | undefined;
	if (search === null || typeof search !== "object" || !Array.isArray(search.listeners) || !Array.isArray(search.incomplete)) {
		return t.assert(false, "the probe reported no list of the TCP and UDP listeners in the user's own network (a computerd too old for its listeners), so the listener fence could not run");
	}
	const listeners = search.listeners.map((one) => {
		const { protocol, address, port, owner, computerd } = one as { protocol?: unknown; address?: unknown; port?: unknown; owner?: unknown; computerd?: unknown };
		return { protocol: String(protocol), address: String(address), port: String(port), owner: typeof owner === "string" && owner !== "" ? owner : "its owner not shown", computerd: computerd === true };
	});
	t.observe(`TCP and UDP listeners in the user's own network: ${listeners.map((one) => `${one.protocol} ${one.address} port ${one.port} (${one.owner}${one.computerd ? ", computerd" : ""})`).join(", ") || "none"}`);
	const incomplete = search.incomplete.map(String);
	t.assert(incomplete.length === 0, `the probe could not read every table of listeners, so the listener fence is unproven: ${incomplete.join("; ")}`);
	const stray = listeners.filter((one) => !one.computerd).map((one) => `${one.protocol} port ${one.port} listens in the user's own network (on ${one.address}, ${one.owner}), and it isn't computerd's`);
	t.assert(stray.length === 0, stray.join("; "));
}

/**
 * The X socket of the display a desktop's hello names (:N or :N.S, /tmp/.X11-unix/XN). Asked of the daemon itself: its
 * /proc/self/environ is root's once init drops to its programs' uid (non-dumpable), so it is never read.
 */
async function displaySocket(client: ComputerClient): Promise<string | undefined> {
	const hello = await client.call("hello", { client: "agentrun-computer conformance" });
	if (!hello.ok) return undefined;
	const number = /^:(\d{1,4})(?:\.\d{1,4})?$/.exec(hello.value.display ?? "")?.[1];
	return number === undefined ? undefined : `/tmp/.X11-unix/X${number}`;
}

/**
 * What root runs or reads in a computer: the directories of root's PATH (the one init gets, hosted/scripts.ts, and
 * Debian's), computerd, the root helpers an Archil image ships (the helper and the archil client it runs), and, where an
 * image has them, the vendor's agent (E2B's envd) and init's table.
 */
export const ROOT_RUNS: readonly string[] = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", DAEMON_IN_COMPUTER, ARCHIL_HELPER, "/usr/bin/archil", "/usr/bin/envd", "/etc/inittab"];

/** Each path given that is there, then every directory above it, each as `writable <path>` or `closed <path>`: `test -w`
 *  as the computer's user, and nothing written. A path on a read-only mount is closed: BusyBox's `test -w` reads the
 *  mode bits alone, so the mount's options are read from /proc/self/mountinfo (the longest mount point above the path,
 *  its own options and its superblock's). */
const ROOT_RUNS_SCRIPT = [
	"# agentrun-conformance: root-runs",
	"ro() { r=$(readlink -f \"$1\" 2>/dev/null); awk -v p=\"${r:-$1}\" '{ m = $5; gsub(/\\\\040/, \" \", m); if ((p == m || m == \"/\" || index(p, m \"/\") == 1) && length(m) >= n) { n = length(m); o = $6; for (i = 7; i < NF; i++) if ($i == \"-\") { o = o \",\" $(i + 3); break } } } END { exit !(o ~ /(^|,)ro(,|$)/) }' /proc/self/mountinfo 2>/dev/null; }",
	'for p in "$@"; do',
	'\t[ -e "$p" ] || [ -L "$p" ] || continue',
	"\tx=$p",
	"\twhile :; do",
	'\t\tif [ -w "$x" ] && ! ro "$x"; then echo "writable $x"; else echo "closed $x"; fi',
	'\t\t[ "$x" = / ] && break',
	"\t\tx=${x%/*}; x=${x:-/}",
	"\tdone",
	"done",
].join("\n");

/** The check's argv, for the paths given (default ROOT_RUNS). */
export const rootRunsArgv = (paths: readonly string[] = ROOT_RUNS): string[] => ["sh", "-c", ROOT_RUNS_SCRIPT, "sh", ...paths];

/**
 * The computer's user can write nothing root runs (ROOT_RUNS), nor any directory above it: a program of its could
 * otherwise change what root runs next. Checked as that user with `test -w`, on the computer `client` reaches (the case's
 * own by default); every path read is recorded, and one it reads none of fails.
 */
export async function assertRootRunsClosed(t: CaseContext, client?: ComputerClient): Promise<void> {
	const ran = await t.exec(rootRunsArgv(), { timeoutMs: t.patience }, client);
	t.equal(ran.exitCode, 0, `the check's exit code (stderr: ${ran.err.trim()})`);
	const said = (word: string) => [...new Set(ran.out.split("\n").flatMap((line) => (line.startsWith(`${word} `) ? [line.slice(word.length + 1)] : [])))];
	const closed = said("closed");
	const writable = said("writable");
	t.observe(`what root runs, and the directories above it, as the computer's user: ${closed.length} closed (${closed.sort().join(", ")})${writable.length > 0 ? `; writable: ${writable.sort().join(", ")}` : ""}`);
	t.assert(closed.length + writable.length > 0, `the check read no path: ${ran.out.slice(0, 200)}`);
	t.assert(writable.length === 0, `the computer's user can write what root runs: ${writable.join(", ")}`);
}

export const isolationCases: Case[] = [
	{
		id: "isolation.vendor-agent",
		level: "core",
		group: "isolation",
		needs: ["vendor-agent", "exec"],
		async run(t) {
			await assertIsolated(t);
		},
	},
	{
		id: "isolation.root-runs",
		level: "core",
		group: "isolation",
		needs: ["exec"],
		async run(t) {
			await assertRootRunsClosed(t);
		},
	},
];
