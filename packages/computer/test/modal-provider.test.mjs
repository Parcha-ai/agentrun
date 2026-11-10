// ModalProvider against a fake of the Modal SDK slice it takes (test/fake-modal.mjs): every call is recorded and
// answered as the SDK documents. No Modal client is constructed, no token is read and nothing reaches the network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, kindRefusals, sweep } from "../dist/index.js";
import { ModalProvider } from "../dist/modal.js";
import * as modal from "../dist/modal.js";
import { DAEMON, DAEMON_IMAGE, deferred, ENTRYPOINT_MARK, fakeModal, GVISOR_KERNEL, HELLO, UPLOAD_MARK, VERSION } from "./fake-modal.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const APP = "computers";
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const SPEC_TAG = "agentrun.computer.spec";
const PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
// The image route holds the daemon's path to root's alone in the image itself, right after the COPY (exec form).
const LAYER = [`COPY --from=${DAEMON_IMAGE} /computerd ${DAEMON}`, `RUN ${JSON.stringify(modal.modalCommands().hold)}`, "ENV HOME=/work", "WORKDIR /work"];
const DAY_MS = 24 * 60 * 60 * 1000;

function setup(options = {}, fakeOptions = {}) {
	const fake = fakeModal(fakeOptions);
	const provider = new ModalProvider({ sdk: fake.sdk, app: APP, daemonImage: DAEMON_IMAGE, ...options });
	return { fake, provider };
}

const createdParams = (fake) => fake.calls.find(([name]) => name === "sandboxes.create")?.[3];
const sandboxOf = (fake, id) => fake.sandboxes.get(id);
const only = (fake) => {
	assert.equal(fake.sandboxes.size, 1, "one sandbox was made");
	return [...fake.sandboxes.values()][0];
};
/** The tags create gives a computer of spec, named name, with deadline and user. */
const tagsFor = (spec, name, deadline, user = "2510:2510") => ({
	...spec.labels,
	[COMPUTER]: "1",
	[NAME]: name,
	[DEADLINE]: deadline,
	[SPEC_TAG]: JSON.stringify({
		image: spec.image,
		user,
		network: spec.network,
		cpus: spec.cpus ?? 2,
		memoryMb: spec.memoryMb ?? 4096,
		workdir: spec.workdir ?? "/work",
		runtime: "vm",
	}),
});
/** A computer as create leaves one, seeded straight into the fake. */
const seeded = ({ spec = SPEC, name = "computer-0123456789ab", deadline = new Date(Date.now() + 600_000).toISOString(), user = "2510:2510", tags = {}, box = {}, running = true } = {}) => ({
	tags: { ...tagsFor(spec, name, deadline, user), ...tags },
	running,
	box: { uid: Number(user.split(":")[0]), gid: Number(user.split(":")[1]), network: spec.network === "none" ? "none" : "open", ...box },
});
const refOf = (fake, name = "computer-0123456789ab") => {
	const found = [...fake.sandboxes.values()].find((one) => one.tags[NAME] === name);
	return { id: found.id, name };
};

test("the constructor refuses, in words, what would make a computer it cannot vouch for", () => {
	const fake = fakeModal();
	const make = (options) => () => new ModalProvider({ sdk: fake.sdk, app: APP, daemonImage: DAEMON_IMAGE, ...options });
	assert.throws(make({ daemonImage: "ghcr.io/example/computerd:latest" }), /pinned by digest/);
	assert.throws(make({ daemonImage: `ghcr.io/example/computerd@sha256:${"a".repeat(63)}` }), /pinned by digest/);
	assert.throws(make({ daemonImage: `ghcr.io/ex ample/computerd@sha256:${"a".repeat(64)}` }), /pinned by digest/);
	assert.throws(make({ app: "" }), /app/);
	assert.throws(make({ user: "0" }), /root/);
	assert.throws(make({ user: "1000:0" }), /group/);
	assert.throws(make({ user: "alice" }), /uid:gid/);
	assert.throws(make({ probeTargets: [] }), /probe/);
	assert.throws(make({ probeTargets: ["example.com"] }), /host:port/);
	assert.throws(make({ probeTargets: ["1.1.1.1:53/sctp"] }), /host:port/);
	assert.throws(make({ probeTargets: ["1.1.1.1:53/"] }), /host:port/);
	assert.doesNotThrow(make({ probeTargets: ["1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp", "example.com:443"] }), "a UDP target is host:port/udp");
	assert.throws(make({ timeouts: { createMs: 0 } }), /createMs/);
	assert.throws(() => new ModalProvider({ sdk: {}, app: APP, daemonImage: DAEMON_IMAGE }), /sdk/);
	assert.deepEqual(fake.calls, [], "no SDK call");
});

test("capabilities: a linux VM whose lifetime Modal enforces up to 24 hours, init its main process, network none alone with no read-back, exec, files and processes, no agent port", () => {
	const { provider, fake } = setup();
	assert.equal(provider.id, "modal");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "vendor",
		network: ["none"],
		networkReadBack: false,
		isolation: "vm",
		os: "linux",
		daemon: "pid1",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: DAY_MS,
		user: ["uid"],
		release: ["delete"],
		mount: ["archil"],
		vendorAgentPorts: [],
	});
	assert.deepEqual(kindRefusals(provider.capabilities()), []);
	assert.equal(provider.extend, undefined, "no extend()");
	assert.equal(provider.stream, undefined, "no stream()");
	assert.deepEqual(fake.calls, []);
});

test("check() takes a spec it can make, with no SDK call", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, cpus: 0.5, memoryMb: 512, labels: { team: "a", run: "r1" }, workdir: "/opt/app", user: "65534" }), []);
	assert.deepEqual(provider.check({ ...SPEC, user: "1000:0" }), [], "root's group, without root, is not root");
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: DAY_MS, user: "65534:65534" }), []);
	assert.deepEqual(fake.calls, []);
});

test("check() refuses in words, field by field, with no SDK call", () => {
	const { provider, fake } = setup();
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	const words = (spec, field) => provider.check(spec).find((r) => r.field === field)?.message ?? "";
	for (const image of [undefined, "", " ", "-x", "debian bookworm", "debian\0"]) assert.deepEqual(refused({ ...SPEC, image }), ["image"], `image ${JSON.stringify(image)}`);
	for (const lifetimeMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "600000"]) {
		assert.deepEqual(refused({ ...SPEC, lifetimeMs }), ["lifetimeMs"], `lifetimeMs ${String(lifetimeMs)}`);
	}
	for (const lifetimeMs of [undefined, 0, 1.5, DAY_MS + 1]) {
		assert.deepEqual(
			provider.check({ ...SPEC, lifetimeMs }).filter((r) => r.field === "lifetimeMs"),
			checkLifetime(lifetimeMs, provider.capabilities()),
			`lifetimeMs ${String(lifetimeMs)}: the shared rule's words`,
		);
	}
	assert.match(words({ ...SPEC, lifetimeMs: DAY_MS + 1 }, "lifetimeMs"), /at most 1 day \(86400000 ms\)/);
	for (const network of ["open", { allow: ["8.8.8.0/24"] }, { allow: ["example.com"] }]) {
		assert.deepEqual(refused({ ...SPEC, network }), ["network"], `network ${JSON.stringify(network)}`);
		assert.match(words({ ...SPEC, network }, "network"), /network "none" only/);
	}
	for (const network of [undefined, "wifi", {}, { allow: "x" }]) assert.deepEqual(refused({ ...SPEC, network }), ["network"], `network ${JSON.stringify(network)}`);
	for (const cpus of [0, -1, 0.1, "2", Number.NaN]) assert.deepEqual(refused({ ...SPEC, cpus }), ["cpus"], `cpus ${String(cpus)}`);
	for (const memoryMb of [0, 1.5, "512"]) assert.deepEqual(refused({ ...SPEC, memoryMb }), ["memoryMb"], `memoryMb ${String(memoryMb)}`);
	assert.deepEqual(refused({ ...SPEC, pids: 64 }), ["pids"]);
	assert.match(words({ ...SPEC, pids: 64 }, "pids"), /pids limit/);
	const seven = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`l${n}`, "v"]));
	assert.deepEqual(refused({ ...SPEC, labels: seven }), ["labels"]);
	assert.match(words({ ...SPEC, labels: seven }, "labels"), /10 tags/);
	for (const labels of [{ [COMPUTER]: "x" }, { [NAME]: "x" }, { a: 1 }, { "": "v" }, { "a\0": "v" }, []]) {
		assert.deepEqual(refused({ ...SPEC, labels }), ["labels"], `labels ${JSON.stringify(labels)}`);
	}
	for (const workdir of ["work", "/my work", "/w$HOME", "/w\nx", "/w\0"]) assert.deepEqual(refused({ ...SPEC, workdir }), ["workdir"], `workdir ${JSON.stringify(workdir)}`);
	for (const user of ["alice", "-1", "1000:", "4294967295"]) assert.deepEqual(refused({ ...SPEC, user }), ["user"], `user ${user}`);
	assert.deepEqual(refused({ ...SPEC, gpu: "A100" }), ["gpu"]);
	assert.match(words({ ...SPEC, gpu: "A100" }, "gpu"), /gVisor/);
	assert.deepEqual(refused({ ...SPEC, region: "us-east-1" }), ["region"]);
	assert.deepEqual(fake.calls, [], "check made no SDK call");
});

