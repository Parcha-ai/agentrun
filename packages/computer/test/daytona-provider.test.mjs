// DaytonaProvider against a fake Daytona served in process (test/fake-daytona.mjs): an injected fetch and WebSocket that
// record every request and answer as Daytona's v0 API does. No Daytona key, no network: the global fetch and WebSocket
// are replaced for the whole file by ones that fail the test, and every request the provider made must be the fake's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DaytonaProvider } from "../dist/index.js";
import { API, DEFAULT_SNAPSHOT, fakeDaytona, HOSTS, KEY, PROXY, scriptOf, statusText, VERSION } from "./fake-daytona.mjs";

const SPEC = { image: "agentrun-debian", lifetimeMs: 600_000, network: "none" };
const FAST = { requestMs: 2000, createMs: 2000, startMs: 300, deleteMs: 2000, stopMs: 500, uploadMs: 2000, execMs: 2000, helloMs: 1000, pollMs: 1, retryMs: 1, listedMs: 2000, listedStableMs: 0 };
const NAME = /^computer-[0-9a-f]{12}$/;

const dir = mkdtempSync(join(tmpdir(), "computer-daytona-test-"));
const DAEMON = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, uploaded and hashed\n");
const DAEMON_SHA = createHash("sha256").update(DAEMON_BYTES).digest("hex");
writeFileSync(DAEMON, DAEMON_BYTES);

const stray = [];
const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
// A hung fake holds no socket open, and a timeout's timer does not hold the event loop: this does, for the file.
let keep;
before(() => {
	keep = setInterval(() => {}, 1000);
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
	clearInterval(keep);
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	rmSync(dir, { recursive: true, force: true });
	assert.deepEqual(stray, [], "no request ever left for a real host");
});

function setup(knobs = {}, options = {}) {
	const fake = fakeDaytona(knobs);
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: fake.fetch, webSocket: fake.webSocket, timeouts: FAST, ...options });
	return { fake, provider };
}

/** Every request went to the fake's hosts, with the key, never following a redirect; every socket too. */
function allToTheFake(fake) {
	assert.ok(fake.requests.length > 0, "the fake saw the provider's requests");
	for (const request of fake.requests) {
		assert.ok(HOSTS.includes(request.host), `${request.method} ${request.url} went to the fake`);
		assert.equal(request.headers.authorization, `Bearer ${KEY}`, `${request.method} ${request.path} carries the key`);
		assert.equal(request.redirect, "error", `${request.method} ${request.path} never follows a redirect`);
	}
	for (const socket of fake.sockets) {
		assert.ok(HOSTS.includes(socket.host), `${socket.url} went to the fake`);
		assert.equal(socket.protocol, "wss:");
		assert.equal(socket.headers.authorization, `Bearer ${KEY}`);
		assert.equal(socket.headers["x-daytona-split-output"], "true", "the log stream keeps stdout and stderr apart");
	}
}

const of = (fake, method, path) => fake.requests.filter((r) => r.method === method && (path instanceof RegExp ? path.test(r.path) : r.path === path));
const deleted = (fake) => of(fake, "DELETE", /^\/api\/sandbox\/[^/]+$/);
const created = (fake) => of(fake, "POST", "/api/sandbox");

test("capabilities: a vendor lifetime, network none, open and allow with the ports each list opens, a container, linux, and the daemon's three", () => {
	const { provider, fake } = setup();
	assert.equal(provider.id, "daytona");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		lifetime: "vendor",
		network: ["none", "open", "allow"],
		allow: { domains: { max: 100, ports: [80, 443] }, cidrs: { max: 10, ports: "any" }, mixed: false },
		isolation: "container",
		os: "linux",
		daemon: ["exec", "files", "processes"],
	});
	assert.equal(setup({}, { sandboxClass: "linux-vm" }).provider.capabilities().isolation, "vm");
	assert.equal(fake.requests.length, 0);
});

test("the constructor refuses what it cannot run with, in words", () => {
	const make = (options) => () => new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => {}, ...options });
	assert.throws(make({ apiKey: "" }), /API key is required/);
	assert.throws(make({ apiUrl: "http://api.daytona.test/api" }), /must be https/);
	assert.throws(make({ daemonUser: "0:0" }), /root/);
	assert.throws(make({ daemonUser: "1000:0" }), /root's group/);
	assert.throws(make({ daemonUser: "daytona" }), /uid:gid in numbers/);
	assert.throws(make({ sandboxClass: "windows" }), /container or linux-vm/);
});

test("check() refuses in words, field by field, before any request", () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, network: "open", labels: { team: "a" } }), []);
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: ["example.com", "*.example.org"] } }), []);
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: ["208.80.154.232/32"] } }), []);
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	const words = (spec) => provider.check(spec).map((r) => r.message).join("; ");
	assert.deepEqual(refused({ ...SPEC, image: "" }), ["image"]);
	assert.deepEqual(refused({ ...SPEC, image: undefined }), ["image"]);
	for (const lifetimeMs of [undefined, 0, -1, 1.5, "600000", 30 * 24 * 3600 * 1000 + 1]) assert.deepEqual(refused({ ...SPEC, lifetimeMs }), ["lifetimeMs"], String(lifetimeMs));
	assert.deepEqual(refused({ ...SPEC, network: "wifi" }), ["network"]);
	assert.match(words({ ...SPEC, network: { allow: [] } }), /at least one/);
	assert.match(words({ ...SPEC, network: { allow: ["example.com", "208.80.154.232/32"] } }), /never both/);
	assert.match(words({ ...SPEC, network: { allow: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) } }), /at most 100 domains/);
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: Array.from({ length: 100 }, (_, i) => `h${i}.example.com`) } }), []);
	assert.match(words({ ...SPEC, network: { allow: Array.from({ length: 11 }, (_, i) => `208.80.154.${i}/32`) } }), /at most 10 CIDRs/);
	assert.match(words({ ...SPEC, network: { allow: ["2620:0:861:ed1a::1/128"] } }), /IPv4 only/);
	assert.match(words({ ...SPEC, network: { allow: ["https://example.com"] } }), /IPv4 only|no scheme/);
	assert.match(words({ ...SPEC, network: { allow: ["example.com/path"] } }), /neither a domain/);
	assert.match(words({ ...SPEC, network: { allow: ["208.80.154.232"] } }), /A\.B\.C\.D\/N/);
	assert.match(words({ ...SPEC, network: { allow: ["208.80.154.232/33"] } }), /A\.B\.C\.D\/N/);
	assert.match(words({ ...SPEC, cpus: 2 }), /size of its snapshot/);
	assert.match(words({ ...SPEC, memoryMb: 2048 }), /size of its snapshot/);
	assert.match(words({ ...SPEC, pids: 64 }), /size of its snapshot/);
	assert.match(words({ ...SPEC, user: "0" }), /daemon user \(1000:1000\)/);
	assert.match(words({ ...SPEC, workdir: "/data" }), /works in \/work/);
	assert.match(words({ ...SPEC, gpu: 1 }), /does not support gpu/);
	assert.deepEqual(refused({ ...SPEC, labels: { "agentrun.computer.deadline": "never" } }), ["labels"]);
	assert.deepEqual(refused({ ...SPEC, labels: { team: 1 } }), ["labels"]);
	assert.equal(fake.requests.length, 0, "check makes no request");
});

