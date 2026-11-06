// The commands the Daytona provider sends into a sandbox, run where Daytona would run them: a root container (Daytona's
// container class runs code as root), the install piped to a shell's stdin as /process/execute does, init detached, the
// bridge on stdin and stdout. AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run build` and `npm run build:daemon`, and
// debian:bookworm-slim pulled. Each container is named computer-daytona-<hex> and removed by that name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DaemonClient } from "../../dist/index.js";
import { daytonaCommands } from "../../dist/daytona.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const STAGING = "/tmp/agentrun-computerd-0123456789abcdef";

describe("the Daytona provider's commands in a root container", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	/** A root container with the daemon at the staging path, as the toolbox's upload leaves it. */
	function sandbox() {
		const name = `computer-daytona-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		docker("run", "--detach", "--name", name, "debian:bookworm-slim", "sleep", "600");
		docker("cp", daemon, `${name}:${STAGING}`);
		return { name, arch, sha: createHash("sha256").update(readFileSync(daemon)).digest("hex") };
	}

	it("installs the daemon, starts init as 1000:1000 with no capabilities, and the bridge speaks the protocol", async () => {
		const { name, arch, sha } = sandbox();
		const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
		const installed = execFileSync("docker", ["exec", "-i", name, "sh"], { input: commands.install, encoding: "utf8" });
		assert.equal(installed.trim(), `sha256 ${sha}`, "the install prints the installed binary's sha256");
		assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/opt/agentrun/computerd").trim(), "0:0 755");
		assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/work", "/run/agentrun").trim(), "1000:1000 700\n1000:1000 700");
		assert.equal(docker("exec", name, "sh", "-c", `test -e ${STAGING} && echo left || echo gone`).trim(), "gone");
		docker("exec", "--detach", name, "sh", "-c", commands.init);
		const child = spawn("docker", ["exec", "-i", name, "sh", "-c", commands.stdio], { stdio: ["pipe", "pipe", "pipe"] });
		children.push(child);
		const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
		const hello = await client.call("hello", { client: "daytona-commands test" }, { signal: AbortSignal.timeout(30_000) });
		assert.equal(hello.ok, true, JSON.stringify(hello));
		assert.equal(hello.value.arch, arch);
		const status = await client.call("files.read", { path: "/proc/self/status" });
		const fields = Object.fromEntries(
			Buffer.from(status.value.data, "base64")
				.toString()
				.split("\n")
				.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
		);
		assert.equal(fields.Uid, "1000\t1000\t1000\t1000");
		assert.equal(fields.Gid, "1000\t1000\t1000\t1000");
		assert.equal(fields.Groups, "");
		assert.equal(fields.NoNewPrivs, "1");
		for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.equal(fields[set], "0000000000000000", set);
		assert.equal((await client.call("files.stat", { path: "/proc/self/cwd" })).value.target, "/work");
		assert.equal((await client.call("files.stat", { path: "/proc/self/exe" })).value.target, "/opt/agentrun/computerd");
		const ran = await client.call("exec.run", { argv: ["sh", "-c", 'id -u; echo ok > "$HOME/x" && cat "$HOME/x"; echo x > /opt/agentrun/computerd || echo denied'], timeoutMs: 10_000 });
		assert.equal(Buffer.from(ran.value.stdout, "base64").toString(), "1000\nok\ndenied\n");
		client.close();
	});

	it("an install by a user that is not root and has no sudo says why, and installs nothing", () => {
		const { name } = sandbox();
		const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
		let failed;
		try {
			execFileSync("docker", ["exec", "-i", "--user", "1000:1000", name, "sh"], { input: commands.install, encoding: "utf8" });
		} catch (error) {
			failed = error;
		}
		assert.equal(failed?.status, 3);
		assert.match(failed.stdout, /is not root and has no passwordless sudo, so the daemon cannot be installed/);
		assert.equal(docker("exec", name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");
	});
});
