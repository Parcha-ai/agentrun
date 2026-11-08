// DockerProvider's bind of the run's folder at /workspace, against the fake docker in test/fake-docker.mjs: the spec
// rule, the ownership rule at create, the --mount it passes, the read-back in attach and list, and the drift check.
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import * as computer from "../dist/index.js";
import { container, fakeDocker, idOf, removal, report, valuesOf } from "./fake-docker.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const TOKEN = "archil-token-fedcba9876543210";
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const runOf = (all) => all.find((args) => args[0] === "run");
const root = realpathSync(mkdtempSync(join(tmpdir(), "computer-docker-mount-")));
after(() => rmSync(root, { recursive: true, force: true }));
let folders = 0;
/** A fresh run folder the provider's default user owns, with this mode. */
function runFolder(mode = 0o700) {
	const dir = join(root, `run-${++folders}`);
	mkdirSync(dir);
	if (process.getuid() === 0) chownSync(dir, 1000, 1000);
	chmodSync(dir, mode);
	return dir;
}
const bind = (path) => ({ kind: "bind", path });

test("capabilities: a Docker computer takes a bind mount, and no other kind", () => {
	const { provider } = fakeDocker();
	assert.deepEqual(provider.capabilities().mount, ["bind"]);
});

test("the provider names the uid:gid a computer runs as by default: the user a bound run folder must be writable by", () => {
	assert.equal(fakeDocker().provider.user, DEFAULT_USER);
	assert.equal(fakeDocker({ user: "1234:5678" }).provider.user, "1234:5678");
});

test("check() takes a bind of an existing run folder, and refuses an Archil mount in words that never hold the token, with no docker call", async () => {
	const { provider, calls } = fakeDocker();
	assert.deepEqual(provider.check({ ...SPEC, mount: bind(runFolder()) }), []);
	const archil = { ...SPEC, mount: { kind: "archil", disk: "d", region: "aws-us-east-1", folder: "runs/r", token: TOKEN } };
	const refused = provider.check(archil);
	assert.deepEqual(refused.map((r) => r.field), ["mount"]);
	assert.match(refused[0].message, /does not take a mount of kind archil; it takes bind/);
	const created = await provider.create(archil);
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "refused");
	assert.match(created.error.message, /^mount: this provider does not take a mount of kind archil/);
	for (const words of [JSON.stringify(refused), created.error.message]) assert.ok(!words.includes(TOKEN), "the token is in a refusal");
	assert.deepEqual(calls(), []);
});

test("check() refuses a bind path Docker cannot take or that is not the run folder itself, with no docker call", async () => {
	const { provider, calls } = fakeDocker();
	const dir = runFolder();
	const link = join(root, "link");
	symlinkSync(dir, link);
	const comma = join(root, "a,b");
	mkdirSync(comma);
	const quote = join(root, 'a"b');
	mkdirSync(quote);
	for (const [path, words] of [
		["run", /mount\.path must be absolute/],
		[join(root, "missing"), /is not a directory on the host/],
		[link, /is not canonical/],
		[comma, /a Docker mount cannot hold a comma, a double quote or a line break in its path/],
		[quote, /a Docker mount cannot hold a comma, a double quote or a line break/],
	]) {
		const refused = provider.check({ ...SPEC, mount: bind(path) });
		assert.deepEqual(refused.map((r) => r.field), ["mount"], `${path}: ${JSON.stringify(refused)}`);
		assert.match(refused[0].message, words, path);
		const created = await provider.create({ ...SPEC, mount: bind(path) });
		assert.equal(created.ok, false);
		assert.equal(created.error.code, "refused");
	}
	assert.deepEqual(calls(), []);
});

test("create() binds the run folder read-write at /workspace after the daemon's mount; HOME and the workdir stay /work", async () => {
	const { provider, calls, daemonPath } = fakeDocker();
	const dir = runFolder();
	const result = await provider.create({ ...SPEC, mount: bind(dir) });
	assert.equal(result.ok, true, JSON.stringify(result));
	const run = runOf(calls());
	assert.deepEqual(valuesOf(run, "--mount"), [`type=bind,src=${daemonPath},dst=/opt/agentrun/computerd,readonly`, `type=bind,src=${dir},dst=/workspace`]);
	assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work"]);
	assert.deepEqual(valuesOf(run, "--workdir"), ["/work"]);
	assert.ok(!valuesOf(run, "--tmpfs").some((tmpfs) => tmpfs.startsWith("/workspace")), "no tmpfs over the run folder");
	const plain = fakeDocker();
	assert.equal((await plain.provider.create(SPEC)).ok, true);
	assert.deepEqual(valuesOf(runOf(plain.calls()), "--mount").length, 1, "a spec with no mount binds nothing at /workspace");
});

