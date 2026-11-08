// The commands the E2B provider sends into a sandbox, run where E2B would run them: a root container, init detached with
// a display and a maximum deadline, the bridge on stdin and stdout. envd runs a command as `bash -l -c <command>`
// (e2b@2.63.0 dist/index.mjs:5123-5146), and each command is itself `sh -c '<script>' sh <args>`, so here a shell runs
// it as-is: the desktop fixture's image (test/fixtures/desktop/Dockerfile, Alpine and Xvfb) has no bash. The X server
// then starts through the daemon on the display init was given, and hello declares the screen: DISPLAY reached init.
// AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run build` and `npm run build:daemon`, and alpine:3.20 pulled. Each
// container is named computer-e2b-<hex> and removed by that name, pass or fail.
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
const DOCKERFILE = fileURLToPath(new URL("../fixtures/desktop/Dockerfile", import.meta.url));

describe("the E2B provider's commands in a root desktop container", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	it("installs the daemon, init drives the display it is given, and deadline.extend moves up to --max-deadline and no further", async () => {
		const name = `computer-e2b-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		const recipe = readFileSync(DOCKERFILE);
		const image = `agentrun-computer-desktop:${createHash("sha256").update(recipe).digest("hex").slice(0, 12)}`;
		execFileSync("docker", ["build", "--quiet", "--tag", image, "-"], { input: recipe, stdio: ["pipe", "ignore", "inherit"] });
		docker("run", "--detach", "--name", name, image, "sleep", "600");
		docker("cp", daemon, `${name}:${STAGING}`);
		const sha = createHash("sha256").update(readFileSync(daemon)).digest("hex");
		const deadline = new Date(Date.now() + 300_000);
		const most = new Date(deadline.getTime() + 600_000);
		const commands = childCommands({ staging: STAGING, deadline: deadline.toISOString(), user: "1000:1000", display: ":7", maxDeadline: most.toISOString() });

		assert.equal(docker("exec", name, "sh", "-c", commands.install).trim(), `sha256 ${sha}`);
		docker("exec", "--detach", name, "sh", "-c", commands.init);
		const child = spawn("docker", ["exec", "-i", name, "sh", "-c", commands.stdio], { stdio: ["pipe", "pipe", "pipe"] });
		children.push(child);
		const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
		let hello;
		for (const until = Date.now() + 30_000; Date.now() < until; ) {
			hello = await client.call("hello", { client: "e2b-commands test" }, { signal: AbortSignal.timeout(5_000) });
			if (hello.ok) break;
		}
		assert.equal(hello?.ok, true, JSON.stringify(hello));
		assert.equal(hello.value.kind, "linux", "no X server answers on :7, so hello declares no screen");

		const status = Buffer.from((await client.call("files.read", { path: "/proc/self/status" })).value.data, "base64").toString();
		assert.match(status, /^Uid:\t1000\t1000\t1000\t1000$/m);
		assert.match(status, /^CapEff:\t0000000000000000$/m);
		// The X server, through the daemon as the provider starts it: hello declares the screen once :7 answers.
		const started = await client.call("process.start", { argv: ["Xvfb", ":7", "-screen", "0", "640x480x24", "-nolisten", "tcp"] });
		assert.equal(started.ok, true, JSON.stringify(started));
		let shown;
		for (const until = Date.now() + 30_000; Date.now() < until; await new Promise((done) => setTimeout(done, 200))) {
			shown = await client.call("hello", { client: "e2b-commands test" });
			if (shown.ok && shown.value.groups.includes("screen")) break;
		}
		assert.equal(shown.value.kind, "desktop", JSON.stringify(shown));

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
