// FreestyleProvider's host on a fake Freestyle (fake-freestyle.mjs): a fetch that answers Freestyle's REST API
// (api.freestyle.sh/v5, the shapes of its OpenAPI), where a VM keeps the files its exec-await commands write and starts
// what its launch line starts. What Freestyle's own host decides is held here: create's body (the slug, the snapshot, the
// packed labels as metadata, ttlSeconds at the backstop, ephemeral, no restart, the public-egress firewall), the 409 that
// is a slug taken or no capacity, the wait for running and the one exec-await launch of agentrun-dial with the boot env
// as its env, get and list with their states and pages, delete, dialLog, dialExit and redial, exec-await's answer, the
// error codes in Freestyle's words, and the janitor's sweep and releaseOlder over packed metadata. The adapter's dial
// lifecycle runs once through it here to its daemon's hello (bootDial) and through Core's provider cases; Freestyle's own
// is proven live, from packages/serve/scripts/dial-conformance.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ATTACH_CLOSE, AttachHub, MemoryMachineTokens, mintedComputer, releaseOlder, sweep } from "../dist/index.js";
import { codeOfError } from "../dist/hosted/process.js";
import { packLabels, unpackLabels } from "../dist/hosted/values.js";
import * as registry from "../dist/providers.js";
import { bootDial, dialServer, socketPair } from "./fake-dial-host.mjs";
import { fakeFreestyle, json, KEY, vmIdOf } from "./fake-freestyle.mjs";

const { FreestyleProvider, accountOf, boxFreestyleSnapshot, create } = await import("../dist/freestyle.js");
const freestyleModule = await import("../dist/conformance/freestyle.js");

const VM = vmIdOf(0);
const NAME = "computer-0123456789ab";
const SNAPSHOT = "sh-00000000-0000-4000-8000-0000000000aa";
const CTX = { timeoutMs: 10_000 };
const ATTACH = "wss://agentrun.example.com/v2/computers/attach";
const TOKEN = `art_${"0".repeat(64)}`;
const BOOT = { AGENTRUN_ATTACH_URL: ATTACH, AGENTRUN_ATTACH_TOKEN: TOKEN, AGENTRUN_DAEMON_URL: "https://agentrun.example.com/v2/computers/daemon", AGENTRUN_DAEMON_SHA256: "0".repeat(64), AGENTRUN_INIT_ARGS: "--deadline 2026-11-28T10:10:00.000Z --user 2510:2510 --own-network" };
const ROOM = { count: 64, packed: { valueBytes: 63 } };
const LABELS = packLabels({ "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.run": "run-1" }, NAME, ROOM).labels;
const REQUEST = { name: NAME, image: SNAPSHOT, labels: LABELS, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 1_200_000).toISOString(), egress: true, boot: { env: BOOT } };
const DIAL_LOG = "/run/agentrun-dial/log";
const DIAL_EXIT = "/run/agentrun-dial/exit";
const DIAL_SCRIPT = "/run/agentrun-dial/launch";
const DAEMON_PATH = fileURLToPath(import.meta.url);
const DAEMON = readFileSync(DAEMON_PATH);
const TIMEOUTS = { pollMs: 1, listedStableMs: 0 };

const provider = (fake, options = {}) => new FreestyleProvider({ apiKey: KEY, fetch: fake.fetch, timeouts: { pollMs: 1 }, ...options });

/** A fake Freestyle whose VMs' launches boot and dial `dial` with the env the launch was given; `booted` holds each boot. */
function dialing(dial, options = {}) {
	const booted = [];
	const fake = fakeFreestyle({ ...options, start: (vm, script, env) => booted.push({ vm: vm.record.id, ...bootDial(env, dial, { daemon: DAEMON }) }) });
	return { fake, booted };
}

/** A VM's labels as the adapter packs them, for a VM another create made. */
const packed = (labels) => packLabels(labels, labels["agentrun.computer.name"], ROOM).labels;

// --- create ---

