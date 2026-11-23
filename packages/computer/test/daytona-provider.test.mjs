// DaytonaProvider without a vendor fake: what Daytona's own host decides (its capabilities, its check, the create body,
// how it reads a sandbox back, the key on every request and where requests may go, the network it refuses to change),
// each read from options or from what an injected fetch is handed. The adapter's lifecycle is tested once, against its
// one fake host (hosted-provider.test.mjs); Daytona's own lifecycle is proven live (test/daytona). The fetch here only
// records what it is given and answers one canned reply per route: no sandbox exists, and nothing reaches the network.
// One test, the desktop over dial, routes to a sandbox it keeps, booted from its env (fake-dial-host.mjs bootDial).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { create, DaytonaProvider } from "../dist/daytona.js";
import { dialLaunch } from "../dist/hosted/scripts.js";
import { AttachHub, checkLifetime, DAYTONA, kindRefusals, MACHINE_TOKEN_SOURCE, MemoryMachineTokens, mountsOf } from "../dist/index.js";
import { bootDial, desktopOverDial, dialServer } from "./fake-dial-host.mjs";
import { fakeHost } from "./fake-host.mjs";

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

/** An Archil egress relay's address: a documentation address (RFC 5737), the mount lane and the data lane. */
const EGRESS = "192.0.2.40:18100:42050";

/**
 * The Daytona provider's host with its calls played by the adapter's one fake host (fake-host.mjs), its descriptor and
 * facts the provider's own: what the adapter does with the Daytona provider's options (archilEgress) is then what the
 * fake records, with no Daytona request.
 */
function fakeHostFor(provider) {
	const fake = fakeHost({ descriptor: provider.host.descriptor, facts: { ...provider.host.facts }, box: { reached: [] } });
	for (const call of ["create", "get", "list", "delete", "exec", "upload", "errorCode"]) provider.host[call] = fake.host[call].bind(fake.host);
	return { host: provider.host, rootRuns: fake.rootRuns };
}

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
		if (reply.text !== undefined) return new Response(reply.text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
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

test("capabilities: a linux computer with init a child of Daytona's toolbox, a vendor lifetime up to 30 days, network none, open and a list probed from inside, a container, delete only, a synced folder, and the toolbox's port", () => {
	const { provider, rec } = setup();
	assert.equal(provider.id, "daytona");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "vendor",
		network: ["none", "open", "allow"],
		allow: { domains: { max: 256, ports: [80, 443] }, cidrs: { max: 256, ports: [80, 443] }, mixed: true },
		networkReadBack: false,
		isolation: "container",
		os: "linux",
		daemon: "child",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: 30 * 24 * 3600 * 1000,
		release: ["delete"],
		mount: ["sync"],
		vendorAgentPorts: [2280],
		// daytona-gpu's one H100 and its limits: its stop deletes it, it runs in region earth, its size is the snapshot's, and
		// it takes a synced folder alone.
		gpu: { types: ["H100"], max: 1, preemptible: true, stopDeletes: true, region: "earth", perGpu: { cpus: 16, memoryMb: 102400, diskMb: 409600 }, mounts: ["sync"], unmounted: { why: "Daytona's GPU runtime gives it no /dev/fuse", yet: false } },
	});
	assert.deepEqual(kindRefusals(provider.capabilities()), []);
	assert.equal(provider.extend, undefined, "no extend(): Daytona's TTL is set once, at create");
	assert.equal(provider.stream, undefined, "no stream()");
	assert.equal(setup({}, { sandboxClass: "linux-vm" }).provider.capabilities().isolation, "vm");
	assert.deepEqual(setup({}, { gpuSnapshot: "agentrun-archil-gpu-h100-0123456789ab" }).provider.capabilities().gpu.types, ["H100"]);
	assert.equal(rec.requests.length, 0);
});

test("capabilities with an Archil egress: the provider declares an Archil mount beside the synced folder, as the descriptor's mountsWith says for DAYTONA_ARCHIL_EGRESS; its GPU computers still take a synced folder alone", () => {
	const { provider, rec } = setup({}, { archilEgress: EGRESS });
	assert.deepEqual(provider.capabilities().mount, ["archil", "sync"]);
	assert.deepEqual(provider.capabilities().gpu.mounts, ["sync"], "Daytona's GPU host gives no /dev/fuse");
	// The provider's facts and the descriptor's agree: what mountsOf gives for the key set, and for none.
	assert.deepEqual({ mounts: provider.capabilities().mount, unmounted: provider.host.descriptor.unmounted }, mountsOf(DAYTONA, (name) => name === "DAYTONA_ARCHIL_EGRESS"));
	assert.deepEqual(provider.host.descriptor.unmounted, {}, "no reason left for the kind it now takes");
	const plain = setup().provider;
	assert.deepEqual({ mounts: plain.capabilities().mount, unmounted: plain.host.descriptor.unmounted }, mountsOf(DAYTONA, () => false));
	assert.deepEqual(DAYTONA.mounts, [], "the static descriptor lists no mount: hosted Daytona is the default, and the synced folder is derived");
	assert.deepEqual(setup({}, { archilEgress: "" }).provider.capabilities().mount, ["sync"], "an empty egress is none");
	assert.equal(rec.requests.length, 0);
});

