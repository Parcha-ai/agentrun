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
import { mayHaveMade } from "../dist/hosted/provider.js";
import { packLabels, unpackLabels } from "../dist/hosted/values.js";
import * as registry from "../dist/providers.js";
import { bootDial, dialServer, socketPair } from "./fake-dial-host.mjs";
import { fakeFreestyle, json, KEY, snapshotIdOf, vmIdOf } from "./fake-freestyle.mjs";

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

test("a VM that stops, pauses or goes before it runs fails create in Freestyle's words, agentrun-dial never started, and the VM is deleted; one still starting at the bound is a timeout, deleted too", async () => {
	for (const state of ["stopped", "paused"]) {
		const fake = fakeFreestyle({ states: ["starting", state] });
		const error = await provider(fake).host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(error.code, "vendor", state);
		assert.match(error.message, new RegExp(`Freestyle reads the VM ${VM} "${state}" before it ran, so agentrun-dial was not started; the VM ${VM} it made was deleted`));
		assert.deepEqual(fake.execs(), []);
		assert.deepEqual(fake.deleted, [VM], state);
	}
	const gone = fakeFreestyle({ states: ["starting"], answer: (method, path) => (method === "GET" && path === `/vms/${VM}` ? json(404, { code: "NOT_FOUND", message: "vm not found" }) : undefined) });
	const went = await provider(gone).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(went.code, "vendor");
	assert.match(went.message, /no longer has the VM .* which went before it ran/);
	const slow = fakeFreestyle({ states: ["starting"] });
	const late = await provider(slow, { timeouts: { pollMs: 20 } }).host.create(REQUEST, { timeoutMs: 100 }).catch((caught) => caught);
	assert.equal(late.code, "timeout");
	assert.match(late.message, /did not read running within 0\.1 s \(it reads starting\)/);
	assert.deepEqual(slow.deleted, [VM], "the VM create made is known by its id: deleted, never left to a sweep");
});

test("a launch that exits other than 0 fails create in its words and deletes the VM; one that got no answer, or a VM_NON_RESPONSIVE, is never sent again", async () => {
	const failing = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? json(200, { stdout: "", stderr: "mkdir: cannot create directory", statusCode: 1 }) : undefined) });
	const error = await provider(failing).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(error.code, "vendor");
	assert.equal(error.message, `starting agentrun-dial in ${VM} exited 1: mkdir: cannot create directory; the VM ${VM} it made was deleted`);
	assert.deepEqual(failing.deleted, [VM]);
	for (const said of [() => Promise.reject(new TypeError("fetch failed")), () => json(409, { code: "VM_NON_RESPONSIVE", message: "the VM stopped responding; the command may already have run" })]) {
		let tries = 0;
		const silent = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? (tries++, said()) : undefined) });
		await assert.rejects(provider(silent).host.create(REQUEST, CTX));
		assert.equal(tries, 1, "a launch that may have run is never sent again");
		assert.deepEqual(silent.deleted, [VM]);
	}
});