test("create posts the slug, the snapshot, the packed labels as metadata, ttlSeconds at the backstop, ephemeral with no restart, the public-egress firewall, and no idle pause or env", async () => {
	const fake = fakeFreestyle();
	const before = Date.now();
	assert.deepEqual(await provider(fake).host.create(REQUEST, CTX), { id: VM });
	const post = fake.calls.find(({ method, url }) => method === "POST" && url.pathname === "/v5/vms");
	assert.equal(post.url.origin, "https://api.freestyle.sh");
	assert.equal(post.headers.Authorization, `Bearer ${KEY}`);
	assert.equal(Object.keys(post.headers).some((name) => /background/i.test(name)), false, "no background request is asked for");
	const { ttlSeconds, ...rest } = post.body;
	assert.deepEqual(rest, { slug: NAME, snapshotId: SNAPSHOT, metadata: LABELS, autoDeleteSeconds: 0, automaticRestart: false, firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] } });
	const expected = Math.ceil((Date.parse(REQUEST.backstopAt) - before) / 1000);
	assert.ok(ttlSeconds <= expected && ttlSeconds >= expected - 2, `ttlSeconds ${ttlSeconds} is the backstop, ${expected} s from now`);
	assert.equal(JSON.stringify(post.body).includes(TOKEN), false, "the token is never in the VM's record");
});

test("create waits for the VM to run, then starts agentrun-dial in one exec-await as root: the launch script, its start under setsid, the boot env the command's env, and the token never in a command or a file", async () => {
	const fake = fakeFreestyle({ states: ["starting", "starting", "running"] });
	assert.deepEqual(await provider(fake).host.create(REQUEST, CTX), { id: VM });
	const execs = fake.execs();
	assert.equal(execs.length, 1, "one command");
	const [{ body }] = execs;
	assert.equal(body.linuxUser, "root");
	assert.deepEqual(body.env, BOOT);
	assert.ok(body.timeoutMs >= 1 && body.timeoutMs <= 300_000, "within exec-await's inline bound");
	assert.match(body.command, /^umask 077 && mkdir -p \/run\/agentrun-dial && /);
	assert.match(body.command, /setsid nohup sh -c 'sh \/run\/agentrun-dial\/launch; echo \$\? > \/run\/agentrun-dial\/exit' > \/run\/agentrun-dial\/log 2>&1 < \/dev\/null &/);
	assert.equal(body.command.includes(TOKEN), false);
	const vm = fake.vms.get(VM);
	assert.match(vm.files.get(DIAL_SCRIPT), /exec \/usr\/local\/bin\/agentrun-dial$/);
	for (const [path, text] of vm.files) assert.equal(String(text).includes(TOKEN), false, `${path} holds no token`);
	assert.deepEqual(vm.starts.map(({ env }) => env.AGENTRUN_ATTACH_TOKEN), [TOKEN], "agentrun-dial started once, with the token in its env");
	const reads = fake.calls.filter(({ method, url }) => method === "GET" && url.pathname === `/v5/vms/${VM}`);
	assert.equal(reads.length, 2, "read until it ran");
});

test("a VM that stops, pauses or goes before it runs fails create in Freestyle's words, agentrun-dial never started; one still starting at the bound is a timeout", async () => {
	for (const state of ["stopped", "paused"]) {
		const fake = fakeFreestyle({ states: ["starting", state] });
		const error = await provider(fake).host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(error.code, "vendor", state);
		assert.match(error.message, new RegExp(`Freestyle reads the VM ${VM} "${state}" before it ran, so agentrun-dial was not started`));
		assert.deepEqual(fake.execs(), []);
	}
	const gone = fakeFreestyle({ states: ["starting"], answer: (method, path) => (method === "GET" && path === `/vms/${VM}` ? json(404, { code: "NOT_FOUND", message: "vm not found" }) : undefined) });
	const went = await provider(gone).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(went.code, "vendor");
	assert.match(went.message, /no longer has the VM .* which went before it ran/);
	const slow = fakeFreestyle({ states: ["starting"] });
	const late = await provider(slow, { timeouts: { pollMs: 20 } }).host.create(REQUEST, { timeoutMs: 100 }).catch((caught) => caught);
	assert.equal(late.code, "timeout");
	assert.match(late.message, /did not read running within 0\.1 s \(it reads starting\)/);
	assert.equal(slow.calls.filter(({ method }) => method === "DELETE").length, 0, "a timeout may have made it: the adapter sweeps by name");
});

