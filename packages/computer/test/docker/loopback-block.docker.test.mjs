// The loopback block, where the remote providers would run their commands: a root container standing in for a sandbox,
// with a root listener on 2280 and 49983 standing in for the vendor's agent (Daytona's toolbox, E2B's envd), which
// listen on every interface and run commands for whoever reaches them. Init starts as each provider starts it (the
// child commands of Daytona and E2B, Modal's entrypoint and upload), and a program of the computer's user, run through
// exec.run as isolation.vendor-agent runs it, must find every port of the stand-in refused, on the loopback and on the
// container's own address, and see its own loopback alone; root outside the daemon still reaches the stand-in. A root
// without CAP_SYS_ADMIN that may make a user namespace (as on gVisor) gets the same cut, made inside one. A root without
// either, and a container where another process holds the computer's uid, refuse to start init, in words. Alpine (BusyBox's nc is the stand-in). AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run build` and
// `npm run build:daemon`, and alpine:3.20 pulled. Each container is named computer-loop-<hex> and removed by that name.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DaemonClient } from "../../dist/index.js";
import { childCommands } from "../../dist/child.js";
import * as modal from "../../dist/modal.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const IMAGE = "alpine:3.20";
const STAGING = "/tmp/agentrun-computerd-0123456789abcdef";
const DAEMON = "/opt/agentrun/computerd";
const NAMESPACE_CAPS = ["--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN"];
const AGENT_PORTS = [2280, 49983];
/** The outside isolation.vendor-agent probes too: a public IP literal on 443 and a DNS name. */
const OUTSIDE = ["1.1.1.1:443", "example.com:443"];
const TOOL = "2510:2510";

