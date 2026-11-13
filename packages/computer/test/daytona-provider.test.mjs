// DaytonaProvider without a vendor fake: what Daytona's own host decides (its capabilities, its check, the create body,
// how it reads a sandbox back, the key on every request and where requests may go, the network it refuses to change),
// each read from options or from what an injected fetch is handed. The adapter's lifecycle is tested once, against its
// one fake host (hosted-provider.test.mjs); Daytona's own lifecycle is proven live (test/daytona). The fetch here only
// records what it is given and answers one canned reply per route: no sandbox exists, and nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { create, DaytonaProvider } from "../dist/daytona.js";
import { checkLifetime, kindRefusals } from "../dist/index.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const KEY = "daytona_fake_computer_key_0123456789";
const BARE = "daytona_bare_key_must_never_be_used";
const API = "https://api.daytona.test/api";
const TOOLBOX = "https://proxy.daytona.test/toolbox";
const COMPUTER = "agentrun.computer";
const SPEC = { image: "agentrun-debian", lifetimeMs: 600_000, network: "none" };
const GPU = { type: "H100", count: 1 };
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, mountMs: 2_000, retryMs: 1 };
const REF = { id: "sb-0001", name: "computer-0123456789ab" };

const dir = mkdtempSync(join(tmpdir(), "computer-daytona-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, Buffer.from("a stand-in for computerd, linux/amd64\n"));

const stray = [];
const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
before(() => {
	globalThis.fetch = async (...args) => {
		stray.push(["fetch", String(args[0])]);
		throw new Error("a test reached the global fetch");
	};
	globalThis.WebSocket = function WebSocket(url) {
		stray.push(["WebSocket", String(url)]);
		throw new Error("a test reached the global WebSocket");
	};
});
after(() => {
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	rmSync(dir, { recursive: true, force: true });
	assert.deepEqual(stray, [], "no request ever left for a real host");
});

/**
 * A fetch that records every request and answers it from `routes`, "<METHOD> <path>" to a reply ({ status, body }) or
 * a function of the request; any other request is refused 401, as Daytona refuses a key it does not take.
 */
function recorder(routes = {}) {
	const requests = [];
	const fetch = async (url, init = {}) => {
		const at = new URL(url);
		const request = { method: init.method, url: String(url), host: at.host, path: at.pathname, query: at.searchParams, headers: init.headers ?? {}, redirect: init.redirect, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
		requests.push(request);
		const route = routes[`${init.method} ${at.pathname}`];
		const reply = typeof route === "function" ? route(request) : (route ?? { status: 401, body: { statusCode: 401, message: "Invalid credentials" } });
		const status = reply.status ?? 200;
		return new Response(reply.body === undefined || status === 204 ? null : JSON.stringify(reply.body), { status, headers: { "content-type": "application/json" } });
	};
	return { requests, fetch };
}

/** No sandbox listed, and a create Daytona refuses (400): what create was asked to send is in the POST's body. */
const refusedCreate = () => recorder({ "GET /api/sandbox": { body: { items: [] } }, "POST /api/sandbox": { status: 400, body: { statusCode: 400, message: "snapshot not found" } } });

function setup(routes, options = {}) {
	const rec = recorder(routes);
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, ...options });
	return { rec, provider };
}

const posted = (rec) => rec.requests.find((r) => r.method === "POST" && r.path === "/api/sandbox")?.body;

async function withProcessEnv(values, fn) {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) process.env[name] = value;
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** A sandbox as Daytona reads one back that this provider made: over `fields`. */
function sandbox(fields = {}) {
	const deadline = new Date(Date.now() + 600_000).toISOString();
	return {
		id: REF.id,
		name: REF.name,
		snapshot: "agentrun-debian",
		state: "started",
		labels: { [COMPUTER]: "1", [`${COMPUTER}.name`]: REF.name, [`${COMPUTER}.image`]: "agentrun-debian", [`${COMPUTER}.deadline`]: deadline },
		public: false,
		networkBlockAll: true,
		autoStopInterval: 0,
		autoDeleteInterval: -1,
		autoDestroyAt: deadline,
		sandboxClass: "container",
		cpu: 1,
		memory: 1,
		toolboxProxyUrl: TOOLBOX,
		...fields,
	};
}

test("capabilities: a linux computer with init a child of Daytona's toolbox, a vendor lifetime up to 30 days, network none read back, a container, stop and delete, an Archil mount, and the toolbox's port", () => {
	const { provider, rec } = setup();
	assert.equal(provider.id, "daytona");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "vendor",
		network: ["none"],
		networkReadBack: true,
		isolation: "container",
		os: "linux",
		daemon: "child",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: 30 * 24 * 3600 * 1000,
		release: ["stop", "delete"],
		stopDeletes: false,
		mount: ["archil"],
		vendorAgentPorts: [2280],
		// daytona-gpu's one H100 and its limits: its stop deletes it, it runs in region earth, its size is the snapshot's, and
		// it takes no mount.
		gpu: { types: ["H100"], max: 1, preemptible: true, stopDeletes: true, region: "earth", perGpu: { cpus: 16, memoryMb: 102400, diskMb: 409600 }, mounts: [], unmounted: { why: "Daytona's GPU runtime gives it no /dev/fuse", yet: false } },
	});
	assert.deepEqual(kindRefusals(provider.capabilities()), []);
	assert.equal(provider.extend, undefined, "no extend(): Daytona's TTL is set once, at create");
	assert.equal(provider.stream, undefined, "no stream()");
	assert.equal(setup({}, { sandboxClass: "linux-vm" }).provider.capabilities().isolation, "vm");
	assert.equal(setup({}, { autoDeleteMinutes: 0 }).provider.capabilities().stopDeletes, true, "autoDeleteMinutes 0: Daytona deletes a sandbox as it stops");
	assert.equal(setup({}, { autoDeleteMinutes: 30 }).provider.capabilities().stopDeletes, false, "a stopped computer is kept for 30 minutes");
	assert.deepEqual(setup({}, { gpuSnapshot: "agentrun-archil-gpu-h100-0123456789ab" }).provider.capabilities().gpu.types, ["H100"]);
	assert.equal(rec.requests.length, 0);
});

