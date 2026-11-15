// BoxdProvider's own half: what boxd's host hands the SDK and how it reads boxd's answers back, call by call, against a
// recorder of the SDK slice (@boxd-sh/sdk@0.3.1) that answers what a test gives it. The adapter's lifecycle (the daemon,
// the bridge, the probe, idempotent create, late-create cleanup, extend, release) is tested once, against its one fake
// host (hosted-provider.test.mjs); boxd's own is proven live (test/boxd). No SDK is loaded and nothing reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { BOXD, kindRefusals } from "../dist/index.js";
import { providerFor } from "../dist/providers.js";

const { BoxdProvider, create } = await import("../dist/boxd.js");
const { BOXD_ENV, settingsFromEnv, conformanceImage, createProvider, createHost, sweepScope } = await import("../dist/conformance/boxd.js");

const KEY = "bxd_fake_computer_key_0123456789";
const NAME = "agentrun.computer.name";
const DEADLINE_LABEL = "agentrun.computer.deadline";
const MAX_LABEL = "agentrun.computer.max-deadline";
const SPEC = { image: "default", lifetimeMs: 600_000, network: "none" };
const LINUX_GROUPS = ["exec", "files", "processes"];
const DESKTOP_GROUPS = [...LINUX_GROUPS, "screen", "input.pointer", "input.keys", "apps"];
const TIMEOUTS = { requestMs: 2_000, createMs: 3_000 };
const HOUR = 3_600_000;

const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

const CREATED = new Date("2026-11-15T08:00:00Z");

/** A machine as boxd reads one that create made: running, in the org. */
function machine(patch = {}) {
	const max = new Date(Date.now() + HOUR).toISOString();
	return {
		id: "m-1",
		name: "computer-0123456789ab",
		status: "running",
		labels: { [NAME]: "computer-0123456789ab", [MAX_LABEL]: max },
		org: { id: "org-1", name: "acme" },
		createdAt: CREATED,
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
const request = (labels = {}) => ({ name: "computer-0123456789ab", image: "default", labels: { [NAME]: "computer-0123456789ab", [MAX_LABEL]: new Date(Date.now() + HOUR).toISOString(), ...labels }, lifetimeMs: HOUR, egress: false });

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

test("capabilities: a child daemon in a microVM, network none, janitor lifetime, delete only, boxd's agent port; desktop too", () => {
	const { provider, host } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ ...caps },
		{ kind: "linux", lifetime: "janitor", network: ["none"], networkReadBack: false, isolation: "microvm", os: "linux", daemon: "child", groups: LINUX_GROUPS, maxLifetimeMs: 24 * HOUR, release: ["delete"], mount: [], vendorAgentPorts: [57073] },
	);
	assert.deepEqual(kindRefusals(caps), []);
	assert.deepEqual(setup({ kind: "desktop" }).provider.capabilities().groups, DESKTOP_GROUPS);
	assert.equal(host.descriptor, BOXD);
	assert.deepEqual(BOXD.mounts, []);
	assert.deepEqual(BOXD.capabilities.map(({ kind, options }) => [kind, options.kind]), [["linux", "linux"], ["desktop", "desktop"]]);
});

test("check takes default or a snapshot's name, refuses a snapshot with a size, the spec's size and a label name boxd does not take, with no call", () => {
	const { rec, provider } = setup();
	const fields = (spec, p = provider) => p.check(spec).map(({ field }) => field);
	assert.deepEqual(fields(SPEC), []);
	assert.deepEqual(fields({ ...SPEC, image: "my-snapshot" }), []);
	assert.deepEqual(fields({ ...SPEC, image: "no spaces" }), ["image"]);
	assert.deepEqual(fields({ ...SPEC, image: "my-snapshot" }, setup({ vcpu: 2, memory: "8G" }).provider), ["image"]);
	assert.deepEqual(fields({ ...SPEC, labels: { "boxd/owner": "x" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, labels: { Team: "x" } }), ["labels"]);
	assert.deepEqual(fields({ ...SPEC, network: "open" }), ["network"]);
	assert.deepEqual(fields({ ...SPEC, cpus: 2, memoryMb: 4096 }), ["cpus", "memoryMb"]);
	assert.deepEqual(rec.calls, []);
});

test("create asks for an isolated machine in the org with no standby, the size, the snapshot, and with deleteTimer a delete 5 minutes past the most it may live", async () => {
	const { rec, host } = setup({ vcpu: 2, memory: "8G", deleteTimer: true }, { create: machine() });
	const req = request();
	assert.deepEqual(await host.create({ ...req, image: "my-snapshot" }, ctx), { id: "m-1" });
	const [[name, params]] = rec.calls;
	assert.equal(name, "create");
	const { deleteAfter, ...rest } = params;
	assert.deepEqual(rest, { name: req.name, org: "acme", labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0, vcpu: 2, memory: "8G" }, fromSnapshot: "my-snapshot" });
	assert.ok(Math.abs(deleteAfter - (HOUR / 1000 + 300)) <= 2, `deleteAfter ${deleteAfter}`);
	const plain = setup({ org: undefined }, { create: machine() });
	await plain.host.create(req, ctx);
	assert.deepEqual(plain.rec.calls[0][1], { name: req.name, labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0 } }, "default is boxd's own image: no snapshot, no size, no timer");
});

