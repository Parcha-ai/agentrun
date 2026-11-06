// DockerProvider against a fake docker program under the test's temp dir (test/fake-docker.mjs): it records each
// call's argv and answers as the docker CLI does. No Docker and no daemon binary are needed.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerProvider } from "../dist/index.js";
import { fakeDocker, idOf, valuesOf, VERSION } from "./fake-docker.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const ALLOWLIST = "a Docker computer cannot enforce an allowlist yet; ask for network none or open";
/** The user a computer runs as when neither the spec nor the provider names one: this process's, or 1000:1000 for root. */
const DEFAULT_USER = process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";

test("capabilities: a container whose lifetime the janitor enforces, network none or open, and a daemon with exec, files and processes", () => {
	const { provider } = fakeDocker();
	assert.equal(provider.id, "docker");
	assert.match(provider.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(provider.capabilities(), { lifetime: "janitor", network: ["none", "open"], isolation: "container", os: "linux", daemon: ["exec", "files", "processes"], user: ["root", "uid"] });
});

test("check() refuses in words, field by field, with no docker call", () => {
	const { provider, calls } = fakeDocker();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64, labels: { team: "a" }, workdir: "/work" }), []);
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(refused({ ...SPEC, image: undefined }), ["image"]);
	assert.deepEqual(refused({ ...SPEC, image: "" }), ["image"]);
	for (const lifetimeMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "600000"]) {
		assert.deepEqual(refused({ ...SPEC, lifetimeMs }), ["lifetimeMs"], `lifetimeMs ${String(lifetimeMs)}`);
	}
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: ["example.com"] } }), [{ field: "network", message: ALLOWLIST }]);
	assert.deepEqual(refused({ ...SPEC, network: undefined }), ["network"]);
	assert.deepEqual(refused({ ...SPEC, network: "wifi" }), ["network"]);
	assert.deepEqual(refused({ ...SPEC, cpus: 0 }), ["cpus"]);
	assert.deepEqual(refused({ ...SPEC, memoryMb: 1.5 }), ["memoryMb"]);
	assert.deepEqual(refused({ ...SPEC, pids: 0 }), ["pids"]);
	assert.deepEqual(refused({ ...SPEC, workdir: "relative" }), ["workdir"]);
	assert.deepEqual(refused({ ...SPEC, labels: { "agentrun.computer.deadline": "never" } }), ["labels"]);
	const gpu = provider.check({ ...SPEC, gpu: "a100" });
	assert.equal(gpu.length, 1);
	assert.equal(gpu[0].field, "gpu");
	assert.match(gpu[0].message, /Docker computer does not support gpu/);
	assert.deepEqual(refused({ lifetimeMs: 0, network: { allow: [] } }), ["image", "lifetimeMs", "network"]);
	assert.equal(calls().length, 0);
});

test("a lifetime is at most 30 days, and create() never throws on a spec check() passes", async () => {
	const { provider, calls } = fakeDocker();
	const days30 = 30 * 24 * 60 * 60 * 1000;
	for (const lifetimeMs of [days30 + 1, 8.64e15, Number.MAX_SAFE_INTEGER]) {
		const refusals = provider.check({ ...SPEC, lifetimeMs });
		assert.deepEqual(refusals.map((r) => r.field), ["lifetimeMs"], `lifetimeMs ${lifetimeMs}`);
		assert.match(refusals[0].message, /at most 30 days/);
		const result = await provider.create({ ...SPEC, lifetimeMs });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
	}
	for (const spec of [{ ...SPEC, image: "debian\0" }, { ...SPEC, labels: { "team\0": "a" } }, { ...SPEC, labels: { team: "a\0" } }, { ...SPEC, workdir: "/work\0" }]) {
		assert.equal(provider.check(spec).length, 1, JSON.stringify(spec));
		const result = await provider.create(spec);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
	}
	assert.deepEqual(calls(), []);
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: days30 }), []);
	const before = Date.now();
	const made = await provider.create({ ...SPEC, lifetimeMs: days30 });
	assert.equal(made.ok, true, JSON.stringify(made));
	const deadline = valuesOf(calls()[0], "--label").find((label) => label.startsWith("agentrun.computer.deadline="))?.split("=")[1];
	assert.ok(Math.abs(Date.parse(deadline) - (before + days30)) < 5000, deadline);
});

