// The commands the Modal provider sends when it uploads the daemon, run where Modal would run them: a container started
// as root (Modal containers always run as root) with no network, whose command is the provider's entrypoint, the
// upload streamed into `docker exec -i` as the provider streams it into exec's stdin, and the bridge over
// `docker exec -i ... computerd stdio`. On a Debian image (coreutils) and an Alpine one (BusyBox only). The containers
// keep Docker's default capabilities, or every one: init leaves itself none, whatever user --user names, root included.
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

	/**
	 * A root container of image, network none, whose command is the provider's entrypoint with init's --user user. It
	 * keeps Docker's default capabilities, as a vendor that runs every computer as root does; caps adds docker run flags.
	 */
	function sandbox(image, { waitSeconds = 120, user = "1000:1000", caps = [] } = {}) {
		const name = `computer-modal-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const deadline = new Date(Date.now() + 300_000).toISOString();
		const commands = modalCommands({ deadline, user, waitSeconds });
		docker("run", "--detach", "--name", name, "--network", "none", "--user", "0:0", ...caps, image, ...commands.entrypoint);
		return { name, deadline };
	}

	/** Streams the daemon in with the provider's upload command, as create does. */
	function upload(name) {
		const { bytes, sha } = daemon();
		const uploaded = execFileSync("docker", ["exec", "-i", name, ...modalCommands({ sha256: sha }).upload], { input: bytes, encoding: "utf8" });
		assert.equal(uploaded, `sha256 ${sha}\n`, "the upload prints the sha256 of what it wrote");
	}

	/** A client over `computerd stdio` once init listens, its hello answered: init drops itself before it listens. */
	async function connected(name) {
		const until = Date.now() + 30_000;
		for (;;) {
			const child = spawn("docker", ["exec", "-i", name, ...modalCommands().stdio], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const hello = await client.call("hello", { client: "modal-commands test" }, { signal: AbortSignal.timeout(10_000) });
			if (hello.ok) return client;
			client.close();
			child.kill("SIGKILL");
			if (Date.now() > until) assert.fail(`init in ${name} did not answer hello within 30 s: ${JSON.stringify(hello)}; logs: ${spawnSync("docker", ["logs", name], { encoding: "utf8" }).stderr}`);
			await sleep(300);
		}
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
		it(`${image}: the upload refuses a daemon path another user can change, and makes the daemon's directory root's alone`, () => {
			const { bytes, sha } = daemon();
			const upload = modalCommands({ sha256: sha }).upload;
			// /opt writable by every user: a non-root computer user could swap the binary every connect runs as root.
			const open = sandbox(image);
			docker("exec", open.name, "sh", "-c", "mkdir -p /opt && chmod 0777 /opt");
			const refused = spawnSync("docker", ["exec", "-i", open.name, ...upload], { input: bytes, encoding: "utf8" });
			assert.notEqual(refused.status, 0, "the upload refuses /opt at mode 0777");
			assert.match(refused.stdout, /the daemon at \/opt\/agentrun\/computerd is not root's alone: \/opt is drwxrwxrwx/);
			assert.equal(docker("exec", open.name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent", "nothing installed");
			// A daemon directory the image left to another user is taken back: root's, 0755, before the daemon is moved in.
			const owned = sandbox(image);
			docker("exec", owned.name, "sh", "-c", "mkdir -p /opt/agentrun && chown 1000:1000 /opt/agentrun && chmod 0777 /opt/agentrun");
			const uploaded = execFileSync("docker", ["exec", "-i", owned.name, ...upload], { input: bytes, encoding: "utf8" });
			assert.equal(uploaded, `sha256 ${sha}\n`);
			assert.equal(docker("exec", owned.name, "stat", "-c", "%u:%g %a", "/opt/agentrun").trim(), "0:0 755", "the daemon's directory is root's alone");
			// A daemon whose sha256 is not the one named is never moved where the entrypoint looks.
			const mismatch = sandbox(image);
			const bad = spawnSync("docker", ["exec", "-i", mismatch.name, ...modalCommands({ sha256: "f".repeat(64) }).upload], { input: bytes, encoding: "utf8" });
			assert.equal(bad.status, 5, bad.stdout);
			assert.match(bad.stdout, new RegExp(`^sha256 ${sha}\\n.*not moved into place`, "s"));
			assert.equal(docker("exec", mismatch.name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");
		});

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

		for (const [user, caps, words] of [
			["0:0", [], "Docker's default capabilities"],
			["0:0", ["--cap-add", "ALL"], "every capability (--cap-add ALL)"],
			["1000:1000", [], "Docker's default capabilities"],
		]) {
			it(`${image}: init --user ${user} in a root container with ${words} and no --cap-drop: every thread of init, and a program exec.run starts, hold no capability and set no_new_privs`, async () => {
				const { name } = sandbox(image, { user, caps });
				upload(name);
				const client = await connected(name);
				const script = "id -u; grep -E '^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):' /proc/1/task/*/status /proc/self/status";
				const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 10_000 });
				client.close();
				assert.equal(ran.ok, true, JSON.stringify(ran));
				const [id, ...lines] = Buffer.from(ran.value.stdout, "base64").toString().trim().split("\n");
				const [uid, gid] = user.split(":");
				assert.equal(id, uid, `id -u in exec.run: init --user ${user}`);
				const byFile = new Map();
				for (const line of lines) {
					const [file, field, value] = line.split(":");
					byFile.set(file, { ...byFile.get(file), [field]: value.trim().replace(/\s+/g, " ") });
				}
				const threads = [...byFile.keys()].filter((file) => file.startsWith("/proc/1/task/"));
				assert.ok(threads.length >= 2, `init's threads: ${threads.join(", ")}`);
				assert.ok(byFile.has("/proc/self/status"), "the program's own status");
				const want = { Uid: `${uid} ${uid} ${uid} ${uid}`, Gid: `${gid} ${gid} ${gid} ${gid}`, CapInh: ZERO, CapPrm: ZERO, CapEff: ZERO, CapBnd: ZERO, CapAmb: ZERO, NoNewPrivs: "1" };
				for (const [file, fields] of byFile) assert.deepEqual(fields, want, `${file} in a root container with ${words}, init --user ${user}`);
			});
		}

		// Why the provider refuses root (ModalProvider.check, ROOT): Modal's exec of the bridge runs /opt/agentrun/computerd
		// outside the daemon, with Modal's own root capabilities. After the upload that path is root's, 0755, in a root
		// 0755 directory under a root / and /opt: a computer user that is not root writes none of them. Root with no
		// capability still owns every one, so it renames another program over the path, and the next exec runs that one
		// with the container's capabilities.
		it(`${image}: after the upload, uid 1000 cannot write the daemon or any directory above it; uid 0 with no capability can, and the next exec of the bridge runs what it put there`, async () => {
			const as = async (user) => {
				const { name } = sandbox(image, { user });
				upload(name);
				return { name, client: await connected(name) };
			};
			const run = async (client, script) => {
				const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 10_000 });
				assert.equal(ran.ok, true, JSON.stringify(ran));
				return { out: Buffer.from(ran.value.stdout, "base64").toString(), code: ran.value.exitCode };
			};
			const owners = "stat -c '%n %u:%g %a' / /opt /opt/agentrun /opt/agentrun/computerd";
			const replace = "printf '#!/bin/sh\\ngrep CapEff /proc/self/status\\n' > /opt/agentrun/x && chmod 0755 /opt/agentrun/x && mv -f /opt/agentrun/x /opt/agentrun/computerd";

			const user = await as("1000:1000");
			assert.equal((await run(user.client, owners)).out, "/ 0:0 755\n/opt 0:0 755\n/opt/agentrun 0:0 755\n/opt/agentrun/computerd 0:0 755\n");
			for (const script of [replace, ": > /opt/agentrun/computerd", "mv /opt/agentrun /tmp/agentrun", "mkdir /opt/other", "chmod 0777 /opt/agentrun"]) {
				assert.notEqual((await run(user.client, script)).code, 0, `uid 1000: ${script}`);
			}
			user.client.close();
			assert.equal(docker("exec", user.name, "stat", "-c", "%u:%g %a %s", "/opt/agentrun/computerd").trim(), `0:0 755 ${daemon().bytes.length}`, "the daemon is as uploaded");

			const root = await as("0:0");
			const ran = await run(root.client, `grep CapEff /proc/self/status && ${replace}`);
			root.client.close();
			assert.equal(ran.code, 0, "root with no capability replaced the daemon: it owns /opt/agentrun");
			assert.match(ran.out, new RegExp(`^CapEff:\\s+${ZERO}\\n$`), "and had no capability to do it with");
			const bridged = spawnSync("docker", ["exec", root.name, ...modalCommands().stdio], { encoding: "utf8" });
			assert.match(bridged.stdout, /^CapEff:\s+[0-9a-f]{16}\n$/);
			assert.notEqual(bridged.stdout.trim().split(/\s+/)[1], ZERO, "the bridge's exec ran the replacement with the container's capabilities");
		});

		it(`${image}: init that cannot empty its bounding set (root without CAP_SETPCAP) refuses to start, in words, and the container ends`, () => {
			const { name } = sandbox(image, { user: "0:0", caps: ["--cap-drop", "SETPCAP"] });
			upload(name);
			const code = execFileSync("docker", ["wait", name], { encoding: "utf8", timeout: 30_000 }).trim();
			assert.equal(code, "1");
			const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
			assert.match(logs.stderr, /refuses to start/);
			assert.match(logs.stderr, /bounding set/);
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
