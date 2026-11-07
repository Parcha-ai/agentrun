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
/** The provider's default user: this process's, or 1000:1000 when this process's uid or gid is 0. */
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const NO_CAPABILITIES = "0000000000000000";

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
		const deadline = Date.parse(labels["agentrun.computer.deadline"]);
		assert.ok(deadline > Date.now() + 9 * 60_000 && deadline <= Date.now() + 10 * 60_000, labels["agentrun.computer.deadline"]);
	});

	it("connects, and hello reports the arch, exec, files and processes", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		assert.equal(connection.hello.os, "linux");
		assert.equal(connection.hello.arch, arch);
		assert.deepEqual(connection.hello.capabilities, ["exec", "files", "processes"]);
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

	it("runs commands as the default non-root user with no capability: effective, permitted or bounding", async () => {
		const [uid, gid] = DEFAULT_USER.split(":");
		assert.equal((await run(["id", "-u"])).out.trim(), uid);
		assert.equal((await run(["id", "-g"])).out.trim(), gid);
		const status = (await run(["cat", "/proc/self/status"])).out;
		for (const set of ["CapEff", "CapPrm", "CapBnd"]) assert.match(status, new RegExp(`^${set}:\\t${NO_CAPABILITIES}$`, "m"), set);
		const init = (await run(["cat", "/proc/1/status"])).out;
		assert.match(init, new RegExp(`^Uid:\\t${uid}\\t`, "m"), "PID 1, the daemon, is not root either");
	});

	it("has a home and work directory the default user can write: /work, its own, mode 700", async () => {
		const result = await run(["sh", "-c", "echo ok > ~/x && cat ~/x && pwd"]);
		assert.equal(result.exitCode, 0, result.err);
		assert.equal(result.out, "ok\n/work\n");
		assert.equal((await run(["stat", "-c", "%u:%g %a", "/work"])).out.trim(), `${DEFAULT_USER} 700`);
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
		assert.equal(result.signal, "TERM");
		const pid = Number(result.out.trim());
		assert.ok(pid > 1, result.out);
		const check = await run(["sh", "-c", `if [ -e /proc/${pid} ]; then cat /proc/${pid}/stat; else echo gone; fi`]);
		assert.equal(check.out.trim(), "gone");
	});

	it("ends a child that left the program's session and group (setsid) when the program ends", async () => {
		const script = `p=$(mktemp -u); mkfifo "$p"; setsid sh -c 'echo $$ > "$0"; exec sleep 302' "$p" >/dev/null 2>&1 </dev/null & read pid < "$p"; echo $pid`;
		const result = await run(["sh", "-c", script]);
		assert.equal(result.exitCode, 0, result.err);
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

	it("stops the computer: the daemon as PID 1 exits 0 on SIGTERM, not SIGKILL (137), and the container stays", async () => {
		await connection.close();
		connection = undefined;
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});

	it("deletes the computer, and a second delete is ok", async () => {
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		assert.equal(ours().includes(ref.name), false);
	});

	it("runs as root only when the spec asks, and root has no capability either", async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", user: "0", labels: { "agentrun.test": "run-command" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const [inspected] = JSON.parse(docker("inspect", created.value.name));
		assert.equal(inspected.Config.User, "0:0");
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			const call = async (argv) => {
				const result = await connected.value.client.call("exec.run", { argv, timeoutMs: 20_000 });
				assert.equal(result.ok, true, JSON.stringify(result));
				return decode(result.value.stdout);
			};
			assert.equal((await call(["id", "-u"])).trim(), "0");
			const status = await call(["cat", "/proc/self/status"]);
			for (const set of ["CapEff", "CapPrm", "CapBnd"]) assert.match(status, new RegExp(`^${set}:\\t${NO_CAPABILITIES}$`, "m"), set);
		} finally {
			await connected.value.close();
		}
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});

	it("keeps HOME at /work for a user the image knows (nobody), so ~ is writable", async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", user: "65534", labels: { "agentrun.test": "run-command" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			const result = await connected.value.client.call("exec.run", { argv: ["sh", "-c", 'echo "$HOME"; echo ok > ~/x && cat ~/x'], timeoutMs: 20_000 });
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(decode(result.value.stdout), "/work\nok\n", decode(result.value.stderr));
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

	it("refuses an allowlist and makes no container", async () => {
		const before = ours();
		const result = await provider.create({ image: IMAGE, lifetimeMs: 60_000, network: { allow: ["example.com"] } });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, /cannot enforce an allowlist yet/);
		assert.deepEqual(ours(), before);
	});
});