test("the constructor refuses what it cannot run with, in words", () => {
	const make = (options) => () => new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => assert.fail("no request"), ...options });
	assert.throws(make({ apiKey: "" }), /the Daytona API key, is required/);
	assert.throws(() => create({ daemonPath: DAEMON }), /options\.apiKey/);
	for (const apiUrl of ["http://api.daytona.test/api", "http://127.0.0.1:3000/api", "http://localhost:3000/api"]) assert.throws(make({ apiUrl }), /^Error: the Daytona API URL must be https, so the key never crosses in the clear: http:$/, apiUrl);
	assert.throws(make({ apiUrl: "api.daytona.test" }), /^Error: the Daytona API URL is not a URL: "api\.daytona\.test"$/);
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
	assert.throws(make({ archilEgress: "192.0.2.40:8100:42050" }), /the Archil egress is <IPv4 gateway>:<mount lane>:<data lane>/);
	assert.throws(make({ archilEgress: "relay.example:18100:42050" }), /the Archil egress is/);
	assert.doesNotThrow(make({ archilEgress: EGRESS }), "a well-formed egress is taken");
	for (const attachEgress of ["relay.example:18443", "192.0.2.40", "192.0.2.40:0", "192.0.2.40:65536", "192.0.2.40:018443", "192.0.2.040:18443", "[2001:db8::1]:18443", "192.0.2.40:18443:1", " 192.0.2.40:18443"]) {
		assert.throws(make({ attachEgress }), /the attach egress is <IPv4 relay>:<port>, such as 192\.0\.2\.40:18443, a port from 1 to 65535; not "/, attachEgress);
	}
	assert.doesNotThrow(make({ attachEgress: "192.0.2.40:18443" }), "a well-formed attach egress is taken");
	assert.doesNotThrow(make({ attachEgress: "" }), "an empty one is none");
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
	for (const network of ["wifi", { allow: [] }, { allow: ["10.0.0.0/8"] }]) assert.deepEqual(refused({ ...SPEC, network }), ["network"], JSON.stringify(network));
	for (const network of ["open", { allow: ["example.com"] }, { allow: ["208.80.154.232/32"] }]) assert.deepEqual(refused({ ...SPEC, network }), [], JSON.stringify(network));
	for (const field of ["cpus", "memoryMb"]) assert.match(words({ ...SPEC, [field]: 2 }), new RegExp(`a Daytona computer has the size of its snapshot: name a snapshot of the size you need, not ${field}`));
	assert.match(words({ ...SPEC, pids: 2 }), /size of its image/);
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

// On Daytona's hosted cloud, Archil's client (0.10.1) never answers its own FUSE INIT on its container (Sysbox)
// sandboxes, on every kernel and mount shape tried (live 11-14). So a provider made with no Archil egress declares no
// mount, and a create that asks for one is refused up front in one sentence saying why: never a sandbox made and a 120 s
// timeout. A self-hosted Daytona target whose sandboxes reach Archil through the operator's egress relay mounts it (live
// 11-14): a provider made with archilEgress takes the mount.
const ARCHIL_SPEC = {
	...SPEC,
	labels: { "agentrun.run": "r1", "agentrun.epoch": "3" },
	mount: { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: "tok-daytona-archil-0123456789abcdef" },
};
const NO_ARCHIL = "Archil mounts don't work on Daytona's hosted cloud, where Archil's client hangs on its sandboxes; a self-hosted Daytona target takes one once its operator sets DAYTONA_ARCHIL_EGRESS";

test("with no Archil egress (hosted Daytona), an Archil mount is refused up front, in one sentence saying why, and nothing is asked of Daytona", async () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.capabilities().mount, ["sync"], "Daytona declares a synced folder alone");
	assert.deepEqual(provider.check(ARCHIL_SPEC), [{ field: "mount", message: NO_ARCHIL }], "exactly one refusal");
	assert.deepEqual(provider.check({ ...ARCHIL_SPEC, gpu: GPU, image: "daytona-gpu" }).map((r) => r.message)[0], NO_ARCHIL, "a GPU computer's own refusal comes after it");
	const made = await provider.create(ARCHIL_SPEC, { requestId: "r-archil" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused", "a mount kind Daytona doesn't declare");
	assert.ok(made.error.message.includes(NO_ARCHIL), made.error.message);
	assert.ok(!made.error.message.includes(ARCHIL_SPEC.mount.token), "the refusal holds no token");
	assert.ok(!made.error.message.includes(KEY), "the refusal holds no key");
	assert.equal(rec.requests.length, 0, "no request: no sandbox is made to time out");
});

test("with an Archil egress, check() takes an Archil mount and create() asks Daytona for a sandbox with egress for the mount's root steps; a GPU computer still takes none, in its own words", async () => {
	const rec = refusedCreate();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, archilEgress: EGRESS });
	assert.deepEqual(provider.check(ARCHIL_SPEC), [], "the mount is taken");
	const gpu = provider.check({ ...ARCHIL_SPEC, gpu: GPU, image: "daytona-gpu" }).map((r) => r.message);
	assert.equal(gpu.length, 1, gpu.join("; "));
	assert.ok(!gpu[0].includes(NO_ARCHIL), "a GPU computer is refused by its GPU's words, not hosted Daytona's");
	const made = await provider.create(ARCHIL_SPEC, { requestId: "r-archil-egress" });
	assert.equal(made.ok, false, "the fake refuses the create (400)");
	assert.equal(posted(rec).networkBlockAll, false, "the sandbox may reach the relay: the mount's root steps need it");
	for (const text of [made.error.message, JSON.stringify(rec.requests.map((r) => r.body ?? null))]) {
		assert.ok(!text.includes(ARCHIL_SPEC.mount.token), "no token in the error or in what Daytona is sent");
		assert.ok(!text.includes(KEY), "no key in the error or in a request's body");
	}
});

test("with an Archil egress, the helper's mount names it as its last word: the Daytona provider's own option, through the adapter (its host's calls played by the adapter's fake host)", async () => {
	// The listing's stability window 0, as the adapter's own fake-host tests run it: two consecutive polls suffice.
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => assert.fail("no request to Daytona"), timeouts: { ...TIMEOUTS, listedStableMs: 0 }, archilEgress: EGRESS });
	const { host, rootRuns } = fakeHostFor(provider);
	assert.equal(host.descriptor.mounts.includes("archil"), true);
	const made = await provider.create(ARCHIL_SPEC, { requestId: "r-archil-fake" });
	assert.equal(made.ok, true, made.ok ? "" : `${made.error.code}: ${made.error.message}`);
	const mount = rootRuns.find(({ verb }) => verb === "mount");
	assert.ok(mount, "the helper's mount ran");
	assert.equal(mount.argv.at(-1), `egress=${EGRESS}`);
	assert.ok(!mount.argv.join(" ").includes(ARCHIL_SPEC.mount.token), "the token goes on stdin alone, never in argv");
});

test("DAYTONA_LISTED_MS is the provider's listedMs, create's wait for Daytona's eventually consistent label listing: a sandbox still unlisted then that reads started is kept; a value that is not a whole number of ms above 0 is refused", async () => {
	assert.deepEqual(DAYTONA.keys.find((key) => key.name === "DAYTONA_LISTED_MS"), { name: "DAYTONA_LISTED_MS", option: "listedMs", required: false });
	const { listedMs: _unset, ...timeouts } = TIMEOUTS;
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => assert.fail("no request to Daytona"), timeouts, listedMs: "300" });
	const { host } = fakeHostFor(provider);
	host.list = async () => [];
	const made = await provider.create(SPEC, { requestId: "r-listed-ms" });
	assert.equal(made.ok, true, made.ok ? "" : `${made.error.code}: ${made.error.message}`);
	assert.match(made.value.notes.join("\n"), /did not show computer-[0-9a-f]{12} \(machine [^)]+\) on 2 polls in a row within 0\.3 s .*so it is kept/);
	const make = (listedMs) => () => new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => assert.fail("no request"), listedMs });
	for (const bad of ["0", "-5", "1.5", "15s", 0, 2.5]) assert.throws(make(bad), /listedMs \(DAYTONA_LISTED_MS\) is a whole number of ms above 0/, String(bad));
	assert.doesNotThrow(make(" 45000 "));
	assert.doesNotThrow(make(""));
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