test("create() on a refused spec, or with no daemon binary, makes no request", async () => {
	const { provider, fake } = setup();
	for (const spec of [{ ...SPEC, lifetimeMs: 0 }, { ...SPEC, network: { allow: ["example.com", "208.80.154.232/32"] } }, { ...SPEC, cpus: 1 }]) {
		const result = await provider.create(spec);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
	}
	const missing = await setup({}, { daemonPath: join(dir, "nothing-here") }).provider.create(SPEC);
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "not_found");
	assert.match(missing.error.message, /no daemon binary/);
	const controller = new AbortController();
	controller.abort();
	const aborted = await provider.create(SPEC, { signal: controller.signal });
	assert.equal(aborted.error.code, "aborted");
	assert.equal(fake.requests.length, 0);
});

test("create() makes the sandbox, pushes the daemon in, starts init, checks it, and returns a ref", async () => {
	const { provider, fake } = setup();
	const before = Date.now();
	const made = await provider.create({ ...SPEC, labels: { team: "a" } });
	assert.equal(made.ok, true, JSON.stringify(made));
	const { id, name } = made.value;
	assert.match(name, NAME);
	assert.ok(fake.sandboxes.has(id), "the ref's id is the sandbox's");

	const [post] = created(fake);
	assert.equal(post.body.name, name);
	assert.equal(post.body.snapshot, SPEC.image);
	assert.equal(post.body.labels.team, "a");
	assert.equal(post.body.labels["agentrun.computer"], "1");
	const deadline = post.body.labels["agentrun.computer.deadline"];
	assert.ok(Math.abs(Date.parse(deadline) - (before + SPEC.lifetimeMs)) < 5000, deadline);
	assert.equal(new Date(Date.parse(deadline)).toISOString(), deadline);
	assert.equal(post.body.ttlMinutes, 10, "Daytona's TTL ends it: the lifetime in whole minutes, rounded up");
	assert.equal(post.body.autoStopInterval, 0, "no idle stop: the daemon's own work is not activity to Daytona");
	assert.equal(post.body.autoDeleteInterval, -1);
	assert.equal(post.body.public, false);
	assert.equal(post.body.networkBlockAll, true);
	assert.equal(post.body.networkAllowList, undefined);
	assert.equal(post.body.domainAllowList, undefined);
	assert.equal(post.body.cpu, undefined, "the size is the snapshot's");

	const [upload] = of(fake, "POST", /\/files\/upload-v2$/);
	assert.match(upload.query.path, /^\/tmp\/agentrun-computerd-[0-9a-f]{16}$/);
	assert.deepEqual(upload.body.file, { size: DAEMON_BYTES.length, sha256: DAEMON_SHA }, "the daemon's own bytes");
	const [install] = of(fake, "POST", /\/process\/execute$/).map((r) => scriptOf(r.body.command));
	assert.equal(install.kind, "install");
	assert.deepEqual(install.args, [upload.query.path, "/opt/agentrun/computerd", "1000", "1000", "/work", "/run/agentrun"]);
	const execs = of(fake, "POST", /\/process\/session\/[^/]+\/exec$/);
	const init = execs.find((r) => scriptOf(r.body.command).kind === "init");
	assert.match(init.path, /\/process\/session\/agentrun-computerd\/exec$/);
	assert.equal(init.body.runAsync, true);
	assert.equal(init.body.suppressInputEcho, true);
	assert.deepEqual(scriptOf(init.body.command).args, ["/opt/agentrun/computerd", deadline, "1000", "1000", "/work", "/run/agentrun"]);
	assert.match(init.body.command, /setpriv --reuid="\$u" --regid="\$g" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs/);
	const stdio = execs.find((r) => scriptOf(r.body.command).kind === "stdio");
	assert.equal(stdio.body.runAsync, true);
	assert.equal(stdio.body.suppressInputEcho, true, "the toolbox would echo input into stdout");
	const order = ["POST /api/sandbox", "upload-v2", "process/execute", "agentrun-computerd/exec", "agentrun-stdio-"].map((what) => fake.requests.findIndex((r) => `${r.method} ${r.path}`.includes(what)));
	assert.deepEqual([...order].sort((a, b) => a - b), order, `the steps in order: ${order}`);
	assert.ok(order.every((at) => at >= 0));
	const stdioSessions = of(fake, "POST", /\/process\/session$/).filter((r) => r.body.sessionId.startsWith("agentrun-stdio-"));
	assert.equal(stdioSessions.length, 1);
	assert.equal(of(fake, "DELETE", new RegExp(`/process/session/${stdioSessions[0].body.sessionId}$`)).length, 1, "the drift check's connection is closed");
	assert.equal(of(fake, "DELETE", /agentrun-computerd$/).length, 0, "init's session is never deleted");
	assert.equal(deleted(fake).length, 0);
	allToTheFake(fake);
});

