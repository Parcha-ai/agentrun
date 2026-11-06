// ModalProvider against a fake of the Modal SDK slice it takes (test/fake-modal.mjs): every call is recorded and
// answered as the SDK documents. No Modal client is constructed, no token is read and nothing reaches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ModalProvider, sweep } from "../dist/index.js";
import { DAEMON, DAEMON_IMAGE, deferred, fakeModal, GVISOR_KERNEL, HELLO, VERSION } from "./fake-modal.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const APP = "computers";
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DEADLINE = "agentrun.computer.deadline";
const SPEC_TAG = "agentrun.computer.spec";
const PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443"];
const LAYER = [`COPY --from=${DAEMON_IMAGE} /computerd ${DAEMON}`, "ENV HOME=/work", "WORKDIR /work"];
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
const tagsFor = (spec, name, deadline, user = "1000:1000") => ({
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
const seeded = ({ spec = SPEC, name = "computer-0123456789ab", deadline = new Date(Date.now() + 600_000).toISOString(), user = "1000:1000", tags = {}, box = {}, running = true } = {}) => ({
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
	assert.throws(make({ timeouts: { createMs: 0 } }), /createMs/);
	assert.throws(() => new ModalProvider({ sdk: {}, app: APP, daemonImage: DAEMON_IMAGE }), /sdk/);
	assert.deepEqual(fake.calls, [], "no SDK call");
});

test("capabilities: a VM whose lifetime Modal enforces, network none or open with no read-back, a daemon with exec, files and processes", () => {
	const { provider, fake } = setup();
	assert.equal(provider.id, "modal");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		lifetime: "vendor",
		network: ["none", "open"],
		networkReadBack: false,
		isolation: "vm",
		os: "linux",
		daemon: ["exec", "files", "processes"],
		user: ["root", "uid"],
		release: ["delete"],
	});
	assert.deepEqual(fake.calls, []);
});

test("check() takes a spec it can make, with no SDK call", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, network: "open", cpus: 0.5, memoryMb: 512, labels: { team: "a", run: "r1" }, workdir: "/opt/app", user: "0" }), []);
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
	assert.deepEqual(refused({ ...SPEC, lifetimeMs: DAY_MS + 1 }), ["lifetimeMs"]);
	assert.match(words({ ...SPEC, lifetimeMs: DAY_MS + 1 }, "lifetimeMs"), /24 hours/);
	assert.deepEqual(refused({ ...SPEC, network: { allow: ["8.8.8.0/24"] } }), ["network"]);
	assert.match(words({ ...SPEC, network: { allow: ["8.8.8.0/24"] } }, "network"), /cannot be read back/);
	assert.match(words({ ...SPEC, network: { allow: ["8.8.8.0/24"] } }, "network"), /bypass/);
	assert.match(words({ ...SPEC, network: { allow: ["example.com"] } }, "network"), /443/);
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
		command: [DAEMON, "init", "--deadline", deadline, "--user", "1000:1000"],
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

test("create: open is no network field at all; sizes, user and workdir map onto Modal's fields", async () => {
	const { provider, fake } = setup({ user: "2000:3000" });
	const created = await provider.create({ ...SPEC, network: "open", cpus: 4, memoryMb: 100, workdir: "/opt/app", lifetimeMs: 1500 });
	assert.equal(created.ok, true, JSON.stringify(created));
	const params = createdParams(fake);
	for (const key of ["blockNetwork", "outboundCidrAllowlist", "outboundDomainAllowlist"]) assert.equal(key in params, false, `${key} is not passed for open`);
	assert.equal(params.timeoutMs, 2000, "Modal takes whole seconds: the lifetime rounds up");
	assert.deepEqual([params.cpu, params.cpuLimit, params.memoryMiB, params.memoryLimitMiB], [0.125, 2, 100, 100]);
	assert.equal(params.workdir, "/opt/app");
	assert.deepEqual(params.command.slice(-2), ["--user", "2000:3000"]);
	assert.deepEqual(fake.calls.find(([name]) => name === "image.dockerfileCommands")[1].at(-1), "WORKDIR /opt/app");
});

test("create: spec.user is the daemon's --user, root included", async () => {
	for (const [user, expected] of [["0", "0:0"], ["65534", "65534:65534"], ["70:80", "70:80"]]) {
		const { provider, fake } = setup();
		const created = await provider.create({ ...SPEC, user });
		assert.equal(created.ok, true, `${user}: ${JSON.stringify(created)}`);
		assert.deepEqual(createdParams(fake).command.slice(-2), ["--user", expected]);
		assert.equal(JSON.parse(createdParams(fake).tags[SPEC_TAG]).user, expected);
	}
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
	await driftedCreate({ box: { hello: { ...HELLO, capabilities: ["exec", "files"] } } }, /processes/);
});