test("the read-back: Daytona's states as the adapter's, its end, its GPUs and its words for a failure; a destroyed sandbox is none", async () => {
	const read = async (fields) => {
		const sb = sandbox(fields);
		const { provider } = setup({ [`GET /api/sandbox/${sb.id}`]: { body: sb } });
		return await provider.host.get(sb.id, { timeoutMs: 1_000 });
	};
	const autoDestroyAt = "2026-01-02T03:04:05.000Z";
	const clean = await read({ autoDestroyAt });
	assert.deepEqual(Object.keys(clean).sort(), ["endsAt", "id", "labels", "resources", "state"], "no drift, network or image: Daytona's create options are not read back; what it gave the sandbox is (resources)");
	assert.equal(clean.state, "running");
	assert.equal(clean.endsAt.toISOString(), autoDestroyAt);
	for (const [state, want] of [
		["started", "running"],
		["creating", "starting"],
		["pulling_snapshot", "starting"],
		["stopping", "stopped"],
		["pausing", "stopped"],
		["stopped", "stopped"],
		["archived", "stopped"],
		["destroying", "gone"],
		["error", "gone"],
	]) {
		assert.equal((await read({ state })).state, want, state);
	}
	// A sandbox being destroyed cannot start again: it reads gone, while the wait after a delete waits for Daytona's 404.
	assert.equal((await read({ state: "started", desiredState: "destroyed" })).state, "gone", "asked to destroy, still started: going");
	assert.equal((await read({ state: "error", errorReason: "no capacity" })).why, "no capacity");
	assert.equal((await read({ state: "build_failed" })).why, "Daytona reads the sandbox build_failed, with no reason given", "a failed sandbox with no reason still carries a why");
	assert.equal((await read({ state: "destroying" })).why, undefined);
	assert.equal(await read({ state: "destroyed" }), undefined, "a destroyed sandbox is one Daytona no longer has");
	assert.equal(Object.hasOwn(await read({ snapshot: "daytona-gpu", gpu: 1, gpuType: "H100", autoDeleteInterval: 0 }), "gpu"), false, "a GPU is the adapter's label, not a read-back");
	const { provider } = setup({ [`GET /api/sandbox/${REF.id}`]: { status: 404, body: { statusCode: 404, message: "not found" } } });
	assert.equal(await provider.host.get(REF.id, { timeoutMs: 1_000 }), undefined);
});

test("the read-back's resources are what Daytona's answer says the sandbox was given (memory and disk in GiB), each only where it says it", async () => {
	const read = async (fields) => {
		const sb = sandbox(fields);
		const { provider } = setup({ [`GET /api/sandbox/${sb.id}`]: { body: sb } });
		return await provider.host.get(sb.id, { timeoutMs: 1_000 });
	};
	assert.deepEqual((await read({ cpu: 4, memory: 8, disk: 10, gpu: 1, gpuType: "H100" })).resources, { cpus: 4, memoryMb: 8192, diskGb: 10, gpu: { type: "H100", count: 1 } });
	assert.deepEqual((await read({ cpu: 2, memory: 4 })).resources, { cpus: 2, memoryMb: 4096 }, "no disk or GPU said: none");
	assert.deepEqual((await read({ cpu: 2, memory: undefined, gpu: 0, gpuType: "H100" })).resources, { cpus: 2 }, "no GPUs given");
	assert.deepEqual((await read({ cpu: 2, memory: undefined, gpu: 1 })).resources, { cpus: 2 }, "a GPU count with no type is no GPU figure");
	assert.equal(Object.hasOwn(await read({ cpu: "four", memory: -1 }), "resources"), false, "a figure that is not a positive number is none");
});

test("list: the adapter's label alone is asked for, every page followed, destroyed ones left out; the adapter keeps the rest by labels and reads each by get", async () => {
	const mine = sandbox({ id: "sb-1", labels: { ...sandbox().labels, team: "a" } });
	const other = sandbox({ id: "sb-2", labels: { ...sandbox().labels, team: "b" } });
	const destroyed = sandbox({ id: "sb-3", state: "destroyed", labels: { ...sandbox().labels, team: "a" } });
	const { rec, provider } = setup({
		"GET /api/sandbox": (request) => (request.query.get("cursor") === null ? { body: { items: [mine, destroyed], nextCursor: "page-2" } } : { body: { items: [other] } }),
		"GET /api/sandbox/sb-1": { body: mine },
	});
	const listed = await provider.host.list({ team: "a" }, { timeoutMs: 1_000 });
	assert.deepEqual(listed.map((m) => [m.id, m.state]), [["sb-1", "running"], ["sb-2", "running"]], "the listing as it reads");
	const pages = rec.requests.filter((r) => r.path === "/api/sandbox");
	assert.equal(pages.length, 2);
	for (const page of pages) assert.deepEqual(JSON.parse(page.query.get("labels")), { [COMPUTER]: "1" });
	const infos = await provider.list({ team: "a" });
	assert.deepEqual(infos.value.map((info) => [info.ref.id, info.network]), [["sb-1", "none"]]);
	assert.equal(rec.requests.filter((r) => r.path === "/api/sandbox/sb-1").length, 1, "one get of the listed computer kept: the listing finds, get answers");
});

