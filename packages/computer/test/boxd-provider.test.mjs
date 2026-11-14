// BoxdProvider's own half: what boxd's host hands the SDK and how it reads boxd's answers back, call by call, against a
// recorder of the SDK slice (@boxd-sh/sdk@0.3.1) that answers what a test gives it. The adapter's lifecycle (the daemon,
// the bridge, the probe, idempotent create, late-create cleanup, extend, release) is tested once, against its one fake
// host (hosted-provider.test.mjs); boxd's own is proven live (test/boxd). No SDK is loaded and nothing reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { BOXD, kindRefusals } from "../dist/index.js";
import { providerFor } from "../dist/providers.js";

const { BoxdProvider, create, CAPABILITIES, MOUNT } = await import("../dist/boxd.js");
const { BOXD_ENV, settingsFromEnv, conformanceImage, createProvider, createHost, sweepScope } = await import("../dist/conformance/boxd.js");

const KEY = "bxd_fake_computer_key_0123456789";
const NAME = "agentrun.computer.name";
const IMAGE_LABEL = "agentrun.computer.image";
const MAX_LABEL = "agentrun.computer.max-deadline";
const SPEC = { image: "default", lifetimeMs: 600_000, network: "none" };
const LINUX_GROUPS = ["exec", "files", "processes"];
const DESKTOP_GROUPS = [...LINUX_GROUPS, "screen", "input.pointer", "input.keys", "apps"];
const TIMEOUTS = { requestMs: 2_000, createMs: 3_000 };
const HOUR = 3_600_000;

const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

/** A machine as boxd reads one that create made as asked: running, isolated, egress closed, no idle timer. */
function machine(patch = {}) {
	const max = new Date(Date.now() + HOUR).toISOString();
	return {
		id: "m-1",
		name: "computer-0123456789ab",
		status: "running",
		labels: { [NAME]: "computer-0123456789ab", [MAX_LABEL]: max },
		egressAllow: ["none"],
		idle: { suspendAfter: 0, hibernateAfter: 0, destroyAfter: 0 },
		resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3 },
		networking: { isolated: true },
		org: { id: "org-1", name: "acme" },
		deleteAt: null,
		source: null,
		...patch,
	};
}

/** The SDK slice as a recorder: each call records its name and arguments and answers what answers[name] gives. */
function recorder(answers = {}) {
	const calls = [];
	const clients = [];
	const call = (name) => async (...args) => {
		calls.push([name, ...args]);
		const answer = answers[name];
		return typeof answer === "function" ? answer(...args) : answer;
	};
	const machines = {
		...Object.fromEntries(["create", "get", "list", "delete", "waitUntilReady", "setEgressAllow", "setAutoHibernateTimeout", "updateLabels"].map((name) => [name, call(name)])),
		streamExec: (...args) => {
			calls.push(["streamExec", ...args]);
			return answers.streamExec();
		},
		files: { upload: call("files.upload") },
	};
	const Boxd = class {
		constructor(options) {
			clients.push(options);
			this.machines = machines;
		}
	};
	return { calls, clients, Boxd };
}

function setup(options = {}, answers = {}) {
	const rec = recorder(answers);
	const provider = new BoxdProvider({ apiKey: KEY, Boxd: rec.Boxd, org: "acme", timeouts: TIMEOUTS, ...options });
	return { rec, provider, host: provider.host };
}
const ctx = { timeoutMs: 1_234 };
const request = (labels = {}) => ({ name: "computer-0123456789ab", image: "default", labels: { [NAME]: "computer-0123456789ab", [MAX_LABEL]: new Date(Date.now() + HOUR).toISOString(), ...labels }, network: "none" });

test("the SDK gets the key, the address and the region explicitly; create has its own client, bounded by createMs and never retried", () => {
	const { rec } = setup({ region: "nyc" });
	assert.deepEqual(rec.clients, [
		{ apiKey: KEY, baseURL: "https://boxd.sh:9443", region: "nyc", timeout: TIMEOUTS.requestMs },
		{ apiKey: KEY, baseURL: "https://boxd.sh:9443", region: "nyc", timeout: TIMEOUTS.createMs, maxRetries: 0 },
	]);
	const bare = recorder();
	new BoxdProvider({ apiKey: KEY, Boxd: bare.Boxd });
	assert.deepEqual(bare.clients.map(({ region, timeout }) => [region, timeout]), [["", 30_000], ["", 120_000]], "no region is the home region, never left for the SDK to read");
});

test("create() needs the key, refuses in words without it, and never echoes one", async () => {
	await assert.rejects(create({}), /options\.apiKey, the boxd API key, is required/);
	await assert.rejects(providerFor("boxd", {}), (error) => {
		assert.doesNotMatch(error.message, /BOXD_API_KEY=|bxd_/);
		return true;
	});
	const provider = await create({ apiKey: KEY, Boxd: recorder().Boxd });
	assert.equal(provider.id, "boxd");
});

