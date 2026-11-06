// The demo on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): a debian:bookworm-slim computer with no network and a
// 10-minute lifetime runs commands through its daemon. Needs `npm run build` and `npm run build:daemon` first, and the
// image pulled. Every container this file makes is removed by its exact name in the after hook, pass or fail.
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

describe("run a command in a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	let provider;
	let arch;
	let ref;
	let connection;

	const ours = () => docker("ps", "-a", "--filter", "label=agentrun.computer=1", "--format", "{{.Names}}").split("\n").filter(Boolean).sort();
	const exec = async (argv, extra = {}, options) => {
		const result = await connection.client.call("exec.run", { argv, timeoutMs: 20_000, ...extra }, options);
		return result;
	};
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

	it("connects, and hello reports the arch and exec", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		assert.equal(connection.hello.os, "linux");
		assert.equal(connection.hello.arch, arch);
		assert.deepEqual(connection.hello.capabilities, ["exec"]);
		assert.deepEqual(await connection.client.call("ping", {}), { ok: true, value: {} });
	});

	it("runs uname -m", async () => {
		const result = await run(["uname", "-m"]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.out.trim(), arch === "arm64" ? "aarch64" : "x86_64");
		assert.equal(result.timedOut, false);
		assert.equal(result.truncated, false);
	});

	it("keeps stdout and stderr apart, and returns a nonzero exit code", async () => {
		const result = await run(["sh", "-c", "echo to-out; echo to-err >&2; exit 7"]);
		assert.equal(result.out, "to-out\n");
		assert.equal(result.err, "to-err\n");
		assert.equal(result.exitCode, 7);
	});

	it("never expands argv in a shell", async () => {
		const result = await run(["echo", "$(id)", "`id`", "a;b", "*"]);
		assert.equal(result.out, "$(id) `id` a;b *\n");
	});

	it("has no network", async () => {
		const result = await run(["sh", "-c", "ls /sys/class/net"]);
		assert.deepEqual(result.out.split("\n").filter(Boolean), ["lo"]);
	});

	it("cannot switch users with every capability dropped, and says so", async () => {
		const result = await exec(["id"], { user: "nobody" });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "denied");
		assert.match(result.error.message, /CAP_SETUID/);
	});

	it("times out, and the whole process group is gone", async () => {
		const result = await run(["sh", "-c", "sleep 300 & echo $!; wait"], { timeoutMs: 1000 });
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, null);
		const pid = Number(result.out.trim());
		assert.ok(pid > 1, result.out);
		const check = await run(["sh", "-c", `if [ -e /proc/${pid} ]; then cat /proc/${pid}/stat; else echo gone; fi`]);
		assert.equal(check.out.trim(), "gone");
	});

	it("aborts through an AbortSignal, and the program is ended", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		const result = await exec(["sleep", "301"], { timeoutMs: 60_000 }, { signal: controller.signal });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "aborted");
		const end = Date.now() + 5000;
		let left;
		do {
			left = (await run(["sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '"])).out;
			if (!left.includes("sleep 301")) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		} while (Date.now() < end);
		assert.ok(!left.includes("sleep 301"), `sleep 301 still runs: ${left}`);
	});

	it("stops the computer at once: the daemon as PID 1 ends on SIGTERM, and the container stays", async () => {
		await connection.close();
		connection = undefined;
		const started = Date.now();
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		assert.ok(Date.now() - started < 5000, `stop took ${Date.now() - started} ms`);
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});

	it("deletes the computer, and a second delete is ok", async () => {
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		assert.equal(ours().includes(ref.name), false);
	});

	it("refuses an allowlist and makes no container", async () => {
		const before = ours();
		const result = await provider.create({ image: IMAGE, lifetimeMs: 60_000, network: { allow: ["example.com"] } });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, /cannot enforce an allowlist yet/);
		assert.deepEqual(ours(), before);
	});
});