test("a sandbox Daytona is destroying is gone: connect answers gone and list leaves it out; release still waits for Daytona's 404", async () => {
	const going = sandbox({ state: "destroying", desiredState: "destroyed" });
	const { provider } = setup({ "GET /api/sandbox": { body: { items: [going] } }, [`GET /api/sandbox/${REF.id}`]: { body: going } });
	const connected = await provider.connect(REF);
	assert.equal(connected.error?.code, "gone", JSON.stringify(connected));
	assert.match(connected.error.message, /is going/);
	assert.deepEqual((await provider.list({})).value, [], "a going sandbox is not listed, stopped or otherwise");

	let deleted = false;
	let destroying = 3;
	const released = setup({
		[`GET /api/sandbox/${REF.id}`]: () => (!deleted ? { body: sandbox() } : destroying-- > 0 ? { body: going } : { status: 404, body: { statusCode: 404, message: "not found" } }),
		[`DELETE /api/sandbox/${REF.id}`]: () => {
			deleted = true;
			return { status: 200 };
		},
	});
	assert.deepEqual(await released.provider.release(REF, "delete"), { ok: true, value: undefined });
	assert.ok(destroying < 0, "release ended only once Daytona answered 404, not while it read the sandbox destroying");
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

test("network(): refuses a form Daytona never makes, with refused and no request: a Daytona computer's network is fixed at create (the read is the adapter's probe from inside)", async () => {
	const { rec, provider } = setup({ [`GET /api/sandbox/${REF.id}`]: { body: sandbox() } });
	for (const policy of [{ allow: [] }, { allow: ["198.51.100.0/24"] }, "wifi"]) {
		const changed = await provider.network(REF, policy);
		assert.equal(changed.error?.code, "refused", JSON.stringify(policy));
		assert.match(changed.error.message, /fixed at create/);
	}
	assert.deepEqual(rec.requests, [], "a refused change asks Daytona nothing");
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

/** A log stream that opens at once and sends nothing: the command's output is not what these tests read. */
const openSocket = () => {
	const listeners = {};
	queueMicrotask(() => listeners.open?.({}));
	return { binaryType: "", addEventListener: (type, listener) => (listeners[type] = listener), close: () => listeners.close?.({ code: 1000 }) };
};

const DAYTONA_500 = { status: 500, body: { statusCode: 500, message: "internal error", code: "Internal Server Error" } };

/**
 * One exec with stdin over a toolbox whose input route answers `replies` in turn (a reply, or "throw" for no answer),
 * one line written: what it settled as, every input request's data, and every pause between two tries. The pause is
 * injected and records alone, so nothing waits on a clock.
 */
async function writeOnce(replies) {
	const inputs = [];
	const pauses = [];
	const left = [...replies];
	const rec = recorder({
		[`GET /api/sandbox/${REF.id}`]: { body: sandbox() },
		[`POST /toolbox/${REF.id}/process/session`]: { body: {} },
	});
	const fetch = async (url, init = {}) => {
		const at = new URL(url);
		if (init.method === "POST" && at.pathname.endsWith("/exec")) return new Response(JSON.stringify({ cmdId: "cmd-1" }), { status: 200 });
		if (init.method === "POST" && at.pathname.endsWith("/command/cmd-1/input")) {
			inputs.push(JSON.parse(init.body).data);
			const reply = left.shift() ?? { status: 204 };
			if (reply === "throw") throw new TypeError("fetch failed: other side closed");
			return new Response(reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
		}
		if (init.method === "DELETE") return new Response(null, { status: 204 });
		return rec.fetch(url, init);
	};
	const pause = async (ms) => {
		pauses.push(ms);
	};
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch, webSocket: openSocket, pause, timeouts: TIMEOUTS });
	const started = await provider.host.exec(REF.id, ["computerd", "stdio"], { timeoutMs: 1_000 });
	const line = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}\n';
	let settled;
	try {
		await started.write(new TextEncoder().encode(line));
		settled = "ok";
	} catch (error) {
		settled = error.message;
	}
	await started.kill();
	return { settled, inputs, pauses, line };
}

test("stdin: a write Daytona answers its own 500 for is sent again, with a doubling pause, up to three tries; it never reached a reader, so the line is read once", async () => {
	const once = await writeOnce([DAYTONA_500]);
	assert.equal(once.settled, "ok");
	assert.deepEqual(once.inputs, [once.line, once.line], "the same whole line, sent again after the 500");
	assert.deepEqual(once.pauses, [1], "one pause of retryMs, injected: no clock");
	const always = await writeOnce([DAYTONA_500, DAYTONA_500, DAYTONA_500, DAYTONA_500]);
	assert.match(always.settled, /writing to the command failed \(vendor\): POST \/toolbox\/sb-0001\/process\/session\/agentrun-[0-9a-f]{16}\/command\/cmd-1\/input: 500 /);
	assert.equal(always.inputs.length, 3, "bounded: three tries in all");
	assert.deepEqual(always.pauses, [1, 2], "each pause twice the one before");
	assert.doesNotMatch(always.settled, /hello/, "its words never hold what was written");
});

test("stdin: a write is never sent again where the line may have reached the command: a 4xx, a 502, 503 or 504, a 500 that is not Daytona's own, or no answer", async () => {
	for (const reply of [
		{ status: 400, body: { statusCode: 400, message: "invalid body" } },
		{ status: 404, body: { statusCode: 404, message: "command not found" } },
		{ status: 410, body: { statusCode: 410, message: "command has already completed with exit code 0" } },
		{ status: 429, body: { statusCode: 429, message: "too many requests" } },
		{ status: 502 },
		{ status: 503, body: { statusCode: 503, message: "unavailable" } },
		{ status: 504, body: "gateway timeout" },
		{ status: 500 },
		{ status: 500, body: "<html>500</html>" },
		"throw",
	]) {
		const what = JSON.stringify(reply);
		const ran = await writeOnce([reply]);
		assert.notEqual(ran.settled, "ok", what);
		assert.equal(ran.inputs.length, 1, `${what}: sent once`);
		assert.deepEqual(ran.pauses, [], `${what}: no pause`);
	}
});

/**
 * A toolbox whose command cmd-1 the test drives: its log stream (send a frame, close it), its exit code in the session
 * (exitCode, unset while it runs), and every input, session read and delete recorded.
 */
function liveCommand({ sessionRead } = {}) {
	const seen = { inputs: [], reads: 0, deleted: [], closedByClient: false };
	const command = { exitCode: undefined };
	const rec = recorder({ [`GET /api/sandbox/${REF.id}`]: { body: sandbox() }, [`POST /toolbox/${REF.id}/process/session`]: { body: {} } });
	const fetch = async (url, init = {}) => {
		const at = new URL(url);
		if (init.method === "POST" && at.pathname.endsWith("/exec")) return new Response(JSON.stringify({ cmdId: "cmd-1" }), { status: 200 });
		if (init.method === "POST" && at.pathname.endsWith("/command/cmd-1/input")) {
			seen.inputs.push(JSON.parse(init.body).data);
			return new Response(null, { status: 204 });
		}
		if (init.method === "GET" && /\/process\/session\/[^/]+$/.test(at.pathname)) {
			seen.reads++;
			if (sessionRead) return sessionRead();
			return new Response(JSON.stringify({ commands: [{ id: "cmd-1", ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }) }] }), { status: 200 });
		}
		if (init.method === "DELETE") {
			seen.deleted.push(at.pathname);
			return new Response(null, { status: 204 });
		}
		return rec.fetch(url, init);
	};
	let listeners = {};
	let opened = () => {};
	const open = new Promise((done) => (opened = done));
	const webSocket = () => {
		listeners = {};
		queueMicrotask(() => {
			listeners.open?.({});
			opened();
		});
		return {
			binaryType: "",
			addEventListener: (type, listener) => (listeners[type] = listener),
			close: () => {
				seen.closedByClient = true;
				listeners.close?.({ code: 1000 });
			},
		};
	};
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch, webSocket, timeouts: TIMEOUTS });
	return {
		provider,
		seen,
		command,
		/** The log stream is open. */
		opened: open,
		send: (bytes) => listeners.message?.({ data: new Uint8Array(bytes).buffer }),
		/** The stream ends as Daytona's does: once the command's exit code is written. */
		end: (code) => {
			command.exitCode = code;
			listeners.close?.({ code: 1000 });
		},
	};
}

const frame = (prefix, text) => Buffer.concat([Buffer.from([prefix, prefix, prefix]), Buffer.from(text)]);

test("exec reads the log stream's prefixed lines as stdout and stderr, drops an echoed request, and reads the exit code once the stream ends, never while it runs", async () => {
	const live = liveCommand();
	const { runToExit } = await import("../dist/hosted/process.js");
	const running = runToExit(live.provider.host, REF.id, ["sh", "-c", "work"], { ms: 2_000, what: "a command" });
	await live.opened;
	live.send(Buffer.concat([frame(1, "out 1\n"), frame(2, "err 1\n"), frame(1, '{"jsonrpc":"2.0","id":1,"method":"hello"}\n'), frame(1, "out ")]));
	// The rest of that line, a character split across two frames.
	live.send(Buffer.from("€ 2\n").subarray(0, 1));
	for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
	assert.equal(live.seen.reads, 0, "no session read while the stream is open: a bridge that runs for hours costs no call");
	live.send(Buffer.from("€ 2\n").subarray(1));
	live.end(3);
	const ran = await running;
	assert.equal(ran.ok, true, ran.ok ? "" : ran.error.message);
	assert.deepEqual(ran.value, { exitCode: 3, stdout: "out 1\nout € 2\n", stderr: "err 1\n" });
	assert.equal(live.seen.reads, 1, "one read, once the stream ended");
	assert.equal(live.seen.deleted.length, 1, "the session is removed");
});