test("create() on a refused spec makes no docker call", async () => {
	const { provider, calls } = fakeDocker();
	for (const spec of [{ ...SPEC, network: { allow: ["example.com"] } }, { ...SPEC, lifetimeMs: undefined }, { ...SPEC, gpu: 1 }]) {
		const result = await provider.create(spec);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
	}
	const allow = await provider.create({ ...SPEC, network: { allow: ["example.com"] } });
	assert.match(allow.error.message, /cannot enforce an allowlist yet/);
	assert.deepEqual(calls(), []);
});

test("create() runs a hardened container with the daemon as its first process and a deadline label", async () => {
	const { provider, calls, daemonPath } = fakeDocker();
	const before = Date.now();
	const result = await provider.create({ ...SPEC, labels: { team: "a" } });
	assert.equal(result.ok, true, JSON.stringify(result));
	const [run, inspect, info, exec, ...rest] = calls();
	assert.deepEqual(rest, []);
	const name = valuesOf(run, "--name")[0];
	assert.match(name, /^computer-[0-9a-f]{12}$/);
	assert.deepEqual(result.value, { id: idOf(name), name });
	assert.deepEqual(run.slice(0, 2), ["run", "--detach"]);
	assert.equal(run.includes("--rm"), false, "stop keeps the computer");
	const labels = valuesOf(run, "--label");
	assert.ok(labels.includes("agentrun.computer=1"));
	assert.ok(labels.includes("team=a"));
	const deadline = labels.find((label) => label.startsWith("agentrun.computer.deadline="))?.split("=")[1];
	assert.ok(deadline, "a deadline label");
	assert.equal(new Date(deadline).toISOString(), deadline);
	assert.ok(Math.abs(Date.parse(deadline) - (before + SPEC.lifetimeMs)) < 5000);
	assert.deepEqual(valuesOf(run, "--cap-drop"), ["ALL"]);
	assert.deepEqual(valuesOf(run, "--security-opt"), ["no-new-privileges"]);
	assert.deepEqual(valuesOf(run, "--network"), ["none"]);
	assert.deepEqual(valuesOf(run, "--mount"), [`type=bind,src=${daemonPath},dst=/opt/agentrun/computerd,readonly`]);
	assert.deepEqual(valuesOf(run, "--entrypoint"), ["/opt/agentrun/computerd"]);
	assert.deepEqual(run.slice(-4), ["debian:bookworm-slim", "init", "--deadline", deadline], "PID 1 ends the computer at the deadline the label holds");
	const [uid, gid] = DEFAULT_USER.split(":");
	assert.deepEqual(
		valuesOf(run, "--tmpfs"),
		[`/work:rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700`, `/run/agentrun:rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700`],
		"a home the computer's user can write, and init's socket directory, the user's alone",
	);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/work"]);
	assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work"]);
	assert.deepEqual(inspect.slice(0, 1), ["inspect"]);
	assert.equal(inspect.at(-1), name);
	assert.deepEqual(info, ["info", "--format", "{{.Architecture}}"]);
	assert.deepEqual(exec, ["exec", "-i", name, "/opt/agentrun/computerd", "stdio"]);
});