test("create: one VM sandbox with the daemon as its command, its tags, the drift check, and the connection closed", async () => {
	const { provider, fake } = setup();
	const before = Date.now();
	const created = await provider.create({ ...SPEC, labels: { team: "a" } });
	const after = Date.now();
	assert.equal(created.ok, true, JSON.stringify(created));
	const made = only(fake);
	assert.deepEqual(created.value, { id: made.id, name: made.tags[NAME] });
	assert.match(created.value.name, /^computer-[0-9a-f]{12}$/);
	assert.deepEqual(fake.names(), [
		"apps.fromName",
		"images.fromRegistry",
		"image.dockerfileCommands",
		"sandboxes.create",
		"sandbox.poll",
		"sandbox.getTags",
		"sandbox.exec",
	]);
	assert.deepEqual(fake.calls[0], ["apps.fromName", APP, { createIfMissing: true }]);
	assert.deepEqual(fake.calls[1], ["images.fromRegistry", SPEC.image]);
	assert.deepEqual(fake.calls[2], ["image.dockerfileCommands", LAYER]);
	const [, app, image, params] = fake.calls[3];
	assert.deepEqual(app, { appId: `ap-${APP}` });
	assert.deepEqual(image.layers, [LAYER], "the sandbox's image is the spec's with the daemon's layer");
	const deadline = params.tags[DEADLINE];
	const at = Date.parse(deadline);
	assert.ok(at >= before + SPEC.lifetimeMs && at <= after + SPEC.lifetimeMs, `deadline ${deadline}`);
	assert.deepEqual(params, {
		runtime: "vm",
		command: [DAEMON, "init", "--deadline", deadline, "--user", "2510:2510", "--own-network"],
		timeoutMs: SPEC.lifetimeMs,
		workdir: "/work",
		cpu: 0.125,
		cpuLimit: 1,
		memoryMiB: 128,
		memoryLimitMiB: 4096,
		blockNetwork: true,
		tags: tagsFor({ ...SPEC, labels: { team: "a" } }, created.value.name, deadline),
	});
	assert.deepEqual(fake.calls[6].slice(1), [made.id, [DAEMON, "stdio"], { mode: "binary" }]);
	assert.deepEqual(
		fake.execRuns.map(({ params: run }) => run.argv),
		[[DAEMON, "probe", ...PROBE_TARGETS.flatMap((target) => ["--connect", target])]],
		"the probe ran once, through the daemon",
	);
	assert.equal(fake.stdinClosed, 1, "the drift check's connection was closed");
	assert.equal(made.running, true);
	assert.equal(made.terminated, 0);
});

test("create: sizes, user and workdir map onto Modal's fields; open makes nothing", async () => {
	const { provider, fake } = setup({ user: "2000:3000" });
	const created = await provider.create({ ...SPEC, cpus: 4, memoryMb: 100, workdir: "/opt/app", lifetimeMs: 1500 });
	assert.equal(created.ok, true, JSON.stringify(created));
	const params = createdParams(fake);
	assert.equal(params.blockNetwork, true);
	for (const key of ["outboundCidrAllowlist", "outboundDomainAllowlist"]) assert.equal(key in params, false, `${key} is never passed`);
	assert.equal(params.timeoutMs, 2000, "Modal takes whole seconds: the lifetime rounds up");
	assert.deepEqual([params.cpu, params.cpuLimit, params.memoryMiB, params.memoryLimitMiB], [0.125, 2, 100, 100]);
	assert.equal(params.workdir, "/opt/app");
	assert.deepEqual(params.command.slice(-3), ["--user", "2000:3000", "--own-network"]);
	assert.deepEqual(fake.calls.find(([name]) => name === "image.dockerfileCommands")[1].at(-1), "WORKDIR /opt/app");
	const open = setup();
	const refused = await open.provider.create({ ...SPEC, network: "open" });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /network "none" only/);
	assert.deepEqual(open.fake.calls, []);
});

test("create: spec.user is the daemon's --user", async () => {
	for (const [user, expected] of [["65534", "65534:65534"], ["70:80", "70:80"], ["1000:0", "1000:0"]]) {
		const { provider, fake } = setup();
		const created = await provider.create({ ...SPEC, user });
		assert.equal(created.ok, true, `${user}: ${JSON.stringify(created)}`);
		assert.deepEqual(createdParams(fake).command.slice(-3), ["--user", expected, "--own-network"]);
		assert.equal(JSON.parse(createdParams(fake).tags[SPEC_TAG]).user, expected);
	}
});

// Modal's exec of the stdio bridge runs /opt/agentrun/computerd outside the daemon, with Modal's own root capabilities.
// A root computer user has no capability, yet owns /, /opt and /opt/agentrun, so it could rename another program over
// that path; no file mode stops uid 0. So a Modal computer never runs as root.
const ROOT_USERS = ["0", "00", "0:0", "0:1000", "root", "root:0", "root:1000"];

test("check() refuses a root user in words that say why: Modal's exec of the bridge runs outside the daemon, as Modal's root", () => {
	const { provider, fake } = setup();
	for (const user of ROOT_USERS) {
		const refusals = provider.check({ ...SPEC, user });
		assert.deepEqual(refusals.map((r) => r.field), ["user"], `user ${user}`);
		const [{ message }] = refusals;
		assert.match(message, /root/, `user ${user}`);
		assert.match(message, /outside the daemon/, `user ${user}: says the bridge runs outside the daemon`);
		assert.match(message, /Modal's own root capabilities/, `user ${user}: says as whom`);
		assert.match(message, /replace/, `user ${user}: says what a root user could do`);
	}
	assert.deepEqual(fake.calls, [], "check made no SDK call");
});

test("create refuses a root user before any SDK call", async () => {
	for (const user of ROOT_USERS) {
		const { provider, fake } = setup();
		const created = await provider.create({ ...SPEC, user });
		assert.equal(created.ok, false, `user ${user}`);
		assert.equal(created.error.code, "refused");
		assert.match(created.error.message, /^user: .*root.*outside the daemon/);
		assert.deepEqual(fake.calls, [], `user ${user}: no SDK call`);
	}
});

test("connect, attach and network refuse a computer recorded with a root user, before any exec in it", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ user: "0:0" })] });
	const ref = refOf(fake);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, false);
	assert.equal(connected.error.code, "refused");
	assert.match(connected.error.message, /root.*outside the daemon/);
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, false);
	assert.equal(attached.error.code, "refused");
	assert.match(attached.error.message, /root/);
	const network = await provider.network(ref);
	assert.equal(network.ok, false);
	assert.equal(network.error.code, "refused");
	assert.match(network.error.message, /root.*outside the daemon/);
	assert.equal(fake.names().includes("sandbox.exec"), false, "no exec in a computer whose user is root");
});

test("create refuses a spec check refuses, and an aborted call, with no SDK call", async () => {
	const { provider, fake } = setup();
	const refused = await provider.create({ ...SPEC, network: { allow: ["8.8.8.0/24"] }, pids: 5 });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /network: .*; pids: /);
	const aborted = await provider.create(SPEC, { signal: AbortSignal.abort() });
	assert.equal(aborted.ok, false);
	assert.equal(aborted.error.code, "aborted");
	assert.deepEqual(fake.calls, []);
});

test("create: a create Modal fails is an error in its words, and nothing is left", async () => {
	const { provider, fake } = setup({}, { create: "fail" });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "invalid");
	assert.match(created.error.message, /COPY --from/);
	assert.equal(fake.sandboxes.size, 0);
});

test("create: a create slower than its bound is a timeout, and the sandbox that lands after it is terminated", async () => {
	const { provider, fake } = setup({ timeouts: { createMs: 50 } }, { create: "late" });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "timeout");
	assert.match(created.error.message, /did not answer within/);
	await fake.release();
	const made = only(fake);
	assert.equal(made.running, false, "the late sandbox was terminated");
	assert.equal(made.terminated, 1);
});

test("create: a create aborted while Modal works is aborted, and the sandbox that lands after it is terminated", async () => {
	const { provider, fake } = setup({}, { create: "late" });
	const controller = new AbortController();
	const creating = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const created = await creating;
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "aborted");
	await fake.release();
	assert.equal(only(fake).running, false);
});

test("create: a create that never answers is still bounded", async () => {
	const { provider, fake } = setup({ timeouts: { createMs: 30 } }, { create: "slow" });
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "timeout");
	await fake.release();
	assert.equal(fake.sandboxes.size, 0);
});

/** create with the fake's options, and the assertion that it was refused in words naming pattern and terminated. */
async function driftedCreate(fakeOptions, pattern, spec = SPEC, options = {}) {
	const { provider, fake } = setup(options, fakeOptions);
	const created = await provider.create(spec);
	assert.equal(created.ok, false, `create was refused (${pattern})`);
	assert.match(created.error.message, pattern);
	assert.match(created.error.message, /was terminated/);
	const made = only(fake);
	assert.equal(made.running, false, "the drifted sandbox does not outlive create");
	assert.ok(made.terminated >= 1);
	return created.error;
}

test("create: drift in the daemon's hello terminates the sandbox and refuses, field by field", async () => {
	assert.equal((await driftedCreate({ box: { hello: { ...HELLO, version: `${VERSION}-drift` } } }, /version/)).code, "refused");
	await driftedCreate({ box: { hello: { ...HELLO, arch: "arm64" } } }, /arch/);
	await driftedCreate({ box: { hello: { ...HELLO, os: "windows" } } }, /os/);
	await driftedCreate({ box: { hello: { ...HELLO, groups: ["exec", "files"] } } }, /groups lack processes/);
	await driftedCreate({ box: { hello: { ...HELLO, groups: [...HELLO.groups, "screen"] } } }, /offers groups screen/);
	await driftedCreate({ box: { hello: { ...HELLO, kind: "desktop" } } }, /kind desktop, expected linux/);
});

test("create: a sandbox whose kernel is gVisor's is refused as another runtime", async () => {
	assert.equal((await driftedCreate({ box: { kernel: GVISOR_KERNEL } }, /runtime: .*gVisor/)).code, "refused");
});

test("create: a daemon whose programs run as another user is refused", async () => {
	await driftedCreate({ box: { uid: 0, gid: 0 } }, /user: declared 2510:2510, read back 0:0/);
});

test("create: network none that reaches an address is refused", async () => {
	await driftedCreate({ box: { reached: ["1.1.1.1:443"] } }, /network: .*1\.1\.1\.1:443/);
});

test("create: network none that answers on one target is refused, whatever the others only accepted", async () => {
	const error = await driftedCreate({ box: { reached: ["1.1.1.1:443"], accepted: ["8.8.8.8:443", "[2606:4700:4700::1111]:443"] } }, /network: declared none, read back an answer from 1\.1\.1\.1:443/);
	assert.equal(error.code, "refused");
});