test("exec's stdin goes to Daytona in whole lines, since its input call ends each with a newline; end() sends what is left, and kill removes the session", async () => {
	const live = liveCommand();
	const proc = await live.provider.host.exec(REF.id, ["computerd", "stdio"], { timeoutMs: 1_000 });
	await proc.write(Buffer.from('{"a":'));
	assert.deepEqual(live.seen.inputs, [], "half a line waits for its end");
	await proc.write(Buffer.from('1}\n{"b":'));
	assert.deepEqual(live.seen.inputs, ['{"a":1}\n']);
	await proc.end();
	assert.deepEqual(live.seen.inputs, ['{"a":1}\n', '{"b":']);
	await proc.kill();
	assert.equal(live.seen.closedByClient, true, "the log stream is closed");
	assert.equal(await proc.wait(), -1, "killed: no exit code is read");
	assert.equal(live.seen.reads, 0);
	assert.equal(live.seen.deleted.length, 1, "the session is removed, once");
});

test("exec: a failed read of the command's exit code ends the run with that failure, at once, its session removed; never a later timeout", async () => {
	const live = liveCommand({ sessionRead: () => new Response(JSON.stringify({ statusCode: 403, message: "session read refused" }), { status: 403 }) });
	const { runToExit } = await import("../dist/hosted/process.js");
	const began = Date.now();
	const running = runToExit(live.provider.host, REF.id, ["true"], { ms: 1_000, what: "a command" });
	await live.opened;
	live.end(0);
	const ran = await running;
	assert.equal(ran.ok, false);
	assert.equal(ran.error.code, "vendor", ran.error.message);
	assert.match(ran.error.message, /a command failed: reading the command's exit code failed .*403 .*session read refused/);
	assert.ok(Date.now() - began < 1_000, "it ends with the read, not at the call's bound");
	assert.equal(live.seen.reads, 1, "a 403 is never sent again");
	assert.equal(live.seen.deleted.length, 1, "the session is removed");
	assert.match(live.seen.deleted[0], /\/process\/session\/agentrun-[0-9a-f]{16}$/);
});

test("exec is a session command of its own: argv as one shell line, async, no input echo, and Daytona adds no word of its own", async () => {
	const run = async (argv) => {
		const tb = toolboxRecorder();
		const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: tb.fetch, timeouts: TIMEOUTS });
		await assert.rejects(provider.host.exec(REF.id, argv, { timeoutMs: 1_000 }), /400 .*refused/);
		assert.equal(tb.commands.length, 1);
		assert.equal(tb.commands[0].runAsync, true);
		assert.equal(tb.commands[0].suppressInputEcho, true);
		for (const request of tb.requests) assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
		return tb.commands[0].command;
	};
	assert.equal(await run(["/usr/local/bin/tool", "run", "a1", "/f", "k=v:1"]), "/usr/local/bin/tool run a1 /f k=v:1", "plain words go as given");
	assert.equal(await run(["sh", "-c", 'echo "$1"', "sh", "it's"]), `sh -c 'echo "$1"' sh 'it'\\''s'`, "every word but a plain one quoted");
});

test("the loopback block: the toolbox's port declared, and open and allowlists taken, through init's egress proxy alone (it refuses the toolbox's port)", () => {
	const { provider } = setup();
	const { network, vendorAgentPorts } = provider.capabilities();
	assert.deepEqual(network, ["none", "open", "allow"]);
	assert.deepEqual(vendorAgentPorts, [2280]);
	for (const policy of ["open", { allow: ["example.com"] }]) assert.deepEqual(provider.check({ ...SPEC, network: policy }), [], JSON.stringify(policy));
});

test("create() under open or a list asks Daytona for the sandbox's network (networkBlockAll false) for init's egress proxy, and records the form in a label; under none it blocks it", async () => {
	for (const [network, blocked, form] of [
		["none", true, undefined],
		["open", false, "open"],
		[{ allow: ["Example.com"] }, false, "allow:example.com"],
	]) {
		const rec = refusedCreate();
		const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS });
		await provider.create({ ...SPEC, network }, { requestId: `r-net-${JSON.stringify(network)}` });
		const body = posted(rec);
		assert.equal(body.networkBlockAll, blocked, JSON.stringify(network));
		assert.equal(body.labels[`${COMPUTER}.network`], form, JSON.stringify(network));
	}
});

/** A dial provider's server in tests: http on 127.0.0.1, which a dial provider takes in tests alone, its tokens and hub. */
const dialOf = () => ({ url: "http://127.0.0.1:8080", tokens: new MemoryMachineTokens(), hub: new AttachHub({ helloMs: 1_000 }) });
/** The boot env's names a dial sandbox's env holds: all but AGENTRUN_ATTACH_URL, which goes to agentrun-dial's start alone. */
const BOOT_NAMES = ["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"];

test("connect dial: create sends the boot env as the sandbox's env, AGENTRUN_ATTACH_URL left out, and its network on, from the snapshot named, and the host has no exec and no upload", async () => {
	const rec = refusedCreate();
	const dial = dialOf();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, connect: "dial", dial });
	assert.equal(provider.host.facts.connect, "dial");
	assert.equal(provider.host.exec, undefined, "no exec");
	assert.equal(provider.host.upload, undefined, "no upload");
	const made = await provider.create({ ...SPEC, image: "agentrun-archil-0123456789ab" }, { requestId: "r-dial" });
	assert.equal(made.error?.code, "invalid", "a create Daytona refused made nothing");
	const body = posted(rec);
	assert.equal(body.snapshot, "agentrun-archil-0123456789ab");
	assert.deepEqual(Object.keys(body.env).sort(), BOOT_NAMES);
	assert.equal("AGENTRUN_ATTACH_URL" in body.env, false, "the URL goes on agentrun-dial's start alone (README, Daytona on dial)");
	assert.equal(body.env.AGENTRUN_DAEMON_URL, "http://127.0.0.1:8080/v2/computers/daemon?arch=amd64");
	assert.match(body.env.AGENTRUN_ATTACH_TOKEN, new RegExp(`^${MACHINE_TOKEN_SOURCE}$`));
	assert.match(body.env.AGENTRUN_INIT_ARGS, /^--deadline \S+ --user 2510:2510 --own-network --max-deadline \S+$/);
	assert.equal(body.networkBlockAll, false, "its root reaches the server; its tools' network none is init's");
	assert.equal(dial.tokens.check(body.env.AGENTRUN_ATTACH_TOKEN), undefined, "a create Daytona refused has its token revoked");
	assert.equal(rec.requests.some((r) => r.url.startsWith(TOOLBOX)), false, "nothing goes through the toolbox");
	// Exec stays the default: no env, the network as the spec says, and the toolbox's exec and upload.
	const plain = setup({ "GET /api/sandbox": { body: { items: [] } }, "POST /api/sandbox": { status: 400, body: { statusCode: 400, message: "snapshot not found" } } });
	await plain.provider.create(SPEC, { requestId: "r-exec" });
	assert.deepEqual(posted(plain.rec).env, {});
	assert.equal(posted(plain.rec).networkBlockAll, true);
	assert.equal(plain.provider.host.facts.connect, undefined);
	assert.equal(typeof plain.provider.host.exec, "function");
	assert.equal(typeof plain.provider.host.upload, "function");
});

