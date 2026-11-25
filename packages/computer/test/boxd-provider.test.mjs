// BoxdProvider's own half: what boxd's host hands the SDK and how it reads boxd's answers back, call by call, against a
// recorder of the SDK slice (@boxd-sh/sdk@0.3.1) that answers what a test gives it. The adapter's lifecycle (the daemon,
// the bridge, the probe, idempotent create, late-create cleanup, extend, release) is tested once, against its one fake
// host (hosted-provider.test.mjs); boxd's own is proven live (test/boxd). No SDK is loaded and nothing reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { BOXD, kindRefusals } from "../dist/index.js";
import { providerFor } from "../dist/providers.js";
import { refusesHttp } from "./https-refusal.mjs";

const { BoxdProvider, boxdDesktopSnapshot, create } = await import("../dist/boxd.js");
const { BOXD_ENV, settingsFromEnv, conformanceImage, createProvider, createDriftedProvider, createHost, sweepScope } = await import("../dist/conformance/boxd.js");

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
	const snapshots = { create: call("snapshots.create"), get: call("snapshots.get") };
	const Boxd = class {
		constructor(options) {
			clients.push(options);
			this.machines = machines;
			this.snapshots = snapshots;
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
const request = (labels = {}) => ({
	name: "computer-0123456789ab",
	image: "default",
	labels: { [NAME]: "computer-0123456789ab", [MAX_LABEL]: new Date(Date.now() + HOUR).toISOString(), ...labels },
	lifetimeMs: HOUR,
	backstopAt: new Date(Date.now() + 2 * HOUR).toISOString(),
	egress: false,
});

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
	assert.throws(make({ kind: "desktop", vcpu: 4, memory: "16G" }), /a boxd desktop starts from a snapshot, which keeps the size it was captured at/);
	assert.doesNotThrow(make({ kind: "desktop" }));
});

test("the API URL is https alone, loopback included, so the key never crosses in the clear: another is refused before any client is made", () => {
	for (const baseUrl of ["http://boxd.sh:9443", "http://127.0.0.1:9443", "http://[::1]:9443", "http://localhost:9443", "ws://boxd.sh:9443"]) {
		const rec = recorder();
		assert.throws(() => new BoxdProvider({ apiKey: KEY, Boxd: rec.Boxd, baseUrl }), refusesHttp("the boxd API URL", baseUrl, KEY));
		assert.deepEqual(rec.clients, [], baseUrl);
	}
	assert.throws(() => new BoxdProvider({ apiKey: KEY, Boxd: recorder().Boxd, baseUrl: "//boxd.sh:9443" }), /the boxd API URL is not a URL/);
	const { rec } = setup({ baseUrl: "https://boxd.example.test:9443/" });
	assert.deepEqual(rec.clients.map(({ baseURL }) => baseURL), ["https://boxd.example.test:9443", "https://boxd.example.test:9443"]);
});

test("capabilities: a child daemon in a microVM, network none, janitor lifetime, delete only, a synced folder, boxd's agent port; desktop too", () => {
	const { provider, host } = setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ ...caps },
		{ kind: "linux", lifetime: "janitor", network: ["none"], networkReadBack: false, isolation: "microvm", os: "linux", daemon: "child", groups: LINUX_GROUPS, maxLifetimeMs: 24 * HOUR, release: ["delete"], mount: ["sync"], vendorAgentPorts: [57073] },
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

test("a desktop on boxd's own image is refused in words: it lists no stock app; a snapshot is taken", () => {
	const { rec, provider } = setup({ kind: "desktop" });
	const [refusal, ...more] = provider.check(SPEC);
	assert.deepEqual(more, []);
	assert.equal(refusal.field, "image");
	assert.match(refusal.message, /^a boxd desktop starts from a snapshot with a desktop app, and boxd's own image lists none of the stock ones \(Xfce's text editor and terminal, xterm\): name agentrun-desktop-[0-9a-f]{12}, which prepareImage\(\) builds, or a snapshot of your own$/);
	assert.deepEqual(provider.check({ ...SPEC, image: boxdDesktopSnapshot() }), []);
	assert.deepEqual(provider.check({ ...SPEC, image: "my-desktop" }), []);
	assert.deepEqual(rec.calls, []);
});

