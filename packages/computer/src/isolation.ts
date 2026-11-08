// What a remote computer's programs are cut off from, as the providers ask for it and read it back. A remote vendor runs
// its own agent in the computer beside them (Daytona's toolbox, E2B's envd), one that runs commands as root or with sudo
// for whoever reaches it. So every remote provider starts init with --own-network: init, still root, refuses to start
// while another process holds the programs' uid, moves itself into a network namespace whose loopback alone is up, and
// refuses vsock and io_uring to every thread (daemon/internal/isolate). Network "none" is all such a computer takes
// until a proxy carries open and allowlists out of that namespace.

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
 * The drift of a computer's programs' network from their own loopback alone, in words: none when the daemon's network
 * namespace holds `lo` alone, else what it holds (or that it could not be read).
 */
export function ownNetworkDrift(interfaces: string[] | undefined): string[] {
	if (interfaces === undefined) return ["daemon network: declared its own (lo alone), read back nothing it could read"];
	if (interfaces.length === 1 && interfaces[0] === "lo") return [];
	return [`daemon network: declared its own (lo alone), read back ${interfaces.length === 0 ? "no interface" : interfaces.join(", ")}`];
}