test("connect dial with DAYTONA_ATTACH_EGRESS's attachEgress: the boot env carries the relay as AGENTRUN_ATTACH_EGRESS, the public addresses unchanged; a desktop's too; exec sends no env still", async () => {
	assert.deepEqual(DAYTONA.keys.find((key) => key.name === "DAYTONA_ATTACH_EGRESS"), { name: "DAYTONA_ATTACH_EGRESS", option: "attachEgress", required: false });
	for (const kind of ["linux", "desktop"]) {
		const rec = refusedCreate();
		const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, connect: "dial", dial: dialOf(), attachEgress: "192.0.2.40:18443", kind });
		await provider.create({ ...SPEC, image: "agentrun-box-0123456789ab" }, { requestId: `r-dial-egress-${kind}` });
		const { env } = posted(rec);
		assert.deepEqual(Object.keys(env).sort(), [...BOOT_NAMES, "AGENTRUN_ATTACH_EGRESS", ...(kind === "desktop" ? ["DISPLAY"] : [])].sort(), kind);
		assert.equal(env.AGENTRUN_ATTACH_EGRESS, "192.0.2.40:18443");
		assert.equal(env.AGENTRUN_DAEMON_URL, "http://127.0.0.1:8080/v2/computers/daemon?arch=amd64");
	}
	const rec = refusedCreate();
	await new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, attachEgress: "192.0.2.40:18443" }).create(SPEC, { requestId: "r-exec-egress" });
	assert.deepEqual(posted(rec).env, {}, "a machine on exec dials nothing, so it is given nothing");
});

/** A dial machine's token and attach URL in the host tests: a URL with words a shell would split or expand, quoted. */
const DIAL_TOKEN = `art_fake-test-key-not-a-secret-${"0".repeat(16)}`;
const DIAL_URL = "wss://agentrun.example/v2/computers/attach?a=1&b='2' $HOME";
/** What the adapter asks of a dial host's create: the boot env with every name, the URL among them. */
const dialRequest = () => ({
	name: REF.name,
	image: "agentrun-box-0123456789ab",
	labels: { [COMPUTER]: "1", [`${COMPUTER}.name`]: REF.name },
	lifetimeMs: 600_000,
	backstopAt: new Date(Date.now() + 900_000).toISOString(),
	egress: true,
	boot: { env: { AGENTRUN_ATTACH_URL: DIAL_URL, AGENTRUN_ATTACH_TOKEN: DIAL_TOKEN, AGENTRUN_DAEMON_URL: "https://agentrun.example/v2/computers/daemon?arch=amd64", AGENTRUN_DAEMON_SHA256: "0".repeat(64), AGENTRUN_INIT_ARGS: "--deadline x --user 2510:2510 --own-network" } },
});

/**
 * A Daytona whose one sandbox reads `states` in turn (the last one from then on; a state, or the sandbox's fields) and
 * whose toolbox takes the dial's session and command, or answers `session` / `exec` instead; `seen` holds each sandbox
 * read, session and command in order. The host is a dial provider's.
 */
function dialDaytona({ states = ["started"], session, exec, routes = {} } = {}) {
	const left = [...states];
	const seen = [];
	const read = () => {
		const next = left.length > 1 ? left.shift() : left[0];
		const fields = typeof next === "string" ? { state: next } : next;
		seen.push(`state ${fields.state}`);
		return sandbox({ ...fields, ...(fields.state === "error" ? { errorReason: "the snapshot's image could not be pulled" } : {}) });
	};
	const rec = recorder({
		"POST /api/sandbox": () => ({ body: read() }),
		[`GET /api/sandbox/${REF.id}`]: () => ({ body: read() }),
		[`POST /toolbox/${REF.id}/process/session`]: ({ body }) => {
			seen.push(`session ${body.sessionId}`);
			return session ?? { body: {} };
		},
		[`POST /toolbox/${REF.id}/process/session/agentrun-dial/exec`]: () => {
			seen.push("exec");
			return exec ?? { body: { cmdId: "cmd-dial" } };
		},
		...routes,
	});
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, connect: "dial", dial: dialOf() });
	return { rec, seen, host: provider.host };
}

test("connect dial: create sends every boot name but AGENTRUN_ATTACH_URL as the sandbox's env, then starts agentrun-dial in a session of its own, async, through dialLaunch's line (E2B's), the URL a quoted assignment on it and the token on none", async () => {
	const { rec, seen, host } = dialDaytona();
	assert.deepEqual(await host.create(dialRequest(), { timeoutMs: 2_000 }), { id: REF.id });
	const { env } = posted(rec);
	assert.deepEqual(Object.keys(env).sort(), BOOT_NAMES);
	assert.equal(env.AGENTRUN_ATTACH_TOKEN, DIAL_TOKEN, "the token stays in the sandbox's env, which a session command inherits");
	assert.deepEqual(seen.filter((one) => !one.startsWith("state")), ["session agentrun-dial", "exec"], "one session, one command");
	const ran = rec.requests.filter((r) => r.method === "POST" && r.path.endsWith("/process/session/agentrun-dial/exec"));
	assert.equal(ran.length, 1);
	assert.equal(ran[0].host, "proxy.daytona.test", "through the sandbox's toolbox");
	assert.equal(ran[0].body.runAsync, true);
	assert.equal(ran[0].body.command, dialLaunch({ attach: DIAL_URL }));
	for (const r of rec.requests.filter((one) => one.url.startsWith(TOOLBOX))) {
		assert.equal(`${r.url} ${JSON.stringify(r.body ?? null)}`.includes(DIAL_TOKEN), false, `${r.method} ${r.path} holds no token`);
	}
	assert.equal(rec.requests.some((r) => r.method === "DELETE"), false, "the session is kept: its log is the dial's last words");
});