test("create() passes the sizes, an open network and the workdir", async () => {
	const { provider, calls } = fakeDocker();
	const result = await provider.create({ ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64, workdir: "/app" });
	assert.equal(result.ok, true);
	const [run] = calls();
	assert.deepEqual(valuesOf(run, "--network"), ["bridge"]);
	assert.deepEqual(valuesOf(run, "--cpu-period"), ["100000"]);
	assert.deepEqual(valuesOf(run, "--cpu-quota"), ["150000"]);
	assert.equal(run.includes("--cpus"), false, "a quota, never --cpus, which Docker refuses above its own CPU count");
	assert.deepEqual(valuesOf(run, "--memory"), ["512m"]);
	assert.deepEqual(valuesOf(run, "--memory-swap"), ["512m"]);
	assert.deepEqual(valuesOf(run, "--pids-limit"), ["64"]);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/app"]);
	assert.equal(valuesOf(run, "--tmpfs").filter((tmpfs) => tmpfs.startsWith("/work:")).length, 1, "/work is mounted even when the spec names another workdir");
});

test("create() with no sizes gives serve's: 2 CPUs, 4 GiB with swap the same, 1024 pids", async () => {
	const { provider, calls } = fakeDocker();
	assert.equal((await provider.create(SPEC)).ok, true);
	const [run] = calls();
	assert.deepEqual(valuesOf(run, "--cpu-period"), ["100000"]);
	assert.deepEqual(valuesOf(run, "--cpu-quota"), ["200000"]);
	assert.equal(run.includes("--cpus"), false);
	assert.deepEqual(valuesOf(run, "--memory"), ["4096m"]);
	assert.deepEqual(valuesOf(run, "--memory-swap"), ["4096m"]);
	assert.deepEqual(valuesOf(run, "--pids-limit"), ["1024"]);
});

test("create() runs a computer as a non-root user unless its spec asks for root", async () => {
	const userOf = async (spec, options) => {
		const { provider, calls } = fakeDocker(options);
		const result = await provider.create(spec);
		assert.equal(result.ok, true, JSON.stringify(result));
		return valuesOf(calls()[0], "--user");
	};
	assert.notEqual(DEFAULT_USER.split(":")[0], "0");
	assert.deepEqual(await userOf(SPEC), [DEFAULT_USER]);
	assert.deepEqual(await userOf(SPEC, { user: "1234:5678" }), ["1234:5678"]);
	assert.deepEqual(await userOf(SPEC, { user: "1234" }), ["1234:1234"], "a uid alone is its own gid, never root's group 0");
	assert.deepEqual(await userOf({ ...SPEC, user: "2000:3000" }, { user: "1234:5678" }), ["2000:3000"], "the spec wins");
	assert.deepEqual(await userOf({ ...SPEC, user: "2000" }), ["2000:2000"]);
	assert.deepEqual(await userOf({ ...SPEC, user: "0" }), ["0:0"]);
	assert.deepEqual(await userOf({ ...SPEC, user: "0:0" }), ["0:0"]);
	const { provider, calls } = fakeDocker({ user: "1234:5678" });
	assert.equal((await provider.create({ ...SPEC, user: "2000:3000" })).ok, true);
	assert.deepEqual(
		valuesOf(calls()[0], "--tmpfs"),
		["/work:rw,nosuid,nodev,exec,uid=2000,gid=3000,mode=0700", "/run/agentrun:rw,noexec,nosuid,nodev,uid=2000,gid=3000,mode=0700"],
		"/work and init's socket directory belong to the user the computer runs as",
	);
	const root = fakeDocker();
	assert.equal((await root.provider.create({ ...SPEC, user: "0" })).ok, true);
	assert.deepEqual(valuesOf(root.calls()[0], "--tmpfs"), ["/work:rw,nosuid,nodev,exec,uid=0,gid=0,mode=0700", "/run/agentrun:rw,noexec,nosuid,nodev,uid=0,gid=0,mode=0700"]);
});

