// The commands the E2B provider sends into a sandbox, run where E2B would run them: a root container, each command
// through `bash -l -c` as envd's process start runs one (e2b@2.63.0 dist/index.mjs:5123-5146), init detached with a
// display and a maximum deadline, the bridge on stdin and stdout. AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run
// build` and `npm run build:daemon`, and debian:bookworm-slim pulled. Each container is named computer-e2b-<hex> and
// removed by that name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DaemonClient } from "../../dist/index.js";
import { childCommands } from "../../dist/child.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const STAGING = "/tmp/agentrun-computerd-0123456789abcdef";

describe("the E2B provider's commands in a root container, through bash -l -c", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	it("installs the daemon, init takes DISPLAY and --max-deadline, and deadline.extend moves up to that maximum and no further", async () => {
		const name = `computer-e2b-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		docker("run", "--detach", "--name", name, "debian:bookworm-slim", "sleep", "600");
		docker("cp", daemon, `${name}:${STAGING}`);
		const sha = createHash("sha256").update(readFileSync(daemon)).digest("hex");
		const deadline = new Date(Date.now() + 300_000);
		const most = new Date(deadline.getTime() + 600_000);
		const commands = childCommands({ staging: STAGING, deadline: deadline.toISOString(), user: "1000:1000", display: ":7", maxDeadline: most.toISOString() });

		assert.equal(docker("exec", name, "bash", "-l", "-c", commands.install).trim(), `sha256 ${sha}`);
		docker("exec", "--detach", name, "bash", "-l", "-c", commands.init);
		const child = spawn("docker", ["exec", "-i", name, "bash", "-l", "-c", commands.stdio], { stdio: ["pipe", "pipe", "pipe"] });
		children.push(child);
		const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
		let hello;
		for (const until = Date.now() + 30_000; Date.now() < until; ) {
			hello = await client.call("hello", { client: "e2b-commands test" }, { signal: AbortSignal.timeout(5_000) });
			if (hello.ok) break;
		}
		assert.equal(hello?.ok, true, JSON.stringify(hello));
		assert.equal(hello.value.kind, "linux", "no X server answers on :7, so hello declares no screen");

		const environ = await client.call("files.read", { path: "/proc/self/environ" });
		const env = Buffer.from(environ.value.data, "base64").toString().split("\0").filter(Boolean).sort();
		assert.deepEqual(env, ["AGENTRUN_COMPUTERD_SOCKET=/run/agentrun/computerd.sock", "DISPLAY=:7", "HOME=/work", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
		const status = Buffer.from((await client.call("files.read", { path: "/proc/self/status" })).value.data, "base64").toString();
		assert.match(status, /^Uid:\t1000\t1000\t1000\t1000$/m);
		assert.match(status, /^CapEff:\t0000000000000000$/m);

		const moved = new Date(deadline.getTime() + 120_000);
		const extended = await client.call("deadline.extend", { at: moved.toISOString() });
		assert.equal(extended.ok, true, JSON.stringify(extended));
		assert.equal(Date.parse(extended.value.at), moved.getTime());
		const past = await client.call("deadline.extend", { at: new Date(most.getTime() + 1_000).toISOString() });
		assert.equal(past.ok, false);
		assert.equal(past.error.code, "limit");
		client.close();
	});
});
