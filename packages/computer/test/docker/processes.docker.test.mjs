// What only Docker shows of a computer's processes, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): init and its
// processes run as the default non-root user with the socket in a tmpfs directory only that user may enter, and the
// daemon as PID 1 exits 0, not 137, on docker stop and at its deadline, though a process ignores TERM. What every
// provider must do with processes is in the conformance suite (conformance.docker.test.mjs). Needs `npm run build` and
// `npm run build:daemon` first, and debian:bookworm-slim pulled. Every container this file makes is removed by its exact
// name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
/** The provider's default user, which init and so every process runs as: this process's, or 1000:1000 as root. */
const DEFAULT_USER = process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");

describe("a Docker computer's init and its processes", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	const open = [];
	let provider;
	let ref;

	const connect = async (computer = ref) => {
		const connected = await provider.connect(computer);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		open.push(connected.value);
		return connected.value;
	};
	const call = async (connection, method, params) => {
		const result = await connection.client.call(method, params);
		assert.equal(result.ok, true, `${method} ${JSON.stringify(params)}: ${JSON.stringify(result)}`);
		return result.value;
	};
	/** Waits, bounded, until the container is not running; returns its state. */
	const stopped = async (name, ms) => {
		const bound = Date.now() + ms;
		let state;
		do {
			[{ State: state }] = JSON.parse(docker("inspect", name));
			if (!state.Running) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		} while (Date.now() < bound);
		return state;
	};

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "processes" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
		made.push(ref.name);
	});

	after(async () => {
		for (const connection of open) await connection.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("runs init and its processes as the non-root user, with the socket in a directory only that user may enter", async () => {
		const a = await connect();
		const loop = await call(a, "process.start", { argv: ["sleep", "306"] });
		const ran = await call(a, "exec.run", {
			argv: ["sh", "-c", "id -u; id -g; stat -c '%a %u:%g %F' /run/agentrun /run/agentrun/computerd.sock; grep ' /run/agentrun ' /proc/mounts; grep '^Uid:' /proc/1/status"],
			timeoutMs: 20_000,
		});
		const [uid, gid, dir, socket, mount, init] = decode(ran.stdout).trim().split("\n");
		assert.equal(`${uid}:${gid}`, DEFAULT_USER);
		assert.notEqual(uid, "0");
		assert.equal(dir, `700 ${DEFAULT_USER} directory`);
		assert.equal(socket, `600 ${DEFAULT_USER} socket`);
		assert.match(mount, /^tmpfs \/run\/agentrun tmpfs /, mount);
		for (const option of ["rw", "nosuid", "nodev", "noexec"]) assert.ok(mount.split(" ")[3].split(",").includes(option), `${option} in ${mount}`);
		assert.match(init, new RegExp(`^Uid:\\t${uid}\\t${uid}\\t`), "PID 1, init, is the same user");
		const pid = await call(a, "exec.run", { argv: ["sh", "-c", `stat -c %u /proc/${loop.pid}`], timeoutMs: 20_000 });
		assert.equal(decode(pid.stdout).trim(), uid, "a process runs as the user too");
		await call(a, "process.signal", { id: loop.id, signal: "KILL" });
	});

	it("the daemon as PID 1 exits 0 on docker stop, not 137, though a process ignores TERM", async () => {
		const connected = await connect();
		await call(connected, "process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] });
		for (const connection of open.splice(0)) await connection.close();
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});

	it("ends at its deadline with a process that ignores TERM still running: init ends every process and exits 0", async () => {
		// Long enough to connect and start the process on a loaded host; the test asserts the end, not its timing.
		const created = await provider.create({ image: IMAGE, lifetimeMs: 15_000, network: "none", labels: { "agentrun.test": "processes" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await connect(created.value);
		await call(connected, "process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] });
		const state = await stopped(created.value.name, 120_000);
		assert.equal(state.Running, false, "still running 120 s after a 15 s lifetime");
		assert.equal(state.ExitCode, 0, "init ended the computer, not Docker's SIGKILL");
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});
});
