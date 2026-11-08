// A program the computer's user runs reaches none of the vendor's own agent, whose ports each provider declares
// (capabilities().vendorAgentPorts), and no outside address, and sees its own loopback alone: computerd init
// --own-network at work.
import { DAEMON_IN_COMPUTER, SOCKET_DIR } from "../../drift.js";
import { ARCHIL_SYNC_SOCKET } from "../../mount-archil.js";
import type { ComputerClient } from "../../protocol.js";
import type { Case, CaseContext } from "../types.js";

/**
 * The path unix sockets a program of the computer's user may connect to: the computer's own, computerd's and the Archil
 * sync socket (which only syncs). A network namespace does not cut a path socket, so any other is a door out.
 */
export const OWN_SOCKETS: readonly string[] = [`${SOCKET_DIR}/computerd.sock`, ARCHIL_SYNC_SOCKET];

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
	results?: Array<{ target?: unknown; outcome?: unknown; detail?: unknown }>;
}

/**
 * The isolation check, on the computer `client` reaches (the case's own by default): computerd's probe, run as the
 * computer's user, sees its own loopback alone, and is refused at the vendor's agent's declared ports on 127.0.0.1 and
 * ::1 and at OUTSIDE_TARGETS; and the path unix sockets it connects to (the probe's own listing, --sockets) are the
 * computer's own (OWN_SOCKETS, and a desktop's display) alone, recorded. A probe that reports no socket list fails the
 * check in words. The Archil case mount.archil-isolated-durable runs the same check on an Archil computer.
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
	for (const target of targets) {
		const result = probe.results?.find((one) => one.target === target);
		const what = agent.includes(target) ? "the vendor's agent" : "the outside";
		t.equal(result?.outcome, "refused", `a program of the computer's user, to ${what} at ${target} (${String(result?.detail ?? "no result")})`);
	}
	// The path unix sockets, which no network namespace cuts: computerd's own listing, so no image can lack it.
	if (!Array.isArray(probe.sockets)) return t.assert(false, "the probe reported no list of the path unix sockets a program can connect to (a computerd too old for probe --sockets), so the socket fence could not run");
	const connects = probe.sockets.map(String);
	t.observe(`path unix sockets a tool can connect to: ${connects.join(", ") || "none"}`);
	// A desktop's tools draw on its display: the one X socket of the daemon's own DISPLAY is the computer's own too.
	const own = [...OWN_SOCKETS];
	if (t.provider.capabilities().kind === "desktop") {
		const display = await displaySocket(client ?? t.client);
		if (display !== undefined) own.push(display);
		else t.observe("the desktop's display socket: not known (the daemon's environment names no DISPLAY of the form :N)");
	}
	const other = connects.filter((path) => !own.includes(path));
	t.assert(other.length === 0, `a program of the computer's user connects to path unix sockets that are not the computer's own (${own.join(", ")}): ${other.join(", ")}`);
}

/** The X socket of the daemon's own DISPLAY (:N or :N.S, /tmp/.X11-unix/XN), read from its /proc/self/environ. */
async function displaySocket(client: ComputerClient): Promise<string | undefined> {
	const read = await client.call("files.read", { path: "/proc/self/environ" });
	if (!read.ok) return undefined;
	const environ = Buffer.from(read.value.data, "base64").toString("utf8").split("\0");
	const display = environ.find((entry) => entry.startsWith("DISPLAY="))?.slice("DISPLAY=".length);
	const number = /^:(\d{1,4})(?:\.\d{1,4})?$/.exec(display ?? "")?.[1];
	return number === undefined ? undefined : `/tmp/.X11-unix/X${number}`;
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
];