test("create() refuses a run folder the computer's user cannot write, in words, having read only the host (docker info), and never changes the folder", async () => {
	const [uid, gid] = DEFAULT_USER.split(":");
	for (const [mode, spec, why] of [
		[0o500, {}, "the owner has no write permission"],
		[0o600, {}, "the owner has no search permission"],
		[0o700, { user: "54321:54321" }, "another user, and others have no write permission"],
		[0o775, { user: "54321:54321" }, "another user and group, and others have no write permission"],
	]) {
		const { provider, calls } = fakeDocker();
		const dir = runFolder(mode);
		const result = await provider.create({ ...SPEC, ...spec, mount: bind(dir) });
		assert.equal(result.ok, false, `${why}: ${JSON.stringify(result)}`);
		assert.equal(result.error.code, "refused");
		const user = spec.user ?? DEFAULT_USER;
		assert.match(
			result.error.message,
			new RegExp(`^mount: the run folder ${dir} is not writable by the computer's user ${user}: it is owned by ${uid}:\\d+ with mode 0?${mode.toString(8)}; the provider never changes it`),
			why,
		);
		// The host is read first, since a host that remaps ids makes the folder's owner meaningless; nothing is made.
		assert.deepEqual(calls().map((args) => args[0]), ["info"], why);
	}
	// Others' write and search permission is enough for any user; so is the group's for a user in it.
	for (const [mode, spec] of [[0o777, { user: "54321:54321" }], [0o1777, { user: "54321:54321" }]]) {
		const { provider } = fakeDocker();
		const result = await provider.create({ ...SPEC, ...spec, mount: bind(runFolder(mode)) });
		assert.equal(result.ok, true, `mode ${mode.toString(8)}: ${JSON.stringify(result)}`);
	}
	const { provider } = fakeDocker();
	const result = await provider.create({ ...SPEC, user: `54321:${gid}`, mount: bind(runFolder(0o770)) });
	assert.equal(result.ok, true, JSON.stringify(result));
	// Root with no capabilities is held to the same bits: it cannot write a folder that is not its own.
	if (process.getuid() !== 0) {
		const refused = await fakeDocker().provider.create({ ...SPEC, user: "0", mount: bind(runFolder(0o700)) });
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, /not writable by the computer's user 0:0/);
	}
});

