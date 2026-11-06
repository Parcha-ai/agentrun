// The commands the Modal provider sends when it uploads the daemon, run where Modal would run them: a container started
// as root (Modal containers always run as root) with no network, whose command is the provider's entrypoint, the
// upload streamed into `docker exec -i` as the provider streams it into exec's stdin, and the bridge over
// `docker exec -i ... computerd stdio`. On a Debian image (coreutils) and an Alpine one (BusyBox only).
// AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run build` and `npm run build:daemon`, and debian:bookworm-slim and
// alpine:3.20 pulled. Each container is named computer-modal-<hex> and removed by that name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DaemonClient } from "../../dist/index.js";
import * as modal from "../../dist/modal.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const IMAGES = ["debian:bookworm-slim", "alpine:3.20"];
const ZERO = "0000000000000000";
const modalCommands = (options) => modal.modalCommands(options);

/** A /proc status file's fields, by name. */
const fieldsOf = (text) =>
	Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes(":"))
			.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
	);

describe("the Modal provider's upload commands in a root container with no network", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) {
			spawnSync("docker", ["kill", name], { stdio: "ignore" });
			spawnSync("docker", ["rm", name], { stdio: "ignore" });
		}
	});

	/** A root container of image, network none, whose command is the provider's entrypoint. */
	function sandbox(image, { waitSeconds = 120 } = {}) {
		const name = `computer-modal-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const deadline = new Date(Date.now() + 300_000).toISOString();
		const commands = modalCommands({ deadline, user: "1000:1000", waitSeconds });
		docker("run", "--detach", "--name", name, "--network", "none", "--user", "0:0", image, ...commands.entrypoint);
		return { name, deadline };
	}

	/** The daemon for this Docker host's architecture, and its sha256. */
	function daemon() {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const bytes = readFileSync(fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url)));
		return { arch, bytes, sha: createHash("sha256").update(bytes).digest("hex") };
	}

	/** PID 1's status, once it is the daemon dropped to its user: init execs and drops itself, so it may take a moment. */
	async function initStatus(name) {
		const until = Date.now() + 30_000;
		for (;;) {
			const read = spawnSync("docker", ["exec", name, "cat", "/proc/1/status"], { encoding: "utf8" });
			const fields = fieldsOf(read.stdout ?? "");
			if (fields.Uid === "1000\t1000\t1000\t1000" || Date.now() > until) return fields;
			await sleep(200);
		}
	}

	for (const image of IMAGES) {
		it(`${image}: the entrypoint waits, the upload streams the daemon in and checks its sha256, init runs as 1000 with no capabilities, and hello answers`, async () => {
			const { name, deadline } = sandbox(image);
			const { arch, bytes, sha } = daemon();
			assert.equal(docker("inspect", "--format", "{{.State.Running}}", name).trim(), "true", "the entrypoint waits for the daemon");
			assert.equal(docker("exec", name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");

			const upload = modalCommands({ sha256: sha }).upload;
			const uploaded = execFileSync("docker", ["exec", "-i", name, ...upload], { input: bytes, encoding: "utf8" });
			assert.equal(uploaded, `sha256 ${sha}\n`, "the upload prints the sha256 of what it wrote");
			assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/opt/agentrun/computerd").trim(), "0:0 755");
			assert.equal(docker("exec", name, "sh", "-c", "test -e /opt/agentrun/.computerd.part && echo left || echo moved").trim(), "moved");

			const fields = await initStatus(name);
			assert.equal(fields.Uid, "1000\t1000\t1000\t1000", "init, PID 1, became uid 1000");
			assert.equal(fields.Gid, "1000\t1000\t1000\t1000");
			assert.equal(fields.CapEff, ZERO);
			assert.equal(fields.NoNewPrivs, "1");
			// /proc/1/exe needs ptrace access to a process that changed its uid; its command line does not.
			const argv = docker("exec", name, "cat", "/proc/1/cmdline").split("\0").filter(Boolean);
			assert.deepEqual(argv, ["/opt/agentrun/computerd", "init", "--deadline", deadline, "--user", "1000:1000"], "the entrypoint exec'd the daemon: it is PID 1");

			const child = spawn("docker", ["exec", "-i", name, ...modalCommands().stdio], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const hello = await client.call("hello", { client: "modal-commands test" }, { signal: AbortSignal.timeout(30_000) });
			assert.equal(hello.ok, true, JSON.stringify(hello));
			assert.equal(hello.value.version, VERSION);
			assert.equal(hello.value.arch, arch);
			const ran = await client.call("exec.run", { argv: ["sh", "-c", 'id -u; echo "$HOME"'], timeoutMs: 10_000 });
			assert.equal(ran.ok, true, JSON.stringify(ran));
			assert.equal(Buffer.from(ran.value.stdout, "base64").toString(), "1000\n/work\n");
			client.close();
		});

		it(`${image}: an upload whose sha256 does not match exits 5 in words and leaves no daemon where the entrypoint looks`, () => {
			const { name } = sandbox(image);
			const { bytes, sha } = daemon();
			const ran = spawnSync("docker", ["exec", "-i", name, ...modalCommands({ sha256: "f".repeat(64) }).upload], { input: bytes, encoding: "utf8" });
			assert.equal(ran.status, 5, ran.stdout + ran.stderr);
			assert.match(ran.stdout, new RegExp(`^sha256 ${sha}\\n.*not moved into place`, "s"));
			assert.equal(docker("exec", name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");
		});

		it(`${image}: with no upload, the entrypoint's bounded wait ends the container nonzero, in words`, () => {
			const { name } = sandbox(image, { waitSeconds: 2 });
			const code = execFileSync("docker", ["wait", name], { encoding: "utf8", timeout: 30_000 }).trim();
			assert.equal(code, "3");
			const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
			assert.match(logs.stderr, /the daemon did not arrive at \/opt\/agentrun\/computerd within 2 s/);
		});
	}
});