test("a 409 is a slug taken where the slug reads a VM (exists, which the adapter adopts), else no capacity (limit); a 429 create is sent again, a create with no answer never", async () => {
	const fake = fakeFreestyle();
	const { host } = provider(fake);
	await host.create(REQUEST, CTX);
	const before = fake.calls.length;
	const taken = await host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(taken.code, "exists");
	assert.match(taken.message, new RegExp(`409 CONFLICT: slug ${NAME} is already used by another VM: the account has a VM of the slug ${NAME} \\(${VM}\\)`));
	assert.deepEqual(
		fake.calls.slice(before).map(({ method, url }) => `${method} ${url.pathname}`),
		["POST /v5/vms", `GET /v5/vms/${NAME}`],
		"the 409's slug read first, then the answer; nothing deleted",
	);
	assert.equal(fake.vms.size, 1, "no second VM");
	const full = fakeFreestyle({ capacity: false });
	const none = await provider(full).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(none.code, "limit");
	assert.match(none.message, /answered 409 CONFLICT: no capacity is available, and no VM has the slug computer-0123456789ab: Freestyle has no capacity for it/);
	assert.deepEqual(
		full.calls.map(({ method, url }) => `${method} ${url.pathname}`),
		["POST /v5/vms", `GET /v5/vms/${NAME}`],
	);
	assert.deepEqual(full.deleted, []);
	let posts = 0;
	const busy = fakeFreestyle({ answer: (method, path) => (path === "/vms" && method === "POST" && ++posts === 1 ? json(429, { code: "LIMIT_EXCEEDED", message: "rate limited" }) : undefined) });
	assert.deepEqual(await provider(busy).host.create(REQUEST, CTX), { id: VM });
	assert.equal(posts, 2);
	let tries = 0;
	const silent = { fetch: async () => (tries++, Promise.reject(new TypeError("fetch failed"))) };
	await assert.rejects(provider(silent).host.create(REQUEST, CTX));
	assert.equal(tries, 1, "a create that got no answer may have made a VM: never sent again");
});

test("once the POST made the VM, a later step's failure deletes it by its id and is never a refusal (which says nothing was made): an exec refused by 429s past every retry, a 401 or 403 on the exec or on the wait's read", async () => {
	const refusing = (status, at) => (method, path) => {
		const said = json(status, { code: { 401: "UNAUTHORIZED", 403: "FORBIDDEN", 429: "LIMIT_EXCEEDED" }[status], message: "the account said no" });
		if (at === "exec" && path.endsWith("/exec-await")) return said;
		if (at === "read" && method === "GET" && path === `/vms/${VM}`) return said;
		return undefined;
	};
	for (const [status, at] of [
		[429, "exec"],
		[401, "exec"],
		[403, "exec"],
		[401, "read"],
	]) {
		const what = `${status} on the ${at}`;
		const fake = fakeFreestyle({ states: at === "read" ? ["starting"] : ["running"], answer: refusing(status, at) });
		const error = await provider(fake).host.create(REQUEST, CTX).catch((caught) => caught);
		assert.ok(mayHaveMade(error.code), `${what}: ${error.code} is no refusal`);
		assert.equal(error.code, "vendor", what);
		assert.match(error.message, new RegExp(`answered ${status} .*the account said no; the VM ${VM} it made was deleted`), what);
		assert.equal(fake.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v5/vms").length, 1, `${what}: only the later step failed`);
		assert.deepEqual(fake.deleted, [VM], `${what}: the VM create made is never left running`);
	}
	// Through the adapter, as serve makes one: the create fails in that code, and nothing is left.
	const fake = fakeFreestyle({ answer: refusing(429, "exec") });
	const made = provider(fake, { dial: dialServer(), daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 30_000 } });
	const created = await made.create({ image: SNAPSHOT, lifetimeMs: 600_000, network: "none" }, { requestId: "freestyle-unmade" });
	assert.equal(created.ok, false);
	assert.ok(mayHaveMade(created.error.code), created.error.code);
	assert.equal(fake.vms.size, 0, "a VM create made is never left");
});