test("check() takes a user as numbers, uid or uid:gid, and refuses a name in words", () => {
	const { provider } = fakeDocker();
	for (const user of ["0", "0:0", "1000", "1000:1000", "65534:65534", "4294967294"]) assert.deepEqual(provider.check({ ...SPEC, user }), [], user);
	for (const user of ["root", "nobody:nogroup", "1000:users", "", "1000:", ":1000", "-1", "1.5", "1000:1000:1000", "4294967295", " 1000", 1000, null]) {
		const refusals = provider.check({ ...SPEC, user });
		assert.deepEqual(refusals.map((r) => r.field), ["user"], JSON.stringify(user));
		assert.match(refusals[0].message, /uid or uid:gid in numbers/);
	}
	assert.match(provider.check({ ...SPEC, user: "root" })[0].message, /name.*image may not have/);
});

test("a provider refuses root, or a user that is not numbers, as its default: root is asked for per computer, in the spec", () => {
	const daemonPath = fakeDocker().daemonPath;
	for (const user of ["0", "0:0", "0:1000", "00"]) {
		assert.throws(() => new DockerProvider({ daemonPath, user }), /root.*spec/, user);
	}
	for (const user of ["root", "1000:", "x"]) {
		assert.throws(() => new DockerProvider({ daemonPath, user }), /uid or uid:gid in numbers/, user);
	}
	assert.ok(new DockerProvider({ daemonPath, user: "1000:1000" }));
});

test("create() removes a container that is not running and says why", async () => {
	const { provider, calls } = fakeDocker({ running: false });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "docker");
	assert.match(result.error.message, /exec format error/);
	const [run, , remove] = calls();
	assert.deepEqual(remove, ["rm", "--force", "--volumes", valuesOf(run, "--name")[0]]);
});

test("create() with no daemon binary is not_found, with no docker call", async () => {
	const { calls } = fakeDocker();
	const provider = new DockerProvider({ daemonPath: join(tmpdir(), "computer-no-such-daemon", "computerd"), docker: "docker-that-is-not-called" });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "not_found");
	assert.match(result.error.message, /build:daemon/);
	assert.deepEqual(calls(), []);
});

test("create() with a daemon only its owner may run is refused, with no docker call", async () => {
	const { provider, calls, daemonPath } = fakeDocker();
	chmodSync(daemonPath, 0o700);
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid");
	assert.match(result.error.message, /mode 700.*chmod 755/);
	assert.deepEqual(calls(), []);
});