test("create asks for an isolated machine in the org with no standby, the size, the snapshot, and boxd's delete timer at the request's backstop", async () => {
	const { rec, host } = setup({ vcpu: 2, memory: "8G" }, { create: machine() });
	const req = request();
	assert.deepEqual(await host.create({ ...req, image: "my-snapshot" }, ctx), { id: "m-1" });
	const [[name, params]] = rec.calls;
	assert.equal(name, "create");
	const { deleteAfter, ...rest } = params;
	assert.deepEqual(rest, { name: req.name, org: "acme", labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0, vcpu: 2, memory: "8G" }, fromSnapshot: "my-snapshot" });
	assert.ok(Math.abs(deleteAfter - (Date.parse(req.backstopAt) - Date.now()) / 1000) <= 2, `deleteAfter ${deleteAfter}`);
	const plain = setup({ org: undefined }, { create: machine() });
	await plain.host.create(req, ctx);
	const { deleteAfter: timer, ...bare } = plain.rec.calls[0][1];
	assert.deepEqual(bare, { name: req.name, labels: req.labels, isolated: true, config: { autoSuspendTimeout: 0 } }, "default is boxd's own image: no snapshot, no size");
	assert.equal(typeof timer, "number", "every machine has the backstop timer");
});

test("the provider's create gives boxd's timer the adapter's backstop: the most a computer may live and 5 minutes", async () => {
	const { rec, provider } = setup({ maxLifetimeMs: HOUR }, { list: [], create: (params) => machine({ name: params.name, labels: params.labels }), waitUntilReady: () => Promise.reject(named("RateLimitError")) });
	await provider.create(SPEC, { requestId: "r-backstop" });
	const [, params] = rec.calls.find(([name]) => name === "create");
	assert.ok(Math.abs(params.deleteAfter - (HOUR + 300_000) / 1000) <= 2, `deleteAfter ${params.deleteAfter}`);
});