test("connect dial: a sandbox that reads creating, then pulling_snapshot, gets agentrun-dial's session only once it reads started; one that reads error fails create in Daytona's words, with no session", async () => {
	const { seen, host } = dialDaytona({ states: ["creating", "pulling_snapshot", "pulling_snapshot", "started"] });
	await host.create(dialRequest(), { timeoutMs: 2_000 });
	const session = seen.indexOf("session agentrun-dial");
	assert.ok(session > 0, JSON.stringify(seen));
	assert.equal(seen.indexOf("state started") < session, true, JSON.stringify(seen));
	assert.deepEqual(seen.slice(0, 3), ["state creating", "state pulling_snapshot", "state pulling_snapshot"]);

	const failed = dialDaytona({ states: ["creating", "error"] });
	await assert.rejects(failed.host.create(dialRequest(), { timeoutMs: 2_000 }), (error) => {
		assert.equal(error.code, "vendor");
		assert.match(error.message, /the snapshot's image could not be pulled/);
		return true;
	});
	assert.equal(failed.seen.some((one) => one.startsWith("session")), false, "no session in a failed sandbox");

	// Asked to destroy while it starts: gone, as a read of the machine says, so create fails at that read.
	const doomed = dialDaytona({ states: ["creating", { state: "starting", desiredState: "destroyed" }] });
	await assert.rejects(doomed.host.create(dialRequest(), { timeoutMs: 2_000 }), (error) => {
		assert.equal(error.code, "vendor");
		assert.match(error.message, /Daytona reads the sandbox sb-0001 starting, to be destroyed, so agentrun-dial was not started/);
		return true;
	});
	assert.deepEqual(doomed.seen, ["state creating", "state starting"], "no read after it, and no session");

	const slow = dialDaytona({ states: ["creating"] });
	await assert.rejects(slow.host.create(dialRequest(), { timeoutMs: 100 }), (error) => {
		assert.equal(error.code, "timeout");
		assert.match(error.message, /did not read started within 0\.1 s/);
		return true;
	});
	assert.equal(slow.seen.some((one) => one.startsWith("session")), false);
});

test("connect dial: a session Daytona refuses fails create in its words, and the adapter deletes the sandbox it made; its token is revoked", async () => {
	const refused = dialDaytona({ exec: { status: 400, body: { statusCode: 400, message: "session refused: no shell" } } });
	await assert.rejects(refused.host.create(dialRequest(), { timeoutMs: 2_000 }), (error) => {
		assert.equal(error.code, "vendor", "a create that made a sandbox: the adapter's sweep deletes it");
		assert.match(error.message, /starting agentrun-dial in sb-0001 failed: .*session refused: no shell/);
		return true;
	});
	const unmade = dialDaytona({ session: { status: 500, body: { statusCode: 500, message: "toolbox not ready" } } });
	await assert.rejects(unmade.host.create(dialRequest(), { timeoutMs: 2_000 }), /starting agentrun-dial in sb-0001 failed: .*toolbox not ready/);

	// Through the provider: the sandbox it made is listed by its name and deleted.
	let made;
	const ID = REF.id;
	const rec = recorder({
		"GET /api/sandbox": () => ({ body: { items: made === undefined || made.state === "destroyed" ? [] : [made] } }),
		"POST /api/sandbox": ({ body }) => {
			made = sandbox({ id: ID, name: body.name, labels: body.labels, networkBlockAll: body.networkBlockAll });
			return { body: made };
		},
		[`GET /api/sandbox/${ID}`]: () => (made.state === "destroyed" ? { status: 404, body: { statusCode: 404, message: "Sandbox not found" } } : { body: made }),
		[`DELETE /api/sandbox/${ID}`]: () => {
			made.state = "destroyed";
			return { status: 204 };
		},
		[`POST /toolbox/${ID}/process/session`]: { body: {} },
		[`POST /toolbox/${ID}/process/session/agentrun-dial/exec`]: { status: 400, body: { statusCode: 400, message: "session refused: no shell" } },
	});
	const dial = dialOf();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: { ...TIMEOUTS, listedStableMs: 0 }, connect: "dial", dial });
	const created = await provider.create({ ...SPEC, image: "agentrun-box-0123456789ab" }, { requestId: "r-dial-session" });
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "vendor");
	assert.match(created.error.message, /session refused: no shell/);
	assert.equal(made.state, "destroyed", "the sandbox create made was deleted");
	assert.equal(dial.tokens.check(posted(rec).env.AGENTRUN_ATTACH_TOKEN), undefined, "its token is revoked");
});

test("connect dial: dialLog is one read of agentrun-dial's command's log, the toolbox's plain text with its stream prefixes dropped; none when this host started no agentrun-dial there; a read that fails throws", async () => {
	const LOGS = `/toolbox/${REF.id}/process/session/agentrun-dial/command/cmd-dial/logs`;
	// The toolbox's answer to a client that names no SDK version: the log file as written, each write behind its stream's
	// prefix (daytonaio/daytona@b5a5d9e7 apps/daemon/pkg/toolbox/process/session/log.go:55-65).
	const framed = "\x01\x01\x01fetching the daemon\n\x02\x02\x02curl: (7) Failed to connect\n\x01\x01\x01connect: no route to host\n";
	const { host, rec } = dialDaytona({ routes: { [`GET ${LOGS}`]: { text: framed } } });
	assert.equal(typeof host.dialLog, "function");
	assert.equal(await host.dialLog(REF.id, { timeoutMs: 2_000 }), undefined, "no start by this host: agentrun-dial never started");
	await host.create(dialRequest(), { timeoutMs: 2_000 });
	const read = rec.requests.length;
	assert.equal(await host.dialLog(REF.id, { timeoutMs: 2_000 }), "fetching the daemon\ncurl: (7) Failed to connect\nconnect: no route to host\n");
	assert.deepEqual(rec.requests.slice(read).map((r) => `${r.method} ${r.path}`), [`GET ${LOGS}`], "one read: the command create started");
	assert.ok(rec.requests.every((r) => r.method !== "DELETE"));

	const down = dialDaytona({ routes: { [`GET ${LOGS}`]: { status: 502, body: { statusCode: 502, message: "bad gateway" } } } });
	await down.host.create(dialRequest(), { timeoutMs: 2_000 });
	await assert.rejects(down.host.dialLog(REF.id, { timeoutMs: 2_000 }));
	assert.equal(setup().provider.host.dialLog, undefined, "a host on exec has no dialLog");
});