test("create() asks Daytona for the network as declared", async () => {
	for (const [network, fields] of [
		["open", { networkBlockAll: false, networkAllowList: undefined, domainAllowList: undefined }],
		[{ allow: ["example.com", "*.example.org"] }, { networkBlockAll: undefined, domainAllowList: "example.com,*.example.org", networkAllowList: "" }],
		[{ allow: ["208.80.154.232/32"] }, { networkBlockAll: undefined, networkAllowList: "208.80.154.232/32", domainAllowList: "" }],
	]) {
		const { provider, fake } = setup();
		const made = await provider.create({ ...SPEC, network });
		assert.equal(made.ok, true, JSON.stringify(made));
		const [post] = created(fake);
		for (const [field, value] of Object.entries(fields)) assert.equal(post.body[field], value, `${JSON.stringify(network)}: ${field}`);
		const read = await provider.network(made.value);
		assert.deepEqual(read, { ok: true, value: network });
	}
});

test('image "default" sends no snapshot field, so Daytona makes the sandbox from its default snapshot; a named one is sent', async () => {
	const { provider, fake } = setup();
	assert.deepEqual(provider.check({ ...SPEC, image: "default" }), [], 'check() accepts "default"');
	const made = await provider.create({ ...SPEC, image: "default" });
	assert.equal(made.ok, true, JSON.stringify(made));
	const [post] = created(fake);
	assert.equal(Object.hasOwn(post.body, "snapshot"), false, "no snapshot key at all for the default snapshot");
	assert.equal(fake.sandboxes.get(made.value.id).snapshot, DEFAULT_SNAPSHOT, "Daytona reports its own default's name");
	const attached = await provider.attach({ id: made.value.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(attached.value.spec.image, DEFAULT_SNAPSHOT, "attach returns the snapshot Daytona reports");

	const named = setup();
	assert.equal((await named.provider.create(SPEC)).ok, true);
	assert.equal(created(named.fake)[0].body.snapshot, SPEC.image, "a named snapshot is sent by its name");
	allToTheFake(fake);
});

test('drift: a "default" computer is not held to a snapshot name, and is held to everything else', async () => {
	for (const snapshot of ["daytona-small", "anything-daytona-reports"]) {
		const { provider } = setup({ readBack: () => ({ snapshot }) });
		const made = await provider.create({ ...SPEC, image: "default" });
		assert.equal(made.ok, true, `${snapshot}: ${JSON.stringify(made)}`);
	}
	for (const [readBack, words] of [
		[() => ({ networkBlockAll: false }), /network: declared none, read back open/],
		[() => ({ autoStopInterval: 15 }), /autoStopInterval: declared 0, read back 15/],
		[() => ({ public: true }), /public: declared false, read back true/],
	]) {
		const { provider, fake } = setup({ readBack });
		const made = await provider.create({ ...SPEC, image: "default" });
		assert.equal(made.ok, false);
		assert.match(made.error.message, words);
		assert.doesNotMatch(made.error.message, /snapshot:/);
		assert.equal(fake.sandboxes.size, 0, "the drifted sandbox is deleted");
	}
	const { provider } = setup({ readBack: () => ({ snapshot: "other" }) });
	const named = await provider.create(SPEC);
	assert.match(named.error.message, /snapshot: declared "agentrun-debian", read back "other"/, "a named snapshot still drifts on its name");
});

test("the constructor takes autoStopMinutes and autoDeleteMinutes as whole minutes, 0 or more, and refuses anything else in words", () => {
	const make = (options) => () => new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: async () => {}, ...options });
	for (const value of [-1, 1.5, "30", Number.NaN, Number.POSITIVE_INFINITY, null]) {
		assert.throws(make({ autoStopMinutes: value }), /autoStopMinutes is a whole number of minutes, 0 or more/, String(value));
		assert.throws(make({ autoDeleteMinutes: value }), /autoDeleteMinutes is a whole number of minutes, 0 or more/, String(value));
	}
	for (const value of [0, 1, 30, 1440]) {
		assert.doesNotThrow(make({ autoStopMinutes: value }));
		assert.doesNotThrow(make({ autoDeleteMinutes: value }));
	}
});

test("create() sends autoStopMinutes and autoDeleteMinutes as Daytona's autoStopInterval and autoDeleteInterval, and the drift check holds them", async () => {
	const lifetimes = { autoStopMinutes: 30, autoDeleteMinutes: 0 };
	const { provider, fake } = setup({}, lifetimes);
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const [post] = created(fake);
	assert.equal(post.body.autoStopInterval, 30);
	assert.equal(post.body.autoDeleteInterval, 0);
	assert.equal(post.body.ttlMinutes, 10, "the TTL is sent besides them");
	assert.equal((await provider.attach({ id: made.value.id })).ok, true, "attach holds the computer to the same lifetimes");

	const defaults = setup();
	assert.equal((await defaults.provider.create(SPEC)).ok, true);
	assert.equal(created(defaults.fake)[0].body.autoStopInterval, 0, "unset: no idle stop");
	assert.equal(created(defaults.fake)[0].body.autoDeleteInterval, -1, "unset: no auto-delete");

	for (const [readBack, words] of [
		[() => ({ autoStopInterval: 0 }), /autoStopInterval: declared 30, read back 0/],
		[() => ({ autoStopInterval: 15 }), /autoStopInterval: declared 30, read back 15/],
		[() => ({ autoDeleteInterval: -1 }), /autoDeleteInterval: declared 0, read back -1/],
		[() => ({ autoDeleteInterval: 30 }), /autoDeleteInterval: declared 0, read back 30/],
		[() => ({ autoDeleteInterval: undefined }), /autoDeleteInterval: declared 0, read back nothing/],
	]) {
		const drifted = setup({ readBack }, lifetimes);
		const result = await drifted.provider.create(SPEC);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, words);
		assert.equal(drifted.fake.sandboxes.size, 0, "the drifted sandbox is deleted");
	}

	const other = setup({}, lifetimes);
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const seeded = other.fake.seed({ name: "computer-0000000000ae", autoDestroyAt: deadline, labels: { "agentrun.computer": "1", "agentrun.computer.deadline": deadline } });
	const attached = await other.provider.attach({ id: seeded.id });
	assert.equal(attached.ok, false, "a computer made with other lifetimes drifts");
	assert.match(attached.error.message, /autoStopInterval: declared 30, read back 0/);
	assert.match(attached.error.message, /autoDeleteInterval: declared 0, read back -1/);
	assert.ok(other.fake.sandboxes.has(seeded.id), "attach leaves it as it is");
});

