// A program the computer's user runs reaches none of the vendor's own agent, whose ports each provider declares
// (capabilities().vendorAgentPorts), and no outside address, and sees its own loopback alone: computerd init
// --own-network at work.
import { DAEMON_IN_COMPUTER } from "../../drift.js";
import type { ComputerClient } from "../../protocol.js";
import type { Case, CaseContext } from "../types.js";

/**
 * The outside the case also probes: a public IP literal on 443, and a DNS name on 443, which a program could reach only
 * through a resolver and a route its own network does not have.
 */
export const OUTSIDE_TARGETS = ["1.1.1.1:443", "example.com:443"];

interface ProbeLine {
	interfaces?: unknown;
	results?: Array<{ target?: unknown; outcome?: unknown; detail?: unknown }>;
}

/**
 * The isolation check, on the computer `client` reaches (the case's own by default): computerd's probe, run as the
 * computer's user, sees its own loopback alone, and is refused at the vendor's agent's declared ports on 127.0.0.1 and
 * ::1 and at OUTSIDE_TARGETS. The Archil case mount.archil-isolated-durable runs the same check on an Archil computer.
 */
export async function assertIsolated(t: CaseContext, client?: ComputerClient): Promise<void> {
	const ports = t.provider.capabilities().vendorAgentPorts ?? [];
	t.assert(ports.every((port) => Number.isSafeInteger(port) && port > 0 && port < 65536), `the declared ports ${JSON.stringify(ports)} are TCP ports`);
	const agent = ports.flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`]); // key-gate: loopback-rule the computer's own loopbacks, where the vendor's agent listens and its programs must be refused
	const targets = [...agent, ...OUTSIDE_TARGETS];
	const ran = await t.exec([DAEMON_IN_COMPUTER, "probe", ...targets.flatMap((target) => ["--connect", target])], { timeoutMs: t.patience }, client);
	t.equal(ran.exitCode, 0, `the probe's exit code (stderr: ${ran.err.trim()})`);
	let probe: ProbeLine;
	try {
		probe = JSON.parse(ran.out) as ProbeLine;
	} catch {
		return t.assert(false, `the probe wrote what is not its report: ${ran.out.slice(0, 200)}`);
	}
	t.deepEqual(probe.interfaces, ["lo"], "the interfaces a program of the computer's user sees: its own loopback alone");
	for (const target of targets) {
		const result = probe.results?.find((one) => one.target === target);
		const what = agent.includes(target) ? "the vendor's agent" : "the outside";
		t.equal(result?.outcome, "refused", `a program of the computer's user, to ${what} at ${target} (${String(result?.detail ?? "no result")})`);
	}
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