test("the constructor refuses what it cannot run with, in words", () => {
	const make = (options) => () => new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => assert.fail("no request"), ...options });
	assert.throws(make({ apiKey: "" }), /API key is required/);
	assert.throws(() => create({ daemonPath: DAEMON }), /options\.apiKey/);
	assert.throws(make({ apiUrl: "http://api.daytona.test/api" }), /must be https/);
	assert.throws(make({ daemonUser: "0:0" }), /root/);
	assert.throws(make({ daemonUser: "1000:0" }), /root's group/);
	for (const daemonUser of ["00:1000", "000:000", "1000:00", "0:01000"]) assert.throws(make({ daemonUser }), /root or in root's group/, daemonUser);
	assert.throws(make({ daemonUser: "daytona" }), /uid:gid in numbers/);
	assert.throws(make({ sandboxClass: "windows" }), /container or linux-vm/);
	assert.throws(make({ arch: "riscv64" }), /amd64 or arm64/);
	for (const value of [-1, 1.5, "30"]) {
		assert.throws(make({ autoStopMinutes: value }), /autoStopMinutes is a whole number of minutes/, String(value));
		assert.throws(make({ autoDeleteMinutes: value }), /autoDeleteMinutes is a whole number of minutes/, String(value));
	}
	assert.throws(make({ gpuSnapshot: "someone-elses-gpu" }), /not a GPU snapshot of box\/Dockerfile/);
	assert.throws(make({ archilEgress: "10.60.0.40:8100:42050" }), /the Archil egress is/);
	assert.throws(make({ timeouts: { retryMs: 0 } }), /retryMs/);
});