test("create: network none whose probe targets only accepted, with no answer, is kept, and the accepts are named in its read-back words", async () => {
	const { provider, fake } = setup({}, { box: { accepted: PROBE_TARGETS } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const made = only(fake);
	assert.equal(made.running, true);
	assert.equal(made.terminated, 0);
	assert.deepEqual([created.value.id, created.value.name], [made.id, made.tags[NAME]]);
	assert.equal(created.value.notes?.length, 1, JSON.stringify(created.value));
	assert.match(created.value.notes[0], /^network: none; accepted with no answer/);
	assert.ok(created.value.notes[0].endsWith(PROBE_TARGETS.join(", ")), created.value.notes[0]);
});

test("create: tags that do not read back as given are drift", async () => {
	await driftedCreate({ tags: { [DEADLINE]: undefined } }, /tag agentrun\.computer\.deadline/);
	await driftedCreate({ tags: { [SPEC_TAG]: "{}" } }, /tag agentrun\.computer\.spec/);
	await driftedCreate({ tags: { extra: "1" } }, /tag extra/);
});

test("create: a sandbox whose own command has already ended is refused with its exit code and the tail of its output", async () => {
	// The Modal live run: every create's sandbox had shut down before the daemon's bridge, and the error said only that.
	const error = await driftedCreate({ running: false, ended: { exitCode: 1, stdout: "", stderr: "computerd init: cannot make its own network: operation not permitted\n" } }, /finished/);
	assert.match(error.message, /its command exited 1/);
	assert.match(error.message, /computerd init: cannot make its own network: operation not permitted/);
	// A sandbox that ended with no output says so, in words.
	const quiet = await driftedCreate({ running: false, ended: { exitCode: 0 } }, /finished/);
	assert.match(quiet.message, /its command exited 0, with no output/);
});

test("create: a sandbox that is not running after create, or has no daemon, is refused", async () => {
	await driftedCreate({ running: false }, /finished/);
	await driftedCreate({ box: { daemon: false } }, /no daemon listens/, SPEC, { timeouts: { helloMs: 300 } });
	await driftedCreate({ box: { probe: "fails" } }, /probe/);
	await driftedCreate({ box: { probe: "garbled" } }, /probe/);
});

test("create: a probe report with no accepted list is refused in words, never read as nothing accepted", async () => {
	const error = await driftedCreate({ box: { probe: "no-accepted" } }, /the probe in .* wrote a report with no accepted list/);
	assert.equal(error.code, "refused");
});

test("create: a daemon that never answers hello is a timeout, and the sandbox is terminated", async () => {
	const error = await driftedCreate({ box: { silent: true } }, /hello/, SPEC, { timeouts: { helloMs: 50 } });
	assert.equal(error.code, "timeout");
});

test("create: a probe that never answers is a timeout, and the sandbox is terminated", async () => {
	const error = await driftedCreate({ box: { probe: "hangs" } }, /probe/, SPEC, { timeouts: { probeMs: 50 } });
	assert.equal(error.code, "timeout");
});

test("create: an abort once the sandbox exists terminates it", async () => {
	const { provider, fake } = setup({}, { box: { silent: true } });
	const controller = new AbortController();
	const creating = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	const created = await creating;
	assert.equal(created.error?.code, "aborted");
	assert.match(created.error.message, /was terminated/);
	assert.equal(only(fake).running, false);
});

// The daemon by upload: no daemonImage, so the binary is streamed in through exec's stdin right after create.

/** A stand-in daemon binary of more than two of the SDK's 256 KiB stdin chunks, in a directory of its own. */
const UPLOAD_DIR = mkdtempSync(join(tmpdir(), "computer-modal-upload-"));
const BINARY = randomBytes(700_000);
const BINARY_PATH = join(UPLOAD_DIR, "computerd-linux-amd64");
writeFileSync(BINARY_PATH, BINARY);
const BINARY_SHA = createHash("sha256").update(BINARY).digest("hex");
const CHUNK = 256 * 1024;
test.after(() => rmSync(UPLOAD_DIR, { recursive: true, force: true }));

function uploadSetup(options = {}, fakeOptions = {}) {
	const fake = fakeModal(fakeOptions);
	const provider = new ModalProvider({ sdk: fake.sdk, app: APP, daemonPath: BINARY_PATH, ...options });
	return { fake, provider };
}
/** The provider's commands; looked up at the call, so a build without them fails each test that uses them. */
const modalCommands = (options) => modal.modalCommands(options);
const execsOf = (fake) => fake.calls.filter(([name]) => name === "sandbox.exec");

test("modalCommands: the entrypoint and the upload are POSIX sh scripts, each marked, with their arguments after them", () => {
	const deadline = "2026-11-06T12:00:00.000Z";
	const commands = modalCommands({ deadline, user: "1000:1000", waitSeconds: 360, sha256: BINARY_SHA });
	assert.deepEqual(commands.entrypoint.slice(0, 2), ["sh", "-c"]);
	assert.ok(commands.entrypoint[2].startsWith(`${ENTRYPOINT_MARK}\n`));
	assert.deepEqual(commands.entrypoint.slice(3), ["sh", DAEMON, "360", "/work", "init", "--deadline", deadline, "--user", "1000:1000", "--own-network"]);
	assert.deepEqual(commands.upload.slice(0, 2), ["sh", "-c"]);
	assert.ok(commands.upload[2].startsWith(`${UPLOAD_MARK}\n`));
	assert.deepEqual(commands.upload.slice(3), ["sh", DAEMON, BINARY_SHA]);
	assert.deepEqual(commands.stdio, [DAEMON, "stdio"]);
	for (const script of [commands.entrypoint[2], commands.upload[2]]) {
		assert.doesNotMatch(script, /\bbash\b|\[\[|\bsudo\b|\bcurl\b|\bwget\b/, "plain POSIX sh, nothing the image may lack, no network");
	}
	assert.match(commands.upload[2], /cat > "\$p"/);
	assert.match(commands.upload[2], /sha256sum/);
	assert.match(commands.upload[2], /mv -f "\$p" "\$d"/);
	assert.match(commands.entrypoint[2], /exec "\$d" "\$@"/, "init replaces the shell: it is the sandbox's main process");
});

test("create without daemonImage: the command is the entrypoint, the image has no COPY --from, and the daemon is streamed in through exec's stdin with its sha256 checked", async () => {
	const { provider, fake } = uploadSetup();
	const before = Date.now();
	const created = await provider.create({ ...SPEC, labels: { team: "a" } });
	const after = Date.now();
	assert.equal(created.ok, true, JSON.stringify(created));
	const made = only(fake);
	assert.deepEqual(fake.names(), [
		"apps.fromName",
		"images.fromRegistry",
		"image.dockerfileCommands",
		"sandboxes.create",
		"sandbox.exec",
		"sandbox.poll",
		"sandbox.getTags",
		"sandbox.exec",
	]);
	assert.deepEqual(fake.calls[2], ["image.dockerfileCommands", ["ENV HOME=/work", "WORKDIR /work"]]);
	assert.doesNotMatch(JSON.stringify(fake.calls), /COPY/, "no layer copies the daemon from a registry");
	const params = createdParams(fake);
	const deadline = params.tags[DEADLINE];
	const at = Date.parse(deadline);
	assert.ok(at >= before + SPEC.lifetimeMs && at <= after + SPEC.lifetimeMs, `deadline ${deadline}`);
	const commands = modalCommands({ deadline, user: "2510:2510", waitSeconds: 360, sha256: BINARY_SHA });
	assert.deepEqual(params.command, commands.entrypoint, "the sandbox's command is the entrypoint that waits for the daemon");
	assert.equal(params.timeoutMs, SPEC.lifetimeMs, "Modal's timeout is the lifetime");
	assert.equal(params.blockNetwork, true, "network none: the upload needs no network in the sandbox");
	const [upload, stdio] = execsOf(fake);
	assert.deepEqual(upload.slice(1), [made.id, commands.upload, { mode: "binary" }]);
	assert.deepEqual(stdio.slice(1), [made.id, [DAEMON, "stdio"], { mode: "binary" }]);
	assert.equal(fake.uploads.length, 1);
	assert.ok(fake.uploads[0].bytes.equals(BINARY), "the bytes streamed in are the daemon's");
	assert.deepEqual(fake.uploads[0].sizes, [CHUNK, CHUNK, BINARY.length - 2 * CHUNK], "in the SDK's 256 KiB stdin chunks");
	assert.deepEqual(made.installed?.path, DAEMON);
	assert.equal(made.running, true);
	assert.equal(made.terminated, 0);
});

test("create without daemonImage: the entrypoint waits as long as the upload's bound and a call's", async () => {
	const { provider, fake } = uploadSetup({ timeouts: { uploadMs: 90_000, callMs: 15_500 } });
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.equal(createdParams(fake).command[5], "106", "ceil((90 s + 15.5 s)) whole seconds");
});

test("create: an upload that fails, exits nonzero or does not read back its sha256 terminates the sandbox and refuses in words", async () => {
	for (const [upload, pattern] of [
		["throw", /upload.*task command router unavailable/],
		["exit", /upload exited with 4: writing the daemon .* failed.*No space left on device/s],
		["corrupt", /upload exited with 5.*not moved into place/],
		["lie", /sha256 .*reads back "0{64}"/],
	]) {
		const { provider, fake } = uploadSetup({}, { upload });
		const created = await provider.create(SPEC);
		assert.equal(created.ok, false, upload);
		assert.match(created.error.message, pattern, upload);
		assert.match(created.error.message, /was terminated/, upload);
		const made = only(fake);
		assert.equal(made.running, false, `${upload}: the sandbox does not outlive create`);
		assert.equal(made.terminated, 1, upload);
		assert.equal(execsOf(fake).length, 1, `${upload}: no bridge is opened to a daemon that was not installed`);
	}
});

test("create: an upload that never ends is a timeout within uploadMs, and the sandbox is terminated", async () => {
	const { provider, fake } = uploadSetup({ timeouts: { uploadMs: 60 } }, { upload: "hang" });
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "timeout");
	assert.match(created.error.message, /upload.*did not answer within 0\.06 s/);
	assert.equal(only(fake).running, false);
});

test("create: an abort during the upload terminates the sandbox", async () => {
	const { provider, fake } = uploadSetup({}, { upload: "hang" });
	const controller = new AbortController();
	const creating = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	const created = await creating;
	assert.equal(created.error?.code, "aborted");
	assert.match(created.error.message, /was terminated/);
	assert.equal(only(fake).running, false);
});

// Modal ends a sandbox asynchronously: a create that refuses one waits, as release does, until poll reads it finished.
const LINGERS = { lingers: { polls: 2, lists: 5 } };
/** What provider.list reads, by name, right after create returned. */
const listedNames = async (provider) => {
	const listed = await provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed));
	return listed.value.map((info) => info.ref.name);
};

test("create: a create refused for drift leaves nothing listed when it returns, though Modal ends the sandbox late", async () => {
	const { provider, fake } = setup({ timeouts: { releasePollMs: 5 } }, { ...LINGERS, box: { hello: { ...HELLO, version: `${VERSION}-drift` } } });
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "refused");
	assert.match(created.error.message, /was terminated/);
	assert.equal(only(fake).running, false, "create returned once poll read the sandbox finished");
	assert.deepEqual(await listedNames(provider), []);
});