test("create: a sandbox whose kernel is gVisor's is refused as another runtime", async () => {
	assert.equal((await driftedCreate({ box: { kernel: GVISOR_KERNEL } }, /runtime: .*gVisor/)).code, "refused");
});

test("create: a daemon whose programs run as another user is refused", async () => {
	await driftedCreate({ box: { uid: 0, gid: 0 } }, /user: declared 1000:1000, read back 0:0/);
});

test("create: network none that reaches an address is refused, and open never is for reaching one", async () => {
	await driftedCreate({ box: { reached: ["1.1.1.1:443"] } }, /network: .*1\.1\.1\.1:443/);
	const { provider } = setup({}, { box: { reached: ["1.1.1.1:443"] } });
	assert.equal((await provider.create({ ...SPEC, network: "open" })).ok, true);
});

test("create: tags that do not read back as given are drift", async () => {
	await driftedCreate({ tags: { [DEADLINE]: undefined } }, /tag agentrun\.computer\.deadline/);
	await driftedCreate({ tags: { [SPEC_TAG]: "{}" } }, /tag agentrun\.computer\.spec/);
	await driftedCreate({ tags: { extra: "1" } }, /tag extra/);
});

test("create: a sandbox that is not running after create, or has no daemon, is refused", async () => {
	await driftedCreate({ running: false }, /finished/);
	await driftedCreate({ box: { daemon: false } }, /no daemon listens/);
	await driftedCreate({ box: { probe: "fails" } }, /probe/);
	await driftedCreate({ box: { probe: "garbled" } }, /probe/);
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
		spec: { image: SPEC.image, user: "1000:1000", network: "none", cpus: 1, memoryMb: 2048, workdir: "/opt/app", deadline: new Date(deadline) },
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
	assert.match(wider.error.message, /fixed at create/);
	const allow = await provider.network(none, { allow: ["8.8.8.0/24"] });
	assert.equal(allow.error?.code, "refused");
	assert.match(allow.error.message, /cannot be read back/);
	assert.equal(fake.names().includes("sandbox.terminate"), false);
});

test("network: none that reaches an address reads back as another network, in words", async () => {
	const { provider, fake } = setup({}, { sandboxes: [seeded({ box: { reached: ["1.1.1.1:443"] } })] });
	const read = await provider.network(refOf(fake));
	assert.equal(read.ok, true);
	assert.match(read.value.other, /1\.1\.1\.1:443/);
	assert.equal((await provider.network(refOf(fake), "none")).error?.code, "refused");
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
	assert.equal(failed.error?.code, "modal");
	assert.match(failed.error.message, /terminate failed/);
	assert.deepEqual(await provider.release(refOf(fake, "computer-000000000002"), "delete"), { ok: true, value: undefined });
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
		driftedDaemonImage: "COMPUTER_MODAL_DRIFTED_DAEMON_IMAGE",
	});
});

/** The names a host running the Grep platform may hold a production token under, with values that must never be used. */
const PROD_TOKEN = { MODAL_TOKEN_ID: "prod-id-must-not-be-used", MODAL_TOKEN_SECRET: "prod-token-must-not-be-used" };
const DEV_TOKEN = { COMPUTER_MODAL_TOKEN_ID: "fake-dev-id", COMPUTER_MODAL_TOKEN_SECRET: "fake-dev-secret" };
const MODAL_SETTINGS = {
	AGENTRUN_COMPUTER_LIVE_MODAL: "1",
	COMPUTER_MODAL_APP: APP,
	COMPUTER_MODAL_DAEMON_IMAGE: DAEMON_IMAGE,
	COMPUTER_MODAL_DRIFTED_DAEMON_IMAGE: DAEMON_IMAGE,
};

/** A stand-in for the SDK's ModalClient constructor: it records the params it is given and answers with the fake slice. */
function fakeClient() {
	const made = [];
	function ModalClient(params) {
		made.push(params);
		return fakeModal().sdk;
	}
	return { ModalClient, made };
}

test("the conformance module refuses MODAL_TOKEN_ID and MODAL_TOKEN_SECRET: it names the COMPUTER_MODAL_ token it needs", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN }, ModalClient }), (error) => {
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
		const provider = await make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN, ...DEV_TOKEN }, ModalClient });
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