test("the constructor refuses a size that is not boxd's and the machine user's uid as the daemon's, in words", () => {
	const make = (options) => () => new BoxdProvider({ apiKey: KEY, Boxd: recorder().Boxd, ...options });
	assert.throws(make({ vcpu: 2 }), /not one of boxd's sizes/);
	assert.throws(make({ vcpu: 2, memory: "16G" }), /not one of boxd's sizes/);
	assert.doesNotThrow(make({ vcpu: 4, memory: "16G" }));
	assert.throws(make({ daemonUser: "1000:1000" }), /machine's own user/);
	assert.throws(make({ maxLifetimeMs: 31 * 24 * HOUR }), /the longest boxd keeps a computer/);
});

test("capabilities: a child daemon in a microVM, network none read back, janitor lifetime, delete only, boxd's agent port; desktop too", () => {
	const caps = setup().provider.capabilities();
	assert.deepEqual(
		{ ...caps },
		{ kind: "linux", lifetime: "janitor", network: ["none"], networkReadBack: true, isolation: "microvm", os: "linux", daemon: "child", groups: LINUX_GROUPS, maxLifetimeMs: 24 * HOUR, release: ["delete"], mount: [], vendorAgentPorts: [57073] },
	);
	assert.deepEqual(kindRefusals(caps), []);
	assert.deepEqual(setup({ kind: "desktop" }).provider.capabilities().groups, DESKTOP_GROUPS);
	assert.deepEqual(MOUNT, []);
	assert.deepEqual(CAPABILITIES, BOXD.capabilities);
	assert.deepEqual(BOXD.capabilities.map(({ kind, options }) => [kind, options.kind]), [["linux", "linux"], ["desktop", "desktop"]]);
});

test("check takes default or a snapshot's name, refuses a snapshot with a size and a label name boxd does not take, with no call", () => {
	const { rec, provider } = setup();
	const fields = (spec, p = provider) => p.check(spec).map(({ field }) => field);
	assert.deepEqual(fields(SPEC), []);
	assert.deepEqual(fields({ ...SPEC, image: "my-snapshot" }), []);
	assert.deepEqual(fields({ ...SPEC, image: "no spaces" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, image: "my-snapshot" }, setup({ vcpu: 2, memory: "8G" }).provider), ["image"]);
	assert.deepEqual(fields({ ...SPEC, labels: { "boxd/owner": "x" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { Team: "x" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(rec.calls, []);
});

test("create asks for an isolated machine in the org with no standby, the size, the snapshot, and with deleteTimer a delete 5 minutes past the most it may live", async () => {
	const { rec, host } = setup({ vcpu: 2, memory: "8G", deleteTimer: true }, { create: machine() });
	const req = request();
	assert.deepEqual(await host.create({ ...req, image: "my-snapshot" }, ctx), { ok: true, value: { id: "m-1" } });
	const [[name, params]] = rec.calls;
	assert.equal(name, "create");
	const { deleteAfter, ...rest } = params;
	assert.deepEqual(rest, { name: req.name, org: "acme", labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0, vcpu: 2, memory: "8G" }, fromSnapshot: "my-snapshot" });
	assert.ok(Math.abs(deleteAfter - (HOUR / 1000 + 300)) <= 2, `deleteAfter ${deleteAfter}`);
	const plain = setup({ org: undefined }, { create: machine() });
	await plain.host.create(req, ctx);
	assert.deepEqual(plain.rec.calls[0][1], { name: req.name, labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0 } }, "default is boxd's own image: no snapshot, no size, no timer");
});

test("prepare waits until boxd's agent is ready, then closes egress and hibernation, in that order", async () => {
	const { rec, host } = setup();
	assert.deepEqual(await host.prepare("m-1", ctx), { ok: true, value: undefined });
	assert.deepEqual(rec.calls, [
		["waitUntilReady", "m-1", { timeout: ctx.timeoutMs }],
		["setEgressAllow", "m-1", ["none"]],
		["setAutoHibernateTimeout", "m-1", 0],
	]);
});

test("get reads the machine back: state, network, size and snapshot; boxd's own create options read back wrong are drift", async () => {
	const read = async (patch, options) => (await setup(options, { get: machine(patch) }).host.get("m-1", ctx)).value;
	const good = await read({}, { vcpu: 2, memory: "8G" });
	assert.deepEqual({ ...good, labels: undefined }, { id: "m-1", labels: undefined, state: "running", network: "none", size: { cpus: 2, memoryMb: 8192 } });
	assert.equal((await read({ egressAllow: [] })).network, "open");
	assert.deepEqual((await read({ egressAllow: ["example.com"] })).network, { other: "an egress allowlist of 1 entries, which this provider never makes" });
	for (const [status, state] of [["pending", "starting"], ["suspended", "running"], ["migrating", "running"], ["hibernated", "stopped"], ["stopped", "stopped"], ["failed", "failed"], ["destroyed", "going"]]) assert.equal((await read({ status })).state, state, status);
	assert.deepEqual(await read({ status: "melting" }).then(({ state, why }) => [state, why]), ["failed", 'boxd reads its status as "melting"']);
	const drift = async (patch, options) => (await read(patch, options)).drift ?? [];
	assert.deepEqual(await drift({}), []);
	assert.match((await drift({ name: "other" }))[0], /^name:/);
	assert.match((await drift({ networking: { isolated: false } }))[0], /^isolated:/);
	assert.deepEqual((await drift({ idle: { suspendAfter: 60, hibernateAfter: 0, destroyAfter: 600 } })).map((line) => line.split(":")[0]), ["auto-suspend", "auto-destroy"]);
	assert.match((await drift({ deleteAt: new Date(Date.now() + 60_000) }))[0], /^delete-after: .* before the most it may live/);
	assert.deepEqual(await drift({ deleteAt: new Date(Date.now() + 2 * HOUR) }), [], "a delete after the most it may live is the backstop");
	assert.match((await drift({ source: { kind: "snapshot", name: "snap" } }))[0], /^snapshot:/);
	const restored = machine({ source: { kind: "snapshot", name: "snap" } });
	restored.labels[IMAGE_LABEL] = "snap";
	assert.deepEqual((await setup({}, { get: restored }).host.get("m-1", ctx)).value.image, { resolved: "snap" });
	assert.match((await drift({ resources: { vcpu: 1, memoryBytes: 4 * 1024 ** 3 } }, { vcpu: 2, memory: "8G" }))[0], /^size:/);
});

test("a restore that carries agentrun labels create did not write is drift; one of another org, or not found, is none", async () => {
	const { host } = setup({}, { create: machine(), get: () => machine({ labels: { ...machine().labels, "agentrun.run": "old" } }) });
	await host.create(request(), ctx);
	assert.match((await host.get("m-1", ctx)).value.drift[0], /^label agentrun\.run: create wrote none/);
	assert.deepEqual(await setup({}, { get: machine({ org: { id: "org-2", name: "other" } }) }).host.get("m-1", ctx), { ok: true, value: undefined });
	assert.equal((await setup({ org: "org-2" }, { get: machine({ org: { id: "org-2", name: "other" } }) }).host.get("m-1", ctx)).value.id, "m-1", "the org by id");
	const gone = setup({}, { get: () => Promise.reject(named("NotFoundError")) });
	assert.deepEqual(await gone.host.get("m-1", ctx), { ok: true, value: undefined });
	await assert.rejects(setup({}, { get: () => Promise.reject(named("AuthenticationError")) }).host.get("m-1", ctx), { name: "AuthenticationError" });
});

test("list asks the org for the labels; delete of a machine boxd no longer has is done", async () => {
	const { rec, host } = setup({}, { list: [machine()], delete: () => Promise.reject(named("NotFoundError")) });
	const listed = await host.list({ "agentrun.computer": "true" }, ctx);
	assert.deepEqual(listed.value.map(({ id }) => id), ["m-1"]);
	assert.deepEqual(rec.calls[0], ["list", { org: "acme", labels: { "agentrun.computer": "true" } }]);
	assert.deepEqual(await host.delete("m-1", ctx), { ok: true, value: undefined });
	await assert.rejects(setup({}, { delete: () => Promise.reject(named("RateLimitError")) }).host.delete("m-1", ctx), { name: "RateLimitError" });
});

test("exec is one streamExec of the quoted argv, stdin ended when none is asked; wait reads a lost stream as -1, kill closes it", async () => {
	const events = [];
	const stream = (code) => ({
		stderr: (async function* () {})(),
		async *[Symbol.asyncIterator]() {},
		write: (bytes) => events.push(["write", Buffer.from(bytes).toString()]),
		end: () => events.push(["end"]),
		wait: () => (code === undefined ? Promise.reject(new Error("stream lost")) : Promise.resolve(code)),
		close: () => events.push(["close"]),
	});
	const { rec, host } = setup({}, { streamExec: () => stream(3) });
	const quiet = (await host.exec("m-1", ["echo", "a b"], { stdin: false }, ctx)).value;
	assert.deepEqual(rec.calls[0], ["streamExec", "m-1", { command: "echo 'a b'" }]);
	assert.deepEqual(events, [["end"]]);
	assert.equal(await quiet.wait(), 3);
	events.length = 0;
	const fed = (await host.exec("m-1", ["cat"], { stdin: true }, ctx)).value;
	await fed.write(Buffer.from("hi"));
	await fed.end();
	await fed.kill();
	assert.deepEqual(events, [["write", "hi"], ["end"], ["close"]]);
	const lost = setup({}, { streamExec: () => stream(undefined) });
	assert.equal(await (await lost.host.exec("m-1", ["true"], { stdin: false }, ctx)).value.wait(), -1);
});

test("upload is files.upload, and setLabels sets the janitor's labels with updateLabels", async () => {
	const { rec, host } = setup({}, { "files.upload": 4, updateLabels: {} });
	const bytes = new Uint8Array([1, 2, 3, 4]);
	assert.deepEqual(await host.upload("m-1", "/tmp/computerd", bytes, ctx), { ok: true, value: undefined });
	assert.deepEqual(await host.setLabels("m-1", { "agentrun.computer.deadline": "x" }, ctx), { ok: true, value: undefined });
	assert.deepEqual(rec.calls, [
		["files.upload", "m-1", "/tmp/computerd", bytes],
		["updateLabels", "m-1", { set: { "agentrun.computer.deadline": "x" } }],
	]);
});

test("errorCode reads the SDK's error names and gRPC codes", () => {
	const { host } = setup();
	const cases = [
		[named("AbortError"), "aborted"],
		[named("NotFoundError"), "not_found"],
		[named("MachineFileNotFoundError"), "not_found"],
		[named("AuthenticationError"), "denied"],
		[named("PermissionDeniedError"), "denied"],
		[named("RegionNotEnabledError"), "denied"],
		[named("RateLimitError"), "limit"],
		[named("APIStatusError", { grpcCode: 8 }), "limit"],
		[named("ConflictError"), "exists"],
		[named("APIConnectionError"), "timeout"],
		[named("APIStatusError", { grpcCode: 4 }), "timeout"],
		[named("APIStatusError", { grpcCode: 14 }), "timeout"],
		[named("APIStatusError", { grpcCode: 3 }), "invalid"],
		[named("APIStatusError", { grpcCode: 9 }), "refused"],
		[new Error("anything"), "vendor"],
		[undefined, "vendor"],
	];
	for (const [error, code] of cases) assert.equal(host.errorCode(error), code, error?.name);
});

test("the conformance module reads only its COMPUTER_BOXD_* names, after the live switch; the sweep's host needs none", async () => {
	assert.throws(() => settingsFromEnv({ BOXD_API_KEY: "fake" }), /COMPUTER_BOXD_API_KEY/);
	assert.deepEqual(settingsFromEnv({ [BOXD_ENV.key]: KEY, [BOXD_ENV.org]: "acme", [BOXD_ENV.region]: "fra", [BOXD_ENV.kind]: "desktop" }), { apiKey: KEY, org: "acme", region: "fra", kind: "desktop" });
	assert.equal(conformanceImage({ env: {} }), "default");
	assert.equal(conformanceImage({ env: { [BOXD_ENV.image]: "snap" } }), "snap");
	await assert.rejects(createProvider({ env: { [BOXD_ENV.key]: KEY } }), /AGENTRUN_COMPUTER_LIVE_BOXD=1/);
	const provider = await createProvider({ env: { [BOXD_ENV.live]: "1", [BOXD_ENV.key]: KEY }, Boxd: recorder().Boxd });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env: { [BOXD_ENV.key]: KEY }, Boxd: recorder().Boxd })).id, "boxd");
});

test("the sweep's scope names the org, the region and the key by its sha256 prefix, so a before file of another is refused", () => {
	const env = { [BOXD_ENV.key]: KEY, [BOXD_ENV.org]: "acme", [BOXD_ENV.region]: "fra" };
	const scope = sweepScope({ env });
	assert.match(scope, /acme/);
	assert.match(scope, /fra/);
	assert.doesNotMatch(scope, new RegExp(KEY), "the key itself is never written");
	assert.notEqual(sweepScope({ env: { ...env, [BOXD_ENV.key]: `${KEY}x` } }), scope, "another key is another place");
	assert.notEqual(sweepScope({ env: { ...env, [BOXD_ENV.org]: "other" } }), scope, "another org is another place");
	assert.notEqual(sweepScope({ env: { ...env, [BOXD_ENV.region]: "nyc" } }), scope, "another region is another place");
	assert.notEqual(sweepScope({ env: { [BOXD_ENV.key]: KEY } }), scope, "the key's own org and home region are another place");
	assert.throws(() => sweepScope({ env: {} }), /COMPUTER_BOXD_API_KEY/);
});