test("check() refuses in words, field by field, before any request", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, labels: { team: "a" } }), []);
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	const words = (spec) => provider.check(spec).map((r) => r.message).join("; ");
	for (const image of ["", undefined, "   ", "snap\nshot"]) assert.deepEqual(refused({ ...SPEC, image }), ["image"], JSON.stringify(image));
	for (const lifetimeMs of [undefined, 0, -1, 1.5, "600000", 30 * 24 * 3600 * 1000 + 1]) {
		assert.deepEqual(provider.check({ ...SPEC, lifetimeMs }), checkLifetime(lifetimeMs, provider.capabilities()), `${String(lifetimeMs)}: the shared rule, in its words`);
	}
	assert.match(words({ ...SPEC, lifetimeMs: 30 * 24 * 3600 * 1000 + 1 }), /at most 30 days \(2592000000 ms\)/);
	for (const network of ["wifi", "open", { allow: [] }, { allow: ["example.com"] }, { allow: ["208.80.154.232/32"] }]) assert.deepEqual(refused({ ...SPEC, network }), ["network"], JSON.stringify(network));
	for (const field of ["cpus", "memoryMb", "pids"]) assert.match(words({ ...SPEC, [field]: 2 }), /size of its image/);
	assert.match(words({ ...SPEC, user: "0" }), /daemon user \(2510:2510\)/);
	assert.match(words({ ...SPEC, workdir: "/data" }), /works in \/work/);
	assert.match(words({ ...SPEC, gpu: 1 }), /gpu is \{ type, count \}/);
	assert.match(words({ ...SPEC, gpu: { type: "T4", count: 1 } }), /not one this provider offers: H100$/);
	// A GPU computer is made from daytona-gpu: a spec names it or "default", never another snapshot.
	for (const image of ["default", "daytona-gpu"]) assert.deepEqual(provider.check({ ...SPEC, image, gpu: GPU }), [], image);
	assert.deepEqual(refused({ ...SPEC, gpu: GPU }), ["image"]);
	assert.match(words({ ...SPEC, gpu: GPU }), /^a Daytona GPU computer here is made from the GPU snapshot daytona-gpu alone, not "agentrun-debian": give "daytona-gpu" or "default"/);
	assert.deepEqual(refused({ ...SPEC, labels: { "agentrun.computer.deadline": "never" } }), ["labels"]);
	assert.deepEqual(refused({ ...SPEC, labels: { team: 1 } }), ["labels"]);
	assert.equal(rec.requests.length, 0, "check makes no request");
});

test("create() asks Daytona for the request's name and labels, a TTL in whole minutes, no public port, network none, and no resources", async () => {
	const rec = refusedCreate();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, target: "eu", autoStopMinutes: 15, autoDeleteMinutes: 30 });
	const spec = { ...SPEC, lifetimeMs: 600_500, labels: { team: "a" } };
	const made = await provider.create(spec, { requestId: "r-body" });
	assert.equal(made.error?.code, "invalid", "a create Daytona refused made nothing");
	assert.equal(rec.requests.filter((r) => r.method === "DELETE").length, 0, "and nothing is deleted after it");
	const body = posted(rec);
	assert.match(body.name, /^computer-[0-9a-f]{12}$/);
	assert.equal(body.labels[`${COMPUTER}.name`], body.name, "the native name and the adapter's name label agree");
	assert.equal(body.labels.team, "a");
	assert.equal(body.labels[COMPUTER], "1");
	assert.equal(body.labels[`${COMPUTER}.image`], "agentrun-debian");
	assert.equal(body.snapshot, "agentrun-debian");
	assert.equal(body.target, "eu");
	assert.equal(body.ttlMinutes, 11, "whole minutes, up: never under the lifetime");
	assert.equal(body.autoStopInterval, 15);
	assert.equal(body.autoDeleteInterval, 30);
	assert.equal(body.networkBlockAll, true);
	assert.equal(body.public, false);
	assert.deepEqual(body.env, {});
	for (const field of ["cpu", "gpu", "gpuType", "memory", "disk"]) assert.equal(Object.hasOwn(body, field), false, `${field}: a snapshot carries its own resources`);
	// The same request again is the same name: Daytona never holds two sandboxes of one request.
	await provider.create(spec, { requestId: "r-body" });
	const names = rec.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").map((r) => r.body.name);
	assert.equal(names.length, 2);
	assert.equal(new Set(names).size, 1);
});

