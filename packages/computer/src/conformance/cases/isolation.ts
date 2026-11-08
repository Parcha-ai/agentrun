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
 * Lists, as the computer's user, every unix socket with a path it can connect to, under the places one is found, each by
 * its real path (so /var/run's are /run's). With python3; prints `connects <path>` or `refused <path>` a line each, or
 * `no python3`.
 */
export const PATH_SOCKETS = [
	"command -v python3 >/dev/null 2>&1 || { echo 'no python3'; exit 0; }",
	"exec python3 -c '",
	"import os, socket, stat",
	"seen = set()",
	"for top in (\"/run\", \"/tmp\", \"/var/run\", \"/var/tmp\", \"/dev/shm\", \"/workspace\", \"/work\", \"/home\", \"/opt\"):",
	"    for root, dirs, files in os.walk(top):",
	"        for name in dirs + files:",
	"            path = os.path.join(root, name)",
	"            try:",
	"                if not stat.S_ISSOCK(os.lstat(path).st_mode): continue",
	"            except OSError: continue",
	"            real = os.path.realpath(path)",
	"            if real in seen: continue",
	"            seen.add(real)",
	"            s = socket.socket(socket.AF_UNIX)",
	"            s.settimeout(2)",
	"            try: s.connect(path); print(\"connects\", real)",
	"            except OSError: print(\"refused\", real)",
	"            finally: s.close()",
	"'",
].join("\n");

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
 * ::1 and at OUTSIDE_TARGETS; and the path unix sockets it connects to are the computer's own (OWN_SOCKETS) alone,
 * recorded, or recorded as not listed when the image has no python3. The Archil case mount.archil-isolated-durable runs
 * the same check on an Archil computer.
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
	const sockets = await t.exec(["sh", "-c", PATH_SOCKETS], { timeoutMs: 60_000 }, client);
	const lines = sockets.out.split("\n").filter(Boolean);
	if (lines.includes("no python3")) return t.observe("path unix sockets a tool can connect to: not listed (the image has no python3)");
	t.equal(sockets.exitCode, 0, `the path socket listing's exit code (stderr: ${sockets.err.trim().slice(0, 200)})`);
	const connects = lines.filter((line) => line.startsWith("connects ")).map((line) => line.slice("connects ".length));
	t.observe(`path unix sockets a tool can connect to: ${connects.join(", ") || "none"}`);
	const other = connects.filter((path) => !OWN_SOCKETS.includes(path));
	t.assert(other.length === 0, `a program of the computer's user connects to path unix sockets that are not the computer's own (${OWN_SOCKETS.join(", ")}): ${other.join(", ")}`);
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