test("create: a create refused for a failed upload leaves nothing listed when it returns", async () => {
	const { provider, fake } = uploadSetup({ timeouts: { releasePollMs: 5 } }, { ...LINGERS, upload: "exit" });
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "refused");
	assert.match(created.error.message, /was terminated/);
	assert.equal(only(fake).running, false);
	assert.deepEqual(await listedNames(provider), []);
});

test("create: an aborted create terminates the sandbox it made, and its wait for the end takes the caller's signal, so it ends on the abort", async () => {
	const { provider, fake } = setup({ timeouts: { releaseMs: 5_000, releasePollMs: 5 } }, { lingers: { polls: 1_000 }, box: { silent: true } });
	const controller = new AbortController();
	const creating = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 30));
	controller.abort();
	const started = Date.now();
	const created = await creating;
	assert.ok(Date.now() - started < 1_000, `create returned ${Date.now() - started} ms after the abort, not after releaseMs`);
	assert.equal(created.error?.code, "aborted");
	assert.match(created.error.message, /was terminated, and may still be ending \(the wait for .* was aborted/);
	const made = only(fake);
	assert.equal(made.terminated, 1, "the terminate itself is sent, abort or not");
	assert.equal(made.running, true, "Modal had not ended it yet: the wait did not go on after the abort");
});

test("create: a refused create's wait for its sandbox's end ends when the caller aborts during it", async () => {
	const { provider, fake } = setup({ timeouts: { releaseMs: 5_000, releasePollMs: 5 } }, { lingers: { polls: 1_000 }, box: { hello: { ...HELLO, version: `${VERSION}-drift` } } });
	const controller = new AbortController();
	const creating = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => {
		const check = setInterval(() => {
			if ([...fake.sandboxes.values()].some((one) => one.terminated >= 1)) resolve(clearInterval(check));
		}, 5);
	});
	controller.abort();
	const started = Date.now();
	const created = await creating;
	assert.ok(Date.now() - started < 1_000, `create returned ${Date.now() - started} ms after the abort, not after releaseMs`);
	assert.match(created.error.message, /may still be ending \(the wait for .* was aborted/);
});

test("create: a refused sandbox that does not finish within releaseMs is said to be still ending, with what poll last read", async () => {
	const { provider } = setup({ timeouts: { releaseMs: 150, releasePollMs: 10 } }, { lingers: { polls: 1_000 }, box: { hello: { ...HELLO, version: `${VERSION}-drift` } } });
	const started = Date.now();
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "refused");
	assert.match(created.error.message, /may still be ending/);
	assert.match(created.error.message, /0\.15 s/);
	assert.match(created.error.message, /poll read null/);
	assert.match(created.error.message, /version/, "the drift is still said");
	assert.ok(Date.now() - started < 5_000, "bounded by releaseMs");
});

test("create: a daemon binary that is not there is not_found in words, before any SDK call", async () => {
	const { provider, fake } = uploadSetup({ daemonPath: join(UPLOAD_DIR, "absent") });
	const created = await provider.create(SPEC);
	assert.equal(created.error?.code, "not_found");
	assert.match(created.error.message, /no daemon binary at .*absent.*build:daemon/);
	assert.deepEqual(fake.calls, []);
});

test("create: init not yet listening when the upload ends is waited for, within helloMs; a daemon that never listens is refused", async () => {
	const { provider, fake } = uploadSetup({}, { box: { notListening: 2 } });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.equal(execsOf(fake).length, 4, "the upload, two bridges that found no socket, and the one that said hello");
	const never = uploadSetup({ timeouts: { helloMs: 300 } }, { box: { notListening: 1_000 } });
	const refused = await never.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /no daemon listens/);
	assert.equal(only(never.fake).running, false);
});

test("the constructor takes daemonImage or daemonPath, not both; with daemonImage the COPY --from layer and the daemon as the command stay", async () => {
	const fake = fakeModal();
	assert.throws(() => new ModalProvider({ sdk: fake.sdk, app: APP, daemonImage: DAEMON_IMAGE, daemonPath: BINARY_PATH }), /daemonImage or daemonPath, not both/);
	assert.deepEqual(fake.calls, []);
	const { provider, fake: imageFake } = setup();
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.deepEqual(createdParams(imageFake).command.slice(0, 2), [DAEMON, "init"]);
	assert.deepEqual(imageFake.uploads, [], "nothing is uploaded when the image holds the daemon");
	assert.equal(execsOf(imageFake).length, 1, "only the drift check's bridge");
});

test("lifetime: maxLifetimeMs caps what check takes, in words; Modal's timeout is the lifetime", async () => {
	const fake = fakeModal();
	const make = (maxLifetimeMs) => () => new ModalProvider({ sdk: fake.sdk, app: APP, daemonPath: BINARY_PATH, maxLifetimeMs });
	for (const bad of [0, -1, 1.5, DAY_MS + 1, "1800000"]) assert.throws(make(bad), /maxLifetimeMs/, String(bad));
	const capped = make(30 * 60_000)();
	assert.equal(capped.capabilities().maxLifetimeMs, 30 * 60_000, "the instance's cap is the one it declares");
	assert.deepEqual(capped.check({ ...SPEC, lifetimeMs: 30 * 60_000 }), []);
	const refusals = capped.check({ ...SPEC, lifetimeMs: 30 * 60_000 + 1 });
	assert.deepEqual(refusals, checkLifetime(30 * 60_000 + 1, capped.capabilities()));
	assert.match(refusals[0].message, /at most 30 min \(1800000 ms\)/);
	const refused = await capped.create({ ...SPEC, lifetimeMs: 60 * 60_000 });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /lifetimeMs: .*30 min/);
	assert.deepEqual(fake.calls, [], "refused before any SDK call");
	const created = await capped.create({ ...SPEC, lifetimeMs: 29 * 60_000 + 500 });
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.equal(createdParams(fake).timeoutMs, 29 * 60_000 + 1000, "whole seconds, rounded up");
});

/** Runs a command's argv with sh on this machine, as Modal would in the sandbox; resolves with its exit and output. */
function runLocally(argv, { input, onSpawn } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid }));
		onSpawn?.(child);
		child.stdin.end(input);
	});
}

test("the entrypoint's wait is bounded: with no daemon it exits nonzero in words once its seconds run out", async () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-modal-entry-"));
	try {
		const daemon = join(dir, "opt", "computerd");
		const started = Date.now();
		const ran = await runLocally(modalCommands({ deadline: "2026-11-06T12:00:00Z", waitSeconds: 1, daemon, home: join(dir, "home") }).entrypoint);
		const took = Date.now() - started;
		assert.equal(ran.code, 3, JSON.stringify(ran));
		assert.match(ran.stderr, /the daemon did not arrive at .*computerd within 1 s/);
		assert.ok(took >= 900 && took < 5_000, `it waited ${took} ms`);
		// A file there that is not executable is not the daemon: still bounded.
		mkdirSync(join(dir, "opt"));
		writeFileSync(daemon, "not yet\n", { mode: 0o644 });
		const half = await runLocally(modalCommands({ waitSeconds: 1, daemon }).entrypoint);
		assert.equal(half.code, 3, JSON.stringify(half));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the entrypoint execs the daemon once it is moved into place: same process, its arguments, HOME", async () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-modal-entry-"));
	try {
		mkdirSync(join(dir, "opt"));
		const daemon = join(dir, "opt", "computerd");
		const part = join(dir, "opt", ".computerd.part");
		const deadline = "2026-11-06T12:00:00.000Z";
		const ran = await runLocally(modalCommands({ deadline, user: "1000:1000", waitSeconds: 20, daemon, home: join(dir, "home") }).entrypoint, {
			onSpawn: () =>
				setTimeout(() => {
					writeFileSync(part, '#!/bin/sh\necho "pid $$ home $HOME args $*"\n', { mode: 0o755 });
					renameSync(part, daemon);
				}, 400),
		});
		assert.equal(ran.code, 0, JSON.stringify(ran));
		assert.equal(ran.stdout, `pid ${ran.pid} home ${join(dir, "home")} args init --deadline ${deadline} --user 1000:1000 --own-network\n`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the upload script refuses a daemon path that is not root's alone, and writes nothing there", async () => {
	// Run here as the test's own user under a temp directory that user owns: the path is not root's, so the upload must
	// refuse before it reads the daemon. The success and sha256-mismatch paths run as root in the Docker commands test.
	const dir = mkdtempSync(join(tmpdir(), "computer-modal-upload-sh-"));
	try {
		const daemon = join(dir, "opt", "agentrun", "computerd");
		const refused = await runLocally(modalCommands({ sha256: BINARY_SHA, daemon }).upload, { input: Buffer.alloc(0) });
		assert.equal(refused.code, 7, JSON.stringify({ ...refused, stdout: refused.stdout.slice(0, 300) }));
		assert.match(refused.stdout, /the daemon at .*computerd is not root's alone: /);
		assert.equal(existsSync(daemon), false, "nothing is installed at a path another user can change");
		assert.equal(existsSync(join(dir, "opt", "agentrun", ".computerd.part")), false, "no part file either");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("connect: the daemon's stdio bridge over exec is the client's stream, hello checked", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded()] });
	const ref = refOf(fake);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.deepEqual(connected.value.hello, HELLO);
	assert.deepEqual(await connected.value.client.call("ping", {}), { ok: true, value: {} });
	const ran = await connected.value.client.call("exec.run", { argv: ["echo", "hi"], timeoutMs: 1000 });
	assert.equal(Buffer.from(ran.value.stdout, "base64").toString(), "echo hi\n");
	await connected.value.close();
	assert.equal(fake.stdinClosed, 1);
	assert.deepEqual(fake.names(), ["sandboxes.fromId", "sandbox.getTags", "sandbox.exec"]);
});