function daemonBytes() {
	const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
	const path = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
	const bytes = readFileSync(path);
	return { path, bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

/** The stand-in agent: a root listener on each port, every interface, that sends back what it is sent. */
function standIn(name) {
	for (const port of AGENT_PORTS) docker("exec", "--detach", name, "nc", "-lk", "-p", String(port), "-e", "/bin/cat");
}

/** The probe's report of targets, run where `how` says: through the daemon (the computer's user) or as root outside. */
async function probe(client, targets) {
	const argv = [DAEMON, "probe", ...targets.flatMap((target) => ["--connect", target])];
	const ran = await client.call("exec.run", { argv, timeoutMs: 30_000 }, { signal: AbortSignal.timeout(40_000) });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.equal(ran.value.exitCode, 0, Buffer.from(ran.value.stderr, "base64").toString());
	return JSON.parse(Buffer.from(ran.value.stdout, "base64").toString());
}

/**
 * That root, outside the daemon, reaches the stand-in on the loopback and on the container's address: what a program
 * of the computer's user must not. Run before init starts: `docker exec` joins the namespaces of the container's first
 * process, which in Modal's shape is init itself once it has moved into its own network.
 */
function reachable(name, address) {
	for (const host of ["127.0.0.1", address]) {
		const said = spawnSync("docker", ["exec", name, "sh", "-c", `echo agent | nc -w 2 ${host} ${AGENT_PORTS[0]}`], { encoding: "utf8", timeout: 20_000 });
		assert.equal(said.stdout, "agent\n", `the stand-in answers root at ${host}:${AGENT_PORTS[0]}: ${said.stderr}`);
	}
}

const outcomes = (report) => Object.fromEntries(report.results.map(({ target, outcome }) => [target, outcome]));

/** The container's own address on Docker's bridge, as the stand-in agent listens on it too. */
function addressOf(name) {
	const address = docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name).trim().split(" ")[0];
	assert.match(address, /^\d+\.\d+\.\d+\.\d+$/, `${name} has an address on Docker's bridge`);
	return address;
}

describe("the loopback block: a program of the computer's user reaches no port of the vendor's agent", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	const named = () => {
		const name = `computer-loop-${randomBytes(6).toString("hex")}`;
		names.push(name);
		return name;
	};

	/** A client over the bridge once init answers hello. */
	async function connected(name, bridge) {
		const until = Date.now() + 30_000;
		for (;;) {
			const child = spawn("docker", ["exec", "-i", name, ...bridge], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const hello = await client.call("hello", { client: "loopback-block test" }, { signal: AbortSignal.timeout(10_000) });
			if (hello.ok) return client;
			client.close();
			child.kill("SIGKILL");
			if (Date.now() > until) assert.fail(`init in ${name} did not answer hello within 30 s: ${JSON.stringify(hello)}; logs: ${spawnSync("docker", ["logs", name], { encoding: "utf8" }).stderr}`);
			await sleep(300);
		}
	}

	/** A root container as Daytona's or E2B's sandbox, the daemon installed and the stand-in agent listening. */
	function childSandbox({ caps = NAMESPACE_CAPS } = {}) {
		const name = named();
		const { path, sha } = daemonBytes();
		docker("run", "--detach", "--name", name, ...caps, IMAGE, "sleep", "600");
		docker("cp", path, `${name}:${STAGING}`);
		const commands = childCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString(), user: TOOL });
		assert.equal(execFileSync("docker", ["exec", "-i", name, "sh"], { input: commands.install, encoding: "utf8" }).trim(), `sha256 ${sha}`);
		standIn(name);
		const address = addressOf(name);
		reachable(name, address);
		return { name, commands, address };
	}

	/**
	 * What a program of the computer's user reaches of the stand-in and of the outside (a public IP literal on 443, a DNS
	 * name; the container itself has Docker's bridge): nothing, and its own loopback still works.
	 */
	async function checkCutOff(client, address) {
		const targets = [...AGENT_PORTS.flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`]), ...AGENT_PORTS.map((port) => `${address}:${port}`), ...OUTSIDE];
		const report = await probe(client, targets);
		assert.deepEqual(report.interfaces, ["lo"], "a program of the computer's user sees its own loopback alone");
		assert.equal(`${report.uid}:${report.gid}`, TOOL);
		assert.deepEqual(outcomes(report), Object.fromEntries(targets.map((target) => [target, "refused"])), "every port of the stand-in, on every address, and the outside, refused");
		// Its own loopback still works: a listener of its own, reached from inside.
		const ran = await client.call("exec.run", { argv: ["sh", "-c", "nc -l -p 4000 -e /bin/echo own & sleep 0.3; nc 127.0.0.1 4000 </dev/null"], timeoutMs: 10_000 });
		assert.equal(Buffer.from(ran.value.stdout, "base64").toString(), "own\n", "a program's own loopback listener answers it");
	}

	for (const provider of ["Daytona", "E2B"]) {
		it(`${provider}'s child commands: init --own-network cuts the computer's programs off from the stand-in agent`, async () => {
			const { name, commands, address } = childSandbox();
			docker("exec", "--detach", name, "sh", "-c", commands.init);
			const client = await connected(name, ["sh", "-c", commands.stdio]);
			await checkCutOff(client, address);
			client.close();
		});
	}

	it("Modal's entrypoint and upload: init --own-network, pid 1, cuts the computer's programs off from the stand-in agent", async () => {
		const name = named();
		const { bytes, sha } = daemonBytes();
		const commands = modal.modalCommands({ deadline: new Date(Date.now() + 300_000).toISOString(), user: TOOL, waitSeconds: 120 });
		docker("run", "--detach", "--name", name, "--user", "0:0", ...NAMESPACE_CAPS, IMAGE, ...commands.entrypoint);
		// The vendor's agent is there before init, as it is in a sandbox: started, and reached, while the entrypoint waits.
		standIn(name);
		const address = addressOf(name);
		reachable(name, address);
		assert.equal(execFileSync("docker", ["exec", "-i", name, ...modal.modalCommands({ sha256: sha }).upload], { input: bytes, encoding: "utf8" }), `sha256 ${sha}\n`);
		const client = await connected(name, modal.modalCommands().stdio);
		await checkCutOff(client, address);
		client.close();
	});

	// As on gVisor (Modal's GPU runtime): root holds no CAP_SYS_ADMIN, but may make a user namespace (Docker's default
	// capabilities, and no seccomp profile, whose default refuses it). The same --own-network: init makes the namespace
	// inside a user namespace, and the stand-in agent, on the loopback and the container's address, is as far out of reach.
	// Not gVisor's netstack: this stand-in passed while init brought lo up by an ioctl gVisor refuses (ENOTTY); init's
	// rtnetlink path is proven on gVisor only live.
	it("as on gVisor: init --own-network, where root may not make a network namespace, makes it inside a user namespace and cuts the computer's programs off from the stand-in agent just the same", async () => {
		const name = named();
		const { bytes, sha } = daemonBytes();
		const commands = modal.modalCommands({ deadline: new Date(Date.now() + 300_000).toISOString(), user: TOOL, waitSeconds: 120 });
		docker("run", "--detach", "--name", name, "--user", "0:0", "--security-opt", "seccomp=unconfined", IMAGE, ...commands.entrypoint);
		standIn(name);
		const address = addressOf(name);
		reachable(name, address);
		assert.equal(execFileSync("docker", ["exec", "-i", name, ...modal.modalCommands({ sha256: sha }).upload], { input: bytes, encoding: "utf8" }), `sha256 ${sha}\n`);
		const client = await connected(name, modal.modalCommands().stdio);
		const hello = await client.call("hello", { client: "loopback-block test" });
		assert.equal(hello.ok && hello.value.fence, "userns-netns", JSON.stringify(hello));
		await checkCutOff(client, address);
		client.close();
	});

	it("a root without CAP_SYS_ADMIN, under Docker's default seccomp profile (no user namespace either), cannot give init a network of its own: init refuses to start, in words naming both ways", () => {
		const { name, commands } = childSandbox({ caps: [] });
		const ran = spawnSync("docker", ["exec", name, "sh", "-c", commands.init], { encoding: "utf8", timeout: 30_000 });
		assert.equal(ran.status, 1, ran.stdout + ran.stderr);
		assert.match(ran.stderr, /init refuses to start: cannot make a network namespace of its own for init and its programs: root here holds no CAP_SYS_ADMIN: operation not permitted, nor can it start itself again in a user and a network namespace of its own/);
	});

	it("init refuses to start while another process holds the computer's uid, and names it", () => {
		const { name, commands } = childSandbox();
		docker("exec", "--detach", "--user", TOOL, name, "sleep", "600");
		const ran = spawnSync("docker", ["exec", name, "sh", "-c", commands.init], { encoding: "utf8", timeout: 30_000 });
		assert.equal(ran.status, 1, ran.stdout + ran.stderr);
		assert.match(ran.stderr, /init refuses to start: uid 2510, which init's programs run as, is held already by process \d+ \(sleep\) outside init/);
	});
});