test("a launch that exits other than 0 fails create in its words; one that got no answer, or a VM_NON_RESPONSIVE, is never sent again", async () => {
	const failing = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? json(200, { stdout: "", stderr: "mkdir: cannot create directory", statusCode: 1 }) : undefined) });
	const error = await provider(failing).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(error.code, "vendor");
	assert.equal(error.message, `starting agentrun-dial in ${VM} exited 1: mkdir: cannot create directory`);
	for (const said of [() => Promise.reject(new TypeError("fetch failed")), () => json(409, { code: "VM_NON_RESPONSIVE", message: "the VM stopped responding; the command may already have run" })]) {
		let tries = 0;
		const silent = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? (tries++, said()) : undefined) });
		await assert.rejects(provider(silent).host.create(REQUEST, CTX));
		assert.equal(tries, 1, "a launch that may have run is never sent again");
	}
});

test("a 409 is a slug taken where the slug reads a VM (exists, which the adapter adopts), else no capacity (limit); a 429 create is sent again, a create with no answer never", async () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	await host.create(REQUEST, CTX);
	const taken = await host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(taken.code, "exists");
	assert.match(taken.message, new RegExp(`409 CONFLICT: slug ${NAME} is already used by another VM: the account has a VM of the slug ${NAME} \\(${VM}\\)`));
	assert.equal(fake.vms.size, 1, "no second VM");
	const full = fakeFreestyle({ capacity: false });
	const none = await provider(full).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(none.code, "limit");
	assert.match(none.message, /answered 409 CONFLICT: no capacity is available, and no VM has the slug computer-0123456789ab: Freestyle has no capacity for it/);
	let posts = 0;
	const busy = fakeFreestyle({ answer: (method, path) => (path === "/vms" && method === "POST" && ++posts === 1 ? json(429, { code: "LIMIT_EXCEEDED", message: "rate limited" }) : undefined) });
	assert.deepEqual(await provider(busy).host.create(REQUEST, CTX), { id: VM });
	assert.equal(posts, 2);
	let tries = 0;
	const silent = { fetch: async () => (tries++, Promise.reject(new TypeError("fetch failed"))) };
	await assert.rejects(provider(silent).host.create(REQUEST, CTX));
	assert.equal(tries, 1, "a create that got no answer may have made a VM: never sent again");
});

test("a create that fails after Freestyle made the VM deletes it, in the create's own code: an exec refused by 429s past every retry (limit) or by a 401 (denied)", async () => {
	for (const [status, code] of [
		[429, "limit"],
		[401, "denied"],
	]) {
		const fake = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? json(status, { code: status === 429 ? "LIMIT_EXCEEDED" : "UNAUTHORIZED", message: "the account said no" }) : undefined) });
		const made = provider(fake, { dial: dialServer(), daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 30_000 } });
		const created = await made.create({ image: SNAPSHOT, lifetimeMs: 600_000, network: "none" }, { requestId: `freestyle-unmade-${status}` });
		assert.equal(created.error?.code, code, String(status));
		assert.match(created.error.message, new RegExp(`the VM ${VM} it made was deleted`), String(status));
		assert.deepEqual(fake.deleted, [VM], `${status}: a VM create made is never left running`);
	}
});

test("a request with no boot env makes nothing", async () => {
	const fake = fakeFreestyle();
	const { boot: _boot, ...bare } = REQUEST;
	const error = await provider(fake).host.create(bare, CTX).catch((caught) => caught);
	assert.equal(error.code, "invalid");
	assert.deepEqual(fake.calls, []);
});

// --- get, list, delete ---

test("get reads Freestyle's states as the adapter's, its resources in the adapter's units and its metadata as labels; a missing VM is none, an id of no VM's form not_found", async () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	for (const [state, read] of [
		["starting", "starting"],
		["running", "running"],
		["pausing", "stopped"],
		["paused", "stopped"],
		["stopped", "stopped"],
	]) {
		const id = fake.add(LABELS, { state });
		const machine = await host.get(id, CTX);
		assert.equal(machine.state, read, state);
		assert.deepEqual(machine.labels, LABELS);
		assert.deepEqual(machine.resources, { cpus: 2, memoryMb: 4096, diskGb: 16 });
		assert.equal(machine.createdAt.toISOString(), "2026-11-28T09:00:00.000Z");
		assert.equal(machine.why, undefined);
	}
	const odd = await host.get(fake.add(LABELS, { state: "hibernating" }), CTX);
	assert.equal(odd.state, "stopped", "listed, so the janitor still ends it");
	assert.match(odd.why, /reads its state as "hibernating", which this provider does not know/);
	assert.equal(await host.get(vmIdOf(99), CTX), undefined);
	const bad = await host.get("../vms", CTX).catch((caught) => caught);
	assert.equal(bad.code, "not_found");
	assert.equal(fake.calls.some(({ url }) => url.pathname.includes("..")), false);
});

