// A program the computer's user runs reaches none of the vendor's own agent, whose ports each provider declares
// (capabilities().vendorAgentPorts), and sees its own loopback alone: computerd init --own-network at work.
import { DAEMON_IN_COMPUTER } from "../../drift.js";
import type { Case } from "../types.js";

interface ProbeLine {
	interfaces?: unknown;
	results?: Array<{ target?: unknown; outcome?: unknown; detail?: unknown }>;
}

export const isolationCases: Case[] = [
	{
		id: "isolation.vendor-agent",
		level: "core",
		group: "isolation",
		needs: ["vendor-agent", "exec"],
		async run(t) {
			const ports = t.provider.capabilities().vendorAgentPorts ?? [];
			t.assert(ports.every((port) => Number.isSafeInteger(port) && port > 0 && port < 65536), `the declared ports ${JSON.stringify(ports)} are TCP ports`);
			const targets = ports.flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`]);
			const ran = await t.exec([DAEMON_IN_COMPUTER, "probe", ...targets.flatMap((target) => ["--connect", target])], { timeoutMs: t.patience });
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
				const outcome = result?.outcome;
				t.equal(outcome, "refused", `a program of the computer's user, to the vendor's agent at ${target} (${String(result?.detail ?? "no result")})`);
			}
		},
	},
];
