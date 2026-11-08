// What only Docker shows of a computer, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): the user, sizes, tmpfs
// mounts, hardening flags and daemon mount in docker inspect, hello's arch against Docker's, the default user's ids and
// bounding set, /work as home, no interface but lo with network none and still none after a refused change, no user
// switch without capabilities, user 0 as Docker's 0:0, and the daemon as PID 1 exiting 0 on docker stop and at its
// deadline.
// What every provider must do is in the conformance suite (conformance.docker.test.mjs). Needs `npm run build` and
// `npm run build:daemon` first, and the image pulled. Every container this file makes is removed by its exact name in
// the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
/** The provider's default user: this process's, or 1000:1000 when this process's uid or gid is 0. */
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const NO_CAPABILITIES = "0000000000000000";

describe("a Docker computer, as Docker shows it", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	let provider;
	let arch;
	let ref;
	let connection;
	/** The times just before and just after create, in ms: the deadline is lifetimeMs from a moment between them. */
	let createdAt;

	const exec = (argv, extra = {}) => connection.client.call("exec.run", { argv, timeoutMs: 20_000, ...extra });
	const run = async (argv, extra) => {
		const result = await exec(argv, extra);
		assert.equal(result.ok, true, JSON.stringify(result));
		return { ...result.value, out: decode(result.value.stdout), err: decode(result.value.stderr) };
	};

	before(() => {
		arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(async () => {
		await connection?.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("creates a computer with no network and a 10-minute lifetime", async () => {
		const from = Date.now();
		const result = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "run-command" } });
		createdAt = { from, to: Date.now() };
		assert.equal(result.ok, true, JSON.stringify(result));
		ref = result.value;
		made.push(ref.name);
		assert.match(ref.name, /^computer-[0-9a-f]{12}$/);
	});

	it("is hardened as asked: a non-root user, no capabilities, no new privileges, no network, serve's sizes, the daemon read-only, a deadline", () => {
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, true);
		assert.equal(inspected.Config.User, DEFAULT_USER);
		assert.deepEqual(inspected.HostConfig.CapDrop, ["ALL"]);
		assert.ok(inspected.HostConfig.SecurityOpt.includes("no-new-privileges"), JSON.stringify(inspected.HostConfig.SecurityOpt));
		assert.equal(inspected.HostConfig.NetworkMode, "none");
		assert.equal(inspected.HostConfig.PidsLimit, 1024);
		assert.equal(inspected.HostConfig.Memory, 4 * 1024 ** 3);
		assert.equal(inspected.HostConfig.MemorySwap, 4 * 1024 ** 3);
		assert.equal(inspected.HostConfig.CpuPeriod, 100_000);
		assert.equal(inspected.HostConfig.CpuQuota, 200_000);
		assert.equal(inspected.HostConfig.NanoCpus, 0);
		assert.deepEqual(Object.keys(inspected.HostConfig.Tmpfs ?? {}).sort(), ["/run/agentrun", "/work"]);
		assert.ok(inspected.HostConfig.Tmpfs["/work"].split(",").includes("size=2048m"), "/work is half the memory, so filling it is ENOSPC");
		assert.ok(inspected.HostConfig.Tmpfs["/run/agentrun"].split(",").includes("size=1m"), inspected.HostConfig.Tmpfs["/run/agentrun"]);
		assert.equal(inspected.Config.WorkingDir, "/work");
		assert.ok(inspected.Config.Env.includes("HOME=/work"), JSON.stringify(inspected.Config.Env));
		assert.equal(inspected.HostConfig.AutoRemove, false);
		const mount = inspected.Mounts.find((m) => m.Destination === "/opt/agentrun/computerd");
		assert.ok(mount, "the daemon is mounted");
		assert.equal(mount.RW, false);
		assert.deepEqual(inspected.Config.Entrypoint, ["/opt/agentrun/computerd"]);
		const labels = inspected.Config.Labels;
		assert.deepEqual(inspected.Config.Cmd, ["init", "--deadline", labels["agentrun.computer.deadline"]]);
		assert.equal(labels["agentrun.computer"], "1");
		// lifetimeMs from the moment create set it, however long docker run then took: a Docker host busy with another
		// workload can hold every container start for a minute or more.
		const deadline = Date.parse(labels["agentrun.computer.deadline"]);
		const window = `${new Date(createdAt.from + 10 * 60_000).toISOString()} to ${new Date(createdAt.to + 10 * 60_000).toISOString()}`;
		assert.ok(deadline >= createdAt.from + 10 * 60_000 && deadline <= createdAt.to + 10 * 60_000, `${labels["agentrun.computer.deadline"]} is not within ${window}`);
	});

	it("connects, and hello reports Docker's arch, exec, files and processes", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		assert.equal(connection.hello.os, "linux");
		assert.equal(connection.hello.arch, arch);
		assert.deepEqual([connection.hello.kind, connection.hello.groups], ["linux", ["exec", "files", "processes"]]);
	});

	it("has no interface but lo with network none", async () => {
		const result = await run(["sh", "-c", "ls /sys/class/net"]);
		assert.deepEqual(result.out.split("\n").filter(Boolean), ["lo"]);
	});

	it("runs commands as the default user, uid and gid, with an empty bounding set, and init is that user too", async () => {
		const [uid, gid] = DEFAULT_USER.split(":");
		assert.equal((await run(["id", "-u"])).out.trim(), uid);
		assert.equal((await run(["id", "-g"])).out.trim(), gid);
		assert.match((await run(["cat", "/proc/self/status"])).out, new RegExp(`^CapBnd:\\t${NO_CAPABILITIES}$`, "m"));
		assert.match((await run(["cat", "/proc/1/status"])).out, new RegExp(`^Uid:\\t${uid}\\t`, "m"), "PID 1, the daemon, is not root either");
	});

	it("starts in /work, its home, the user's own with mode 700", async () => {
		assert.equal((await run(["pwd"])).out, "/work\n");
		assert.equal((await run(["stat", "-c", "%u:%g %a", "/work"])).out.trim(), `${DEFAULT_USER} 700`);
	});

	it("refuses a network change, fixed at create, and docker inspect still shows network none", async () => {
		const opened = await provider.network(ref, "open");
		assert.equal(opened.ok, false);
		assert.equal(opened.error.code, "refused");
		assert.match(opened.error.message, /fixed at create; create a new computer/);
		assert.equal(docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", ref.name).trim(), "none");
	});

	it("cannot switch users with every capability dropped, and says so", async () => {
		const result = await exec(["id"], { user: "nobody" });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "denied");
		assert.match(result.error.message, /CAP_SETUID/);
	});

	it("stops the computer: the daemon as PID 1 exits 0 on SIGTERM, not SIGKILL (137), and the container stays", async () => {
		await connection.close();
		connection = undefined;
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});

	it("runs as Docker's 0:0 only when the spec asks for user 0, and root's bounding set is empty too", async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", user: "0", labels: { "agentrun.test": "run-command" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const [inspected] = JSON.parse(docker("inspect", created.value.name));
		assert.equal(inspected.Config.User, "0:0");
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			const status = await connected.value.client.call("exec.run", { argv: ["cat", "/proc/self/status"], timeoutMs: 20_000 });
			assert.equal(status.ok, true, JSON.stringify(status));
			assert.match(decode(status.value.stdout), new RegExp(`^CapBnd:\\t${NO_CAPABILITIES}$`, "m"));
		} finally {
			await connected.value.close();
		}
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});

	it("ends itself at its deadline: PID 1 exits 0 with no janitor", async () => {
		// Long enough for create's checks while other files make computers on a loaded host; the test asserts the end.
		const created = await provider.create({ image: IMAGE, lifetimeMs: 45_000, network: "none", labels: { "agentrun.test": "run-command" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const bound = Date.now() + 120_000;
		let state;
		do {
			[{ State: state }] = JSON.parse(docker("inspect", created.value.name));
			if (!state.Running) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		} while (Date.now() < bound);
		assert.equal(state.Running, false, "still running 120 s after a 45 s lifetime");
		assert.equal(state.ExitCode, 0);
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});
});