test("list asks Freestyle by metadata, every pair at once, reads every page by offset, and matches each label itself, so a listing that answers more is filtered", async () => {
	const fake = fakeFreestyle({ filters: false });
	const { host } = provider(fake);
	const mine = fake.add({ agentrun: NAME, "agentrun-0": "pabcp" });
	for (let n = 0; n < 150; n++) fake.add({ agentrun: `computer-${String(n).padStart(12, "0")}` });
	fake.add({});
	const listed = await host.list({ agentrun: NAME }, CTX);
	assert.deepEqual(listed.map(({ id }) => id), [mine], "the over-return is filtered here");
	const lists = fake.calls.filter(({ method, url }) => method === "GET" && url.pathname === "/v5/vms");
	assert.deepEqual(lists.map(({ url }) => [url.searchParams.get("metadata"), url.searchParams.get("offset"), url.searchParams.get("limit")]), [
		[`agentrun:${NAME}`, "0", "100"],
		[`agentrun:${NAME}`, "100", "100"],
	]);
	assert.equal((await host.list({}, CTX)).length, 152, "no label asked: every VM, every page");
	const tricky = await host.list({ agentrun: NAME, "a:b": "c,d" }, CTX);
	assert.deepEqual(tricky, [], "a label the filter can't say is matched here alone");
	assert.equal(fake.calls.at(-1).url.searchParams.get("metadata"), `agentrun:${NAME}`);
});

test("delete deletes the VM, a missing one is done, and a VM deleted reads none after", async () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	const { id } = await host.create(REQUEST, CTX);
	await host.delete(id, CTX);
	assert.deepEqual(fake.deleted, [VM]);
	assert.equal(await host.get(id, CTX), undefined, "delete's read-back");
	await host.delete(id, CTX);
	await assert.rejects(host.redial(id, CTX), (error) => error.code === "not_found", "its dial's env went with it");
});

// --- the dial's log, exit and redial ---

test("dialLog and dialExit read agentrun-dial's log and exit through exec-await, none before it wrote them; redial starts its launch script once more with create's env", async () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	const other = fake.add(LABELS);
	assert.equal(await host.dialLog(other, CTX), undefined, "never started there");
	assert.equal(await host.dialExit(other, CTX), undefined);
	const { id } = await host.create(REQUEST, CTX);
	const vm = fake.vms.get(id);
	vm.files.set(DIAL_LOG, "agentrun-dial: fetching the daemon failed: 503\n");
	assert.equal(await host.dialLog(id, CTX), "agentrun-dial: fetching the daemon failed: 503\n");
	assert.match(fake.execs().at(-1).body.command, /tail -c 65536 \/run\/agentrun-dial\/log$/);
	assert.equal(await host.dialExit(id, CTX), undefined, "still running");
	vm.files.set(DIAL_EXIT, "3\n");
	assert.equal(await host.dialExit(id, CTX), 3);
	await host.redial(id, CTX);
	assert.deepEqual(vm.starts.map(({ script, env }) => [script === vm.files.get(DIAL_SCRIPT), env.AGENTRUN_ATTACH_TOKEN]), [
		[true, TOKEN],
		[true, TOKEN],
	]);
	assert.equal(vm.files.has(DIAL_EXIT), false, "the new start's exit is its own");
	const fresh = provider(fake).host;
	await assert.rejects(fresh.redial(id, CTX), (error) => error.code === "not_found" && /from this process/.test(error.message), "another process holds no env to start it with");
});