test("create then waits until boxd's agent is ready, and closes egress and hibernation, in that order; a request for egress is refused", async () => {
	const { rec, host } = setup({}, { create: machine() });
	await host.create(request(), ctx);
	assert.deepEqual(rec.calls.slice(1), [
		["waitUntilReady", "m-1", { timeout: ctx.timeoutMs }],
		["setEgressAllow", "m-1", ["none"]],
		["setAutoHibernateTimeout", "m-1", 0],
	]);
	const failing = setup({}, { create: machine(), setEgressAllow: () => Promise.reject(named("APIStatusError", { grpcCode: 9 })) });
	await assert.rejects(failing.host.create(request(), ctx), { name: "APIStatusError" }, "a setting that fails fails the create");
	assert.deepEqual(failing.rec.calls.at(-1), ["delete", "m-1"], "and a refusal deletes the machine it made");
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

test("a step that fails as vendor or timeout leaves its machine to the adapter's sweep by name, which deletes it and never a second create's", async () => {
	// Another provider instance's create of the same request finds no machine by the name once this one's is deleted,
	// and makes its own (m-2). A delete here before the adapter's sweep would leave the sweep to find m-2 instead. The
	// adapter sweeps a vendor failure before create answers, and a timeout's once the host's call settles, after it.
	const failures = [
		["vendor", named("BoxdError", { message: "machine computer-x entered terminal state 'failed' while waiting" }), /entered terminal state 'failed'/],
		["timeout", named("APIConnectionError", { message: "connection to boxd timed out" }), /connection to boxd timed out/],
	];
	for (const [code, failure, words] of failures) {
		const deleted = new Set();
		let mine;
		const replacement = () => ({ ...mine, id: "m-2", status: "starting", createdAt: new Date(CREATED.getTime() + 60_000) });
		const listing = () => (mine === undefined ? [] : deleted.has("m-1") ? [replacement()] : [mine]);
		const { rec, provider } = setup(
			{ timeouts: { ...TIMEOUTS, pollMs: 5 } },
			{
				list: listing,
				create: (params) => (mine = machine({ name: params.name, labels: params.labels })),
				waitUntilReady: () => Promise.reject(failure),
				get: (id) => (deleted.has(id) ? Promise.reject(named("NotFoundError")) : id === "m-1" ? mine : replacement()),
				delete: (id) => void deleted.add(id),
			},
		);
		const made = await provider.create(SPEC, { requestId: `r-${code}` });
		assert.equal(made.ok, false);
		assert.equal(made.error.code, code);
		assert.match(made.error.message, words);
		const deletes = () => rec.calls.filter(([name]) => name === "delete");
		for (let waited = 0; deletes().length === 0 && waited < 2_000; waited += 10) await new Promise((done) => setTimeout(done, 10));
		await new Promise((done) => setTimeout(done, 200));
		assert.deepEqual(deletes(), [["delete", "m-1"]], `${code}: the machine this create made, and no other`);
	}
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

/** An exec stream that prints stderr and exits with code. */
function ran(code, stderr = "") {
	return {
		stderr: (async function* () {
			if (stderr) yield Buffer.from(stderr);
		})(),
		async *[Symbol.asyncIterator]() {},
		write() {},
		end() {},
		wait: () => Promise.resolve(code),
		close() {},
	};
}

/** A snapshot as boxd reads one. */
const snapshot = (patch = {}) => ({ name: boxdDesktopSnapshot(), status: "ready", archived: false, storage: "local", ...patch });

/**
 * A build's answers: no snapshot until snapshots.create, then ready; the build machine listed by its name (with another
 * machine of the org) until deleted, then gone. answers.create may take the name and throw, as a create whose reply was lost.
 */
function building(answers = {}) {
	let taken = false;
	let deleted = false;
	let named_ = null;
	const { create = (params) => machine({ id: "b-1", name: params.name, labels: {} }), ...rest } = answers;
	return {
		"snapshots.get": () => (taken ? snapshot() : Promise.reject(named("NotFoundError"))),
		"snapshots.create": () => {
			taken = true;
			return { name: boxdDesktopSnapshot(), status: "pending" };
		},
		create: (params) => {
			named_ = params.name;
			return create(params);
		},
		list: () => [machine({ id: "m-9", name: "someone-else" }), ...(named_ === null || deleted ? [] : [machine({ id: "b-1", name: named_, labels: {} })])],
		get: () => (deleted ? Promise.reject(named("NotFoundError")) : machine({ id: "b-1" })),
		delete: () => void (deleted = true),
		streamExec: () => ran(0),
		...rest,
	};
}

test("prepareImage: a sandbox starts from boxd's own image, with no call and no wait", async () => {
	const { rec, provider } = setup();
	const told = [];
	assert.deepEqual(await provider.prepareImage({ onWait: (...said) => told.push(said) }), { ok: true, value: "default" });
	assert.deepEqual([rec.calls, told], [[], []]);
	assert.equal(BOXD.prepareImage, true);
	assert.deepEqual(BOXD.defaultImage, { sandbox: "default" }, "a desktop has no default: it starts from what prepareImage() answers");
});

test("prepareImage: a desktop's snapshot the org has is answered by its name, with no build and no wait", async () => {
	const { rec, provider } = setup({ kind: "desktop" }, { "snapshots.get": snapshot() });
	const told = [];
	const name = boxdDesktopSnapshot();
	assert.match(name, /^agentrun-desktop-[0-9a-f]{12}$/);
	assert.deepEqual(await provider.prepareImage({ onWait: (...said) => told.push(said) }), { ok: true, value: name });
	assert.deepEqual(rec.calls, [["snapshots.get", name, { org: "acme" }]]);
	assert.deepEqual(told, []);
	const keyOrg = setup({ kind: "desktop", org: undefined }, { "snapshots.get": snapshot() });
	await keyOrg.provider.prepareImage();
	assert.deepEqual(keyOrg.rec.calls, [["snapshots.get", name, {}]], "no org: the key's own");
	const reads = [snapshot({ status: "pending" }), snapshot()];
	const pending = setup({ kind: "desktop" }, { "snapshots.get": () => reads.shift() });
	assert.deepEqual(await pending.provider.prepareImage({ onWait: (...said) => told.push(said) }), { ok: true, value: name }, "one being made is waited for");
	assert.deepEqual([pending.rec.calls.map(([call]) => call), told], [["snapshots.get", "snapshots.get"], []]);
});

test("prepareImage: the desktop recipe adds what boxd's own image lacks: Mousepad and xfce4-terminal from Ubuntu, Firefox ESR from Mozilla's APT repository with its signing key pinned by sha256, each program and desktop file checked", async () => {
	const { rec, provider } = setup({ kind: "desktop" }, building());
	assert.equal((await provider.prepareImage()).ok, true);
	const { command } = rec.calls.find(([call]) => call === "streamExec")[2];
	assert.ok(!command.slice("sudo -n sh -c '".length, -1).includes("'"), "the recipe holds no single quote, so its quoting is one pair");
	const key = "/etc/apt/keyrings/packages.mozilla.org.asc";
	assert.ok(command.includes(`curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o ${key}`), "Mozilla's signing key, fetched");
	assert.ok(command.includes(`echo "3ecc63922b7795eb23fdc449ff9396f9114cb3cf186d6f5b53ad4cc3ebfbb11f  ${key}" | sha256sum -c --quiet -`), "and held to the key whose fingerprint is 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3");
	assert.ok(command.includes(`deb [signed-by=${key}] https://packages.mozilla.org/apt mozilla main`), "the repository signed by that key alone");
	assert.ok(command.indexOf("sha256sum -c") < command.indexOf("mozilla main"), "the key is checked before apt reads anything it signs");
	assert.match(command, /apt-get install -y -qq --no-install-recommends mousepad xfce4-terminal firefox-esr >\/dev\/null/);
	assert.match(command, /for x in mousepad xfce4-terminal firefox-esr; do command -v "\$x"/);
	assert.match(command, /for app in org\.xfce\.mousepad xfce4-terminal firefox-esr; do test -f "\/usr\/share\/applications\/\$app\.desktop"/);
});

test("prepareImage: a desktop's snapshot is built once from boxd's own image: the recipe as root, the capture, the build machine deleted and gone", async () => {
	const { rec, provider } = setup({ kind: "desktop" }, building());
	const told = [];
	const name = boxdDesktopSnapshot();
	assert.deepEqual(await provider.prepareImage({ onWait: (...said) => told.push(said) }), { ok: true, value: name });
	assert.deepEqual(told, [["build", name]], "told once, before the build");
	const [first, made, ...rest] = rec.calls;
	assert.deepEqual(first, ["snapshots.get", name, { org: "acme" }]);
	const [what, params] = made;
	assert.equal(what, "create");
	assert.match(params.name, /^agentrun-desktop-build-[0-9a-f]{8}$/);
	assert.deepEqual({ ...params, name: "x" }, { name: "x", org: "acme", isolated: true, config: { autoSuspendTimeout: 0 }, deleteAfter: 7_200 }, "boxd's own image, no labels (a restore carries them over), boxd's delete timer");
	const exec = rest.find(([call]) => call === "streamExec");
	assert.equal(exec[1], "b-1");
	assert.match(exec[2].command, /^sudo -n sh -c '[^']*apt-get install -y -qq --no-install-recommends mousepad [^']*'$/, "the recipe as root (its apps: the test above)");
	assert.deepEqual(
		rest.map(([call]) => call),
		["waitUntilReady", "streamExec", "snapshots.create", "snapshots.get", "list", "delete", "get"],
		"ready, the recipe, the capture, read until ready, then the machine found by its name in the org's list, deleted and read gone",
	);
	assert.deepEqual(rest.find(([call]) => call === "snapshots.create").slice(1), ["b-1", name]);
	assert.deepEqual(rest.find(([call]) => call === "list").slice(1), [{ org: "acme", labels: {} }], "the org's whole list: the build machine has no label");
	assert.deepEqual(rest.filter(([call]) => call === "delete"), [["delete", "b-1"]], "the build machine alone");

	const unlisted = setup({ kind: "desktop" }, building({ list: () => [] }));
	assert.deepEqual(await unlisted.provider.prepareImage(), { ok: true, value: name });
	assert.deepEqual(
		unlisted.rec.calls.slice(-3).map(([call, id]) => [call, id]),
		[["list", { org: "acme", labels: {} }], ["delete", "b-1"], ["get", "b-1"]],
		"the id create answered is deleted and read gone though the list lags",
	);
});

test("prepareImage: a cancelled request makes no build machine, and a cancel while one starts deletes it at once", async () => {
	const cancelled = setup({ kind: "desktop" }, building());
	const already = new AbortController();
	already.abort();
	const told = [];
	const refused = await cancelled.provider.prepareImage({ signal: already.signal, onWait: (...said) => told.push(said) });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "aborted");
	assert.deepEqual([cancelled.rec.calls, told], [[], []], "no read, no machine, no word of a build");

	const starting = setup({ kind: "desktop" }, building({ waitUntilReady: () => new Promise(() => {}) }));
	const cancel = new AbortController();
	const answer = starting.provider.prepareImage({ signal: cancel.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	cancel.abort();
	const failed = await answer;
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "aborted", "boxd's own wait for a ready machine is not the caller's to sit through");
	assert.deepEqual(starting.rec.calls.filter(([call]) => call === "delete"), [["delete", "b-1"]]);
	assert.equal(starting.rec.calls.some(([call]) => call === "streamExec" || call === "snapshots.create"), false);
});

test("prepareImage: a build machine whose create reply was lost is found by its name and deleted; the create's error is the answer", async () => {
	const { rec, provider } = setup({ kind: "desktop" }, building({ create: () => Promise.reject(named("APIConnectionError")) }));
	const failed = await provider.prepareImage();
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /^boxd's desktop snapshot agentrun-desktop-[0-9a-f]{12}: APIConnectionError$/);
	assert.deepEqual(rec.calls.filter(([call]) => call === "delete"), [["delete", "b-1"]]);
	assert.equal(rec.calls.some(([call]) => call === "waitUntilReady"), false);
});

test("prepareImage: a build machine that cannot be deleted is said, after a build that passed or with the error of one that failed", async () => {
	const stuck = () => Promise.reject(named("RateLimitError"));
	const passed = await setup({ kind: "desktop" }, building({ delete: stuck })).provider.prepareImage();
	assert.equal(passed.ok, false);
	assert.match(
		passed.error.message,
		/^boxd's desktop snapshot (agentrun-desktop-[0-9a-f]{12}): the boxd snapshot \1 is ready, but its build machine agentrun-desktop-build-[0-9a-f]{8} could not be deleted \(.*RateLimitError.*\), and boxd's delete timer ends it within 2 h: call again to start from the snapshot$/,
	);
	const failed = await setup({ kind: "desktop" }, building({ delete: stuck, streamExec: () => ran(100, "E: Unable to locate package mousepad\n") })).provider.prepareImage();
	assert.equal(failed.error.code, "vendor");
	assert.match(failed.error.message, /exited with 100: E: Unable to locate package mousepad; its build machine agentrun-desktop-build-[0-9a-f]{8} could not be deleted \(.*RateLimitError.*\), and boxd's delete timer ends it within 2 h$/);
});

test("prepareImage: a recipe that fails fails in its own words, and the build machine is deleted; no snapshot is taken", async () => {
	const { rec, provider } = setup({ kind: "desktop" }, building({ streamExec: () => ran(100, "E: Unable to locate package mousepad\n") }));
	const failed = await provider.prepareImage();
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "vendor");
	assert.match(failed.error.message, /^boxd's desktop snapshot agentrun-desktop-[0-9a-f]{12}: the desktop recipe \(mousepad\) on the build machine b-1 exited with 100: E: Unable to locate package mousepad$/);
	assert.equal(rec.calls.some(([call]) => call === "snapshots.create"), false);
	assert.deepEqual(rec.calls.filter(([call]) => call === "delete"), [["delete", "b-1"]]);
});

test("prepareImage: a desktop snapshot that failed or that boxd archived is refused in words, with no build", async () => {
	for (const [patch, code, words] of [
		[{ status: "failed" }, "vendor", /is "failed", not ready: delete it, then call again to build it anew$/],
		[{ archived: true, storage: "archived" }, "refused", /is archived \(storage "archived"\), and boxd makes no machine from it until its operator unarchives it: delete it, then call again to build it anew$/],
	]) {
		const { rec, provider } = setup({ kind: "desktop" }, { "snapshots.get": snapshot(patch) });
		const told = [];
		const failed = await provider.prepareImage({ onWait: (...said) => told.push(said) });
		assert.equal(failed.ok, false);
		assert.equal(failed.error.code, code);
		assert.match(failed.error.message, words);
		assert.deepEqual([rec.calls.map(([call]) => call), told], [["snapshots.get"], []]);
	}
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
	assert.equal(await conformanceImage({ env: {} }), "default");
	assert.equal(await conformanceImage({ env: { [BOXD_ENV.image]: "snap", [BOXD_ENV.kind]: "desktop" } }), "snap");
	const desktop = { [BOXD_ENV.live]: "1", [BOXD_ENV.key]: KEY, [BOXD_ENV.kind]: "desktop" };
	assert.equal(await conformanceImage({ env: desktop, Boxd: recorder({ "snapshots.get": snapshot() }).Boxd }), boxdDesktopSnapshot(), "a desktop's is the desktop snapshot, through prepareImage");
	await assert.rejects(conformanceImage({ env: { ...desktop, [BOXD_ENV.live]: undefined } }), /AGENTRUN_COMPUTER_LIVE_BOXD=1/);
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

test("the conformance module hands the caller's onNote to the provider: a release whose run folder was not let go cleanly is said through it", async () => {
	// A running Archil computer: release lets go of its folder first, through an exec that cannot start here.
	const labels = { "agentrun.computer": "1", [NAME]: "computer-0123456789ab", "agentrun.run": "r1", "agentrun.mount": JSON.stringify({ kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", agent: "a1" }) };
	let deleted = false;
	const { Boxd } = recorder({
		get: () => (deleted ? Promise.reject(named("NotFoundError")) : machine({ labels })),
		delete: () => {
			deleted = true;
		},
		streamExec: () => {
			throw new Error("no exec here");
		},
	});
	const notes = [];
	const provider = await createProvider({ env: { [BOXD_ENV.live]: "1", [BOXD_ENV.key]: KEY }, Boxd, timeouts: { ...TIMEOUTS, pollMs: 1 }, onNote: (note) => notes.push(note) });
	const released = await provider.release({ id: "m-1", name: "computer-0123456789ab" }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released));
	assert.equal(deleted, true);
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.equal(notes[0].computer, "computer-0123456789ab");
	assert.match(notes[0].note, /was deleted, and the run's folder was not let go cleanly/);
});

test("the conformance module's daemon: an option's path over COMPUTER_BOXD_DAEMON, and the drifted twin uploads the one it built", async () => {
	const env = { [BOXD_ENV.live]: "1", [BOXD_ENV.key]: KEY, [BOXD_ENV.daemon]: "/nonexistent/untangle-env/computerd" };
	const options = { env, timeouts: TIMEOUTS, daemonPath: "/nonexistent/untangle-option/computerd", buildDaemon: async () => "/nonexistent/untangle-drift/computerd" };
	const made = await (await createProvider({ ...options, Boxd: recorder({ list: [] }).Boxd })).create(SPEC, { requestId: "req-untangle-boxd-1" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /no daemon binary at \/nonexistent\/untangle-option\/computerd/);
	const drifted = await (await createDriftedProvider({ ...options, Boxd: recorder({ list: [] }).Boxd })).create(SPEC, { requestId: "req-untangle-boxd-2" });
	assert.equal(drifted.ok, false);
	assert.match(drifted.error.message, /no daemon binary at \/nonexistent\/untangle-drift\/computerd/);
});
