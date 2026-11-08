// DockerProvider against a fake docker program under the test's temp dir (test/fake-docker.mjs): it records each
// call's argv and answers as the docker CLI does. No Docker and no daemon binary are needed.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, DockerProvider } from "../dist/index.js";
import { fakeDocker, idOf, removal, valuesOf, VERSION } from "./fake-docker.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const NO_LIST = 'an allowlist needs at least one name or CIDR; for no network ask for "none"';
/** The user a computer runs as when neither the spec nor the provider names one: this process's, or 1000:1000 when its uid or gid is 0. */
/** docker run's argv: create reads the host with docker info first. */
const runOf = (all) => all.find((args) => args[0] === "run");
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";

test("capabilities: a linux container with computerd as PID 1, whose lifetime the janitor enforces up to 30 days, network none, open or an allowlist, exec, files and processes, and a bind mount", () => {
	const { provider } = fakeDocker();
	assert.equal(provider.id, "docker");
	assert.match(provider.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "janitor",
		network: ["none", "open", "allow"],
		allow: { domains: { max: 256, ports: [80, 443] }, cidrs: { max: 256, ports: [80, 443] }, mixed: true },
		networkReadBack: true,
		isolation: "container",
		os: "linux",
		daemon: "pid1",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
		user: ["root", "uid"],
		release: ["stop", "delete"],
		stopDeletes: false,
		mount: ["bind"],
	});
	assert.equal(provider.extend, undefined, "no extend(): the deadline is a label, which cannot change after create");
	assert.equal(provider.stream, undefined, "no stream()");
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
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: ["example.com"] } }), []);
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: [] } }), [{ field: "network", message: NO_LIST }]);
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
		assert.deepEqual(refusals, checkLifetime(lifetimeMs, provider.capabilities()), "the shared lifetime rule, with Docker's cap");
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
	const deadline = valuesOf(runOf(calls()), "--label").find((label) => label.startsWith("agentrun.computer.deadline="))?.split("=")[1];
	assert.ok(Math.abs(Date.parse(deadline) - (before + days30)) < 5000, deadline);
});

test("create() on a refused spec makes no docker call", async () => {
	const { provider, calls } = fakeDocker();
	for (const spec of [{ ...SPEC, network: { allow: [] } }, { ...SPEC, network: { allow: ["pypi.org:443"] } }, { ...SPEC, lifetimeMs: undefined }, { ...SPEC, gpu: 1 }]) {
		const result = await provider.create(spec);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
	}
	const allow = await provider.create({ ...SPEC, network: { allow: [] } });
	assert.ok(allow.error.message.includes(NO_LIST), allow.error.message);
	assert.deepEqual(calls(), []);
});

test("create() runs a hardened container with the daemon as its first process and a deadline label", async () => {
	const { provider, calls, bound } = fakeDocker();
	const before = Date.now();
	const result = await provider.create({ ...SPEC, labels: { team: "a" } });
	assert.equal(result.ok, true, JSON.stringify(result));
	const [info, run, inspect, exec, ...rest] = calls();
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
	assert.deepEqual(valuesOf(run, "--ipc"), ["private"], "never another daemon default, such as shareable");
	assert.deepEqual(valuesOf(run, "--cgroupns"), ["private"], "never the host's, a cgroup v1 host's default");
	assert.deepEqual(valuesOf(run, "--network"), ["none"]);
	assert.deepEqual(valuesOf(run, "--mount"), [`type=bind,src=${bound},dst=/opt/agentrun/computerd,readonly`], "the provider's private copy of the daemon");
	assert.deepEqual(valuesOf(run, "--entrypoint"), ["/opt/agentrun/computerd"]);
	assert.deepEqual(run.slice(-4), ["debian:bookworm-slim", "init", "--deadline", deadline], "PID 1 ends the computer at the deadline the label holds");
	const [uid, gid] = DEFAULT_USER.split(":");
	assert.deepEqual(
		valuesOf(run, "--tmpfs"),
		[`/work:rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700,size=2048m`, `/run/agentrun:rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700,size=1m`],
		"a home the computer's user can write, half its memory, and init's socket directory, the user's alone, 1 MiB",
	);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/work"]);
	assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work"]);
	assert.deepEqual(inspect.slice(0, 1), ["inspect"]);
	assert.equal(inspect.at(-1), name);
	assert.deepEqual(info.slice(0, 2), ["info", "--format"]);
	for (const field of ["Architecture", "SecurityOptions", "MemoryLimit", "SwapLimit", "PidsLimit", "CPUCfsQuota", "CPUCfsPeriod"]) {
		assert.ok(info[2].includes(`{{json .${field}}}`), `docker info reads ${field}`);
	}
	assert.deepEqual(exec, ["exec", "-i", name, "/opt/agentrun/computerd", "stdio"]);
});