test("create then waits until boxd's agent is ready, and closes egress and hibernation, in that order; a request for egress is refused", async () => {
	const { rec, host } = setup({}, { create: machine() });
	await host.create(request(), ctx);
	assert.deepEqual(rec.calls.slice(1), [
		["waitUntilReady", "m-1", { timeout: ctx.timeoutMs }],
		["setEgressAllow", "m-1", ["none"]],
		["setAutoHibernateTimeout", "m-1", 0],
	]);
	const failing = setup({}, { create: machine(), setEgressAllow: () => Promise.reject(named("APIStatusError", { grpcCode: 14 })) });
	await assert.rejects(failing.host.create(request(), ctx), { name: "APIStatusError" }, "a setting that fails fails the create");
	assert.deepEqual(failing.rec.calls.at(-1), ["delete", "m-1"], "and deletes the machine it made");
	const open = setup();
	await assert.rejects(open.host.create({ ...request(), egress: true }, ctx), (error) => error.code === "invalid" && /reaches nothing outside/.test(error.message));
	assert.deepEqual(open.rec.calls, [], "no machine is made");
});

test("a step after the machine exists that throws deletes that machine by its id once and throws its own error, which the adapter reads as made nothing", async () => {
	for (const step of ["waitUntilReady", "setEgressAllow", "setAutoHibernateTimeout"]) {
		const limited = named("RateLimitError");
		const { rec, host } = setup({}, { create: machine(), [step]: () => Promise.reject(limited) });
		await assert.rejects(host.create(request(), ctx), (error) => {
			assert.equal(error, limited, `${step}: the step's own error`);
			assert.equal(host.errorCode(error), "limit");
			assert.match(error.message, /^RateLimitError; the machine m-1 it made was deleted$/);
			return true;
		});
		assert.deepEqual(rec.calls.filter(([name]) => name === "delete"), [["delete", "m-1"]], step);
		assert.equal(rec.calls.at(-1)[0], "delete", `${step}: no step runs after the delete`);
	}
	const gone = setup({}, { create: machine(), waitUntilReady: () => Promise.reject(named("PermissionDeniedError")), delete: () => Promise.reject(named("NotFoundError")) });
	await assert.rejects(gone.host.create(request(), ctx), (error) => error.name === "PermissionDeniedError" && /m-1 it made was deleted$/.test(error.message), "not found is deleted");
	const stuck = setup({}, { create: machine(), setEgressAllow: () => Promise.reject(named("RateLimitError")), delete: () => Promise.reject(named("APIConnectionError")) });
	await assert.rejects(stuck.host.create(request(), ctx), (error) => {
		assert.equal(error.name, "RateLimitError", "a failed delete never hides the step's error");
		assert.equal(stuck.host.errorCode(error), "limit");
		assert.match(error.message, /the machine m-1 it made could not be deleted \(APIConnectionError\)$/);
		return true;
	});
});

