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

test("capabilities: a container whose lifetime the janitor enforces, network none or open, and a daemon with exec, files and processes", () => {
	const { provider } = fakeDocker();
	assert.equal(provider.id, "docker");
	assert.match(provider.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(provider.capabilities(), { lifetime: "janitor", network: ["none", "open"], isolation: "container", os: "linux", daemon: ["exec", "files", "processes"] });
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
	assert.deepEqual(valuesOf(run, "--pids-limit"), ["4096"]);
	assert.deepEqual(valuesOf(run, "--network"), ["none"]);
	assert.deepEqual(valuesOf(run, "--mount"), [`type=bind,src=${daemonPath},dst=/opt/agentrun/computerd,readonly`]);
	assert.deepEqual(valuesOf(run, "--entrypoint"), ["/opt/agentrun/computerd"]);
	assert.deepEqual(run.slice(-2), ["debian:bookworm-slim", "init"]);
	for (const flag of ["--cpus", "--memory", "--workdir"]) assert.equal(run.includes(flag), false, `${flag} only when asked`);
	assert.deepEqual(inspect.slice(0, 1), ["inspect"]);
	assert.equal(inspect.at(-1), name);
	assert.deepEqual(info, ["info", "--format", "{{.Architecture}}"]);
	assert.deepEqual(exec, ["exec", "-i", name, "/opt/agentrun/computerd", "stdio"]);
});

test("create() passes the sizes, an open network and the workdir", async () => {
	const { provider, calls } = fakeDocker();
	const result = await provider.create({ ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64, workdir: "/work" });
	assert.equal(result.ok, true);
	const [run] = calls();
	assert.deepEqual(valuesOf(run, "--network"), ["bridge"]);
	assert.deepEqual(valuesOf(run, "--cpus"), ["1.5"]);
	assert.deepEqual(valuesOf(run, "--memory"), ["512m"]);
	assert.deepEqual(valuesOf(run, "--pids-limit"), ["64"]);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/work"]);
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
