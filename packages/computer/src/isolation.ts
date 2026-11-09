// What a remote computer's programs are cut off from, as the providers ask for it and read it back. A remote vendor runs
// its own agent in the computer beside them (Daytona's toolbox, E2B's envd), one that runs commands as root or with sudo
// for whoever reaches it. So every remote provider starts init with --own-network: init, still root, refuses to start
// while another process holds the programs' uid, moves itself into a network namespace whose loopback alone is up or
// addressed, and refuses vsock and io_uring to every thread (daemon/internal/isolate). A kernel with the tunnel modules
// loaded also gives that namespace its fallback tunnels (tunl0, gre0, sit0, ...), down with no address; no program can
// raise them, holding no CAP_NET_ADMIN, and the read-back here proves it through computerd's probe. Network "none" is
// all such a computer takes until a proxy carries open and allowlists out of that namespace.
import { DAEMON_IN_COMPUTER } from "./drift.js";
import type { ComputerClient } from "./protocol.js";
import { fail, ok, type Result } from "./result.js";

/** The uid:gid the programs of a remote computer run as by default: the box image's agentrun-tool, no sudo. */
export const TOOL_USER = "2510:2510";

/** Why a remote provider refuses network open or an allowlist, in words. */
export const OWN_NETWORK_ONLY =
	'a remote computer takes network "none" only: its programs run in a network of their own, their loopback alone, so the vendor\'s agent in it (which runs commands as root) is out of their reach; open and allowlists wait for a proxy out of that network';

/** The interfaces /proc/<pid>/net/dev lists, in its order; undefined when the text is not that file. */
export function netDevInterfaces(text: string): string[] | undefined {
	const lines = text.split("\n");
	if (!lines[0]?.startsWith("Inter-|") || !lines[1]?.includes("face |")) return undefined;
	const names: string[] = [];
	for (const line of lines.slice(2)) {
		if (line.trim() === "") continue;
		const at = line.indexOf(":");
		if (at < 0) return undefined;
		names.push(line.slice(0, at).trim());
	}
	return names;
}

/**
 * The drift of a computer's programs' network from their own loopback alone, in words: none when the live interfaces
 * (up or addressed) of the daemon's network namespace are `lo` alone, else what they are (or that they could not be read).
 */
export function ownNetworkDrift(interfaces: string[] | undefined): string[] {
	if (interfaces === undefined) return ["daemon network: declared its own (lo alone), read back nothing it could read"];
	if (interfaces.length === 1 && interfaces[0] === "lo") return [];
	return [`daemon network: declared its own (lo alone), read back ${interfaces.length === 0 ? "no interface" : interfaces.join(", ")}`];
}

/** What computerd probe reports of its own network namespace: the live interfaces, the quiet ones, the raised ones. */
export interface OwnNetworkReport {
	interfaces?: unknown;
	quiet?: unknown;
	raised?: unknown;
}

const names = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((one) => typeof one === "string") ? value : undefined);

/**
 * The drift of a probe report from the own network, in words: its live interfaces `lo` alone (a kernel's quiet tunnels,
 * down and addressless, are no drift), and none a program of the computer's user could bring up.
 */
export function probeOwnNetworkDrift(report: OwnNetworkReport): string[] {
	const found = ownNetworkDrift(names(report.interfaces));
	const raised = names(report.raised) ?? [];
	if (raised.length > 0) found.push(`daemon network: a program of the computer's user brought up ${raised.join(", ")}, which no program of its own network may`);
	return found;
}

/**
 * A computer's own network read back as its user sees it: computerd's probe, with no target, through the daemon's
 * exec.run (as the computer's user), and its drift (probeOwnNetworkDrift).
 */
export async function readOwnNetwork(client: ComputerClient, timeoutMs: number, signal?: AbortSignal): Promise<Result<string[]>> {
	const ran = await client.call("exec.run", { argv: [DAEMON_IN_COMPUTER, "probe"], timeoutMs }, signal ? { signal } : undefined);
	if (!ran.ok) return fail(ran.error.code, `reading the computer's own network back (computerd probe): ${ran.error.message}`);
	const out = Buffer.from(ran.value.stdout, "base64").toString("utf8");
	if (ran.value.exitCode !== 0) return fail("refused", `computerd probe, reading the computer's own network back, exited ${ran.value.exitCode}: ${Buffer.from(ran.value.stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
	try {
		return ok(probeOwnNetworkDrift(JSON.parse(out) as OwnNetworkReport));
	} catch {
		return fail("refused", `computerd probe, reading the computer's own network back, wrote what is not its report: ${out.slice(0, 200)}`);
	}
}