test("connect refuses what is not one of this provider's computers before any exec", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded(), { tags: { [COMPUTER]: "1", [NAME]: "computer-ffffffffffff" }, box: {} }, { tags: { other: "1" } }] });
	const ours = refOf(fake);
	const ids = [...fake.sandboxes.keys()];
	const bad = await provider.connect({ id: ours.id, name: "not-a-computer" });
	assert.equal(bad.error?.code, "invalid");
	assert.deepEqual(fake.calls, [], "a bad name makes no call");
	assert.equal((await provider.connect({ id: ours.id, name: "computer-aaaaaaaaaaaa" })).error?.code, "not_found");
	assert.equal((await provider.connect({ id: ids[2], name: "computer-0123456789ab" })).error?.code, "not_found");
	assert.equal((await provider.connect({ id: "sb-missing", name: "computer-0123456789ab" })).error?.code, "not_found");
	assert.equal(fake.names().includes("sandbox.exec"), false, "no exec in a sandbox that is not this provider's");
});

test("connect refuses a daemon of another version, and closes the connection", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ box: { hello: { ...HELLO, version: "0.0.1" } } })] });
	const connected = await provider.connect(refOf(fake));
	assert.equal(connected.error?.code, "refused");
	assert.match(connected.error.message, /version/);
	assert.equal(fake.stdinClosed, 1);
});

test("connect: a bridge whose exec answers after callMs is closed when it lands", async () => {
	const { provider, fake } = setup({ timeouts: { callMs: 50 } }, { sandboxes: [seeded()], bridgeMs: 150 });
	const connected = await provider.connect(refOf(fake));
	assert.equal(connected.ok, false);
	assert.equal(connected.error.code, "timeout");
	assert.equal(fake.stdinClosed, 0, "the bridge has not landed yet");
	await new Promise((resolve) => setTimeout(resolve, 250));
	const [late] = only(fake).box.bridges;
	assert.ok(late, "the bridge landed after connect gave up");
	assert.equal(fake.stdinClosed, 1, "and its stdin was closed as it landed, so it ends");
});

test("attach: a bridge whose exec lands after the caller aborted is closed when it lands", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded()], bridgeMs: 150 });
	const controller = new AbortController();
	const attaching = provider.attach({ id: refOf(fake).id }, { signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	const attached = await attaching;
	assert.equal(attached.ok, false);
	assert.equal(attached.error.code, "aborted");
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(only(fake).box.bridges.length, 1, "the bridge landed after attach gave up");
	assert.equal(fake.stdinClosed, 1, "and its stdin was closed as it landed");
});

test("hello's bound covers the bridge's start: a slow exec and a silent daemon fail at helloMs in all, not helloMs + the exec", async () => {
	const helloMs = 400;
	const bridgeMs = 300;
	for (const how of ["connect", "create"]) {
		const { provider, fake } =
			how === "connect"
				? setup({ timeouts: { helloMs } }, { sandboxes: [seeded({ box: { silent: true } })], bridgeMs })
				: setup({ timeouts: { helloMs } }, { box: { silent: true }, bridgeMs });
		const started = Date.now();
		const result = how === "connect" ? await provider.connect(refOf(fake)) : await provider.create(SPEC);
		const took = Date.now() - started;
		assert.equal(result.ok, false, how);
		assert.equal(result.error.code, "timeout", `${how}: ${result.error.message}`);
		assert.ok(took < helloMs + bridgeMs - 100, `${how} took ${took} ms: hello's ${helloMs} ms began only after the exec's ${bridgeMs} ms`);
	}
});

test("connect to a sandbox that has finished is an error", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ running: false })] });
	const connected = await provider.connect(refOf(fake));
	assert.equal(connected.ok, false);
	assert.match(connected.error.message, /finished/);
});

test("list: this provider's running sandboxes with every label, by tags through the SDK", async () => {
	const deadline = new Date(Date.now() + 60_000).toISOString();
	const { provider, fake } = setup(
		{},
		{
			sandboxes: [
				seeded({ name: "computer-000000000001", tags: { team: "a" }, deadline }),
				seeded({ name: "computer-000000000002", tags: { team: "a", [DEADLINE]: "tomorrow" } }),
				seeded({ name: "computer-000000000003", tags: { team: "b" } }),
				seeded({ name: "computer-000000000004", tags: { team: "a" }, spec: { ...SPEC, network: "open" } }),
				{ tags: { [COMPUTER]: "1", team: "a", [NAME]: "not-ours" } },
				seeded({ name: "computer-000000000005", tags: { team: "a" }, running: false }),
			],
		},
	);
	const listed = await provider.list({ team: "a" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(
		listed.value.map((info) => [info.ref.name, info.state, info.network, info.deadline?.toISOString()]),
		[
			["computer-000000000001", "running", "none", deadline],
			["computer-000000000002", "running", "none", undefined],
			["computer-000000000004", "running", "open", listed.value[2].deadline?.toISOString()],
		],
	);
	assert.equal(listed.value[0].labels.team, "a");
	assert.equal(listed.value[0].ref.id, refOf(fake, "computer-000000000001").id);
	assert.deepEqual(fake.calls[1], ["sandboxes.list", { appId: `ap-${APP}`, tags: { team: "a", [COMPUTER]: "1" } }]);
});

test("list refuses labels that are not a filter, with no call, and is bounded and abortable", async () => {
	const { provider, fake } = setup({ timeouts: { listMs: 50 } });
	for (const labels of [null, [], { a: 1 }, { "": "v" }]) assert.equal((await provider.list(labels)).error?.code, "invalid");
	assert.deepEqual(fake.calls, []);
	fake.sdk.sandboxes.list = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
	assert.equal((await provider.list({})).error?.code, "timeout");
	assert.equal((await provider.list({}, { signal: AbortSignal.abort() })).error?.code, "aborted");
});

test("attach by id: the spec as recorded and as the daemon reads it back, the drift check passed", async () => {
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const spec = { ...SPEC, cpus: 1, memoryMb: 2048, workdir: "/opt/app" };
	const { provider, fake } = setup({}, { sandboxes: [seeded({ spec, deadline, user: "1000:1000" })] });
	const ref = refOf(fake);
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value, {
		...ref,
		spec: { image: SPEC.image, user: "1000:1000", network: "none", cpus: 1, memoryMb: 2048, workdir: "/opt/app", deadline: new Date(deadline), kind: "linux" },
	});
	assert.equal(fake.execRuns.length, 1, "the probe ran");
	assert.equal(fake.stdinClosed, 1);
	assert.equal(sandboxOf(fake, ref.id).terminated, 0);
});

test("attach by labels: one match is attached, none is not_found, several is invalid", async () => {
	const { provider, fake } = setup(
		{},
		{ sandboxes: [seeded({ name: "computer-000000000001", tags: { role: "a" } }), seeded({ name: "computer-000000000002", tags: { role: "b" } }), seeded({ name: "computer-000000000003", tags: { role: "b" } })] },
	);
	const one = await provider.attach({ labels: { role: "a" } });
	assert.equal(one.ok, true, JSON.stringify(one));
	assert.equal(one.value.name, "computer-000000000001");
	assert.equal((await provider.attach({ labels: { role: "c" } })).error?.code, "not_found");
	const several = await provider.attach({ labels: { role: "b" } });
	assert.equal(several.error?.code, "invalid");
	assert.match(several.error.message, /computer-000000000002/);
	assert.equal((await provider.attach({ labels: {} })).error?.code, "invalid");
	assert.equal((await provider.attach({})).error?.code, "invalid");
	assert.equal((await provider.attach({ id: "x", labels: { a: "b" } })).error?.code, "invalid");
});

test("attach refuses a drifted computer in words and leaves it running", async () => {
	const cases = [
		[{ box: { kernel: GVISOR_KERNEL } }, /gVisor/],
		[{ box: { hello: { ...HELLO, version: "0.0.1" } } }, /version/],
		[{ box: { reached: ["8.8.8.8:443"] } }, /network/],
		[{ box: { uid: 0, gid: 0 } }, /user/],
		[{ deadline: new Date(Date.now() + 2 * DAY_MS).toISOString() }, /24 hours/],
		[{ deadline: "soon" }, /deadline/],
		[{ tags: { [SPEC_TAG]: "not json" } }, /spec/],
		[{ tags: { [SPEC_TAG]: JSON.stringify({ image: "x", user: "1000:1000", network: "none", cpus: 2, memoryMb: 4096, workdir: "/work", runtime: "gvisor" }) } }, /runtime/],
	];
	for (const [options, pattern] of cases) {
		const { provider, fake } = setup({}, { sandboxes: [seeded(options)] });
		const ref = refOf(fake);
		const attached = await provider.attach({ id: ref.id });
		assert.equal(attached.ok, false, `attach of ${JSON.stringify(options)} was refused`);
		assert.equal(attached.error.code, "refused");
		assert.match(attached.error.message, pattern);
		assert.match(attached.error.message, /left as it is/);
		assert.equal(sandboxOf(fake, ref.id).running, true);
		assert.equal(fake.names().includes("sandbox.terminate"), false, "attach never terminates");
	}
});

test("attach: an id that is not this provider's, or a sandbox that has finished, is not_found", async () => {
	const { provider, fake } = setup({}, { sandboxes: [{ tags: { other: "1" } }, seeded({ running: false })] });
	const [other, finished] = [...fake.sandboxes.keys()];
	assert.equal((await provider.attach({ id: other })).error?.code, "not_found");
	assert.equal((await provider.attach({ id: finished })).error?.code, "not_found");
	assert.equal((await provider.attach({ id: "sb-missing" })).error?.code, "not_found");
	assert.equal((await provider.attach({ id: "../x" })).error?.code, "invalid");
	assert.equal(fake.names().includes("sandbox.exec"), false);
});

test("network: none is read back by the probe from inside; open is open; a change is refused in words", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded(), seeded({ name: "computer-000000000002", spec: { ...SPEC, network: "open" } })] });
	const none = refOf(fake);
	const open = refOf(fake, "computer-000000000002");
	assert.deepEqual(await provider.network(none), { ok: true, value: "none" });
	assert.equal(fake.execRuns.length, 1, "none was probed");
	assert.deepEqual(await provider.network(open), { ok: true, value: "open" });
	assert.equal(fake.execRuns.length, 1, "open needs no probe: nothing is wider");
	assert.deepEqual(await provider.network(none, "none"), { ok: true, value: "none" });
	const wider = await provider.network(none, "open");
	assert.equal(wider.error?.code, "refused");
	assert.match(wider.error.message, /network "none" only.*fixed at create/);
	const allow = await provider.network(none, { allow: ["8.8.8.0/24"] });
	assert.equal(allow.error?.code, "refused");
	assert.match(allow.error.message, /network "none" only/);
	assert.equal(fake.names().includes("sandbox.terminate"), false);
});

