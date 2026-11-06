// What only Docker shows of a computer, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): the hardening flags and
// the daemon mount in docker inspect, hello's arch against Docker's, no interface but lo with network none, no user
// switch without capabilities, and the daemon as PID 1 exiting 0 on docker stop. What every provider must do is in the
// conformance suite (conformance.docker.test.mjs). Needs `npm run build` and `npm run build:daemon` first, and the image
// pulled. Every container this file makes is removed by its exact name in the after hook, pass or fail.
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

describe("a Docker computer, as Docker shows it", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	let provider;
	let arch;
	let ref;
	let connection;

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
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "run-command" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
		made.push(ref.name);
		assert.match(ref.name, /^computer-[0-9a-f]{12}$/);
	});

	it("is hardened as asked: no capabilities, no new privileges, no network, the daemon read-only, a deadline", () => {
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, true);
		assert.deepEqual(inspected.HostConfig.CapDrop, ["ALL"]);
		assert.ok(inspected.HostConfig.SecurityOpt.includes("no-new-privileges"), JSON.stringify(inspected.HostConfig.SecurityOpt));
		assert.equal(inspected.HostConfig.NetworkMode, "none");
		assert.equal(inspected.HostConfig.PidsLimit, 4096);
		assert.equal(inspected.HostConfig.AutoRemove, false);
		const mount = inspected.Mounts.find((m) => m.Destination === "/opt/agentrun/computerd");
		assert.ok(mount, "the daemon is mounted");
		assert.equal(mount.RW, false);
		assert.deepEqual(inspected.Config.Entrypoint, ["/opt/agentrun/computerd"]);
		assert.deepEqual(inspected.Config.Cmd, ["init"]);
		const labels = inspected.Config.Labels;
		assert.equal(labels["agentrun.computer"], "1");
		const deadline = Date.parse(labels["agentrun.computer.deadline"]);
		assert.ok(deadline > Date.now() + 9 * 60_000 && deadline <= Date.now() + 10 * 60_000, labels["agentrun.computer.deadline"]);
	});

	it("connects, and hello reports Docker's arch, exec, files and processes", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		assert.equal(connection.hello.os, "linux");
		assert.equal(connection.hello.arch, arch);
		assert.deepEqual(connection.hello.capabilities, ["exec", "files", "processes"]);
	});

	it("has no interface but lo with network none", async () => {
		const result = await run(["sh", "-c", "ls /sys/class/net"]);
		assert.deepEqual(result.out.split("\n").filter(Boolean), ["lo"]);
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
});