test("create() passes the sizes, an open network and the workdir", async () => {
	const { provider, calls } = fakeDocker();
	const result = await provider.create({ ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64, workdir: "/app" });
	assert.equal(result.ok, true);
	const run = runOf(calls());
	assert.deepEqual(valuesOf(run, "--network"), ["bridge"]);
	assert.deepEqual(valuesOf(run, "--cpu-period"), ["100000"]);
	assert.deepEqual(valuesOf(run, "--cpu-quota"), ["150000"]);
	assert.equal(run.includes("--cpus"), false, "a quota, never --cpus, which Docker refuses above its own CPU count");
	assert.deepEqual(valuesOf(run, "--memory"), ["512m"]);
	assert.deepEqual(valuesOf(run, "--memory-swap"), ["512m"]);
	assert.deepEqual(valuesOf(run, "--pids-limit"), ["64"]);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/app"]);
	assert.equal(valuesOf(run, "--tmpfs").filter((tmpfs) => tmpfs.startsWith("/work:")).length, 1, "/work is mounted even when the spec names another workdir");
	const [uid, gid] = DEFAULT_USER.split(":");
	assert.deepEqual(
		valuesOf(run, "--tmpfs"),
		[`/work:rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700,size=256m`, `/run/agentrun:rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700,size=1m`],
		"/work is half of memoryMb, so a full /work is ENOSPC before the memory limit; the socket directory stays 1 MiB",
	);
	const odd = fakeDocker();
	assert.equal((await odd.provider.create({ ...SPEC, memoryMb: 7 })).ok, true);
	assert.ok(valuesOf(runOf(odd.calls()), "--tmpfs")[0].endsWith(",size=3m"), "half of an odd memoryMb rounds down");
});