test("a failed create whose delete of the VM fails too says so, naming Freestyle's ttlSeconds backstop, in a code the adapter sweeps by name", async () => {
	const fake = fakeFreestyle({
		answer: (method, path) => {
			if (path.endsWith("/exec-await")) return json(200, { stdout: "", stderr: "no space left", statusCode: 1 });
			if (method === "DELETE") return json(400, { code: "BAD_REQUEST", message: "try later" });
			return undefined;
		},
	});
	const error = await provider(fake).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(error.code, "vendor");
	assert.ok(mayHaveMade(error.code));
	assert.match(error.message, new RegExp(`exited 1: no space left; the VM ${VM} it made could not be deleted \\(.*400 BAD_REQUEST: try later\\); Freestyle deletes it at its ttlSeconds`));
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

test("a listing of many pages is held to the caller's timeout as a whole, each page given only the time left", async () => {
	const slow = (signal) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(undefined), 150);
			signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
		});
	const fake = fakeFreestyle({ answer: (method, path, body, { signal }) => (method === "GET" && path === "/vms" ? slow(signal) : undefined) });
	const { host } = provider(fake);
	const listings = () => fake.calls.filter(({ method, url }) => method === "GET" && url.pathname === "/v5/vms").length;
	for (let n = 0; n < 450; n++) fake.add({ agentrun: NAME });
	assert.equal((await host.list({ agentrun: NAME }, CTX)).length, 450, "five pages of 100, given the time");
	assert.equal(listings(), 5);
	const before = listings();
	const started = Date.now();
	const late = await host.list({ agentrun: NAME }, { timeoutMs: 400 }).catch((caught) => caught);
	const took = Date.now() - started;
	assert.equal(codeOfError(host, late), "timeout", late?.message);
	assert.ok(took < 1_000, `the whole listing ended near its 400 ms (${took} ms)`);
	const pages = listings() - before;
	assert.ok(pages <= 3, `five 150 ms pages don't fit in 400 ms: the third is cut at the bound, and none asked after it (${pages} asked)`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(listings() - before, pages, "nothing fetched after the listing gave up");
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

test("the dial token travels in exec-await's env alone: never in a URL, a header, a command or a request's other fields, the VM's metadata or files, or an error's words, even where the VM's output echoes it", async () => {
	const answers = [];
	const fake = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") && answers.length > 0 ? answers.shift() : undefined) });
	const { host } = provider(fake);
	const { id } = await host.create(REQUEST, CTX);
	await host.dialLog(id, CTX);
	await host.dialExit(id, CTX);
	await host.redial(id, CTX);
	await host.get(id, CTX);
	await host.list({ "agentrun.computer.name": NAME }, CTX);
	answers.push(json(200, { stdout: "", stderr: `agentrun-dial: refused ${TOKEN}`, statusCode: 2 }));
	const again = await host.redial(id, CTX).catch((caught) => caught);
	assert.equal(again.code, "vendor");
	assert.equal(again.message.includes(TOKEN), false, again.message);
	assert.match(again.message, /exited 2: agentrun-dial: refused <AGENTRUN_ATTACH_TOKEN>/);
	const vm = fake.vms.get(id);
	assert.equal(JSON.stringify(vm.record).includes(TOKEN), false, "the VM's record and metadata");
	for (const [path, text] of vm.files) assert.equal(String(text).includes(TOKEN), false, `${path} holds no token`);
	await host.delete(id, CTX);
	// A launch whose output echoes the token: the create's error names the env, never the token.
	const echoing = fakeFreestyle({ answer: (method, path) => (path.endsWith("/exec-await") ? json(200, { stdout: `token=${TOKEN}`, stderr: `dial failed with ${TOKEN}`, statusCode: 1 }) : undefined) });
	const failed = await provider(echoing).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(failed.message.includes(TOKEN), false, failed.message);
	assert.match(failed.message, /exited 1: dial failed with <AGENTRUN_ATTACH_TOKEN>/);
	for (const [one, launches] of [
		[fake, 3],
		[echoing, 1],
	]) {
		const carried = [];
		for (const { method, url, headers, body } of one.calls) {
			const { env, ...rest } = body ?? {};
			assert.equal(`${method} ${url} ${JSON.stringify(headers)} ${JSON.stringify(rest)}`.includes(TOKEN), false, `${method} ${url.pathname}: the token outside env`);
			if (env === undefined) continue;
			assert.match(url.pathname, /\/exec-await$/, "env is exec-await's alone");
			if (env.AGENTRUN_ATTACH_TOKEN === TOKEN) carried.push(url.pathname);
		}
		assert.equal(carried.length, launches, "the token went in each start's env (create's launch and each redial), and in no read's");
	}
});

/** A fetch answer that never comes: it rejects once the request's signal aborts, as fetch does. */
const hanging = (signal) =>
	new Promise((_resolve, reject) => {
		const stop = () => reject(signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
	});

test("exec-await is bounded by its caller: an abort in the middle of the call ends it at once, as aborted; a call past its timeoutMs ends as a timeout; a launch cut short deletes the VM", { timeout: 20_000 }, async () => {
	let hang = false;
	const fake = fakeFreestyle({ answer: (method, path, body, { signal }) => (hang && path.endsWith("/exec-await") ? hanging(signal) : undefined) });
	const { host } = provider(fake);
	const { id } = await host.create(REQUEST, CTX);
	hang = true;
	const controller = new AbortController();
	const started = Date.now();
	setTimeout(() => controller.abort(), 50);
	const aborted = await host.dialExit(id, { timeoutMs: 60_000, signal: controller.signal }).catch((caught) => caught);
	assert.equal(codeOfError(host, aborted), "aborted", aborted.message);
	assert.ok(Date.now() - started < 2_000, `the abort ended the call at once (${Date.now() - started} ms)`);
	const sent = fake.execs().length;
	const timed = Date.now();
	const late = await host.dialLog(id, { timeoutMs: 200 }).catch((caught) => caught);
	assert.equal(codeOfError(host, late), "timeout", late.message);
	assert.ok(Date.now() - timed < 3_000, `held to its 200 ms (${Date.now() - timed} ms)`);
	assert.ok(fake.execs().slice(sent).every(({ body }) => body.timeoutMs <= 200), "Freestyle is asked for no more time than the caller gave");
	const launching = fakeFreestyle({ answer: (method, path, body, { signal }) => (path.endsWith("/exec-await") ? hanging(signal) : undefined) });
	const cut = new AbortController();
	setTimeout(() => cut.abort(), 50);
	const stopped = await provider(launching).host.create(REQUEST, { timeoutMs: 60_000, signal: cut.signal }).catch((caught) => caught);
	assert.equal(stopped.code, "aborted", stopped.message);
	assert.deepEqual(launching.deleted, [VM], "the VM the POST made is deleted, on its own bound past the caller's abort");
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
	assert.match(boxFreestyleSnapshot(), /^agentrun-box-[0-9a-f]{12}$/, "the box snapshot is named by the box recipe's hash");
	const fake = fakeFreestyle();
	const elsewhere = new FreestyleProvider({ apiKey: KEY, fetch: fake.fetch, apiUrl: "https://freestyle.example.com/" });
	await elsewhere.host.list({}, CTX);
	assert.equal(fake.calls[0].url.origin, "https://freestyle.example.com");
});

// --- the box snapshot ---

const BOX = boxFreestyleSnapshot();
const BUILD_DIR = "/tmp/agentrun-box";
const RECIPE = ["install.sh", "agentrun-archil"].map((file) => [`${BUILD_DIR}/${file}`, readFileSync(new URL(`../box/${file}`, import.meta.url), "utf8")]);
/** A fake whose build VM's install.sh answers `outcome`, the files the VM held when it started kept in `seen`. */
function building(outcome = { exit: 0, log: "" }, options = {}) {
	const seen = [];
	const fake = fakeFreestyle({ states: ["starting", "running"], ...options, build: (vm) => (seen.push({ files: new Map(vm.files), execs: [...vm.execs] }), outcome) });
	return { fake, seen };
}
const waits = () => {
	const told = [];
	return { told, onWait: (making, tag) => told.push([making, tag]) };
};

test("prepareImage answers the account's snapshot of the box recipe's digest when it has one, by its id, and makes nothing", async () => {
	const fake = fakeFreestyle({ snapshots: [BOX] });
	const { told, onWait } = waits();
	assert.deepEqual(await provider(fake).prepareImage({ onWait }), { ok: true, value: snapshotIdOf(0) });
	assert.deepEqual(fake.calls.map(({ method, url }) => `${method} ${url.pathname}`), [`GET /v5/snapshots/${BOX}`]);
	assert.deepEqual(told, [], "onWait is told nothing when the account has it");
});

test("prepareImage builds the box snapshot once where the account has none: freestyle/ubuntu booted, the recipe uploaded, install.sh started detached and its exit file polled, the snapshot taken by the digest, and the build VM deleted", async () => {
	const { fake, seen } = building({ exit: 0, log: "the box is ready" });
	const { told, onWait } = waits();
	const made = provider(fake);
	const prepared = await made.prepareImage({ onWait });
	assert.deepEqual(prepared, { ok: true, value: snapshotIdOf(0) });
	assert.deepEqual(told, [["build", BOX]], "onWait is told once, before the build");
	const posts = fake.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v5/vms");
	assert.equal(posts.length, 1);
	const { snapshotId, metadata, ttlSeconds, autoDeleteSeconds, automaticRestart, firewall, slug } = posts[0].body;
	assert.deepEqual({ snapshotId, metadata, ttlSeconds, autoDeleteSeconds, automaticRestart, slug }, { snapshotId: "freestyle/ubuntu", metadata: { "agentrun-box-build": BOX }, ttlSeconds: 7200, autoDeleteSeconds: 0, automaticRestart: false, slug: undefined });
	assert.ok(firewall, "the build VM has the public-egress firewall: install.sh fetches its packages");
	assert.equal(seen.length, 1, "install.sh started once");
	for (const [path, text] of RECIPE) assert.equal(seen[0].files.get(path), text, `${path} is the recipe's own`);
	const start = seen[0].execs.at(-1);
	assert.match(start.command, /setsid nohup sh -c 'sh \/tmp\/agentrun-box\/install\.sh; echo \$\? > \/tmp\/agentrun-box\/exit'/);
	const execs = fake.execs();
	for (const { body } of execs) {
		assert.equal(body.linuxUser, "root");
		assert.equal(body.env, undefined, "the build runs with no env");
		assert.ok(body.timeoutMs <= 300_000, "every exec-await is answered inline");
	}
	assert.ok(execs.at(-1).body.command.includes(`rm -rf ${BUILD_DIR}`), "the build folder is removed before the snapshot");
	const shots = fake.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/snapshot"));
	assert.deepEqual(shots.map(({ url, body }) => [url.pathname, body.slug]), [[`/v5/vms/${VM}/snapshot`, BOX]]);
	const [snapshot] = fake.snapshots.values();
	assert.equal(snapshot.record.slug, BOX);
	assert.deepEqual([...snapshot.files.keys()].filter((path) => path.startsWith(BUILD_DIR)), [], "the snapshot holds no build folder");
	assert.deepEqual(fake.deleted, [VM], "the build VM is deleted");
	assert.equal(fake.vms.size, 0);

	const before = fake.calls.length;
	assert.deepEqual(await made.prepareImage({ onWait }), { ok: true, value: snapshotIdOf(0) });
	assert.deepEqual(fake.calls.slice(before).map(({ method, url }) => `${method} ${url.pathname}`), [`GET /v5/snapshots/${BOX}`], "a second call finds it");
	assert.equal(told.length, 1);
});

test("a build whose install.sh exits other than 0 fails in its log's words, takes no snapshot and deletes the build VM", async () => {
	const { fake } = building({ exit: 100, log: "/tmp/node.tar.xz: OK\nE: Unable to fetch some archives, maybe run apt-get update\n" });
	const prepared = await provider(fake).prepareImage();
	assert.equal(prepared.ok, false);
	assert.equal(prepared.error.code, "vendor");
	assert.match(prepared.error.message, new RegExp(`^the box image ${BOX} as a Freestyle snapshot: box/install\\.sh exited 100 in the build VM ${VM}: .*E: Unable to fetch some archives`, "s"));
	assert.equal(fake.snapshots.size, 0);
	assert.deepEqual(fake.deleted, [VM]);
});

test("a build cut short deletes its VM: an abort while install.sh runs, a build VM that stops before it runs, an exec refused mid-build", { timeout: 20_000 }, async () => {
	const { fake } = building({ exit: null });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	const started = Date.now();
	const aborted = await provider(fake).prepareImage({ signal: controller.signal });
	clearTimeout(timer);
	assert.equal(aborted.error?.code, "aborted", JSON.stringify(aborted));
	assert.ok(Date.now() - started < 5_000);
	assert.equal(fake.snapshots.size, 0);
	assert.deepEqual(fake.deleted, [VM]);

	const stopped = building({ exit: 0 }, { states: ["starting", "stopped"] });
	const gone = await provider(stopped.fake).prepareImage();
	assert.equal(gone.error?.code, "vendor");
	assert.match(gone.error.message, new RegExp(`the build VM ${VM} .*"stopped"`));
	assert.deepEqual(stopped.fake.deleted, [VM]);

	let uploads = 0;
	const refusing = building({ exit: 0 }, { answer: (method, path, body) => (path.endsWith("/exec-await") && body.command.includes("base64 -d") && ++uploads === 2 ? json(403, { code: "FORBIDDEN", message: "not yours" }) : undefined) });
	const refused = await provider(refusing.fake).prepareImage();
	assert.equal(refused.error?.code, "denied");
	assert.deepEqual(refusing.fake.deleted, [VM]);
	assert.equal(refusing.fake.snapshots.size, 0);
});

test("a build whose snapshot's slug another build took first answers that one, and still deletes its VM; a build VM's create refused makes nothing", async () => {
	let fake;
	({ fake } = building({ exit: 0 }, { answer: (method, path) => (method === "POST" && path.endsWith("/snapshot") ? void fake.addSnapshot(BOX) : undefined) }));
	const raced = await provider(fake).prepareImage();
	assert.deepEqual(raced, { ok: true, value: snapshotIdOf(0) });
	assert.equal(fake.snapshots.size, 1, "no second snapshot");
	assert.deepEqual(fake.deleted, [VM]);

	const denied = fakeFreestyle({ answer: (method, path) => (method === "POST" && path === "/vms" ? json(403, { code: "FORBIDDEN", message: "no VMs on this plan" }) : undefined) });
	const refused = await provider(denied).prepareImage();
	assert.equal(refused.error?.code, "denied");
	assert.match(refused.error.message, /no VMs on this plan/);
	assert.deepEqual(denied.deleted, []);
	assert.equal(denied.calls.some(({ method }) => method === "DELETE"), false);
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

test("the janitor's sweep and releaseOlder over packed metadata: a VM whose deadline can't be read, past its deadline, is swept, and one with no parseable run hash (no packed map to read) never touched; older or unreadable epochs released, a newer epoch kept", async () => {
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
	const fake = fakeFreestyle({ snapshots: [BOX] });
	assert.equal(await freestyleModule.conformanceImage({ env: { ...env, [live]: "1" }, fetch: fake.fetch }), snapshotIdOf(0), "the box snapshot prepareImage() finds or builds");
	await assert.rejects(freestyleModule.conformanceImage({ env, fetch: fake.fetch }), /set AGENTRUN_COMPUTER_LIVE_FREESTYLE=1/, "finding or building it calls Freestyle, so it needs the live switch");
	assert.equal(await freestyleModule.conformanceImage({ env: { ...env, COMPUTER_FREESTYLE_IMAGE: SNAPSHOT }, fetch: () => assert.fail("a named image calls nothing") }), SNAPSHOT);
	assert.throws(() => freestyleModule.dialKit({ env }), /^Error: Freestyle's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider freestyle/);
});