test("network: none that reaches an address reads back as another network, in words", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ box: { reached: ["1.1.1.1:443"] } })] });
	const read = await provider.network(refOf(fake));
	assert.equal(read.ok, true);
	assert.match(read.value.other, /1\.1\.1\.1:443/);
	assert.equal((await provider.network(refOf(fake), "none")).error?.code, "refused");
});

test("attach and network: none whose probe targets only accepted reads back none, the accepts named in attach's words", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ box: { accepted: ["1.1.1.1:443", "8.8.8.8:443"] } })] });
	const ref = refOf(fake);
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(attached.value.spec.network, "none");
	assert.deepEqual(attached.value.notes, ["network: none; accepted with no answer (no bytes came back): 1.1.1.1:443, 8.8.8.8:443"]);
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	assert.deepEqual(await provider.network(ref, "none"), { ok: true, value: "none" });
});

test("attach and network: none that answers on one target is refused and reads back another network, whatever the others only accepted", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ box: { reached: ["8.8.8.8:443"], accepted: ["1.1.1.1:443"] } })] });
	const ref = refOf(fake);
	const attached = await provider.attach({ id: ref.id });
	assert.equal(attached.error?.code, "refused");
	assert.match(attached.error.message, /network: declared none, read back an answer from 8\.8\.8\.8:443/);
	const read = await provider.network(ref);
	assert.equal(read.ok, true);
	assert.match(read.value.other, /an answer came back from 8\.8\.8\.8:443/);
});

test("network: a computer that is not this provider's is not_found", async () => {
	const { provider, fake } = setup({}, { sandboxes: [{ tags: { other: "1" } }] });
	const [id] = fake.sandboxes.keys();
	assert.equal((await provider.network({ id, name: "computer-0123456789ab" })).error?.code, "not_found");
	assert.equal((await provider.network({ id, name: "nope" })).error?.code, "invalid");
});

test("release delete terminates, and is idempotent; stop is refused in words, since Modal has no stop that keeps a sandbox", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded()] });
	const ref = refOf(fake);
	const stop = await provider.release(ref, "stop");
	assert.equal(stop.error?.code, "unsupported");
	assert.match(stop.error.message, /terminate/);
	assert.equal(sandboxOf(fake, ref.id).running, true, "stop left the computer running");
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(sandboxOf(fake, ref.id).running, false);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined }, "a second delete");
	assert.deepEqual(await provider.release({ id: "sb-missing", name: ref.name }, "delete"), { ok: true, value: undefined }, "a computer already gone");
	assert.equal((await provider.release({ id: ref.id, name: "x" }, "delete")).error?.code, "invalid");
	assert.equal((await provider.release(ref, "pause")).error?.code, "invalid");
});

test("release never terminates a sandbox that is not this provider's", async () => {
	const { provider, fake } = setup({}, { sandboxes: [{ tags: { other: "1" } }, seeded()] });
	const [other] = fake.sandboxes.keys();
	assert.equal((await provider.release({ id: other, name: "computer-0123456789ab" }, "delete")).error?.code, "not_found");
	const misnamed = refOf(fake);
	assert.equal((await provider.release({ id: misnamed.id, name: "computer-ffffffffffff" }, "delete")).error?.code, "not_found");
	assert.equal(fake.names().includes("sandbox.terminate"), false);
});

test("release: a terminate that fails is an error unless the sandbox has finished", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded(), seeded({ name: "computer-000000000002", running: false })], terminate: "fail" });
	const failed = await provider.release(refOf(fake), "delete");
	assert.deepEqual([failed.error?.code, failed.error?.vendor], ["vendor", "modal"]);
	assert.match(failed.error.message, /terminate failed/);
	assert.deepEqual(await provider.release(refOf(fake, "computer-000000000002"), "delete"), { ok: true, value: undefined });
});

const polls = (fake, id) => fake.calls.filter(([name, of]) => name === "sandbox.poll" && of === id).length;

test("release delete waits, polling, until Modal reads the sandbox finished: a terminate is asynchronous", async () => {
	const { provider, fake } = setup({ timeouts: { releasePollMs: 5 } }, { sandboxes: [seeded()], lingers: { polls: 3 } });
	const ref = refOf(fake);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(sandboxOf(fake, ref.id).running, false, "release returned once the sandbox had finished");
	assert.equal(polls(fake, ref.id), 4, "three polls read null, the fourth an exit code");
	const terminated = fake.names().indexOf("sandbox.terminate");
	assert.ok(terminated >= 0 && fake.names().indexOf("sandbox.poll") > terminated, "the polls come after the terminate");
});

test("release delete that does not see the sandbox finish within releaseMs is a timeout naming what poll read, never done", async () => {
	const { provider, fake } = setup({ timeouts: { releaseMs: 200, releasePollMs: 10 } }, { sandboxes: [{ ...seeded(), stuck: true }] });
	const ref = refOf(fake);
	const started = Date.now();
	const released = await provider.release(ref, "delete");
	assert.equal(released.ok, false);
	assert.equal(released.error.code, "timeout");
	assert.match(released.error.message, /computer-0123456789ab/);
	assert.match(released.error.message, /0\.2 s/);
	assert.match(released.error.message, /poll read null/);
	assert.ok(Date.now() - started < 5_000, "bounded by releaseMs");
	assert.ok(polls(fake, ref.id) >= 3, "it polled again and again within the bound");
});

test("release delete's wait takes the caller's signal, and an abort names what poll last read", async () => {
	const { provider, fake } = setup({ timeouts: { releasePollMs: 10 } }, { sandboxes: [{ ...seeded(), stuck: true }] });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const released = await provider.release(refOf(fake), "delete", { signal: controller.signal });
	assert.equal(released.error?.code, "aborted");
	assert.match(released.error.message, /poll read null/);
});

test("release delete's wait ends when Modal no longer knows the sandbox", async () => {
	const { provider, fake } = setup({ timeouts: { releasePollMs: 10 } }, { sandboxes: [{ ...seeded(), stuck: true }] });
	const ref = refOf(fake);
	setTimeout(() => fake.sandboxes.delete(ref.id), 60);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

test("list leaves out a sandbox Modal still lists after its terminate once poll reads it finished", async () => {
	const { provider, fake } = setup({ timeouts: { releasePollMs: 5 } }, { sandboxes: [seeded(), seeded({ name: "computer-000000000002" })], lingers: { polls: 0, lists: 5 } });
	const gone = refOf(fake);
	assert.deepEqual(await provider.release(gone, "delete"), { ok: true, value: undefined });
	const listed = await provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(listed.value.map((info) => info.ref.name), ["computer-000000000002"]);
	const raw = [];
	for await (const one of fake.sdk.sandboxes.list({ appId: `ap-${APP}`, tags: {} })) raw.push(one.sandboxId);
	assert.ok(raw.includes(gone.id), "Modal's own listing still yields the finished sandbox");
});

test("list leaves out a sandbox whose poll finds it gone, and fails in words on a poll that fails otherwise", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded(), seeded({ name: "computer-000000000002" })] });
	const first = refOf(fake);
	const list = fake.sdk.sandboxes.list;
	fake.sdk.sandboxes.list = (params) =>
		(async function* () {
			for await (const one of list(params)) {
				yield one.sandboxId === first.id ? { ...one, poll: async () => Promise.reject(Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" })) } : one;
			}
		})();
	const listed = await provider.list({});
	assert.deepEqual(listed.value?.map((info) => info.ref.name), ["computer-000000000002"]);
	fake.sdk.sandboxes.list = (params) =>
		(async function* () {
			for await (const one of list(params)) yield { ...one, poll: async () => Promise.reject(new Error("the server is unavailable")) };
		})();
	const failed = await provider.list({});
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /poll/);
	assert.match(failed.error.message, /the server is unavailable/);
});

test("the live Modal suite gives cleanup more than release's 120 s wait", () => {
	const live = readFileSync(new URL("./modal/conformance.modal.test.mjs", import.meta.url), "utf8");
	assert.match(live, /cleanupTimeoutMs: 150_000/);
});

test("every SDK call is bounded: a getTags that never answers is a timeout", async () => {
	const { provider, fake } = setup({ timeouts: { callMs: 40 } }, { sandboxes: [seeded()] });
	const ref = refOf(fake);
	const fromId = fake.sdk.sandboxes.fromId;
	fake.sdk.sandboxes.fromId = async (id) => ({ ...(await fromId(id)), getTags: () => new Promise(() => {}) });
	for (const call of [() => provider.connect(ref), () => provider.attach({ id: ref.id }), () => provider.network(ref), () => provider.release(ref, "delete")]) {
		const result = await call();
		assert.equal(result.error?.code, "timeout");
		assert.match(result.error.message, /getTags/);
	}
	const hung = deferred();
	fake.sdk.apps.fromName = () => hung.promise;
	assert.equal((await provider.create(SPEC)).error?.code, "timeout");
	assert.equal((await provider.list({})).error?.code, "timeout");
});