/** docker info's SecurityOptions on a host that remaps user ids: userns-remap, or rootless Docker. */
const REMAPS = [
	["userns", ["name=seccomp,profile=builtin", "name=userns", "name=cgroupns"]],
	["rootless", ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"]],
];

test("hostOf() reads whether the host remaps user ids (name=userns, name=rootless), which is no problem for a computer with no mount", () => {
	for (const [remap, SecurityOptions] of REMAPS) {
		const host = computer.hostOf({ Architecture: "x86_64", SecurityOptions, MemoryLimit: true, SwapLimit: true, PidsLimit: true, CPUCfsQuota: true, CPUCfsPeriod: true });
		assert.equal(host.remap, remap);
		assert.deepEqual(host.problems, []);
	}
	const plain = computer.hostOf({ Architecture: "x86_64", SecurityOptions: ["name=seccomp,profile=builtin"], MemoryLimit: true, SwapLimit: true, PidsLimit: true, CPUCfsQuota: true, CPUCfsPeriod: true });
	assert.equal("remap" in plain, false);
});

test("create() with a bind on a host that remaps user ids is refused in words before any docker run; a computer with no mount is made as before", async () => {
	const dir = runFolder();
	for (const [remap, SecurityOptions] of REMAPS) {
		const { provider, calls, names } = fakeDocker({ info: { SecurityOptions } });
		const result = await provider.create({ ...SPEC, mount: bind(dir) });
		assert.equal(result.ok, false, `${remap}: ${JSON.stringify(result)}`);
		assert.equal(result.error.code, "refused");
		assert.match(
			result.error.message,
			new RegExp(
				`^mount: this Docker host remaps user ids \\(${remap === "userns" ? "userns-remap" : "rootless Docker"}\\), so the run folder's owner on the host is not ` +
					`the computer's user, and the provider cannot tell whether the computer can write ${dir}; it never changes the folder: ` +
					"bind the run folder on a Docker host that does not remap ids",
			),
			remap,
		);
		assert.deepEqual(calls().map((args) => args[0]), ["info"], `${remap}: no container is made`);
		assert.deepEqual(names(), []);
		// Once the host is read, check() says so too, for a bind alone.
		assert.deepEqual(provider.check({ ...SPEC, mount: bind(dir) }).map((r) => r.field), ["mount"], remap);
		assert.match(provider.check({ ...SPEC, mount: bind(dir) })[0].message, /^this Docker host remaps user ids/);
		assert.deepEqual(provider.check(SPEC), [], `${remap}: a spec with no mount`);
		const plain = await provider.create(SPEC);
		assert.equal(plain.ok, true, `${remap}: a computer with no mount: ${JSON.stringify(plain)}`);
	}
	// A host that does not remap ids binds as before.
	const { provider } = fakeDocker();
	assert.equal((await provider.create({ ...SPEC, mount: bind(dir) })).ok, true);
});

test("create() deletes a computer whose bind is not what was asked: another folder, read-only, or none", async () => {
	for (const [binds, words] of [
		[{ src: "/elsewhere" }, /workspace mount: declared .* bound read-write at \/workspace, read back .*\/elsewhere/],
		[{ readonly: true }, /workspace mount: declared .* bound read-write at \/workspace, read back .*"RW":false/],
		["drop", /workspace mount: declared .* bound read-write at \/workspace, read back \[\]/],
	]) {
		const { provider, calls, names } = fakeDocker({ binds });
		const result = await provider.create({ ...SPEC, mount: bind(runFolder()) });
		assert.equal(result.ok, false, JSON.stringify(binds));
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, words);
		assert.match(result.error.message, /HostConfig\.Mounts/);
		assert.deepEqual(calls().slice(-3), removal(valuesOf(runOf(calls()), "--name")[0]));
		assert.deepEqual(names(), []);
	}
});

