// DockerProvider against a fake docker program under the test's temp dir: it records each call's argv and answers as
// the docker CLI does. No Docker and no daemon binary are needed.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DockerProvider } from "../dist/index.js";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const ALLOWLIST = "a Docker computer cannot enforce an allowlist yet; ask for network none or open";

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fake docker: `running` is what inspect reports, `gone` makes stop and rm answer "No such container". */
function fakeDocker({ running = true, gone = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-fake-docker-"));
	dirs.push(dir);
	const log = join(dir, "calls.jsonl");
	const daemonPath = join(dir, "computerd");
	writeFileSync(daemonPath, "not a real daemon");
	chmodSync(daemonPath, 0o755);
	const program = join(dir, "docker");
	const config = JSON.stringify({ log, running, gone });
	writeFileSync(
		program,
		`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const config = ${config};
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify(args) + "\\n");
const noSuch = () => { process.stderr.write("Error response from daemon: No such container: " + args.at(-1) + "\\n"); process.exit(1); };
switch (args[0]) {
	case "run": process.stdout.write("f".repeat(64) + "\\n"); break;
	case "inspect": process.stdout.write(JSON.stringify({ Id: "f".repeat(64), State: { Running: config.running, Status: config.running ? "running" : "exited", ExitCode: config.running ? 0 : 127, Error: config.running ? "" : "exec format error" } }) + "\\n"); break;
	case "stop": case "rm": if (config.gone) noSuch(); process.stdout.write(args.at(-1) + "\\n"); break;
	case "exec": {
		let buffered = "";
		process.stdin.on("data", (chunk) => {
			buffered += chunk;
			let at;
			while ((at = buffered.indexOf("\\n")) >= 0) {
				const request = JSON.parse(buffered.slice(0, at));
				buffered = buffered.slice(at + 1);
				if (request.method === "hello") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { version: "fake", os: "linux", arch: "amd64", capabilities: ["exec"] } }) + "\\n");
			}
		});
		process.stdin.on("end", () => process.exit(0));
		break;
	}
	default: process.stderr.write("unexpected docker call\\n"); process.exit(2);
}
`,
		{ mode: 0o755 },
	);
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
	return { provider: new DockerProvider({ daemonPath, docker: program }), calls, daemonPath };
}

/** The value after each occurrence of a flag. */
const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

test("capabilities: a container whose lifetime the janitor enforces, network none or open, and a daemon with exec", () => {
	const { provider } = fakeDocker();
	assert.equal(provider.id, "docker");
	assert.match(provider.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(provider.capabilities(), { lifetime: "janitor", network: ["none", "open"], isolation: "container", os: "linux", daemon: ["exec"] });
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
	const [run, inspect, ...rest] = calls();
	assert.deepEqual(rest, []);
	const name = valuesOf(run, "--name")[0];
	assert.match(name, /^computer-[0-9a-f]{12}$/);
	assert.deepEqual(result.value, { id: "f".repeat(64), name });
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
	assert.deepEqual(connected.value.hello.capabilities, ["exec"]);
	assert.deepEqual(calls(), [["exec", "-i", ref.name, "/opt/agentrun/computerd", "stdio"]]);
	await connected.value.close();
	const after = await connected.value.client.call("ping", {});
	assert.equal(after.ok, false);
	assert.equal(after.error.code, "gone");
});