test('create(): image "default" sends no snapshot, so Daytona makes the sandbox from its default; unset, autoDeleteMinutes sends -1', async () => {
	const rec = refusedCreate();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS });
	await provider.create({ ...SPEC, image: "default" }, { requestId: "r-default" });
	const body = posted(rec);
	assert.equal(Object.hasOwn(body, "snapshot"), false);
	assert.equal(Object.hasOwn(body, "target"), false, "no target: the organization's");
	assert.equal(body.autoStopInterval, 0);
	assert.equal(body.autoDeleteInterval, -1);
});

test("create() of a GPU computer asks for the GPU snapshot and no resources, ephemeral (autoDeleteInterval 0) in region earth, whatever the target", async () => {
	for (const [options, snapshot] of [
		[{}, "daytona-gpu"],
		[{ gpuSnapshot: "agentrun-archil-gpu-h100-0123456789ab" }, "agentrun-archil-gpu-h100-0123456789ab"],
	]) {
		const rec = refusedCreate();
		const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, target: "eu", autoDeleteMinutes: 30, ...options });
		await provider.create({ ...SPEC, image: "default", gpu: GPU }, { requestId: `r-gpu-${snapshot}` });
		const body = posted(rec);
		assert.equal(body.snapshot, snapshot);
		assert.equal(body.target, "earth");
		assert.equal(body.autoDeleteInterval, 0);
		for (const field of ["cpu", "gpu", "gpuType", "memory", "disk"]) assert.equal(Object.hasOwn(body, field), false, field);
	}
});

test("a name Daytona already holds (409) is exists, and makes and deletes nothing", async () => {
	const { rec, provider } = setup({ "GET /api/sandbox": { body: { items: [] } }, "POST /api/sandbox": { status: 409, body: { statusCode: 409, message: "Sandbox with name computer-x already exists" } } });
	const made = await provider.create(SPEC, { requestId: "r-409" });
	assert.equal(made.error?.code, "exists", JSON.stringify(made));
	assert.equal(rec.requests.filter((r) => r.method === "DELETE").length, 0);
});