test("the janitor does not sweep Modal computers: Modal ends them at their lifetime", async () => {
	const { provider, fake } = setup();
	const swept = await sweep(provider);
	assert.equal(swept.error?.code, "refused");
	assert.deepEqual(fake.calls, []);
});

test("no real Modal client: the provider and the conformance module import nothing from the SDK at load", async () => {
	for (const file of ["../dist/modal.js", "../dist/conformance/modal.js"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /^import[^\n]*["']modal["']/m, `${file} has no static import of modal`);
	}
	const module = await import("../dist/conformance/modal.js");
	assert.equal(typeof module.createProvider, "function");
	assert.equal(typeof module.createDriftedProvider, "function");
	assert.deepEqual(module.MODAL_ENV, {
		live: "AGENTRUN_COMPUTER_LIVE_MODAL",
		tokenId: "COMPUTER_MODAL_TOKEN_ID",
		tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
		app: "COMPUTER_MODAL_APP",
		daemonImage: "COMPUTER_MODAL_DAEMON_IMAGE",
		serverUrl: "COMPUTER_MODAL_SERVER_URL",
	});
	assert.deepEqual(Object.values(module.ARCHIL_ENV), ["COMPUTER_ARCHIL_DISK", "COMPUTER_ARCHIL_REGION", "COMPUTER_ARCHIL_TOKEN", "COMPUTER_ARCHIL_API_KEY", "COMPUTER_ARCHIL_S3_URL"], "the mount cases' disk is named apart from the provider's settings");
	assert.equal(module.CONFORMANCE_MAX_LIFETIME_MS, 30 * 60_000);
});

/** The names a host may hold a production token under, with values that must never be used. */
const PROD_TOKEN = { MODAL_TOKEN_ID: "prod-id-must-not-be-used", MODAL_TOKEN_SECRET: "prod-token-must-not-be-used" };
const DEV_TOKEN = { COMPUTER_MODAL_TOKEN_ID: "fake-dev-id", COMPUTER_MODAL_TOKEN_SECRET: "fake-dev-secret" };
const MODAL_SETTINGS = {
	AGENTRUN_COMPUTER_LIVE_MODAL: "1",
	COMPUTER_MODAL_APP: APP,
};
/** The module's options a unit test adds: the stand-in daemon, and a drifted build that runs no Go. */
const builds = [];
const MODULE_TEST = {
	daemonPath: BINARY_PATH,
	buildDaemon: async (version) => {
		builds.push(version);
		return BINARY_PATH;
	},
};

/**
 * A stand-in for the SDK's ModalClient constructor: it records the params it is given, and the MODAL_SERVER_URL its
 * getProfile would read at that moment (it beats a profile's server_url: modal-client@64880502:js/src/config.ts:140-143),
 * and answers with the fake slice.
 */
function fakeClient() {
	const made = [];
	const servers = [];
	function ModalClient(params) {
		made.push(params);
		servers.push(process.env.MODAL_SERVER_URL);
		return fakeModal().sdk;
	}
	return { ModalClient, made, servers };
}

/** Runs fn with these names set in process.env, where the SDK reads them, and puts back what was there. */
async function withProcessEnv(values, fn) {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("the conformance module refuses MODAL_TOKEN_ID and MODAL_TOKEN_SECRET: it names the COMPUTER_MODAL_ token it needs", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN }, ModalClient, ...MODULE_TEST }), (error) => {
			assert.match(error.message, /needs COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/);
			assert.match(error.message, /never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET/);
			assert.doesNotMatch(error.message, /prod-(id|token)-must-not-be-used/);
			return true;
		});
		assert.deepEqual(made, [], "no client is made without the COMPUTER_MODAL_ token");
	}
});

test("the conformance module passes the COMPUTER_MODAL_ token to the client explicitly, so an ambient MODAL_TOKEN_ cannot win", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		const provider = await make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN, ...DEV_TOKEN }, ModalClient, ...MODULE_TEST });
		assert.equal(provider.id, "modal");
		assert.deepEqual(made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }]);
		assert.doesNotMatch(JSON.stringify(made), /prod-(id|token)-must-not-be-used/);
	}
});

test("the live Modal suite skips when only MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are set", () => {
	const live = new URL("./modal/conformance.modal.test.mjs", import.meta.url).pathname;
	const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", live], {
		env: { PATH: process.env.PATH, AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...PROD_TOKEN },
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /# SKIP .*COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/);
	assert.match(run.stdout, /^# fail 0$/m);
	assert.match(run.stdout, /^# pass 0$/m);
});

test("the conformance module pins the client's server: an ambient MODAL_PROFILE or MODAL_CONFIG_PATH cannot redirect the key", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	const dir = mkdtempSync(join(tmpdir(), "modal-profile-"));
	const toml = join(dir, "modal.toml");
	writeFileSync(toml, '[prod]\nactive = true\nserver_url = "https://prod.example.invalid:443"\ntoken_id = "prod-id-must-not-be-used"\n');
	try {
		await withProcessEnv({ MODAL_PROFILE: "prod", MODAL_CONFIG_PATH: toml }, async () => {
			for (const make of [createProvider, createDriftedProvider]) {
				for (const [chosen, server] of [
					[{}, "https://api.modal.com:443"],
					[{ COMPUTER_MODAL_SERVER_URL: "https://dev.example.invalid:443" }, "https://dev.example.invalid:443"],
				]) {
					const { ModalClient, made, servers } = fakeClient();
					await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN, MODAL_PROFILE: "prod", MODAL_CONFIG_PATH: toml, ...chosen }, ModalClient, ...MODULE_TEST });
					assert.deepEqual(made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }]);
					assert.deepEqual(servers, [server], "the client is made with the server the module chose");
					assert.equal(process.env.MODAL_SERVER_URL, undefined, "and process.env is put back after");
				}
			}
		});
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("the conformance module refuses an ambient MODAL_SERVER_URL in words, before any client", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		const env = { ...MODAL_SETTINGS, ...DEV_TOKEN, MODAL_SERVER_URL: "https://prod.example.invalid:443" };
		await assert.rejects(make({ env, ModalClient, ...MODULE_TEST }), (error) => {
			assert.match(error.message, /MODAL_SERVER_URL is set/);
			assert.match(error.message, /COMPUTER_MODAL_SERVER_URL/);
			return true;
		});
		assert.deepEqual(made, [], "no client is made while MODAL_SERVER_URL is set");
	}
});

/** A Modal token passed as options, as serve passes its own MODAL_TOKEN_ID and MODAL_TOKEN_SECRET. */
const TOKEN_OPTIONS = { tokenId: "fake-test-key", tokenSecret: "fake-test-key" };

test("the provider's create() reads no environment: the token, the app and the server are options, and it keeps Modal's 24-hour cap", async () => {
	const modalModule = await import("../dist/modal.js");
	assert.equal(modalModule.ENV, undefined, "no ENV of names");
	assert.equal(modalModule.fromEnv, undefined, "no fromEnv");
	assert.equal(modalModule.modalServerUrl, undefined, "no reader of COMPUTER_MODAL_SERVER_URL");
	const conformance = await import("../dist/conformance/modal.js");
	const env = { ...DEV_TOKEN, COMPUTER_MODAL_APP: APP };
	const refused = fakeClient();
	await assert.rejects(conformance.createProvider({ env, ModalClient: refused.ModalClient, ...MODULE_TEST }), /set AGENTRUN_COMPUTER_LIVE_MODAL=1/);
	assert.deepEqual(refused.made, [], "the conformance module makes no client without its live switch");
	await withProcessEnv({ ...PROD_TOKEN, ...DEV_TOKEN, COMPUTER_MODAL_APP: "elsewhere", AGENTRUN_BOX_APP: "elsewhere", COMPUTER_MODAL_SERVER_URL: "https://prod.example.invalid:443" }, async () => {
		const { ModalClient, made, servers } = fakeClient();
		const provider = await modalModule.create({ ...TOKEN_OPTIONS, app: APP, ModalClient, daemonPath: BINARY_PATH });
		assert.equal(provider.id, "modal");
		assert.equal(provider.capabilities().maxLifetimeMs, DAY_MS);
		assert.deepEqual(made, [TOKEN_OPTIONS], "the token passed in, never one of the environment");
		assert.deepEqual(servers, ["https://api.modal.com:443"], "the SDK's default server, not COMPUTER_MODAL_SERVER_URL");
		const chosen = fakeClient();
		await modalModule.create({ ...TOKEN_OPTIONS, app: APP, serverUrl: "https://dev.example.invalid:443", ModalClient: chosen.ModalClient, daemonPath: BINARY_PATH });
		assert.deepEqual(chosen.servers, ["https://dev.example.invalid:443"], "options.serverUrl is the server");
	});
});

test("the conformance module reads COMPUTER_MODAL_APP and passes it as options.app, and refuses without it in words naming it", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const fake = fakeModal();
		await withProcessEnv({ AGENTRUN_BOX_APP: "elsewhere" }, async () => {
			const provider = await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: clientOf(fake), ...MODULE_TEST });
			assert.equal((await provider.list({})).ok, true);
		});
		assert.deepEqual(fake.calls.find(([name]) => name === "apps.fromName").slice(0, 2), ["apps.fromName", APP]);
		const { ModalClient, made } = fakeClient();
		await assert.rejects(make({ env: { AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...DEV_TOKEN }, ModalClient, ...MODULE_TEST }), /COMPUTER_MODAL_APP/);
		assert.deepEqual(made, []);
	}
});