test("create() with no sizes gives serve's: 2 CPUs, 4 GiB with swap the same, 1024 pids", async () => {
	const { provider, calls } = fakeDocker();
	assert.equal((await provider.create(SPEC)).ok, true);
	const run = runOf(calls());
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
		return valuesOf(runOf(calls()), "--user");
	};
	assert.notEqual(DEFAULT_USER.split(":")[0], "0");
	assert.deepEqual(await userOf(SPEC), [DEFAULT_USER]);
	assert.deepEqual(await userOf(SPEC, { user: "1234:5678" }), ["1234:5678"]);
	assert.deepEqual(await userOf(SPEC, { user: "1234" }), ["1234:1234"], "a uid alone is its own gid, never root's group 0");
	assert.deepEqual(await userOf({ ...SPEC, user: "2000:3000" }, { user: "1234:5678" }), ["2000:3000"], "the spec wins");
	assert.deepEqual(await userOf({ ...SPEC, user: "2000" }), ["2000:2000"]);
	assert.deepEqual(await userOf({ ...SPEC, user: "0" }), ["0:0"]);
	assert.deepEqual(await userOf({ ...SPEC, user: "0:0" }), ["0:0"]);
	assert.deepEqual(await userOf({ ...SPEC, user: "1000:0" }), ["1000:0"], "root's group only when the spec asks for it");
	const { provider, calls } = fakeDocker({ user: "1234:5678" });
	assert.equal((await provider.create({ ...SPEC, user: "2000:3000" })).ok, true);
	assert.deepEqual(
		valuesOf(runOf(calls()), "--tmpfs"),
		["/work:rw,nosuid,nodev,exec,uid=2000,gid=3000,mode=0700,size=2048m", "/run/agentrun:rw,noexec,nosuid,nodev,uid=2000,gid=3000,mode=0700,size=1m"],
		"/work and init's socket directory belong to the user the computer runs as",
	);
	const root = fakeDocker();
	assert.equal((await root.provider.create({ ...SPEC, user: "0" })).ok, true);
	assert.deepEqual(valuesOf(runOf(root.calls()), "--tmpfs"), ["/work:rw,nosuid,nodev,exec,uid=0,gid=0,mode=0700,size=2048m", "/run/agentrun:rw,noexec,nosuid,nodev,uid=0,gid=0,mode=0700,size=1m"]);
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

test("a provider refuses root's group, gid 0, as its default too: a computer is in group 0 only when its spec asks", () => {
	const daemonPath = fakeDocker().daemonPath;
	for (const user of ["1000:0", "65534:00"]) {
		assert.throws(() => new DockerProvider({ daemonPath, user }), /root's group \(gid 0\).*spec/, user);
	}
	assert.throws(() => new DockerProvider({ daemonPath, user: "0:0" }), /root.*spec/);
});

test("the default user is never in root's group: a process with uid or gid 0 gives 1000:1000", async () => {
	const { getuid, getgid } = process;
	const defaultOf = async (uid, gid) => {
		process.getuid = () => uid;
		process.getgid = () => gid;
		let made;
		try {
			made = fakeDocker();
		} finally {
			process.getuid = getuid;
			process.getgid = getgid;
		}
		assert.equal((await made.provider.create(SPEC)).ok, true);
		return valuesOf(runOf(made.calls()), "--user")[0];
	};
	assert.equal(await defaultOf(1234, 5678), "1234:5678");
	assert.equal(await defaultOf(0, 0), "1000:1000");
	assert.equal(await defaultOf(1234, 0), "1000:1000", "a process in root's group does not hand group 0 to its computers");
	assert.equal(await defaultOf(0, 5678), "1000:1000");
});

test("create() removes a container that is not running and says why", async () => {
	const { provider, calls } = fakeDocker({ running: false });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "docker");
	assert.match(result.error.message, /exec format error/);
	const [, run, , ...remove] = calls();
	assert.deepEqual(remove, removal(valuesOf(run, "--name")[0]));
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

test("release() stops or deletes, and a computer already gone is ok", async () => {
	const { provider, calls } = fakeDocker();
	const ref = { id: "f".repeat(64), name: "computer-0123456789ab" };
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	const proxies = ["ps", "-a", "--no-trunc", "--filter", `label=agentrun.computer.egress=${ref.name}`, "--format", "{{.ID}}"];
	assert.deepEqual(calls(), [["stop", ref.name], proxies, ...removal(ref.name)], "each looks for the computer's egress proxy, by its label, and delete its volume too");
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
	assert.deepEqual(connected.value.hello, { version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] });
	assert.deepEqual(calls(), [["exec", "-i", ref.name, "/opt/agentrun/computerd", "stdio"]]);
	await connected.value.close();
	const after = await connected.value.client.call("ping", {});
	assert.equal(after.ok, false);
	assert.equal(after.error.code, "gone");
});

test("connect() refuses a daemon of another version, kind or groups, and closes the stream", async () => {
	const ref = { id: "f".repeat(64), name: "computer-0123456789ab" };
	for (const [hello, words] of [
		[{ version: "0.0.1" }, /version 0\.0\.1.*expected/],
		[{ groups: ["exec", "files"] }, /groups lack processes/],
		[{ groups: ["exec", "files", "processes", "screen"] }, /offers groups screen/],
		[{ kind: "desktop" }, /kind desktop/],
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
	const reordered = fakeDocker({ hello: { groups: ["processes", "files", "exec"] } });
	const connected = await reordered.provider.connect(ref);
	assert.equal(connected.ok, true, "the same groups in another order");
	await connected.value.close();
});

test("create() deletes a computer whose own report drifts from its spec, and says every way it drifted", async () => {
	const { provider, calls, names } = fakeDocker({ patch: { HostConfig: { PidsLimit: 1, CapDrop: [] } }, hello: { version: "0.0.1" } });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	const name = valuesOf(runOf(calls()), "--name")[0];
	assert.match(result.error.message, new RegExp(`${name}.*deleted`));
	assert.match(result.error.message, /PidsLimit/);
	assert.match(result.error.message, /CapDrop/);
	assert.match(result.error.message, /version 0\.0\.1/);
	assert.deepEqual(calls().map((args) => args[0]), ["info", "run", "inspect", "exec", "rm", "ps", "volume"]);
	assert.deepEqual(calls().slice(-3), removal(name));
	assert.deepEqual(names(), []);
});

test("create() deletes a computer whose /work or socket tmpfs drifts on size", async () => {
	const [uid, gid] = DEFAULT_USER.split(":");
	for (const Tmpfs of [
		{ "/work": `rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700` },
		{ "/work": `rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700,size=4096m` },
		{ "/run/agentrun": `rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700` },
	]) {
		const { provider, calls, names } = fakeDocker({ patch: { HostConfig: { Tmpfs } } });
		const result = await provider.create(SPEC);
		assert.equal(result.ok, false, JSON.stringify(Tmpfs));
		assert.equal(result.error.code, "refused");
		const [path] = Object.keys(Tmpfs);
		assert.match(result.error.message, new RegExp(`deleted: .*tmpfs ${path}: declared "[^"]*size=${path === "/work" ? 2048 : 1}m"`));
		assert.deepEqual(calls().slice(-3), removal(valuesOf(runOf(calls()), "--name")[0]));
		assert.deepEqual(names(), []);
	}
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
	assert.deepEqual(calls().slice(-3), removal(valuesOf(runOf(calls()), "--name")[0]));
	assert.deepEqual(names(), []);
});

test("create() deletes a computer whose daemon reports another architecture than the Docker host", async () => {
	const { provider, calls, names } = fakeDocker({ arch: "aarch64" });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, /arch amd64.*arm64/);
	assert.deepEqual(calls().slice(-3), removal(valuesOf(runOf(calls()), "--name")[0]));
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
	assert.deepEqual(calls().map((args) => args[0]), ["info", "run", "inspect", "exec", "rm", "ps", "volume"]);
	assert.deepEqual(names(), []);
});

/** Waits until check() holds, polling; fails after a minute. */
async function until(check, what) {
	const bound = Date.now() + 60_000;
	while (!check()) {
		assert.ok(Date.now() < bound, `still waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

for (const [step, call] of [["inspect", "inspect"], ["hello", "exec"]]) {
	test(`create() aborted while its ${step} after docker run is pending returns aborted and deletes the computer`, async () => {
		const { provider, calls, names, proceed } = fakeDocker({ hold: [step] });
		const controller = new AbortController();
		const pending = provider.create(SPEC, { signal: controller.signal });
		await until(() => calls().some((args) => args[0] === call), `docker ${call}`);
		controller.abort();
		// Unsignalled, the held step now answers, and create would go on to ok.
		proceed(step);
		const result = await pending;
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.equal(result.error.code, "aborted");
		assert.match(result.error.message, /computer-[0-9a-f]{12} was deleted/);
		assert.deepEqual(calls().slice(-3), removal(valuesOf(runOf(calls()), "--name")[0]));
		assert.deepEqual(names(), [], "nothing is left running");
	});
}

test("create() aborted while docker info is pending returns aborted and makes nothing", async () => {
	const { provider, calls, names, proceed } = fakeDocker({ hold: ["info"] });
	const controller = new AbortController();
	const pending = provider.create(SPEC, { signal: controller.signal });
	await until(() => calls().some((args) => args[0] === "info"), "docker info");
	controller.abort();
	proceed("info");
	const result = await pending;
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.error.code, "aborted");
	assert.deepEqual(calls().map((args) => args[0]), ["info"]);
	assert.deepEqual(names(), []);
});

/** Each enforcement docker info can lack, and the words create and check() refuse with. */
const UNENFORCED = [
	[{ MemoryLimit: false }, "this Docker host does not enforce memory limits, so a computer's memory size is only configuration"],
	[{ SwapLimit: false }, "this Docker host does not enforce swap limits"],
	[{ PidsLimit: false }, "this Docker host does not enforce pids limits"],
	[{ CPUCfsQuota: false }, "this Docker host does not enforce CPU quotas"],
	[{ CPUCfsPeriod: false }, "this Docker host does not enforce CPU periods"],
	[{ SecurityOptions: ["name=apparmor", "name=cgroupns"] }, "this Docker host has no seccomp"],
	[{ SecurityOptions: ["name=seccomp,profile=unconfined"] }, "this Docker host's default seccomp profile is unconfined"],
];

for (const [info, words] of UNENFORCED) {
	test(`create() refuses before making anything, and check() from then on: ${words}`, async () => {
		const { provider, calls, names } = fakeDocker({ info });
		const result = await provider.create(SPEC);
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.equal(result.error.code, "refused");
		assert.ok(result.error.message.includes(words), result.error.message);
		assert.deepEqual(calls().map((args) => args[0]), ["info"], "no docker run");
		assert.deepEqual(names(), []);
		const refusals = provider.check(SPEC);
		assert.equal(refusals.length, 1, JSON.stringify(refusals));
		assert.equal(refusals[0].field, "host");
		assert.ok(refusals[0].message.includes(words), refusals[0].message);
		const again = await provider.create(SPEC);
		assert.equal(again.ok, false);
		assert.deepEqual(calls().map((args) => args[0]), ["info"], "the host is read once per provider");
	});
}

test("the host's enforcement is read once per provider, and a docker info that fails is read again", async () => {
	const { provider, calls, daemonPath } = fakeDocker();
	assert.deepEqual(provider.check(SPEC), [], "before the host is read, check() has only the spec to go on");
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.deepEqual(calls().map((args) => args[0]), ["info", "run", "inspect", "exec", "run", "inspect", "exec"]);
	const host = await provider.host();
	assert.deepEqual(host, { ok: true, value: { arch: "amd64", apparmor: false, selinux: false, problems: [] } });
	const broken = new DockerProvider({ daemonPath, docker: join(tmpdir(), "no-such-docker-cli") });
	const first = await broken.host();
	assert.equal(first.ok, false);
	assert.equal(first.error.code, "docker");
	assert.equal((await broken.host()).ok, false);
});

test("create() on a host with AppArmor expects Docker's default profile", async () => {
	const { provider } = fakeDocker({ info: { SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin"] } });
	assert.equal((await provider.create(SPEC)).ok, true);
	const drifted = fakeDocker({ info: { SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin"] }, patch: { AppArmorProfile: "unconfined", HostConfig: { PidMode: "host" } } });
	const result = await drifted.provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.match(result.error.message, /AppArmorProfile/);
	assert.match(result.error.message, /PidMode/);
	assert.deepEqual(drifted.names(), []);
});

const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const XVFB = ["Xvfb", ":0", "-screen", "0", "1280x800x24", "-nolisten", "tcp"];

test("desktop: a desktop computer declares kind desktop and the display's groups; the default stays linux", () => {
	const { provider } = fakeDocker({ desktop: {} });
	const caps = provider.capabilities();
	assert.deepEqual([caps.kind, caps.daemon, caps.groups], ["desktop", "pid1", DESKTOP_GROUPS]);
	assert.equal(fakeDocker().provider.capabilities().kind, "linux");
	assert.throws(() => fakeDocker({ desktop: { display: "0" } }), /display "0" .*such as :0/);
	assert.throws(() => fakeDocker({ desktop: { server: [] } }), /server .*program/);
});

test("desktop: create() gives the daemon DISPLAY, starts the X server through the daemon, and checks hello once the display is up", async () => {
	const { provider, calls, started } = fakeDocker({ desktop: {} });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, true, JSON.stringify(result));
	const run = runOf(calls());
	assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work", "DISPLAY=:0"]);
	assert.deepEqual(run.slice(-4, -2), ["debian:bookworm-slim", "init"], "computerd is still the first process; it starts nothing itself");
	assert.deepEqual(started(), [{ argv: XVFB }], "the X server is one process in the daemon's table, started as any program is");
	const connected = await provider.connect(result.value);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.deepEqual([connected.value.hello.kind, connected.value.hello.groups], ["desktop", DESKTOP_GROUPS]);
	await connected.value.close();
});

test("desktop: the display and the X server's argv are options", async () => {
	const server = ["Xvfb", ":5", "-screen", "0", "800x600x24", "-nolisten", "tcp"];
	const { provider, calls, started } = fakeDocker({ desktop: { display: ":5", server } });
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.deepEqual(valuesOf(runOf(calls()), "--env"), ["HOME=/work", "DISPLAY=:5"]);
	assert.deepEqual(started(), [{ argv: server }]);
});

test("desktop: create() deletes a computer whose X server ends, with the server's own words", async () => {
	const { provider, names } = fakeDocker({ desktop: {}, display: "exits" });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.match(result.error.message, /X server/);
	assert.match(result.error.message, /no screens found/);
	assert.deepEqual(names(), []);
});

test("desktop: create() keeps to its bound when the daemon stops answering once the X server starts", async () => {
	const { provider, names } = fakeDocker({ desktop: { timeoutMs: 300 }, display: "stalls" });
	// The test's own bound: a create that outwaits the desktop's is aborted at 20 s, so it fails here instead of hanging.
	const controller = new AbortController();
	const stop = setTimeout(() => controller.abort(), 20_000);
	const began = Date.now();
	const result = await provider.create(SPEC, { signal: controller.signal });
	clearTimeout(stop);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "timeout", result.error.message);
	assert.match(result.error.message, /display :0 .*not up within 0\.3 s/);
	assert.ok(Date.now() - began < 10_000, `create took ${Date.now() - began} ms on a 300 ms bound`);
	assert.deepEqual(names(), []);
});

test("desktop: create() deletes a computer whose display never comes up, after its bound", async () => {
	const { provider, names } = fakeDocker({ desktop: { timeoutMs: 300 }, display: "never" });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.match(result.error.message, /display :0 .*not up within 0\.3 s/);
	assert.deepEqual(names(), []);
});

test("desktop: a timeoutMs a timer cannot hold is refused when the provider is made, before any computer exists", () => {
	const daemonPath = fakeDocker().daemonPath;
	for (const timeoutMs of [2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
		assert.throws(() => new DockerProvider({ daemonPath, desktop: { timeoutMs } }), /the desktop's timeoutMs must be .* at most 2147483647/, String(timeoutMs));
	}
	assert.doesNotThrow(() => new DockerProvider({ daemonPath, desktop: { timeoutMs: 2 ** 31 - 1 } }));
});