test("with autoDeleteMinutes 0 a stop deletes: release stop is ok, the computer is gone, and a stopped one is never listed", async () => {
	const { provider, fake } = setup({}, { autoStopMinutes: 30, autoDeleteMinutes: 0 });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.deepEqual(await provider.release(made.value, "stop"), { ok: true, value: undefined });
	assert.equal(fake.sandboxes.has(made.value.id), false, "Daytona deleted it as it stopped");
	assert.deepEqual(await provider.list({}), { ok: true, value: [] });
	assert.equal((await provider.connect(made.value)).error.code, "not_found");
	assert.deepEqual(await provider.release(made.value, "delete"), { ok: true, value: undefined });
});

test("create() waits out a sandbox still being made, and a 5xx on a read is retried", async () => {
	const { provider, fake } = setup({ startAfterReads: 4, fail: [{ method: "GET", path: /^\/api\/sandbox\/[^/]+$/, status: 503, times: 2 }] });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.ok(of(fake, "GET", /^\/api\/sandbox\/[^/]+$/).length >= 6);
	assert.equal(created(fake).length, 1);
});

test("create() of a sandbox stuck in a pending state times out and deletes it", async () => {
	const { provider, fake } = setup({ stuck: true });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	assert.match(made.error.message, /did not start within 0\.3 s \(state pending_build\)/);
	assert.match(made.error.message, /was deleted/);
	assert.equal(deleted(fake).length, 1);
	assert.equal(fake.sandboxes.size, 0);
});

test("create() of a sandbox that errors while it starts deletes it and says why", async () => {
	const { provider, fake } = setup({ startError: "no runner had capacity" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /went to error while starting: no runner had capacity/);
	assert.equal(fake.sandboxes.size, 0);
});

test("a create Daytona refuses is not retried, and a sandbox it may have made is deleted by its name", async () => {
	const { provider, fake } = setup({ fail: [{ method: "POST", path: /^\/api\/sandbox$/, status: 500, times: 1 }] });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "daytona");
	assert.match(made.error.message, /Daytona did not create the sandbox: POST \/api\/sandbox: 500/);
	assert.equal(created(fake).length, 1, "POST /sandbox is not idempotent: never retried");
	const name = created(fake)[0].body.name;
	assert.deepEqual(deleted(fake).map((r) => r.path), [`/api/sandbox/${name}`]);
	for (const [status, body, code] of [
		[403, { message: "Total CPU quota exceeded" }, "limit"],
		[401, undefined, "denied"],
		[400, { message: "networkAllowList, domainAllowList and networkBlockAll are mutually exclusive" }, "invalid"],
	]) {
		const refused = setup({ fail: [{ method: "POST", path: /^\/api\/sandbox$/, status, body }] });
		const result = await refused.provider.create(SPEC);
		assert.equal(result.error.code, code, String(status));
		assert.equal(deleted(refused.fake).length, 0, `${status}: Daytona said no, so nothing was made to delete`);
	}
});