test("the provider's create() given both daemonImage and daemonPath takes the image: the daemon is copied from it, and nothing is uploaded", async () => {
	const modalModule = await import("../dist/modal.js");
	const fake = fakeModal();
	const provider = await modalModule.create({ ...TOKEN_OPTIONS, app: APP, daemonImage: DAEMON_IMAGE, daemonPath: BINARY_PATH, ModalClient: clientOf(fake) });
	assert.equal(provider.id, "modal");
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.deepEqual(fake.calls.find(([name]) => name === "image.dockerfileCommands")[1][0], `COPY --from=${DAEMON_IMAGE} /computerd ${DAEMON}`);
	assert.deepEqual(fake.uploads, [], "no upload: the image wins");
});

test("the provider's create() refuses without options.app in words naming the option, before any client: COMPUTER_MODAL_APP or AGENTRUN_BOX_APP in the environment is never read", async () => {
	const modalModule = await import("../dist/modal.js");
	await withProcessEnv({ COMPUTER_MODAL_APP: APP, AGENTRUN_BOX_APP: APP }, async () => {
		for (const app of [undefined, ""]) {
			const { ModalClient, made } = fakeClient();
			await assert.rejects(modalModule.create({ ...TOKEN_OPTIONS, ...(app === undefined ? {} : { app }), ModalClient, daemonPath: BINARY_PATH }), (error) => {
				assert.match(error.message, /options\.app/);
				assert.doesNotMatch(error.message, /COMPUTER_MODAL_APP|AGENTRUN_BOX_APP/);
				return true;
			});
			assert.deepEqual(made, [], "no client is made without the app");
		}
	});
	await withProcessEnv({ ...PROD_TOKEN, ...DEV_TOKEN }, async () => {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(modalModule.create({ app: APP, ModalClient, daemonPath: BINARY_PATH }), (error) => {
			assert.match(error.message, /options\.tokenId and options\.tokenSecret/);
			assert.doesNotMatch(error.message, /prod-(id|token)-must-not-be-used|fake-dev-(id|secret)/);
			return true;
		});
		assert.deepEqual(made, []);
	});
});

test("the provider refuses an ambient MODAL_SERVER_URL in process.env, the one variable it reads, and makes no client", async () => {
	const modalModule = await import("../dist/modal.js");
	await withProcessEnv({ MODAL_SERVER_URL: "https://prod.example.invalid:443" }, async () => {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(modalModule.create({ ...TOKEN_OPTIONS, app: APP, ModalClient, daemonPath: BINARY_PATH }), (error) => {
			assert.match(error.message, /MODAL_SERVER_URL is set/);
			assert.match(error.message, /options\.serverUrl/);
			return true;
		});
		assert.deepEqual(made, []);
		assert.equal(process.env.MODAL_SERVER_URL, "https://prod.example.invalid:443", "and leaves it as it was");
	});
});

test("client constructions run one at a time: each sees only its own MODAL_SERVER_URL, and process.env is put back after each, a failed one too", async () => {
	const { modalClient } = await import("../dist/modal.js");
	const servers = ["https://one.example.invalid:443", "https://two.example.invalid:443", "https://three.example.invalid:443"];
	const seen = [];
	let inside = 0;
	function ModalClient(params) {
		inside += 1;
		seen.push({ server: process.env.MODAL_SERVER_URL, inside, tokenId: params.tokenId });
		inside -= 1;
		if (process.env.MODAL_SERVER_URL === servers[1]) throw new Error("the SDK failed");
		return fakeModal().sdk;
	}
	const before = process.env.MODAL_SERVER_URL;
	await withProcessEnv({ MODAL_SERVER_URL: "" }, async () => {
		const made = servers.map((serverUrl) => modalClient({ ...TOKEN_OPTIONS, serverUrl, ModalClient }));
		assert.equal(process.env.MODAL_SERVER_URL, "", "nothing is set before a construction's turn");
		const settled = await Promise.allSettled(made);
		assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "rejected", "fulfilled"]);
		assert.match(settled[1].reason.message, /the SDK failed/);
		assert.deepEqual(seen.map((s) => s.server), servers, "each construction saw its own server, in turn");
		assert.ok(seen.every((s) => s.inside === 1), "never two at once");
		assert.equal(process.env.MODAL_SERVER_URL, "", "the empty value it held is put back");
	});
	assert.equal(process.env.MODAL_SERVER_URL, before);
	const after = await modalClient({ ...TOKEN_OPTIONS, ModalClient });
	assert.ok(after, "a failed construction leaves the turn free for the next");
	assert.equal(seen.at(-1).server, "https://api.modal.com:443");
	assert.equal(process.env.MODAL_SERVER_URL, before, "and unset again after it");
});

test("the CLI resolves --provider modal through the registry to the conformance module, which refuses without its live switch", async () => {
	const { main } = await import("../dist/conformance/cli.js");
	let err = "";
	const stderr = { write: (text, done) => ((err += text), done?.(), true) };
	const before = process.env.AGENTRUN_COMPUTER_LIVE_MODAL;
	delete process.env.AGENTRUN_COMPUTER_LIVE_MODAL;
	try {
		assert.equal(await main(["--provider", "modal"], { stdout: stderr, stderr }), 1, err);
	} finally {
		if (before !== undefined) process.env.AGENTRUN_COMPUTER_LIVE_MODAL = before;
	}
	assert.match(err, /set AGENTRUN_COMPUTER_LIVE_MODAL=1/);
});

/** A ModalClient stand-in that answers with one given fake. */
const clientOf = (fake) =>
	function ModalClient() {
		return fake.sdk;
	};

test("the conformance module uploads the daemon when COMPUTER_MODAL_DAEMON_IMAGE is unset, and copies it from the image when set", async () => {
	const { createProvider } = await import("../dist/conformance/modal.js");
	const uploading = fakeModal();
	const provider = await createProvider({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: clientOf(uploading), daemonPath: BINARY_PATH });
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.deepEqual(createdParams(uploading).command.slice(0, 2), ["sh", "-c"]);
	assert.ok(createdParams(uploading).command[2].startsWith(ENTRYPOINT_MARK));
	assert.equal(uploading.uploads.length, 1);
	assert.ok(uploading.uploads[0].bytes.equals(BINARY));
	assert.doesNotMatch(JSON.stringify(uploading.calls), /COPY/);

	const copying = fakeModal();
	const imaged = await createProvider({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN, COMPUTER_MODAL_DAEMON_IMAGE: DAEMON_IMAGE }, ModalClient: clientOf(copying), daemonPath: BINARY_PATH });
	assert.equal((await imaged.create(SPEC)).ok, true);
	assert.deepEqual(copying.calls.find(([name]) => name === "image.dockerfileCommands")[1][0], `COPY --from=${DAEMON_IMAGE} /computerd ${DAEMON}`);
	assert.deepEqual(copying.uploads, []);
});

test("the conformance module caps every computer's lifetime at 30 minutes, refused longer in words, Modal's timeout the lifetime", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const fake = fakeModal();
		const provider = await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: clientOf(fake), ...MODULE_TEST });
		assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 }), []);
		const refusals = provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 + 1000 });
		assert.deepEqual(refusals.map((r) => r.field), ["lifetimeMs"]);
		assert.match(refusals[0].message, /at most 30 min \(1800000 ms\)/);
		const refused = await provider.create({ ...SPEC, lifetimeMs: 2 * 60 * 60_000 });
		assert.equal(refused.error?.code, "refused");
		assert.deepEqual(fake.calls, []);
		assert.equal((await provider.create({ ...SPEC, lifetimeMs: 30 * 60_000 })).ok, true);
		assert.equal(createdParams(fake).timeoutMs, 30 * 60_000);
	}
});

test("the drifted provider uploads a daemon built as <version>-drift, and needs no second image", async () => {
	const { createDriftedProvider } = await import("../dist/conformance/modal.js");
	const fake = fakeModal();
	builds.length = 0;
	const drifted = await createDriftedProvider({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: clientOf(fake), ...MODULE_TEST });
	assert.deepEqual(builds, [`${VERSION}-drift`]);
	assert.equal((await drifted.create(SPEC)).ok, true);
	assert.equal(fake.uploads.length, 1, "the drifted daemon is uploaded like any other");
	assert.doesNotMatch(JSON.stringify(fake.calls), /COPY/);
});

// The loopback block: whatever Modal runs inside a sandbox, the daemon's programs get a network of their own (init
// --own-network) and run as 2510:2510. No listener of Modal's inside is documented, so no port is declared.

test("the loopback block: network none only, no agent port declared, open refused in words", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.capabilities().network, ["none"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, []);
	const refusals = provider.check({ ...SPEC, network: "open" });
	assert.deepEqual(refusals.map((r) => r.field), ["network"]);
	assert.match(refusals[0].message, /network "none" only: its programs run in a network of their own/);
	assert.deepEqual(fake.calls, []);
});

test("the loopback block: init starts with --own-network as 2510:2510 by default, on both routes", async () => {
	// The upload route gets the test's own stand-in binary: a unit run has no built daemon in dist/.
	for (const options of [{}, { daemonImage: undefined, daemonPath: BINARY_PATH }]) {
		const { provider, fake } = setup(options);
		const made = await provider.create(SPEC);
		assert.equal(made.ok, true, JSON.stringify(made));
		const command = createdParams(fake).command;
		assert.deepEqual(command.slice(-3), ["--user", "2510:2510", "--own-network"], JSON.stringify(options));
	}
});

test("the loopback block: a kernel's fallback tunnels, down and addressless, are no drift; one the computer's user could raise is", async () => {
	// The Modal live run: Modal's VM kernel gives the programs' namespace tunl0, gre0, sit0 and the rest, down.
	const quiet = setup({}, { box: { interfaces: ["lo"], quiet: ["tunl0", "gre0", "sit0"] } });
	const made = await quiet.provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const raised = setup({}, { box: { interfaces: ["lo"], quiet: ["tunl0"], raised: ["tunl0"] } });
	const refused = await raised.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /brought up tunl0/);
});

test("the loopback block: a daemon whose programs see more than their loopback is refused and terminated", async () => {
	const { provider, fake } = setup({}, { box: { interfaces: ["lo", "eth0"] } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /daemon network: declared its own \(lo alone\), read back lo, eth0/);
	assert.equal(only(fake).terminated, 1);
});