test("release() stops or deletes, and a computer already gone is ok", async () => {
	const { provider, calls } = fakeDocker();
	const ref = { id: "f".repeat(64), name: "computer-0123456789ab" };
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.deepEqual(calls(), [["stop", ref.name], ["rm", "--force", "--volumes", ref.name]]);
	const gone = fakeDocker({ gone: true });
	assert.deepEqual(await gone.provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.deepEqual(await gone.provider.release(ref, "stop"), { ok: true, value: undefined });
});

test("release() and connect() refuse a name this provider does not make, with no docker call", async () => {
	const { provider, calls } = fakeDocker();
	for (const name of ["postgres", "computer-xyz", "computer-0123456789ab; rm -rf /", "--all"]) {
		const released = await provider.release({ id: "x", name }, "delete");
		assert.equal(released.ok, false);
		assert.equal(released.error.code, "invalid");
		const connected = await provider.connect({ id: "x", name });
		assert.equal(connected.ok, false);
		assert.equal(connected.error.code, "invalid");
	}
	assert.deepEqual(calls(), []);
});

test("connect() opens the daemon over docker exec and says hello", async () => {
	const { provider, calls } = fakeDocker();
	const ref = { id: "f".repeat(64), name: "computer-0123456789ab" };
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.deepEqual(connected.value.hello, { version: VERSION, os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"] });
	assert.deepEqual(calls(), [["exec", "-i", ref.name, "/opt/agentrun/computerd", "stdio"]]);
	await connected.value.close();
	const after = await connected.value.client.call("ping", {});
	assert.equal(after.ok, false);
	assert.equal(after.error.code, "gone");
});

test("connect() refuses a daemon of another version, or one missing a declared capability, and closes the stream", async () => {
	const ref = { id: "f".repeat(64), name: "computer-0123456789ab" };
	for (const [hello, words] of [
		[{ version: "0.0.1" }, /version 0\.0\.1.*expected/],
		[{ capabilities: ["exec", "files"] }, /processes/],
		[{ os: "windows" }, /os windows/],
	]) {
		const { provider, calls } = fakeDocker({ hello });
		const connected = await provider.connect(ref);
		if (connected.ok) await connected.value.close();
		assert.equal(connected.ok, false, JSON.stringify(hello));
		assert.equal(connected.error.code, "refused");
		assert.match(connected.error.message, words);
		assert.match(connected.error.message, /computer-0123456789ab/);
		assert.deepEqual(calls(), [["exec", "-i", ref.name, "/opt/agentrun/computerd", "stdio"]]);
	}
	const extra = fakeDocker({ hello: { capabilities: ["exec", "files", "processes", "display"] } });
	const connected = await extra.provider.connect(ref);
	assert.equal(connected.ok, true, "a daemon may offer more than the provider declares");
	await connected.value.close();
});

test("create() deletes a computer whose own report drifts from its spec, and says every way it drifted", async () => {
	const { provider, calls, names } = fakeDocker({ patch: { HostConfig: { PidsLimit: 1, CapDrop: [] } }, hello: { version: "0.0.1" } });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	const name = valuesOf(calls()[0], "--name")[0];
	assert.match(result.error.message, new RegExp(`${name}.*deleted`));
	assert.match(result.error.message, /PidsLimit/);
	assert.match(result.error.message, /CapDrop/);
	assert.match(result.error.message, /version 0\.0\.1/);
	assert.deepEqual(calls().map((args) => args[0]), ["run", "inspect", "info", "exec", "rm"]);
	assert.deepEqual(calls().at(-1), ["rm", "--force", "--volumes", name]);
	assert.deepEqual(names(), []);
});

test("create() deletes a computer that runs as another user, without its tmpfs mounts, or on another CPU quota or command", async () => {
	const { provider, calls, names } = fakeDocker({
		patch: { Config: { User: "0:0", Cmd: ["init"] }, HostConfig: { Tmpfs: { "/work": "rw,uid=0,gid=0,mode=0777", "/run/agentrun": null }, CpuQuota: 0 } },
	});
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	for (const words of [`User: declared "${DEFAULT_USER}", read back "0:0"`, "tmpfs /work", "tmpfs /run/agentrun", "CpuQuota: declared 200000, read back 0", "Cmd: declared"]) {
		assert.ok(result.error.message.includes(words), `${words} in ${result.error.message}`);
	}
	assert.deepEqual(calls().at(-1), ["rm", "--force", "--volumes", valuesOf(calls()[0], "--name")[0]]);
	assert.deepEqual(names(), []);
});

test("create() deletes a computer whose daemon reports another architecture than the Docker host", async () => {
	const { provider, calls, names } = fakeDocker({ arch: "aarch64" });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, /arch amd64.*arm64/);
	assert.equal(calls().at(-1)[0], "rm");
	assert.deepEqual(names(), []);
});

test("create() maps docker info's architecture to Go's names: x86_64 is amd64, aarch64 is arm64", async () => {
	const amd = fakeDocker({ arch: "x86_64" });
	assert.equal((await amd.provider.create(SPEC)).ok, true);
	const arm = fakeDocker({ arch: "aarch64", hello: { arch: "arm64" } });
	assert.equal((await arm.provider.create(SPEC)).ok, true);
	const odd = fakeDocker({ arch: "riscv64", hello: { arch: "riscv64" } });
	assert.equal((await odd.provider.create(SPEC)).ok, true);
});

test("create() deletes a computer whose daemon does not answer hello", async () => {
	const { provider, calls, names } = fakeDocker({ noDaemon: true });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.match(result.error.message, /OCI runtime exec failed/);
	assert.deepEqual(calls().map((args) => args[0]), ["run", "inspect", "info", "exec", "rm"]);
	assert.deepEqual(names(), []);
});