test("the read-back: the idle stop and auto-delete Daytona keeps, its TTL, the class, no public port, no KVM, the snapshot and the GPUs, each held to what was asked", async () => {
	const read = async (fields, options = {}) => {
		const sb = sandbox(fields);
		const { provider } = setup({ [`GET /api/sandbox/${sb.id}`]: { body: sb } }, options);
		return (await provider.host.get(sb.id, { timeoutMs: 1_000 })).value;
	};
	const clean = await read();
	assert.equal(clean.drift, undefined, JSON.stringify(clean.drift));
	assert.equal(clean.state, "running");
	assert.equal(clean.network, "none");
	assert.deepEqual(clean.image, { resolved: "agentrun-debian" });
	assert.deepEqual(clean.size, { cpus: 1, memoryMb: 1024 });
	const drift = async (fields, pattern, options) => {
		const machine = await read(fields, options);
		assert.ok(machine.drift?.some((line) => pattern.test(line)), `${JSON.stringify(fields)}: ${JSON.stringify(machine.drift)}`);
	};
	// Money backstops: an idle stop or an auto-delete Daytona did not keep, and a TTL past the deadline.
	await drift({ autoStopInterval: 60 }, /^autoStopInterval: declared 15, read back 60$/, { autoStopMinutes: 15 });
	await drift({ autoDeleteInterval: -1 }, /^autoDeleteInterval: declared 0, read back -1$/, { autoDeleteMinutes: 0 });
	await drift({ autoDestroyAt: new Date(Date.now() + 3_600_000).toISOString() }, /^autoDestroyAt: .* is past the deadline/);
	await drift({ autoDestroyAt: undefined }, /Daytona would not end the computer/);
	await drift({ sandboxClass: "linux-vm" }, /^sandboxClass: declared "container", read back "linux-vm"$/);
	await drift({ public: true }, /^public: declared false, read back true$/);
	await drift({ kvm: true }, /^kvm: declared false, read back true$/);
	await drift({ snapshot: "someone-else" }, /^snapshot: declared "agentrun-debian", read back "someone-else"$/);
	await drift({ volumes: [{ volumeId: "v" }] }, /^volumes:/);
	await drift({ linkedSandboxId: "sb-9" }, /^linkedSandboxId:/);
	// A computer of Daytona's default snapshot is not held to a name: Daytona names its default as it likes.
	const byDefault = await read({ snapshot: "daytona-default-v3", labels: { ...sandbox().labels, [`${COMPUTER}.image`]: "default" } });
	assert.equal(byDefault.drift, undefined, JSON.stringify(byDefault.drift));
	// A GPU computer it reports is held to the GPU snapshot's GPU and its ephemeral stop.
	const gpu = await read({ snapshot: "daytona-gpu", gpu: 1, gpuType: "H100", autoDeleteInterval: 0, labels: { ...sandbox().labels, [`${COMPUTER}.image`]: "default" } });
	assert.equal(gpu.drift, undefined, JSON.stringify(gpu.drift));
	assert.deepEqual(gpu.gpu, GPU);
	await drift({ snapshot: "daytona-gpu", gpu: 1, gpuType: "A100", autoDeleteInterval: 0 }, /^gpuType: declared "H100", read back "A100"$/);
});

test("the read-back: Daytona's states as the adapter's, its network in words, and a destroyed sandbox gone", async () => {
	const read = async (fields) => {
		const sb = sandbox(fields);
		const { provider } = setup({ [`GET /api/sandbox/${sb.id}`]: { body: sb } });
		return (await provider.host.get(sb.id, { timeoutMs: 1_000 })).value;
	};
	for (const [state, want] of [
		["started", "running"],
		["creating", "starting"],
		["pulling_snapshot", "starting"],
		["stopping", "stopped"],
		["stopped", "stopped"],
		["archived", "stopped"],
		["destroying", "going"],
		["error", "failed"],
	]) {
		assert.equal((await read({ state })).state, want, state);
	}
	assert.equal((await read({ state: "started", desiredState: "destroyed" })).state, "going");
	assert.equal((await read({ state: "error", errorReason: "no capacity" })).why, "no capacity");
	assert.equal(await read({ state: "destroyed" }), undefined, "a destroyed sandbox is one Daytona no longer has");
	assert.deepEqual((await read({ networkBlockAll: false })).network, "open");
	assert.deepEqual((await read({ networkBlockAll: false, domainAllowList: "example.com" })).network, { allow: ["example.com"] });
	assert.deepEqual((await read({ outboundProxyUrl: "http://proxy" })).network, { other: "an outbound proxy is set on it" });
	assert.deepEqual((await read({ networkBlockAll: undefined })).network, { other: "Daytona did not report networkBlockAll" });
	const { provider } = setup({ [`GET /api/sandbox/${REF.id}`]: { status: 404, body: { statusCode: 404, message: "not found" } } });
	assert.deepEqual(await provider.host.get(REF.id, { timeoutMs: 1_000 }), { ok: true, value: undefined });
});