test("connect dial: no Archil mount, no GPU and not Daytona's default snapshot, each refused in words; labels refused as on exec; no value but exec or dial", () => {
	const { provider, rec } = setup({}, { connect: "dial", dial: dialOf(), archilEgress: EGRESS });
	const caps = provider.capabilities();
	assert.equal(caps.kind, "linux");
	assert.equal(caps.daemon, "child", "init is agentrun-dial's child, and agentrun-dial a session command create starts");
	assert.deepEqual(caps.mount, ["sync"], "no Archil mount on dial, even with an egress: a synced folder alone, its /workspace made by agentrun-dial");
	assert.equal(caps.gpu, undefined, "no GPU on dial");
	assert.deepEqual(caps.vendorAgentPorts, [2280], "the toolbox still runs, and its port is still blocked");
	const mount = provider.check(ARCHIL_SPEC);
	assert.deepEqual(mount.map(({ field }) => field), ["mount"]);
	assert.ok(mount[0].message.includes(mountsOf(DAYTONA, () => false, true).unmounted.archil), mount[0].message);
	const gpu = provider.check({ ...SPEC, image: "default", gpu: GPU });
	assert.ok(gpu.length > 0 && gpu.every(({ field }) => field === "gpu"), JSON.stringify(gpu));
	assert.ok(gpu.some(({ message }) => /a Daytona computer that dials this server takes no GPU: daytona-gpu holds no agentrun-dial/.test(message)), JSON.stringify(gpu));
	assert.deepEqual(provider.check({ ...SPEC, labels: { "agentrun.computer.deadline": "never" } }).map(({ field }) => field), ["labels"]);
	assert.deepEqual(provider.check(SPEC), []);
	const plain = provider.check({ ...SPEC, image: "default" });
	assert.deepEqual(plain.map(({ field }) => field), ["image"], "Daytona's default snapshot holds no agentrun-dial");
	assert.match(plain[0].message, /Daytona's default snapshot has none, so it would never dial/);
	assert.throws(() => setup({}, { connect: "ssh" }), /connect is how Daytona reaches its machines, "exec" \(the default\) or "dial", not "ssh"/);
	assert.equal(rec.requests.length, 0);
});

test("kind desktop on connect dial: the desktop's groups, no GPU, the window manager computerd starts (init --window-manager), and DISPLAY beside the boot env, with no resources beside the snapshot; on connect exec it is refused when made, in kindRefusal's words", async () => {
	const rec = refusedCreate();
	const dial = dialOf();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: TIMEOUTS, connect: "dial", dial, kind: "desktop" });
	const caps = provider.capabilities();
	assert.equal(caps.kind, "desktop");
	assert.deepEqual(caps.groups, ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"]);
	assert.equal(caps.gpu, undefined);
	assert.equal(provider.host.facts.windowManager, true, "a snapshot of box/Dockerfile has xfwm4");
	const made = await provider.create({ ...SPEC, image: "agentrun-box-0123456789ab" }, { requestId: "r-dial-desktop" });
	assert.equal(made.error?.code, "invalid", "a create Daytona refused made nothing");
	const body = posted(rec);
	assert.deepEqual(Object.keys(body.env).sort(), [...BOOT_NAMES, "DISPLAY"]);
	assert.equal(body.env.DISPLAY, ":0");
	assert.match(body.env.AGENTRUN_INIT_ARGS, / --window-manager$/, "computerd starts the window manager, as root makes its network namespace");
	assert.deepEqual([body.cpu, body.memory, body.disk], [undefined, undefined, undefined], "the snapshot's 2 CPUs and 4 GB: no resources beside a snapshot");
	for (const connect of [undefined, "exec"]) {
		assert.throws(() => setup({}, { ...(connect ? { connect } : {}), kind: "desktop" }), /^Error: Daytona gives a desktop computer on connect "dial" alone, not "exec"$/, `connect ${connect}`);
		assert.equal(setup({}, { ...(connect ? { connect } : {}), kind: "linux" }).provider.capabilities().kind, "linux");
	}
});

test("Daytona's desktop configuration, as serve builds it over connect exec, makes a desktop over dial from the box snapshot: the sandbox boots from its env, dials, its X server starts over that socket and computerd starts xfwm4", async () => {
	const dial = dialServer();
	// The operator's snapshot of box/Dockerfile (AGENTRUN_DAYTONA_SNAPSHOT, box/build-daytona.py's name): it holds Xvfb and xfwm4.
	const SNAPSHOT = "agentrun-box-0123456789ab";
	const ID = "sb-desktop-1";
	let made;
	let booted;
	// A Daytona API that keeps the one sandbox it makes: it boots when agentrun-dial's session command runs, from the env
	// it was posted and the URL that command gives (bootDial).
	let env;
	const rec = recorder({
		"GET /api/sandbox": () => ({ body: { items: made === undefined || made.state === "destroyed" ? [] : [made] } }),
		"POST /api/sandbox": ({ body }) => {
			made = sandbox({ id: ID, name: body.name, snapshot: body.snapshot, labels: body.labels, networkBlockAll: body.networkBlockAll });
			env = body.env;
			return { body: made };
		},
		[`POST /toolbox/${ID}/process/session`]: { body: {} },
		[`POST /toolbox/${ID}/process/session/agentrun-dial/exec`]: ({ body }) => {
			const url = `${dial.url.replace(/^http/, "ws")}/v2/computers/attach`;
			assert.equal(body.command, dialLaunch({ attach: url }), "agentrun-dial dials the server's attach address");
			booted = bootDial({ ...env, AGENTRUN_ATTACH_URL: url }, dial, { daemon: readFileSync(DAEMON) });
			return { body: { cmdId: "cmd-dial" } };
		},
		[`GET /api/sandbox/${ID}`]: () => (made.state === "destroyed" ? { status: 404, body: { statusCode: 404, message: "Sandbox not found" } } : { body: made }),
		[`DELETE /api/sandbox/${ID}`]: () => {
			made.state = "destroyed";
			return { status: 204 };
		},
	});
	const { options } = DAYTONA.capabilities.find(({ kind }) => kind === "desktop");
	// serve's options for this provider: the keys' and the settings' (daytonaConnect exec), then the configuration's.
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: rec.fetch, timeouts: { ...TIMEOUTS, listedStableMs: 0 }, dial, connect: "exec", ...options });
	assert.equal(provider.capabilities().kind, "desktop");
	assert.equal(provider.host.facts.connect, "dial");
	await desktopOverDial(provider, dial, () => booted, { image: SNAPSHOT, lifetimeMs: 600_000, network: "none" });
	const body = posted(rec);
	assert.equal(body.snapshot, SNAPSHOT, "made from the box snapshot");
	assert.deepEqual([body.cpu, body.memory, body.disk], [undefined, undefined, undefined], "the snapshot's 2 CPUs, 4 GB and 10 GB: no resources beside a snapshot");
	assert.equal(made.state, "destroyed", "release deleted the sandbox");
});

test("Daytona's descriptor offers a sandbox and, on connect dial, a desktop, and leaves no kind unserved", () => {
	assert.deepEqual(DAYTONA.capabilities.map(({ kind, options }) => [kind, options?.connect]), [["linux", undefined], ["desktop", "dial"]]);
	assert.equal(DAYTONA.unserved, undefined);
});

test("Daytona's descriptor declares the connect setting, with no default of its own: a server's settings pass it to create() as connect, else the provider's exec holds", () => {
	assert.deepEqual(DAYTONA.settings, [{ name: "daytonaConnect", option: "connect" }]);
});

test("the provider writes nowhere but its results, and reads no environment: its source has no console, no stdio and no process.env", () => {
	const source = readFileSync(new URL("../src/daytona.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /console\.|process\.std(out|err)/);
	assert.doesNotMatch(source, /process\.env/);
});