test("the provider's create whose wait for the machine throws RateLimitError fails as limit, and the one machine it made is deleted by its id", async () => {
	const { rec, provider } = setup({}, { list: [], create: (params) => machine({ name: params.name, labels: params.labels }), waitUntilReady: () => Promise.reject(named("RateLimitError")) });
	const made = await provider.create(SPEC, { requestId: "r-limit" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "limit");
	assert.match(made.error.message, /RateLimitError; the machine m-1 it made was deleted/);
	assert.equal(rec.calls.filter(([name]) => name === "create").length, 1);
	assert.deepEqual(rec.calls.filter(([name]) => name === "delete"), [["delete", "m-1"]]);
});

test("get reads the machine back: its labels, its state and when boxd made it", async () => {
	const base = machine();
	const read = async (patch) => setup({}, { get: { ...base, ...patch } }).host.get("m-1", ctx);
	assert.deepEqual(await read({}), { id: "m-1", labels: base.labels, state: "running", createdAt: CREATED });
	for (const [status, state] of [["pending", "starting"], ["starting", "starting"], ["suspended", "running"], ["migrating", "running"], ["hibernated", "stopped"], ["stopped", "stopped"], ["failed", "gone"], ["destroyed", "gone"]]) assert.equal((await read({ status })).state, state, status);
	assert.deepEqual(await read({ status: "melting" }).then(({ state, why }) => [state, why]), ["gone", 'boxd reads its status as "melting"']);
	assert.equal((await read({ createdAt: null })).createdAt, undefined);
});

test("one of another org is none; not found and other errors are thrown for the adapter to read", async () => {
	assert.equal(await setup({}, { get: machine({ org: { id: "org-2", name: "other" } }) }).host.get("m-1", ctx), undefined);
	assert.equal((await setup({ org: "org-2" }, { get: machine({ org: { id: "org-2", name: "other" } }) }).host.get("m-1", ctx)).id, "m-1", "the org by id");
	assert.equal((await setup({ org: undefined }, { get: machine({ org: { id: "org-2", name: "other" } }) }).host.get("m-1", ctx)).id, "m-1", "no org set: the key's own");
	const { host } = setup({}, { get: () => Promise.reject(named("NotFoundError")) });
	await assert.rejects(host.get("m-1", ctx), (error) => host.errorCode(error) === "not_found");
	await assert.rejects(setup({}, { get: () => Promise.reject(named("AuthenticationError")) }).host.get("m-1", ctx), { name: "AuthenticationError" });
});

test("list asks the org for the labels; delete of a machine boxd no longer has is done", async () => {
	const { rec, host } = setup({}, { list: [machine()], delete: () => Promise.reject(named("NotFoundError")) });
	const listed = await host.list({ "agentrun.computer": "true" }, ctx);
	assert.deepEqual(listed.map(({ id }) => id), ["m-1"]);
	assert.deepEqual(rec.calls[0], ["list", { org: "acme", labels: { "agentrun.computer": "true" } }]);
	assert.equal(await host.delete("m-1", ctx), undefined);
	await assert.rejects(setup({}, { delete: () => Promise.reject(named("RateLimitError")) }).host.delete("m-1", ctx), { name: "RateLimitError" });
});

test("exec is one streamExec of the quoted argv, stdin open; wait reads a lost stream as -1, kill closes it", async () => {
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
	const fed = await host.exec("m-1", ["echo", "a b"], ctx);
	assert.deepEqual(rec.calls[0], ["streamExec", "m-1", { command: "echo 'a b'" }]);
	assert.deepEqual(events, [], "stdin stays open until the adapter ends it");
	await fed.write(Buffer.from("hi"));
	await fed.end();
	assert.equal(await fed.wait(), 3);
	await fed.kill();
	assert.deepEqual(events, [["write", "hi"], ["end"], ["close"]]);
	const lost = setup({}, { streamExec: () => stream(undefined) });
	assert.equal(await (await lost.host.exec("m-1", ["true"], ctx)).wait(), -1);
});

test("upload is files.upload, and extend sets the janitor's deadline label with updateLabels", async () => {
	const { rec, host } = setup({}, { "files.upload": 4, updateLabels: {} });
	const bytes = new Uint8Array([1, 2, 3, 4]);
	assert.equal(await host.upload("m-1", "/tmp/computerd", bytes, ctx), undefined);
	const end = new Date("2026-11-15T10:00:00Z");
	assert.equal(await host.extend("m-1", end, ctx), undefined);
	assert.deepEqual(rec.calls, [
		["files.upload", "m-1", "/tmp/computerd", bytes],
		["updateLabels", "m-1", { set: { [DEADLINE_LABEL]: end.toISOString() } }],
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
	assert.equal((await createHost({ env: { [BOXD_ENV.key]: KEY }, Boxd: recorder().Boxd })).descriptor.id, "boxd");
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