test("attach() and list() read the mount back from docker inspect; a computer with none reports none", async () => {
	const M = "computer-0000000000a1";
	const N = "computer-0000000000a2";
	const dir = runFolder();
	const { provider } = fakeDocker({
		containers: [container({ name: M, labels: { run: "m" }, binds: [{ src: dir, dst: "/workspace" }] }), container({ name: N, labels: { run: "n" } })],
	});
	const attached = await provider.attach({ id: M });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.mount, { kind: "bind", path: dir });
	const listed = await provider.list({ run: "m" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(listed.value.map((info) => [info.ref, info.mount]), [[{ id: idOf(M), name: M }, { kind: "bind", path: dir }]]);
	const plain = await provider.attach({ id: N });
	assert.equal(plain.ok, true, JSON.stringify(plain));
	assert.equal("mount" in plain.value.spec, false);
	const none = await provider.list({ run: "n" });
	assert.equal("mount" in none.value[0], false);
});

test("attach() refuses a computer whose /workspace is read-only, or that binds anything else, and leaves it as it is", async () => {
	const R = "computer-0000000000b1";
	const X = "computer-0000000000b2";
	const dir = runFolder();
	const { provider, names } = fakeDocker({
		containers: [
			container({ name: R, binds: [{ src: dir, dst: "/workspace", readonly: true }] }),
			container({ name: X, binds: [{ src: dir, dst: "/data" }] }),
		],
	});
	const readOnly = await provider.attach({ id: R });
	assert.equal(readOnly.ok, false);
	assert.equal(readOnly.error.code, "refused");
	assert.match(readOnly.error.message, /mount: a read-only bind of .* at \/workspace, which this provider never makes/);
	const listed = await provider.list({});
	assert.deepEqual(listed.value.find((info) => info.ref.name === R)?.mount, { other: `a read-only bind of ${dir} at /workspace` });
	const elsewhere = await provider.attach({ id: X });
	assert.equal(elsewhere.ok, false);
	assert.match(elsewhere.error.message, /bind mount: none declared but the daemon's, read back .*"\/data"/);
	assert.deepEqual(names().sort(), [R, X]);
});

test("drift(): a bind declared and made is no drift; one missing, extra, elsewhere, read-only or of another propagation is", () => {
	const deadline = "2026-11-06T12:00:00.000Z";
	const expected = { version: "1.2.3", kind: "linux", groups: ["exec", "files", "processes"], arch: "amd64", daemonPath: "/data/computerd", deadline, user: "1000:1000", apparmor: false, selinux: false };
	const hello = { version: "1.2.3", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
	const spec = { ...SPEC, mount: bind("/runs/r1") };
	const made = (binds) =>
		report({ id: "f".repeat(64), name: "computer-0123456789ab", labels: { "agentrun.computer": "1", "agentrun.computer.deadline": deadline }, cmd: ["init", "--deadline", deadline], daemonPath: "/data/computerd", binds });
	assert.deepEqual(computer.drift(spec, made([{ src: "/runs/r1", dst: "/workspace" }]), hello, expected), []);
	const words = (found) => found.join("; ");
	assert.match(words(computer.drift(spec, made([]), hello, expected)), /workspace mount: declared \/runs\/r1 bound read-write at \/workspace, read back \[\]/);
	assert.match(words(computer.drift(SPEC, made([{ src: "/runs/r1", dst: "/workspace" }]), hello, expected)), /bind mount: none declared but the daemon's, read back/);
	assert.match(words(computer.drift(spec, made([{ src: "/runs/r2", dst: "/workspace" }]), hello, expected)), /workspace mount: declared \/runs\/r1/);
	assert.match(words(computer.drift(spec, made([{ src: "/runs/r1", dst: "/workspace", readonly: true }]), hello, expected)), /workspace mount: declared \/runs\/r1/);
	const shared = made([{ src: "/runs/r1", dst: "/workspace" }]);
	shared.Mounts[1].Propagation = "rshared";
	assert.match(words(computer.drift(spec, shared, hello, expected)), /workspace mount: declared \/runs\/r1/);
	const twice = made([{ src: "/runs/r1", dst: "/workspace" }, { src: "/runs/r1", dst: "/workspace" }]);
	assert.match(words(computer.drift(spec, twice, hello, expected)), /workspace mount: declared/);
	const asked = made([{ src: "/runs/r1", dst: "/workspace" }]);
	asked.HostConfig.Mounts[1].BindOptions = { Propagation: "rshared" };
	assert.match(words(computer.drift(spec, asked, hello, expected)), /HostConfig\.Mounts: declared/);
});

test("mountOf(): the mount at /workspace as inspect reports it: a read-write bind, none, or anything else in words", () => {
	const at = (mounts) => computer.mountOf({ Mounts: mounts });
	assert.equal(at([]), undefined);
	assert.equal(computer.mountOf(undefined), undefined);
	assert.equal(at([{ Type: "bind", Source: "/d", Destination: "/opt/agentrun/computerd", RW: false }]), undefined);
	assert.deepEqual(at([{ Type: "bind", Source: "/runs/r1", Destination: "/workspace", RW: true, Propagation: "rprivate" }]), { kind: "bind", path: "/runs/r1" });
	assert.deepEqual(at([{ Type: "bind", Source: "/runs/r1", Destination: "/workspace", RW: false }]), { other: "a read-only bind of /runs/r1 at /workspace" });
	assert.deepEqual(at([{ Type: "volume", Name: "v1", Source: "/var/lib/docker/volumes/v1/_data", Destination: "/workspace", RW: true }]), {
		other: "a read-write volume of /var/lib/docker/volumes/v1/_data at /workspace",
	});
	assert.deepEqual(
		at([
			{ Type: "bind", Source: "/a", Destination: "/workspace", RW: true },
			{ Type: "bind", Source: "/b", Destination: "/workspace", RW: true },
		]),
		{ other: "a read-write bind of /a, a read-write bind of /b at /workspace" },
	);
});