test("a refused daemon upload deletes the sandbox and says so", async () => {
	const { provider, fake } = setup({ uploadStatus: 403 });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "denied");
	assert.match(made.error.message, /the daemon's upload was refused: POST \/toolbox\/[^ ]+\/files\/upload-v2: 403/);
	assert.match(made.error.message, /was deleted/);
	assert.equal(fake.sandboxes.size, 0);
	assert.equal(of(fake, "POST", /\/process\//).length, 0, "nothing runs after a refused upload");
});

test("an install the snapshot cannot do, and a daemon that reads back other bytes, are refused and deleted", async () => {
	for (const [knobs, words] of [
		[{ install: { exitCode: 3, result: "the sandbox user daytona is not root and has no passwordless sudo, so the daemon cannot be installed\n" } }, /installing the daemon failed \(exit 3\): the sandbox user daytona is not root/],
		[{ install: { exitCode: 4, result: "the snapshot has no setpriv (util-linux), which starts the daemon with no capabilities\n" } }, /no setpriv/],
		[{ installSha: "0".repeat(64) }, /daemon: uploaded sha256 [0-9a-f]{64}, the installed binary reads back "0{64}"/],
	]) {
		const { provider, fake } = setup(knobs);
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "refused");
		assert.match(made.error.message, words);
		assert.equal(fake.sandboxes.size, 0);
	}
});

test("an init that does not start is reported in its own words, and the sandbox deleted", async () => {
	const { provider, fake } = setup({ initFails: "init: /run/agentrun is not the user's alone" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /the daemon did not answer: cannot reach the daemon in computer-[0-9a-f]{12}: computerd: stdio: cannot reach the daemon/);
	assert.match(made.error.message, /init wrote: computerd: init: \/run\/agentrun is not the user's alone/);
	assert.equal(fake.sandboxes.size, 0);
});

const DRIFT = [
	["the network read back open when none was asked", { readBack: () => ({ networkBlockAll: false }) }, /network: declared none, read back open/],
	["no TTL on the sandbox", { readBack: () => ({ autoDestroyAt: undefined }) }, /autoDestroyAt: declared a TTL/],
	["a TTL long past the deadline", { readBack: () => ({ autoDestroyAt: new Date(Date.now() + 3_600_000).toISOString() }) }, /autoDestroyAt: .* is past the deadline/],
	["an idle stop", { readBack: () => ({ autoStopInterval: 15 }) }, /autoStopInterval: declared 0, read back 15/],
	["an auto-delete", { readBack: () => ({ autoDeleteInterval: 0 }) }, /autoDeleteInterval: declared -1, read back 0/],
	["another snapshot", { readBack: () => ({ snapshot: "other" }) }, /snapshot: declared "agentrun-debian", read back "other"/],
	["a missing deadline label", { readBack: (sb) => ({ labels: { ...sb.labels, "agentrun.computer.deadline": undefined } }) }, /label agentrun\.computer\.deadline: declared "[^"]+", read back nothing/],
	["a missing label of the spec", { readBack: (sb) => ({ labels: { ...sb.labels, team: undefined } }) }, /label team: declared "a", read back nothing/],
	["a VM class", { readBack: () => ({ sandboxClass: "linux-vm" }) }, /sandboxClass: declared "container", read back "linux-vm"/],
	["a public preview", { readBack: () => ({ public: true }) }, /public: declared false, read back true/],
	["an outbound proxy", { readBack: () => ({ outboundProxyUrl: "http://user:secret@proxy.example.com:3128" }) }, /an outbound proxy is set on it/],
	["a volume", { readBack: () => ({ volumes: [{ volumeId: "v", mountPath: "/data" }] }) }, /volumes: declared \[\]/],
	["a linked sandbox", { readBack: () => ({ linkedSandboxId: "other-sandbox" }) }, /linkedSandboxId/],
	["KVM", { readBack: () => ({ kvm: true }) }, /kvm: declared false, read back true/],
	["a GPU", { readBack: () => ({ gpu: 1 }) }, /gpu: declared 0, read back 1/],
	["a daemon of another version", { hello: { version: "9.9.9" } }, new RegExp(`hello: the daemon reports version 9\\.9\\.9, expected ${VERSION.replaceAll(".", "\\.")}`)],
	["a daemon of another arch", { hello: { arch: "arm64" } }, /hello: the daemon reports arch arm64, expected the host's amd64/],
	["a daemon that lacks a capability", { hello: { capabilities: ["exec", "files"] } }, /capabilities lack processes/],
	["a daemon run as root", { status: statusText({ uid: 0 }) }, /daemon user: declared uid 1000, read back "0\\t0\\t0\\t0"/],
	["a daemon in root's group", { status: statusText({ gid: 0 }) }, /daemon group: declared gid 1000/],
	["a daemon with capabilities", { status: statusText({ capEff: "000001ffffffffff" }) }, /daemon CapEff: declared no capabilities, read back "000001ffffffffff"/],
	["a daemon with a bounding set", { status: statusText({ capBnd: "000001ffffffffff" }) }, /daemon CapBnd/],
	["a daemon that may gain privileges", { status: statusText({ noNewPrivs: 0 }) }, /daemon no_new_privs: declared 1, read back "0"/],
	["a daemon with groups", { status: statusText({ groups: "27" }) }, /daemon groups: declared none, read back "27"/],
	["a daemon in another directory", { cwd: "/" }, /daemon working directory: declared \/work, read back "\/"/],
	["a daemon run from another binary", { exe: "/tmp/computerd" }, /daemon binary: declared \/opt\/agentrun\/computerd, read back "\/tmp\/computerd"/],
];

for (const [what, knobs, words] of DRIFT) {
	test(`drift: ${what} is refused, in words, and the sandbox deleted`, async () => {
		const { provider, fake } = setup(knobs);
		const made = await provider.create({ ...SPEC, labels: { team: "a" } });
		assert.equal(made.ok, false, `${what}: create refused`);
		assert.equal(made.error.code, "refused");
		assert.match(made.error.message, /did not match its spec|does not match/);
		assert.match(made.error.message, words);
		assert.match(made.error.message, /computer-[0-9a-f]{12} was deleted/);
		assert.equal(deleted(fake).length, 1);
		assert.equal(fake.sandboxes.size, 0);
		assert.doesNotMatch(made.error.message, /secret/, "an outbound proxy's credentials are never repeated");
	});
}

test("drift: an allowlist Daytona did not keep is refused and deleted", async () => {
	for (const [network, readBack] of [
		[{ allow: ["example.com"] }, () => ({ domainAllowList: "example.com,example.org" })],
		[{ allow: ["example.com"] }, () => ({ domainAllowList: undefined })],
		[{ allow: ["208.80.154.232/32"] }, () => ({ networkAllowList: "208.80.154.0/24" })],
		["none", () => ({ networkBlockAll: true, networkAllowList: "208.80.154.232/32" })],
		["open", () => ({ networkBlockAll: undefined })],
	]) {
		const { provider, fake } = setup({ readBack });
		const made = await provider.create({ ...SPEC, network });
		assert.equal(made.ok, false, JSON.stringify(network));
		assert.match(made.error.message, /network: declared/);
		assert.equal(fake.sandboxes.size, 0);
	}
});

test("an abort during create deletes the sandbox, and create never returns ok once aborted", async () => {
	const steps = [/^\/api\/sandbox\/[^/]+$/, /\/files\/upload-v2$/, /\/process\/execute$/, /\/process\/session\/agentrun-computerd\/exec$/, /\/command\/[^/]+\/input$/];
	for (const path of steps) {
		const { provider, fake } = setup({ hang: [{ method: path.source.includes("api") ? "GET" : "POST", path }] });
		const controller = new AbortController();
		const pending = provider.create(SPEC, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort();
		const made = await pending;
		assert.equal(made.ok, false, path.source);
		assert.equal(made.error.code, "aborted", `${path.source}: ${made.error.message}`);
		assert.match(made.error.message, /was deleted/);
		assert.equal(fake.sandboxes.size, 0, `${path.source}: the sandbox is gone`);
	}
	const { provider, fake } = setup({ hang: [{ method: "POST", path: /^\/api\/sandbox$/ }] });
	const controller = new AbortController();
	const pending = provider.create(SPEC, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const made = await pending;
	assert.equal(made.error.code, "aborted");
	assert.deepEqual(deleted(fake).map((r) => r.path), [`/api/sandbox/${created(fake)[0].body.name}`], "the create's name is deleted, in case Daytona made it");
});

test("every call is bounded: a request that never answers times out in words", async () => {
	const { provider, fake } = setup({ hang: [{ method: "POST", path: /\/process\/session$/ }] }, { timeouts: { ...FAST, requestMs: 50 } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	assert.match(made.error.message, /POST \/toolbox\/[^ ]+\/process\/session did not answer within 0\.05 s/);
	assert.equal(fake.sandboxes.size, 0);
	const listing = setup({ hang: [{ method: "GET", path: /^\/api\/sandbox$/ }] }, { timeouts: { ...FAST, requestMs: 30 } });
	const listed = await listing.provider.list({});
	assert.equal(listed.error.code, "timeout");
	assert.equal(of(listing.fake, "GET", "/api/sandbox").length, 3, "a read is retried, up to three times");
});

test("list() asks for the provider's label alone, follows every page, and filters the rest itself", async () => {
	const { provider, fake } = setup({ pageSize: 2 });
	const now = Date.now();
	const deadline = new Date(now + 60_000).toISOString();
	const mine = (name, labels, fields = {}) => fake.seed({ name, labels: { "agentrun.computer": "1", "agentrun.computer.deadline": deadline, ...labels }, ...fields });
	const a = mine("computer-00000000000a", { team: "a" });
	const b = mine("computer-00000000000b", { team: "a" }, { state: "stopped", networkBlockAll: false, domainAllowList: "example.com" });
	mine("computer-00000000000c", { team: "b" });
	mine("computer-00000000000d", { team: "a" }, { state: "destroying" });
	mine("computer-00000000000e", { team: "a", "agentrun.computer.deadline": "tomorrow" });
	fake.seed({ name: "someone-else", labels: { "agentrun.computer": "1", team: "a" } });
	fake.seed({ name: "computer-00000000000f", labels: { team: "a" } });
	const listed = await provider.list({ team: "a" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	const byName = Object.fromEntries(listed.value.map((info) => [info.ref.name, info]));
	assert.deepEqual(Object.keys(byName).sort(), ["computer-00000000000a", "computer-00000000000b", "computer-00000000000e"]);
	assert.deepEqual(byName["computer-00000000000a"], { ref: { id: a.id, name: a.name }, labels: a.labels, deadline: new Date(deadline), state: "running", network: "none" });
	assert.equal(byName["computer-00000000000b"].state, "stopped");
	assert.deepEqual(byName["computer-00000000000b"].network, { allow: ["example.com"] });
	assert.equal(byName["computer-00000000000e"].deadline, undefined, "a deadline that is not the ISO time create writes");
	const queries = of(fake, "GET", "/api/sandbox");
	assert.ok(queries.length >= 3, "every page");
	for (const query of queries) assert.deepEqual(JSON.parse(query.query.labels), { "agentrun.computer": "1" });
	assert.equal(b.state, "stopped");
	const invalid = await provider.list("team=a");
	assert.equal(invalid.error.code, "invalid");
});

test("list() reads a sandbox whose listing leaves its network out", async () => {
	const { provider, fake } = setup({ listBack: () => ({ networkBlockAll: undefined }) });
	fake.seed({ name: "computer-00000000000a", labels: { "agentrun.computer": "1", "agentrun.computer.deadline": new Date().toISOString() } });
	const listed = await provider.list({});
	assert.equal(listed.value[0].network, "none");
	assert.equal(of(fake, "GET", /^\/api\/sandbox\/[^/]+$/).length, 1);
});

test("attach() by id, by name and by labels returns the spec read back, with the daemon checked", async () => {
	const { provider, fake } = setup();
	const made = await provider.create({ ...SPEC, labels: { team: "a" } });
	assert.equal(made.ok, true, JSON.stringify(made));
	const deadline = created(fake)[0].body.labels["agentrun.computer.deadline"];
	for (const ref of [{ id: made.value.id }, { id: made.value.name }, { labels: { team: "a" } }]) {
		const attached = await provider.attach(ref);
		assert.equal(attached.ok, true, `${JSON.stringify(ref)}: ${JSON.stringify(attached)}`);
		assert.deepEqual(attached.value, { ...made.value, spec: { image: SPEC.image, user: "1000:1000", network: "none", cpus: 1, memoryMb: 1024, workdir: "/work", deadline: new Date(deadline) } });
	}
	const missing = await provider.attach({ id: "nothing-by-this-id" });
	assert.equal(missing.error.code, "not_found");
	assert.equal((await provider.attach({ labels: { team: "z" } })).error.code, "not_found");
	assert.equal((await provider.attach({})).error.code, "invalid");
	assert.equal((await provider.attach({ id: made.value.id, labels: {} })).error.code, "invalid");
	await provider.create({ ...SPEC, labels: { team: "a" } });
	const two = await provider.attach({ labels: { team: "a" } });
	assert.equal(two.error.code, "invalid");
	assert.match(two.error.message, /2 computers match the labels/);
});

test("attach() never finds a sandbox the provider did not make", async () => {
	const { provider, fake } = setup();
	const theirs = fake.seed({ name: "their-sandbox", labels: { team: "a" } });
	const labelled = fake.seed({ name: "not-a-computer-name", labels: { "agentrun.computer": "1", team: "a" } });
	for (const id of [theirs.id, labelled.id, "their-sandbox"]) assert.equal((await provider.attach({ id })).error.code, "not_found", id);
	assert.equal((await provider.attach({ labels: { team: "a" } })).error.code, "not_found");
	assert.equal(of(fake, "POST", /\/process\//).length, 0, "nothing ran in them");
});

test("attach() refuses a drifted computer and leaves it as it is", async () => {
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const labels = { "agentrun.computer": "1", "agentrun.computer.deadline": deadline };
	for (const [what, fields, knobs, words] of [
		["open to a public preview", { public: true }, {}, /public: declared false, read back true/],
		["an outbound proxy", { outboundProxyUrl: "http://proxy.example.com:3128" }, {}, /network: an outbound proxy is set on it, which this provider never makes/],
		["both lists", { networkBlockAll: false, networkAllowList: "208.80.154.232/32", domainAllowList: "example.com" }, {}, /both a CIDR and a domain allow list/],
		["a deadline label of another shape", { labels: { ...labels, "agentrun.computer.deadline": "soon" } }, {}, /deadline: the label agentrun\.computer\.deadline reads "soon"/],
		["no TTL", { autoDestroyAt: undefined }, {}, /autoDestroyAt/],
		["a daemon of another version", {}, { hello: { version: "0.0.1" } }, /hello: the daemon reports version 0\.0\.1/],
		["a daemon run as root", {}, { status: statusText({ uid: 0 }) }, /daemon user/],
	]) {
		const { provider, fake } = setup(knobs);
		const sb = fake.seed({ name: "computer-0000000000aa", labels, autoDestroyAt: deadline, ...fields });
		const attached = await provider.attach({ id: sb.id });
		assert.equal(attached.ok, false, what);
		assert.equal(attached.error.code, "refused", what);
		assert.match(attached.error.message, /attach refuses it and it is left as it is/);
		assert.match(attached.error.message, words, what);
		assert.equal(deleted(fake).length, 0, `${what}: attach never deletes`);
		assert.ok(fake.sandboxes.has(sb.id));
		assert.doesNotMatch(attached.error.message, /3128/, "never the proxy's address");
	}
});

test("attach() of a stopped computer checks the sandbox alone", async () => {
	const { provider, fake } = setup();
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const sb = fake.seed({ name: "computer-0000000000ab", state: "stopped", autoDestroyAt: deadline, labels: { "agentrun.computer": "1", "agentrun.computer.deadline": deadline } });
	const attached = await provider.attach({ id: sb.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(attached.value.spec.workdir, undefined);
	assert.equal(of(fake, "POST", /\/toolbox\//).length, 0, "no toolbox call to a stopped sandbox");
});

test("connect() speaks to the daemon over a session's input and log stream, and close() ends that session", async () => {
	const { provider, fake } = setup({ bridgeStderr: "computerd: stdio: connected" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const sessionsBefore = of(fake, "POST", /\/process\/session$/).length;
	const connected = await provider.connect(made.value);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.equal(connected.value.hello.version, VERSION);
	const calls = await Promise.all([connected.value.client.call("ping", {}), connected.value.client.call("exec.run", { argv: ["echo", "one", "two"], timeoutMs: 1000 }), connected.value.client.call("ping", {})]);
	assert.deepEqual(calls[0], { ok: true, value: {} });
	assert.equal(Buffer.from(calls[1].value.stdout, "base64").toString(), "one two\n");
	assert.deepEqual(calls[2], { ok: true, value: {} });
	const inputs = of(fake, "POST", /\/input$/).slice(-3);
	for (const input of inputs) assert.ok(input.body.data.endsWith("\n"), "whole lines only: Daytona adds a newline to any other");
	await connected.value.close();
	await connected.value.close();
	const sessions = of(fake, "POST", /\/process\/session$/).slice(sessionsBefore);
	assert.equal(sessions.length, 1, "one session per connection");
	assert.equal(of(fake, "DELETE", new RegExp(`${sessions[0].body.sessionId}$`)).length, 1, "closed once");
	const after = await connected.value.client.call("ping", {});
	assert.equal(after.error.code, "gone");
	allToTheFake(fake);
});

test("connect() drops an echo of its own requests, should the toolbox echo input", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	fake.knobs.echoInput = true;
	const connected = await provider.connect(made.value);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.deepEqual(await connected.value.client.call("ping", {}), { ok: true, value: {} });
	await connected.value.close();
});

test("connect() refuses a daemon of another version, a stopped computer, a deleted one and another's", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	fake.knobs.hello = { version: "0.0.1" };
	const drifted = await provider.connect(made.value);
	assert.equal(drifted.ok, false);
	assert.equal(drifted.error.code, "refused");
	assert.match(drifted.error.message, /version 0\.0\.1/);
	const stdio = of(fake, "POST", /\/process\/session$/).at(-1).body.sessionId;
	assert.equal(of(fake, "DELETE", new RegExp(`${stdio}$`)).length, 1, "its session is closed");
	fake.knobs.hello = undefined;
	assert.equal((await provider.release(made.value, "stop")).ok, true);
	const stopped = await provider.connect(made.value);
	assert.equal(stopped.error.code, "refused");
	assert.match(stopped.error.message, /is stopped, not started/);
	assert.equal((await provider.release(made.value, "delete")).ok, true);
	assert.equal((await provider.connect(made.value)).error.code, "not_found");
	const theirs = fake.seed({ name: "computer-0000000000ac", labels: { team: "a" } });
	assert.equal((await provider.connect({ id: theirs.id, name: theirs.name })).error.code, "not_found");
	assert.equal((await provider.connect({ id: "x", name: "x" })).error.code, "invalid");
});

test("a daemon whose bridge cannot reach init is reported with the bridge's words", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	fake.inside(made.value.id).running = false;
	const connected = await provider.connect(made.value);
	assert.equal(connected.ok, false);
	assert.match(connected.error.message, /cannot reach the daemon in computer-[0-9a-f]{12}: computerd: stdio: cannot reach the daemon/);
});

test("network() reads back, and a change is applied and read back, or refused with the network put back", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	const ref = made.value;
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	const before = of(fake, "POST", /network-settings$/).length;
	assert.deepEqual(await provider.network(ref, "none"), { ok: true, value: "none" });
	assert.equal(of(fake, "POST", /network-settings$/).length, before, "asking for the network it has changes nothing");
	for (const [policy, body] of [
		["open", { networkBlockAll: false }],
		[{ allow: ["example.com"] }, { domainAllowList: "example.com", networkAllowList: "" }],
		[{ allow: ["208.80.154.232/32"] }, { networkAllowList: "208.80.154.232/32", domainAllowList: "" }],
		["none", { networkBlockAll: true }],
	]) {
		assert.deepEqual(await provider.network(ref, policy), { ok: true, value: policy }, JSON.stringify(policy));
		assert.deepEqual(of(fake, "POST", /network-settings$/).at(-1).body, body);
		assert.deepEqual(await provider.network(ref), { ok: true, value: policy });
	}
	const bad = await provider.network(ref, { allow: [] });
	assert.equal(bad.error.code, "invalid");
	fake.knobs.networkStatus = 403;
	const tier = await provider.network(ref, "open");
	assert.equal(tier.error.code, "refused");
	assert.match(tier.error.message, /Daytona refused the change to network open: .*403 .*cannot be overridden/);
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
	fake.knobs.networkStatus = undefined;
	fake.knobs.networkIgnored = true;
	const ignored = await provider.network(ref, "open");
	assert.equal(ignored.error.code, "refused");
	assert.match(ignored.error.message, /Daytona did not apply network open: computer-[0-9a-f]{12} still reads back none/);
	assert.equal(of(fake, "POST", /network-settings$/).at(-1).body.networkBlockAll, false, "nothing to put back");
	fake.knobs.networkIgnored = false;
	fake.knobs.hang = [{ method: "POST", path: /network-settings$/ }];
	const slow = await provider.network(ref, "open", { signal: AbortSignal.timeout(50) });
	assert.equal(slow.error.code, "aborted");
	assert.match(slow.error.message, /the change to network open did not complete: POST \/api\/sandbox\/[^ ]+\/network-settings was aborted/);
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" }, "a change that never answered is read back, and left as it was");
	fake.knobs.hang = undefined;
	assert.equal((await provider.network({ id: "x", name: "x" })).error.code, "invalid");
	assert.equal((await provider.network({ ...ref, id: "nothing-by-this-id" })).error.code, "not_found");
});

test("network(): a change Daytona applies otherwise is never left wider: it is put back, or blocked", async () => {
	const { provider, fake } = setup();
	const made = await provider.create({ ...SPEC, network: { allow: ["example.com"] } });
	const ref = made.value;
	// Daytona keeps the domain list and adds what was not asked for: the change is undone.
	fake.knobs.readBack = (sb) => (sb.domainAllowList === "example.org" ? { domainAllowList: "example.org,example.net" } : {});
	const widened = await provider.network(ref, { allow: ["example.org"] });
	assert.equal(widened.error.code, "refused");
	assert.match(widened.error.message, /is back on \["example\.com"\]|is back on \{"allow":\["example\.com"\]\}/);
	assert.deepEqual(await provider.network(ref), { ok: true, value: { allow: ["example.com"] } });
	// One that cannot be put back either is blocked.
	const changes = of(fake, "POST", /network-settings$/).length;
	fake.knobs.readBack = (sb) => (!sb.networkBlockAll && of(fake, "POST", /network-settings$/).length > changes ? { domainAllowList: "example.org,example.net" } : {});
	const blocked = await provider.network(ref, { allow: ["example.org"] });
	assert.equal(blocked.error.code, "refused");
	assert.match(blocked.error.message, /was blocked \(none\)/);
	fake.knobs.readBack = undefined;
	assert.deepEqual(await provider.network(ref), { ok: true, value: "none" });
});

test("release(): delete and stop are idempotent, retried where the prior art retries, and never touch another's sandbox", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	const ref = made.value;
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.equal(fake.sandboxes.get(ref.id).state, "stopped");
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined }, "a stopped computer stops again");
	const listed = await provider.list({});
	assert.deepEqual(listed.value.map((info) => [info.ref.name, info.state]), [[ref.name, "stopped"]]);
	fake.knobs.fail = [{ method: "DELETE", path: /^\/api\/sandbox\/[^/]+$/, status: 502, times: 2 }];
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(deleted(fake).length, 3, "a DELETE that met a 502 is retried");
	assert.equal(fake.sandboxes.size, 0);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined }, "a computer already gone");
	assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
	assert.equal((await provider.list({})).value.length, 0);
	const theirs = fake.seed({ name: "computer-0000000000ad", labels: { team: "a" } });
	const refused = await provider.release({ id: theirs.id, name: theirs.name }, "delete");
	assert.equal(refused.error.code, "not_found");
	assert.ok(fake.sandboxes.has(theirs.id), "another's sandbox is left as it is");
	assert.equal((await provider.release(ref, "pause")).error.code, "invalid");
	assert.equal((await provider.release({ id: "x", name: "x" }, "delete")).error.code, "invalid");
});

test("release(): a DELETE that keeps failing is reported in words, with a forced stop before the last attempt", async () => {
	const { provider, fake } = setup();
	const made = await provider.create(SPEC);
	fake.knobs.fail = [{ method: "DELETE", path: /^\/api\/sandbox\/[^/]+$/, status: 500, times: 100 }];
	const released = await provider.release(made.value, "delete");
	assert.equal(released.ok, false);
	assert.equal(released.error.code, "daytona");
	assert.match(released.error.message, /DELETE \/api\/sandbox\/[^ ]+: 500/);
	assert.equal(of(fake, "POST", /\/stop$/).length, 1, "a forced stop before the last attempt");
	assert.equal(of(fake, "POST", /\/stop$/)[0].url.endsWith("stop?force=true"), true);
});

test("a redirect is never followed, so the key never goes where it points", async () => {
	const redirecting = async () => {
		throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
	};
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: redirecting, webSocket: () => assert.fail("no socket"), timeouts: FAST });
	const listed = await provider.list({});
	assert.equal(listed.ok, false);
	assert.match(listed.error.message, /redirect, which is never followed/);
});

test("a toolbox URL that is not https is refused before the key is sent to it", async () => {
	const { provider, fake } = setup({ readBack: () => ({ toolboxProxyUrl: "http://proxy.daytona.test/toolbox" }) });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.match(made.error.message, /toolbox URL Daytona gave is not https/);
	assert.equal(fake.requests.filter((r) => r.host === "proxy.daytona.test").length, 0);
	assert.equal(PROXY.startsWith("https://"), true);
});