test("list: the adapter's label alone is asked for, every page followed, the rest filtered here; one whose listing leaves the network out is read back", async () => {
	const mine = sandbox({ id: "sb-1", networkBlockAll: undefined, labels: { ...sandbox().labels, team: "a" } });
	const other = sandbox({ id: "sb-2", labels: { ...sandbox().labels, team: "b" } });
	const destroyed = sandbox({ id: "sb-3", state: "destroyed", labels: { ...sandbox().labels, team: "a" } });
	const { rec, provider } = setup({
		"GET /api/sandbox": (request) => (request.query.get("cursor") === null ? { body: { items: [mine, destroyed], nextCursor: "page-2" } } : { body: { items: [other] } }),
		"GET /api/sandbox/sb-1": { body: { ...mine, networkBlockAll: true } },
	});
	const listed = await provider.host.list({ team: "a" }, { timeoutMs: 1_000 });
	assert.deepEqual(listed.value.map((m) => [m.id, m.network]), [["sb-1", "none"]]);
	const pages = rec.requests.filter((r) => r.path === "/api/sandbox");
	assert.equal(pages.length, 2);
	for (const page of pages) assert.deepEqual(JSON.parse(page.query.get("labels")), { [COMPUTER]: "1" });
});

test("every request carries the key passed in, the source header and no redirect, whatever DAYTONA_ or COMPUTER_DAYTONA_ names hold; a refused key is never echoed", async () => {
	const rec = recorder();
	await withProcessEnv({ DAYTONA_API_KEY: BARE, COMPUTER_DAYTONA_API_KEY: BARE, DAYTONA_API_URL: "https://prod.example.invalid" }, async () => {
		const provider = create({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS });
		assert.equal((await provider.create(SPEC, { requestId: "r-key" })).error?.code, "denied", "the listing by name the create starts with");
		assert.equal((await provider.list({})).error?.code, "denied");
		const tested = await provider.testConnection();
		assert.equal(tested.error?.code, "unauthorized");
		assert.doesNotMatch(tested.error.message, new RegExp(KEY));
		assert.equal((await provider.release(REF, "delete")).error?.code, "denied");
		assert.equal((await provider.connect(REF)).error?.code, "denied");
		assert.equal((await provider.attach({ labels: { team: "a" } })).error?.code, "denied");
	});
	assert.ok(rec.requests.length >= 6);
	for (const request of rec.requests) {
		assert.equal(request.host, "api.daytona.test", `${request.method} ${request.path}: options.apiUrl, never DAYTONA_API_URL`);
		assert.equal(request.headers.Authorization, `Bearer ${KEY}`, `${request.method} ${request.path}`);
		assert.equal(request.headers["X-Daytona-Source"], "agentrun-computer");
		assert.equal(request.redirect, "error", `${request.method} ${request.path}: a followed redirect would keep the key`);
	}
	assert.doesNotMatch(JSON.stringify(rec.requests), new RegExp(BARE));
});

test("a redirect is never followed, and a toolbox URL that is not https is refused before the key is sent to it", async () => {
	const redirecting = new DaytonaProvider({
		apiKey: KEY,
		apiUrl: API,
		daemonPath: DAEMON,
		timeouts: TIMEOUTS,
		fetch: async () => {
			throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
		},
	});
	const listed = await redirecting.list({});
	assert.equal(listed.error?.code, "vendor");
	assert.match(listed.error.message, /redirect, which is never followed/);
	const sb = sandbox({ toolboxProxyUrl: "http://proxy.daytona.test/toolbox" });
	const { rec, provider } = setup({ [`GET /api/sandbox/${sb.id}`]: { body: sb } });
	const connected = await provider.connect(REF);
	assert.equal(connected.error?.code, "vendor");
	assert.match(connected.error.message, /not https/);
	assert.deepEqual([...new Set(rec.requests.map((r) => r.host))], ["api.daytona.test"], "nothing went to the toolbox");
});

test("network(): reads none back, and refuses any change, with refused and no request: a Daytona computer's network is fixed at create", async () => {
	const { rec, provider } = setup({ [`GET /api/sandbox/${REF.id}`]: { body: sandbox() } });
	for (const policy of ["open", { allow: ["example.com"] }, { allow: ["10.0.0.0/8"] }, "wifi"]) {
		const changed = await provider.network(REF, policy);
		assert.equal(changed.error?.code, "refused", JSON.stringify(policy));
		assert.match(changed.error.message, /fixed at create/);
	}
	assert.deepEqual(rec.requests, [], "a refused change asks Daytona nothing");
	assert.deepEqual(await provider.network(REF), { ok: true, value: "none" });
	assert.deepEqual(await provider.network(REF, "none"), { ok: true, value: "none" });
	assert.ok(rec.requests.every((r) => r.method === "GET"), "and never POST network-settings");
});