test("exec-await's answer: its text as Freestyle decoded it, no exit status a timeout, a 202 a background request this provider never asks for, never a pass", async () => {
	const answers = [];
	const fake = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") && answers.length > 0 ? answers.shift() : undefined) });
	const { host } = provider(fake);
	const { id } = await host.create(REQUEST, CTX);
	answers.push(json(200, { stdout: "café �\u{1f600}\r\nend", stderr: "", statusCode: 0 }));
	assert.equal(await host.dialLog(id, CTX), "café �\u{1f600}\r\nend", "every code point as Freestyle answered it, \\r\\n kept");
	answers.push(json(200, { stdout: "", stderr: "", statusCode: null }));
	const killed = await host.dialLog(id, CTX).catch((caught) => caught);
	assert.equal(killed.code, "timeout");
	assert.match(killed.message, /answered no exit status: its timeout killed the command/);
	answers.push(new Response(null, { status: 202, headers: { "x-freestyle-background-request-id": "br-1" } }));
	const background = await host.dialExit(id, CTX).catch((caught) => caught);
	assert.equal(background.code, "vendor");
	assert.match(background.message, /answered 202 \(a background request, which this provider never asks for\)/);
	answers.push(json(200, { stdout: "", stderr: "", statusCode: "0" }));
	assert.match((await host.dialExit(id, CTX).catch((caught) => caught)).message, /an exit status that is no number: "0"/);
});

// --- errors, check, the constructor ---

test("Freestyle's errors are codes in Freestyle's words, never the key", async () => {
	for (const [status, said, code] of [
		[401, "UNAUTHORIZED", "denied"],
		[403, "FORBIDDEN", "denied"],
		[400, "BAD_REQUEST", "invalid"],
		[429, "LIMIT_EXCEEDED", "limit"],
		[500, "INTERNAL_ERROR", "vendor"],
	]) {
		const fake = fakeFreestyle({ answer: (method, path) => (path === "/vms" && method === "POST" ? json(status, { code: said, message: "the account said no" }) : undefined) });
		const { host } = provider(fake, { timeouts: { pollMs: 1 } });
		const error = await host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(codeOfError(host, error), code, String(status));
		assert.equal(error.message, `POST /v5/vms answered ${status} ${said}: the account said no`);
		assert.equal(error.message.includes(KEY), false);
	}
	const fake = fakeFreestyle();
	const wrong = new FreestyleProvider({ apiKey: "fake-test-key", fetch: fake.fetch });
	const denied = await wrong.host.list({}, CTX).catch((caught) => caught);
	assert.equal(denied.code, "denied");
	assert.equal(denied.message.includes("fake-test-key"), false);
});

test("check takes a snapshot of the account by id or slug, or a public {owner}/{slug}; Freestyle's base snapshots, another form or a size are refused before any call", () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	for (const image of [SNAPSHOT, "agentrun-box-0123456789ab", "acme/agentrun-box"]) assert.deepEqual(host.check({ image }), [], image);
	for (const image of ["freestyle/ubuntu", "freestyle/ubuntu-sm", "ghcr.io/parcha-ai/agentrun-box:abc", "Agentrun", "a--b", "-x", "a/b/c", ""]) {
		assert.deepEqual(host.check({ image }).map(({ field }) => field), ["image"], image);
	}
	assert.match(host.check({ image: "freestyle/ubuntu" })[0].message, /base snapshots \(freestyle\/\.\.\.\) have none/);
	assert.deepEqual(host.check({ image: boxFreestyleSnapshot() }), [], "the box snapshot's slug");
	assert.deepEqual(host.check({ image: SNAPSHOT, cpus: 2 }).map(({ field }) => field), ["cpus"]);
	assert.deepEqual(host.check({ image: SNAPSHOT, memoryMb: 4096 }).map(({ field }) => field), ["memoryMb"]);
	assert.match(host.check({ cpus: 2 })[0].message, /a Freestyle VM has the size of its snapshot/);
	assert.deepEqual(fake.calls, []);
});

test("the constructor refuses a missing key, a fetch that is no function, an API URL off https, the VM user's uid as the daemon's and a lifetime past a day, never echoing the key", async () => {
	assert.throws(() => new FreestyleProvider({}), /options.apiKey, the Freestyle API key, is required/);
	assert.throws(() => new FreestyleProvider({ apiKey: KEY, fetch: "no" }), /options.fetch must be a function/);
	assert.throws(() => new FreestyleProvider({ apiKey: KEY, apiUrl: "http://api.freestyle.sh" }), (error) => /must be https/.test(error.message) && !error.message.includes(KEY));
	assert.throws(() => new FreestyleProvider({ apiKey: KEY, daemonUser: "1000:1000" }), /the uid of the VM's own user/);
	assert.throws(() => new FreestyleProvider({ apiKey: KEY, maxLifetimeMs: 25 * 3_600_000 }), /maxLifetimeMs/);
	assert.ok((await create({ apiKey: KEY })) instanceof FreestyleProvider);
	const prepared = await new FreestyleProvider({ apiKey: KEY, fetch: () => assert.fail("prepareImage calls nothing") }).prepareImage();
	assert.deepEqual(prepared, { ok: true, value: boxFreestyleSnapshot() });
	assert.match(boxFreestyleSnapshot(), /^agentrun-box-[0-9a-f]{12}$/, "the box snapshot is named by the box recipe's hash");
	const fake = fakeFreestyle();
	const elsewhere = new FreestyleProvider({ apiKey: KEY, fetch: fake.fetch, apiUrl: "https://freestyle.example.com/" });
	await elsewhere.host.list({}, CTX);
	assert.equal(fake.calls[0].url.origin, "https://freestyle.example.com");
});

test("the provider dials: kind linux, a VM, the janitor's lifetime, no exec, upload or extend, none, open and a list; a server with no public address calls Freestyle for nothing", async () => {
	const fake = fakeFreestyle();
	const made = provider(fake, { dial: { tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	assert.equal(made.id, "freestyle");
	assert.equal(made.host.facts.connect, "dial");
	assert.deepEqual(made.host.facts.labels, { count: 64, packed: { valueBytes: 63 } });
	for (const member of ["exec", "upload", "download", "extend"]) assert.equal(made.host[member], undefined, member);
	const caps = made.capabilities();
	assert.deepEqual([caps.kind, caps.isolation, caps.lifetime, caps.network], ["linux", "vm", "janitor", ["none", "open", "allow"]]);
	const refused = await made.create({ image: SNAPSHOT, lifetimeMs: 600_000, network: "none" }, { requestId: "freestyle-no-address" });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /^Freestyle machines dial this server, and it has no public https address/);
	assert.deepEqual(fake.calls, []);
});

// --- over dial, as serve builds it ---

test("a Freestyle VM over dial, as serve builds it: the VM boots from the launch and its env, dials, and its daemon answers linux; release deletes it", async () => {
	const dial = dialServer();
	const { fake, booted } = dialing(dial);
	const made = provider(fake, { dial, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const created = await made.create({ image: SNAPSHOT, lifetimeMs: 600_000, network: "none" }, { requestId: "freestyle-over-dial" });
	assert.equal(created.ok, true, created.ok ? "" : `${created.error.code}: ${created.error.message}`);
	assert.equal(booted.length, 1);
	assert.equal(booted[0].dialed, true, "the VM's daemon is the server's: it dialed");
	const labels = unpackLabels(fake.vms.get(created.value.id).record.metadata);
	assert.equal(labels["agentrun.computer.name"], created.value.name, "the metadata unpacks to the adapter's labels");
	const connection = await made.connect(created.value);
	assert.equal(connection.ok, true, connection.ok ? "" : `${connection.error.code}: ${connection.error.message}`);
	assert.equal(connection.value.hello.kind, "linux");
	await connection.value.close();
	const released = await made.release(created.value, "delete");
	assert.equal(released.ok, true, released.ok ? "" : `${released.error.code}: ${released.error.message}`);
	assert.equal(fake.vms.size, 0);
});

/** A DialKit over a fake Freestyle and its server, for provider.dial-token: each VM's token is its launch's env's. */
function kitOf(fake, dial, made) {
	const attach = (token, socket) => {
		const minted = dial.tokens.check(token);
		if (minted === undefined) return socket.close(ATTACH_CLOSE.unauthorized, "no machine has this token");
		void dial.hub.accept(mintedComputer(minted.machine, minted.mint), socket);
	};
	const creates = () => fake.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v5/vms").length;
	return () => ({
		check: (token, at) => dial.tokens.check(token, at)?.machine,
		token: (ref) => fake.execs().find(({ url }) => fake.vms.get(decodeURIComponent(url.pathname.split("/")[3]))?.record.slug === ref.name)?.body.env?.AGENTRUN_ATTACH_TOKEN,
		async dialAs(token, hello) {
			const [server, machine] = socketPair();
			machine.onText((text) => {
				const request = JSON.parse(text);
				if (typeof request.id !== "number") return;
				machine.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(request.method === "hello" ? { result: hello } : { error: { code: -32601, message: `${request.method} is not a method` } }) }));
			});
			const closed = new Promise((done) => machine.onClose((code) => done(code)));
			attach(token, server);
			return Promise.race([closed, new Promise((done) => setTimeout(done, 2_000))]);
		},
		unreachable() {
			const before = creates();
			return { provider: provider(fake, { ...made, dial: { tokens: dial.tokens, hub: dial.hub } }), creates: () => creates() - before };
		},
	});
}

test("Core's provider cases pass through the Freestyle REST calls and the dial, provider.dial-token among them, and leave nothing behind", { timeout: 120_000 }, async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const dial = dialServer();
	const { fake } = dialing(dial);
	const options = { dial, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS };
	// Not provider.deadline or drift.arch: they run programs, which the fake machine's daemon only echoes (as hosted-dial's run).
	const cases = conformanceCases.filter((one) => ["provider", "health", "drift"].includes(one.group) && one.level === "core" && !["provider.deadline", "drift.arch"].includes(one.id));
	const report = await runConformance(provider(fake, options), { image: SNAPSHOT, cases, dial: kitOf(fake, dial, options), caseTimeoutMs: 30_000, cleanupTimeoutMs: 10_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.equal(report.results.find(({ id }) => id === "provider.dial-token")?.status, "pass", JSON.stringify(report.results.find(({ id }) => id === "provider.dial-token")));
	assert.deepEqual(
		report.results.filter(({ status }) => status === "fail").map(({ id, reason }) => `${id}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(fake.vms.size, 0, "every VM made was deleted");
});

// --- the janitor ---

test("the janitor's sweep and releaseOlder over packed metadata: past or unreadable deadlines are swept, older or unreadable epochs released, a newer epoch kept, and a VM with no packed map to read a run from never touched", async () => {
	const fake = fakeFreestyle();
	const made = provider(fake, { timeouts: TIMEOUTS });
	const labels = (n, extra) => ({ "agentrun.computer": "1", "agentrun.computer.name": `computer-${String(n).padStart(12, "0")}`, ...extra });
	const past = "2026-11-28T08:00:00.000Z";
	const ahead = "2026-11-28T12:00:00.000Z";
	const expired = fake.add(packed(labels(1, { "agentrun.computer.deadline": past })));
	const unreadable = fake.add(packed(labels(2, { "agentrun.computer.deadline": "not a time" })));
	const missing = fake.add(packed(labels(3, {})));
	const current = fake.add(packed(labels(4, { "agentrun.computer.deadline": ahead })));
	// No packed map the adapter can read: a run's labels can't be read from it, so neither the sweep nor a release ever touches it.
	const corrupt = fake.add({ agentrun: "computer-000000000005", "agentrun-0": "p!!not-deflate!!p" });
	const named = fake.add({ agentrun: "computer-000000000006" });
	const foreign = fake.add({ team: "someone-else" });
	const swept = await sweep(made, { now: new Date("2026-11-28T10:00:00.000Z") });
	assert.equal(swept.ok, true, swept.ok ? "" : swept.error.message);
	assert.deepEqual(swept.value.deleted.sort(), ["computer-000000000001", "computer-000000000002", "computer-000000000003"], "past, unreadable and missing deadlines: fail closed");
	assert.equal(swept.value.kept, 1);
	assert.deepEqual(fake.deleted.sort(), [expired, unreadable, missing].sort());
	for (const id of [current, corrupt, named, foreign]) assert.ok(fake.vms.has(id), `${id} never touched`);

	const run = (n, epoch) => fake.add(packed(labels(n, { "agentrun.computer.deadline": ahead, "agentrun.run": "run-1", ...(epoch === undefined ? {} : { "agentrun.epoch": epoch }) })));
	const older = run(10, "1");
	const noEpoch = run(11, undefined);
	const badEpoch = run(12, "one");
	const same = run(13, "2");
	const otherRun = fake.add(packed(labels(14, { "agentrun.computer.deadline": ahead, "agentrun.run": "run-2", "agentrun.epoch": "1" })));
	const released = await releaseOlder(made, "run-1", 2);
	assert.equal(released.ok, true, released.ok ? "" : released.error.message);
	assert.deepEqual(released.value.released.map(({ name }) => name).sort(), ["computer-000000000010", "computer-000000000011", "computer-000000000012"]);
	assert.deepEqual(released.value.unproven.map(({ ref }) => ref.name).sort(), ["computer-000000000011", "computer-000000000012"]);
	assert.deepEqual(released.value.kept.map(({ name }) => name), ["computer-000000000013"]);
	for (const id of [older, noEpoch, badEpoch]) assert.equal(fake.vms.has(id), false, `${id} released`);
	for (const id of [same, otherRun, current, corrupt, named, foreign]) assert.ok(fake.vms.has(id), `${id} never touched`);
	const fenced = await releaseOlder(made, "run-1", 1);
	assert.equal(fenced.ok, false, "a newer epoch's VM fences an older claim");
	assert.match(fenced.error.message, /^fenced: run "run-1" has computer-000000000013 at epoch 2/);
	assert.ok(fake.vms.has(same));
});

// --- the registry and the conformance module ---

test("the registry builds Freestyle from its options alone, and its source reads no environment and writes nowhere", async () => {
	const fake = fakeFreestyle();
	const made = await registry.providerFor("freestyle", { apiKey: KEY, fetch: fake.fetch });
	assert.equal(made.id, "freestyle");
	assert.deepEqual(fake.calls, []);
	assert.ok(registry.providerIds.includes("freestyle"));
	assert.equal((await registry.providerModule("freestyle")).create, create);
	assert.deepEqual(registry.descriptorOf("freestyle").keys.map(({ name, option, required }) => [name, option, required]), [["FREESTYLE_API_KEY", "apiKey", true]]);
	assert.equal(registry.descriptorOf("freestyle").connect, "dial");
	const source = readFileSync(new URL("../dist/freestyle.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /COMPUTER_FREESTYLE_/);
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/);
	assert.equal(accountOf(KEY), accountOf(KEY, "https://api.freestyle.sh/"));
	assert.doesNotMatch(accountOf(KEY), new RegExp(KEY));
});

test("the conformance module reads COMPUTER_FREESTYLE_* alone, needs its live switch first, refuses a dialKit off the public server, and its sweep's host and scope need none", async () => {
	const { live, ...names } = freestyleModule.ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_FREESTYLE");
	assert.deepEqual(names, { key: "COMPUTER_FREESTYLE_API_KEY", image: "COMPUTER_FREESTYLE_IMAGE", apiUrl: "COMPUTER_FREESTYLE_API_URL" });
	const env = { COMPUTER_FREESTYLE_API_KEY: KEY };
	await assert.rejects(freestyleModule.createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_FREESTYLE=1/);
	assert.throws(() => freestyleModule.settingsFromEnv({ FREESTYLE_API_KEY: KEY }), (error) => /set COMPUTER_FREESTYLE_API_KEY/.test(error.message) && !error.message.includes(KEY));
	const made = await freestyleModule.createProvider({ env: { ...env, [live]: "1" } });
	assert.equal(made.capabilities().maxLifetimeMs, 30 * 60_000);
	const host = await freestyleModule.createHost({ env });
	assert.equal(host.descriptor.id, "freestyle");
	assert.equal(freestyleModule.sweepScope({ env }), accountOf(KEY));
	assert.doesNotMatch(freestyleModule.sweepScope({ env }), new RegExp(KEY));
	assert.equal(await freestyleModule.conformanceImage({ env }), boxFreestyleSnapshot(), "the box snapshot prepareImage() names");
	assert.equal(await freestyleModule.conformanceImage({ env: { ...env, COMPUTER_FREESTYLE_IMAGE: SNAPSHOT } }), SNAPSHOT);
	assert.throws(() => freestyleModule.dialKit({ env }), /^Error: Freestyle's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider freestyle/);
});