/** A toolbox that takes a session and records the command each exec is given, then refuses the command (400). */
function toolboxRecorder() {
	const commands = [];
	const rec = recorder({ [`GET /api/sandbox/${REF.id}`]: { body: sandbox() }, [`POST /toolbox/${REF.id}/process/session`]: { body: {} } });
	const fetch = async (url, init = {}) => {
		const at = new URL(url);
		if (init.method === "POST" && /\/process\/session\/[^/]+\/exec$/.test(at.pathname)) {
			rec.requests.push({ method: init.method, host: at.host, path: at.pathname, headers: init.headers ?? {} });
			commands.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ statusCode: 400, message: "refused" }), { status: 400 });
		}
		if (init.method === "DELETE") return new Response(null, { status: 204 });
		return rec.fetch(url, init);
	};
	return { commands, fetch, requests: rec.requests };
}

test("exec is a session command of its own: argv as one shell line, async, no input echo; with archilEgress, the helper's mount and revoke take egress= as their last word", async () => {
	const helper = "/usr/local/sbin/agentrun-archil";
	const run = async (options, argv) => {
		const tb = toolboxRecorder();
		const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: tb.fetch, timeouts: TIMEOUTS, ...options });
		const ran = await provider.host.exec(REF.id, argv, { stdin: true }, { timeoutMs: 1_000 });
		assert.equal(ran.ok, false);
		assert.equal(tb.commands.length, 1);
		assert.equal(tb.commands[0].runAsync, true);
		assert.equal(tb.commands[0].suppressInputEcho, true);
		for (const request of tb.requests) assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
		return tb.commands[0].command;
	};
	const egress = { archilEgress: "10.60.0.40:18100:42050" };
	assert.equal(await run(egress, [helper, "mount", "dsk", "aws-us-east-1", "/agents/a1/runs/r1/work"]), `${helper} mount dsk aws-us-east-1 /agents/a1/runs/r1/work egress=10.60.0.40:18100:42050`);
	assert.equal(await run(egress, [helper, "revoke", "dsk", "aws-us-east-1", "/f"]), `${helper} revoke dsk aws-us-east-1 /f egress=10.60.0.40:18100:42050`);
	assert.equal(await run(egress, [helper, "serve"]), `${helper} serve`, "serve takes no gateway");
	assert.equal(await run({}, [helper, "mount", "dsk", "aws-us-east-1", "/f"]), `${helper} mount dsk aws-us-east-1 /f`, "no gateway, no egress word");
	assert.equal(await run({ archilEgress: "" }, [helper, "mount", "dsk", "aws-us-east-1", "/f"]), `${helper} mount dsk aws-us-east-1 /f`, "an empty setting is none");
	assert.equal(await run({}, ["sh", "-c", 'echo "$1"', "sh", "it's"]), `sh -c 'echo "$1"' sh 'it'\\''s'`, "every word but a plain one quoted");
});

test("the loopback block: network none only, the toolbox's port declared, and open and allowlists refused in words", () => {
	const { provider } = setup();
	const { network, vendorAgentPorts } = provider.capabilities();
	assert.deepEqual(network, ["none"]);
	assert.deepEqual(vendorAgentPorts, [2280]);
	for (const policy of ["open", { allow: ["example.com"] }]) assert.match(provider.check({ ...SPEC, network: policy }).map((r) => r.message).join(" "), /network of their own/);
});

test("the provider writes nowhere but its results, and reads no environment: its source has no console, no stdio and no process.env", () => {
	const source = readFileSync(new URL("../src/daytona.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /console\.|process\.std(out|err)/);
	assert.doesNotMatch(source, /process\.env/);
});
