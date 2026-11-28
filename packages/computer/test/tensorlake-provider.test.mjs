// TensorlakeProvider's host on a fake Tensorlake (fake-tensorlake.mjs): the sandbox API and each sandbox's proxy as a
// fetch in the OpenAPI's shapes, the proxy's TCP tunnel as a WebSocket, and the sandbox's sshd as ssh2's own Server on
// loopback, taking as tl-user the key the last ssh/enable named. What Tensorlake's host decides is tested here: the
// create's body, the name that carries the run, the epoch and the deadline, the labels file written and read through the
// processes API, get's states, list's filter and its fail-closed reads, delete, a run's end and the janitor's sweep by
// the labels in the names, the error codes, the SSH enable and the
// host-key pin, an exec's frames and kill through the tunnel, the bounds on each call, check()'s refusals, the exec
// pre-check, and the provider's Core conformance cases. The adapter's lifecycle is tested once, against its fake host
// (hosted-provider.test.mjs); Tensorlake's own is proven live.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseOlder, sweep } from "../dist/index.js";
import * as registry from "../dist/providers.js";
import { fingerprintOf, keyPair } from "./fake-agent37.mjs";
import { fakeHost } from "./fake-host.mjs";
import { API_URL, fakeRest, fakeTensorlake, KEY, PROXY_DOMAIN } from "./fake-tensorlake.mjs";

const { TensorlakeProvider, create, accountOf } = await import("../dist/tensorlake.js");
const { TENSORLAKE, TENSORLAKE_IMAGE } = await import("../dist/descriptors/index.js");
const { runHash } = await import("../dist/labels.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const conformanceModule = await import("../dist/conformance/tensorlake.js");
const { TENSORLAKE_ENV: ENV, settingsFromEnv, sweepScope } = conformanceModule;

const CTX = { timeoutMs: 10_000 };
const NAME = "computer-0123456789ab";
const DEADLINE = new Date(Date.now() + 600_000).toISOString();
const D = Date.parse(DEADLINE).toString(36);
const HAS_PROC = existsSync("/proc/self/stat");
const DAY_MS = 24 * 3_600_000;
const BARE = "not-a-secret-bare-tensorlake-key";
const IMAGE = "tensorlake/ubuntu-minimal";
const backstop = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const labelsOf = (more = {}) => ({ "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.computer.deadline": DEADLINE, ...more });
const request = (more = {}) => ({ name: NAME, image: IMAGE, labels: labelsOf(), lifetimeMs: 600_000, backstopAt: backstop(), egress: false, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-tensorlake-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 5_000, createMs: 5_000, uploadMs: 5_000, execMs: 5_000, helloMs: 2_000, probeMs: 2_000, listMs: 5_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 5_000 };
/** A WebSocket no REST-only test opens. */
class NoSocket {
	constructor() {
		throw new Error("a tunnel was opened");
	}
}

/** A REST-only provider: no tunnel, nothing over SSH. */
function restOnly(restOptions = {}, more = {}) {
	const rest = fakeRest(restOptions);
	const provider = new TensorlakeProvider({ apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, WebSocket: NoSocket, apiUrl: API_URL, timeouts: { pollMs: 1 }, ...more });
	return { rest, provider, host: provider.host };
}

/** A provider on the fake API, proxy, tunnel and sshd; the sshd is closed after the test. */
async function setup(t, fakeOptions = {}, more = {}) {
	const fake = await fakeTensorlake(fakeOptions);
	t.after(() => fake.sshd.close());
	const provider = new TensorlakeProvider({ ...fake.options, timeouts: { pollMs: 1 }, ...more });
	return { fake, rest: fake.rest, provider, host: provider.host };
}

/** A sandbox made on the fake straight, as another process made it: this provider knows nothing of it. */
async function madeElsewhere(rest, name, { file, status = "running" } = {}) {
	const answer = await rest.fetch(`${API_URL}/sandboxes`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ name, image: IMAGE, wait: false }) });
	const { sandbox_id: id } = await answer.json();
	const one = rest.sandboxes.get(id);
	Object.assign(one.sandbox, { status });
	one.file = file === undefined ? undefined : JSON.stringify(file);
	return id;
}

/** The sandbox name of a computer of NAME with this run, epoch and deadline. */
const nameOf = ({ computer = NAME, run, epoch, deadline = DEADLINE } = {}) => `${computer}${run === undefined ? "" : `-r${runHash(run)}`}${epoch === undefined ? "" : `-e${Number(epoch).toString(36)}`}-d${Date.parse(deadline).toString(36)}`;

/** Runs argv to its end: its exit code, stdout and stderr. */
async function run(host, id, argv, input) {
	const proc = await host.exec(id, argv, CTX);
	const out = [];
	const err = [];
	const reading = Promise.all([
		(async () => {
			for await (const chunk of proc.stdout) out.push(Buffer.from(chunk));
		})(),
		(async () => {
			for await (const chunk of proc.stderr) err.push(Buffer.from(chunk));
		})(),
	]);
	if (input !== undefined) await proc.write(Buffer.from(input));
	await proc.end();
	const code = await proc.wait();
	await reading;
	return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(check, ms = 5_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain" } });
/** A proxy answer that never comes: it rejects as fetch does once the call's signal aborts. */
const never = (_body, _one, signal) =>
	new Promise((_, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
	});
const runs = (rest) => rest.calls.filter((call) => call.path === "/api/v1/processes/run");
const enables = (rest) => rest.calls.filter((call) => call.path === "/api/v1/ssh/enable");

// --- what it declares ---

test("the descriptor: a sandbox under TENSORLAKE_API_KEY, every network form through init, no mount, tensorlake/ubuntu-minimal as the default; the host a janitor's microVM whose names carry the run and epoch", () => {
	assert.equal(TENSORLAKE.id, "tensorlake");
	assert.equal(TENSORLAKE.label, "Tensorlake");
	assert.deepEqual(TENSORLAKE.keys, [{ name: "TENSORLAKE_API_KEY", option: "apiKey", required: true }]);
	assert.deepEqual([TENSORLAKE.network, TENSORLAKE.mounts, TENSORLAKE.defaultImage, TENSORLAKE.prepareImage, TENSORLAKE.metered], [["none", "open", "allow"], [], { sandbox: IMAGE }, undefined, true]);
	assert.equal(TENSORLAKE_IMAGE, IMAGE);
	const { host, provider } = restOnly();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: DAY_MS - 300_000, arch: "amd64", vendorAgentPorts: [22, 9501], labels: { named: true } });
	const caps = provider.capabilities();
	assert.deepEqual([caps.kind, caps.daemon, caps.lifetime, caps.isolation], ["linux", "child", "janitor", "microvm"]);
	assert.equal(typeof host.upload, "undefined", "no upload: the daemon goes through the exec's stdin");
	assert.equal(typeof host.extend, "undefined", "no extend: the deadline is in the name");
});

test("the provider takes the key as an option, checks ssh2, fetch, the WebSocket, the API URL and the daemon user, and never echoes the key", async () => {
	const ssh2 = { Client: class {} };
	await assert.rejects(create({ ssh2 }), /options\.apiKey, the Tensorlake API key, is required/);
	assert.throws(() => new TensorlakeProvider({ apiKey: KEY, ssh2: {} }), /ssh2 package/);
	assert.throws(() => new TensorlakeProvider({ apiKey: KEY, ssh2, fetch: "no" }), /options\.fetch/);
	assert.throws(() => new TensorlakeProvider({ apiKey: KEY, ssh2, WebSocket: "no" }), /options\.WebSocket/);
	assert.throws(() => new TensorlakeProvider({ apiKey: KEY, ssh2, apiUrl: "http://api.tensorlake.ai" }), /must be https/);
	assert.throws(() => new TensorlakeProvider({ apiKey: KEY, ssh2, daemonUser: "1000:1000" }), /tl-user's uid/);
	assert.ok(new TensorlakeProvider({ apiKey: KEY, ssh2, daemonUser: "2510:2510" }));
	try {
		new TensorlakeProvider({ apiKey: KEY, ssh2: {} });
	} catch (error) {
		assert.doesNotMatch(error.message, new RegExp(KEY));
	}
});

// --- create ---

test("create posts the name with the run's hash, the epoch and the deadline, the image, the backstop's span as the idle threshold, the internet as asked, no auto resume, no wait, its own bound for capacity; then waits for running and writes the labels file as root", async () => {
	const { rest, host } = restOnly();
	const labels = labelsOf({ "agentrun.run": "run-1", "agentrun.epoch": "2", team: "a" });
	const { id } = await host.create(request({ labels, backstopAt: backstop(3_600_000) }), CTX);
	assert.match(id, /^sbx[0-9a-z]{20}$/);
	const post = rest.calls.find((call) => call.method === "POST" && call.path === "/sandboxes");
	assert.equal(post.headers.Authorization, `Bearer ${KEY}`);
	const { timeout_secs: idle, ...body } = post.body;
	const name = nameOf({ run: "run-1", epoch: "2" });
	assert.equal(name, `${NAME}-r${runHash("run-1")}-e2-d${D}`);
	assert.ok(name.length <= 63, name);
	assert.deepEqual(body, { name, image: IMAGE, network: { allow_internet_access: false }, auto_resume: false, wait: false, max_pending_secs: 10 });
	assert.ok(idle >= 3_598 && idle <= 3_600, String(idle));
	assert.equal(rest.sandboxes.get(id).sandbox.status, "running");
	const [write] = runs(rest);
	assert.equal(write.host, `${id}.${PROXY_DOMAIN}`);
	assert.deepEqual([write.headers.Authorization, write.headers["X-Tensorlake-Sandbox-Id"]], [`Bearer ${KEY}`, id]);
	assert.deepEqual([write.body.command, ...write.body.args.slice(0, 3)], ["sudo", "-n", "sh", "-c"]);
	assert.match(write.body.args[3], /umask 077 && mkdir -p \/var\/lib\/agentrun-computer/);
	assert.deepEqual(JSON.parse(rest.sandboxes.get(id).file), labels);
	// A size, the internet, and the idle threshold within a minute and a day.
	await host.create(request({ name: "computer-000000000001", cpus: 2, memoryMb: 4096, egress: true, backstopAt: backstop(2 * DAY_MS) }), CTX);
	await host.create(request({ name: "computer-000000000002", backstopAt: backstop(5_000) }), CTX);
	const [sized, short] = rest.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").slice(1).map((call) => call.body);
	assert.deepEqual([sized.resources, sized.network, sized.timeout_secs, short.timeout_secs, short.resources], [{ cpus: 2, memory_mb: 4096 }, { allow_internet_access: true }, 86_400, 60, undefined]);
});

test("a request with no deadline label of the adapter's form, or a name that is not a computer's, is invalid before any call", async () => {
	const { rest, host } = restOnly();
	for (const deadline of [undefined, "tomorrow", "2026-11-28T00:00:00Z"]) {
		const labels = labelsOf();
		if (deadline === undefined) delete labels["agentrun.computer.deadline"];
		else labels["agentrun.computer.deadline"] = deadline;
		await assert.rejects(host.create(request({ labels }), CTX), (error) => error.code === "invalid" && /deadline/.test(error.message), String(deadline));
	}
	await assert.rejects(host.create(request({ name: "my-sandbox" }), CTX), (error) => error.code === "invalid" && /computer's name/.test(error.message));
	const far = new Date(8.64e15).toISOString();
	await assert.rejects(host.create(request({ labels: labelsOf({ "agentrun.run": "r", "agentrun.epoch": String(2 ** 53 - 1), "agentrun.computer.deadline": far }) }), CTX), (error) => error.code === "invalid" && /past 63 characters/.test(error.message));
	assert.deepEqual(rest.calls, []);
});

test("a create of a name the project holds is exists (unverified until the live run: Tensorlake's 409); a size refused is refused in Tensorlake's own words; a 429 past every retry is a limit; a key refused is denied, never echoed", { timeout: 30_000 }, async () => {
	const { host } = restOnly();
	await host.create(request(), CTX);
	await assert.rejects(host.create(request(), CTX), (error) => error.code === "exists" && /409: sandbox with name .* already exists/.test(error.message));
	const sized = restOnly();
	await assert.rejects(sized.host.create(request({ cpus: 2, memoryMb: 1024 }), CTX), (error) => error.code === "invalid" && /answered 400: memory_mb must be between 1024 and 8192 per CPU, got 1024 for 2/.test(error.message));
	assert.equal(sized.rest.sandboxes.size, 0);
	const busy = restOnly();
	for (let at = 0; at < 4; at++) busy.rest.fail("POST", /^\/sandboxes$/, () => text(429, "too many sandboxes"));
	await assert.rejects(busy.host.create(request(), CTX), (error) => error.code === "limit" && /too many sandboxes/.test(error.message));
	assert.equal(busy.rest.calls.filter((call) => call.method === "POST").length, 4, "a 429 is sent again");
	const rest = fakeRest();
	const denied = new TensorlakeProvider({ apiKey: BARE, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL }).host;
	await assert.rejects(denied.create(request(), CTX), (error) => error.code === "denied" && /invalid API key/.test(error.message) && !error.message.includes(BARE));
	// A create that got no answer is never sent again: it may have made the sandbox, which the adapter finds by its name.
	const lost = restOnly();
	lost.rest.fail("POST", /^\/sandboxes$/, () => text(503, "unavailable"));
	await assert.rejects(lost.host.create(request(), CTX), (error) => error.code === "vendor");
	assert.equal(lost.rest.calls.filter((call) => call.method === "POST").length, 1);
});

test("a sandbox Tensorlake ends before it runs is the reason in its words, no capacity a limit, and is deleted by its id; one still pending at the bound is a timeout, left for the adapter's sweep by name", async () => {
	const full = restOnly({ capacity: false });
	await assert.rejects(full.host.create(request(), CTX), (error) => error.code === "limit" && /ended the sandbox .* before it ran: no_capacity/.test(error.message) && /was deleted/.test(error.message));
	assert.equal(full.rest.calls.filter((call) => call.method === "DELETE").length, 1);
	const slow = restOnly({ pendingReads: 1_000_000 });
	const started = Date.now();
	await assert.rejects(slow.host.create(request(), { timeoutMs: 300 }), (error) => error.code === "timeout" && /did not read running within 0.3 s \(it reads pending: scheduling\)/.test(error.message));
	assert.ok(Date.now() - started < 2_000);
	assert.equal(slow.rest.calls.filter((call) => call.method === "DELETE").length, 0, "a timeout may have made it: the adapter sweeps by name");
	assert.equal(slow.rest.live().length, 1);
});

test("a labels write the proxy refuses (a key it does not take) deletes the sandbox and is denied; one that exits non-zero is the vendor's, its stderr in the words", async () => {
	const refused = restOnly();
	refused.rest.fail("POST", /\/processes\/run$/, () => json(401, { error: "invalid API key", code: "UNAUTHORIZED" }));
	await assert.rejects(refused.host.create(request(), CTX), (error) => error.code === "denied" && /answered 401 UNAUTHORIZED: invalid API key/.test(error.message) && /was deleted/.test(error.message));
	assert.equal(refused.rest.live().length, 0);
	const failed = restOnly();
	failed.rest.proxy.script = () => [{ line: "mkdir: cannot create directory: Permission denied", stream: "stderr" }, { exit_code: 1, signal: null }];
	await assert.rejects(failed.host.create(request(), CTX), (error) => error.code === "vendor" && /exited 1: mkdir: cannot create directory: Permission denied/.test(error.message));
	const unended = restOnly();
	unended.rest.proxy.script = () => [{ line: "half", stream: "stdout" }];
	await assert.rejects(unended.host.create(request(), CTX), (error) => error.code === "vendor" && /ended with no exit event/.test(error.message));
});

// --- get, labels, list, delete ---

test("get reads a sandbox by id: pending is starting, running and snapshotting running, suspended and resume_failed stopped (the latter with Tensorlake's words), one it does not know stopped with why; terminated or a 404 is none", async () => {
	const { rest, host } = restOnly();
	const { id } = await host.create(request(), CTX);
	const one = rest.sandboxes.get(id);
	assert.deepEqual(await host.get(id, CTX), { id, labels: labelsOf(), state: "running", createdAt: new Date(one.sandbox.created_at), resources: { cpus: 1, memoryMb: 1024, diskGb: 10 } });
	const states = { pending: "starting", running: "running", snapshotting: "running", suspending: "stopped", suspended: "stopped", resume_failed: "stopped", migrating: "stopped" };
	for (const [status, want] of Object.entries(states)) {
		Object.assign(one.sandbox, { status, error_details: status === "resume_failed" ? "snapshot missing" : null });
		one.reads = 1_000;
		const read = await host.get(id, CTX);
		assert.equal(read.state, want, status);
		if (status === "resume_failed") assert.match(read.why, /could not resume it: snapshot missing/);
		if (status === "migrating") assert.match(read.why, /"migrating", which this provider does not know/);
	}
	one.sandbox.status = "terminated";
	assert.equal(await host.get(id, CTX), undefined, "a terminated sandbox is none");
	assert.equal(await host.get("sbxffffffffffffffffffff", CTX), undefined, "a 404 is none");
	await assert.rejects(host.get("../sandboxes", CTX), (error) => error.code === "not_found");
	await assert.rejects(host.exec("not an id", ["true"], CTX), (error) => error.code === "not_found");
});

test("labels another process wrote: a sandbox not running reads its name's (the adapter's two, the epoch, the deadline, the run's hash), a running one its labels file once, kept; a file that disagrees with its name is not read; a sandbox not named as a computer carries none", async () => {
	const { rest, host } = restOnly();
	const file = labelsOf({ "agentrun.run": "run-1", "agentrun.epoch": "7", team: "a" });
	const id = await madeElsewhere(rest, nameOf({ run: "run-1", epoch: "7" }), { file, status: "suspended" });
	const named = { "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.computer.deadline": DEADLINE, "agentrun.epoch": "7", "agentrun.run.hash": runHash("run-1") };
	assert.deepEqual((await host.get(id, CTX)).labels, named, "suspended: the name's, and no read wakes it");
	assert.equal(runs(rest).length, 0);
	rest.sandboxes.get(id).sandbox.status = "running";
	assert.deepEqual((await host.get(id, CTX)).labels, file);
	assert.deepEqual((await host.get(id, CTX)).labels, file);
	assert.equal(runs(rest).length, 1, "the file is read once, then kept");
	const liar = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000c", run: "run-1", epoch: "7" }), { file: labelsOf({ "agentrun.run": "run-2", "agentrun.epoch": "8", "agentrun.computer.name": "computer-00000000000c" }) });
	const read = await host.get(liar, CTX);
	assert.equal(read.labels["agentrun.epoch"], "7", "the name's epoch");
	assert.equal(read.labels["agentrun.run"], undefined, "no run read from a file that is not the name's");
	const none = await madeElsewhere(rest, "computer-00000000000d-d", {});
	assert.deepEqual((await host.get(none, CTX)).labels, {});
	const missing = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000e" }), {});
	assert.equal((await host.get(missing, CTX)).labels["agentrun.computer.name"], "computer-00000000000e", "no file yet: the name's");
});

test("list reads every page, keeps only sandboxes named as computers whose name may carry the labels asked, reads a label beyond the name's from each one's file, and leaves out terminated ones the listing still shows", async () => {
	const { rest, host } = restOnly({ pageSize: 2, overList: true });
	const a = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000a", run: "run-1", epoch: "2" }), { file: labelsOf({ "agentrun.computer.name": "computer-00000000000a", "agentrun.run": "run-1", "agentrun.epoch": "2", team: "a" }) });
	const b = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000b", run: "run-1", epoch: "3" }), { file: labelsOf({ "agentrun.computer.name": "computer-00000000000b", "agentrun.run": "run-1", "agentrun.epoch": "3", team: "b" }) });
	const other = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000c", run: "run-2" }), {});
	await madeElsewhere(rest, "a-sandbox-of-the-project", {});
	const gone = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000f", run: "run-1" }), { status: "terminated" });
	rest.proxy.script = (_body, one) => (one.sandbox.id === other ? text(500, "boom") : undefined);
	const byRun = await host.list({ "agentrun.run": "run-1" }, CTX);
	assert.deepEqual(byRun.map(({ id }) => id), [a, b], "the run's, by its name alone: another run's unreadable sandbox never fails it");
	assert.equal(runs(rest).length, 0, "the name holds every label asked: no file read");
	assert.ok(!byRun.some(({ id }) => id === gone));
	const pages = rest.calls.filter((call) => call.path === "/sandboxes" && call.method === "GET");
	assert.deepEqual(pages.map((call) => call.query.cursor), [undefined, "2", "4"]);
	assert.equal(pages[0].query.limit, "100");
	assert.deepEqual((await host.list({ "agentrun.run": "run-1", team: "b" }, CTX)).map(({ id, labels }) => [id, labels.team]), [[b, "b"]]);
	assert.deepEqual((await host.list({ "agentrun.computer.name": "computer-00000000000a", "agentrun.run": "run-1", "agentrun.epoch": "2" }, CTX)).map(({ id }) => id), [a]);
});

test("a listing by a label beyond the name's fails closed on a file it can't read, once every read has ended, naming the sandbox and why; get answers the name's", async () => {
	const { rest, host } = restOnly();
	const a = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000a" }), { file: labelsOf({ "agentrun.computer.name": "computer-00000000000a", team: "a" }) });
	const b = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000b" }), { file: labelsOf({ "agentrun.computer.name": "computer-00000000000b", team: "b" }) });
	rest.proxy.script = (_body, one) => (one.sandbox.id === b ? json(502, { error: "upstream unavailable", code: "SANDBOX_UNAVAILABLE" }) : undefined);
	await assert.rejects(host.list({ team: "a" }, CTX), (error) => error.code === "vendor" && error.message.includes(`could not read the labels of ${b}: `) && /502 SANDBOX_UNAVAILABLE: upstream unavailable/.test(error.message) && /can't tell whether it carries team=a/.test(error.message));
	assert.equal((await host.get(b, CTX)).labels["agentrun.computer.name"], "computer-00000000000b");
	rest.proxy.script = undefined;
	assert.deepEqual((await host.list({ team: "a" }, CTX)).map(({ id }) => id), [a], "a read that failed is kept for nothing: the next one reads it");
});

test("a listing by a label beyond the name's fails closed on a sandbox whose file it can't read as it stands (not running, or no file yet), naming each and why, never a short list; a listing the names answer, or by a run whose hash none of them has, still lists (review)", async () => {
	const { rest, host } = restOnly({ pageSize: 2 });
	const team = (computer, run) => labelsOf({ "agentrun.computer.name": computer, ...(run === undefined ? {} : { "agentrun.run": run }), team: "a" });
	const a = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000a", run: "run-1" }), { file: team("computer-00000000000a", "run-1") });
	const suspended = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000b", run: "run-1" }), { file: team("computer-00000000000b", "run-1"), status: "suspended" });
	const pending = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000c", run: "run-1" }), { status: "pending" });
	const unwritten = await madeElsewhere(rest, nameOf({ computer: "computer-00000000000d", run: "run-1" }), {});
	await assert.rejects(host.list({ team: "a" }, CTX), (error) => {
		assert.equal(error.code, "vendor");
		assert.match(error.message, new RegExp(`could not read the labels of ${suspended}: it is suspended, .*; ${pending}: it is pending, .*; ${unwritten}: it has no labels file yet.*; the listing can't tell whether they carry team=a`));
		assert.ok(!error.message.includes(`${a}:`), "the one it read is not named");
		return true;
	}, "a suspended sandbox, a pending one and one with no file yet are each named: the listing can't tell whether they carry team=a");
	assert.equal(runs(rest).length, 2, "only the running sandboxes' files are read: no read wakes the suspended one");
	await assert.rejects(host.list({ "agentrun.run": "run-1", team: "a" }, CTX), /could not read the labels of/, "the same within the run");
	assert.deepEqual((await host.list({ "agentrun.run": "run-2", team: "a" }, CTX)).map(({ id }) => id), [], "a run whose hash none of them has reads none of them, and lists");
	assert.deepEqual((await host.list({ "agentrun.run": "run-1" }, CTX)).map(({ id }) => id), [a, suspended, pending, unwritten], "a listing every name answers reads no file, and lists every one");
	assert.deepEqual((await host.list({}, CTX)).map(({ id }) => id), [a, suspended, pending, unwritten], "so does the janitor's, by no label");
	// Once each can be read as it stands, the listing answers the ones that carry the label.
	rest.sandboxes.get(suspended).sandbox.status = "running";
	rest.sandboxes.get(pending).sandbox.status = "running";
	rest.sandboxes.get(pending).file = JSON.stringify(team("computer-00000000000c", "run-1"));
	rest.sandboxes.get(unwritten).file = JSON.stringify(labelsOf({ "agentrun.computer.name": "computer-00000000000d", "agentrun.run": "run-1", team: "b" }));
	assert.deepEqual((await host.list({ team: "a" }, CTX)).map(({ id }) => id), [a, suspended, pending]);
});

test("timeouts: a labels read with no answer is held to the call's own bound; get answers the name's within it, and a listing fails closed with no answer within it", async () => {
	const { rest, host } = restOnly();
	const id = await madeElsewhere(rest, nameOf(), { file: labelsOf({ team: "a" }) });
	rest.proxy.script = never;
	let started = Date.now();
	const read = await host.get(id, { timeoutMs: 400 });
	assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`);
	assert.equal(read.labels.team, undefined);
	assert.equal(read.labels["agentrun.computer.name"], NAME);
	started = Date.now();
	await assert.rejects(host.list({ team: "a" }, { timeoutMs: 400 }), (error) => error.code === "vendor" && /no answer within 0.4 s/.test(error.message));
	assert.ok(Date.now() - started < 2_000);
	// The caller's own abort ends a read at once, as aborted.
	const cancel = new AbortController();
	setTimeout(() => cancel.abort(), 50);
	await assert.rejects(host.list({ team: "a" }, { timeoutMs: 10_000, signal: cancel.signal }), (error) => error.code === "aborted" || error.name === "AbortError");
});

test("a listing is held to its own bound across its pages: each page gets what is left of it, and no page is asked once it has passed (review)", async () => {
	const rest = fakeRest({ pageSize: 2 });
	// Each page of the listing answers 150 ms late, or not at all once its call's signal aborts.
	let asked = 0;
	const slow = async (url, init = {}) => {
		if ((init.method ?? "GET") === "GET" && new URL(url).pathname === "/sandboxes") {
			asked += 1;
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 150);
				init.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal.reason)), { once: true });
			});
		}
		return rest.fetch(url, init);
	};
	const host = new TensorlakeProvider({ apiKey: KEY, ssh2: { Client: class {} }, fetch: slow, WebSocket: NoSocket, apiUrl: API_URL, timeouts: { pollMs: 1 } }).host;
	for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await madeElsewhere(rest, nameOf({ computer: `computer-0000000000${n.toString(16).padStart(2, "0")}` }), {});
	assert.equal((await host.list({}, CTX)).length, 10, "five pages of two, given the time");
	assert.equal(asked, 5);
	asked = 0;
	const started = Date.now();
	await assert.rejects(host.list({}, { timeoutMs: 400 }), (error) => error.code === "timeout", "five 150 ms pages don't fit in 400 ms: a timeout, not a list");
	assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`);
	assert.ok(asked <= 3, `${asked} pages asked: the third is cut at the bound, and none after it`);
});

test("delete deletes by id and lets go; a sandbox gone is done (a 404); the provider's release deletes and reads it back as none", async () => {
	const { rest, host } = restOnly();
	const { id } = await host.create(request(), CTX);
	await host.delete(id, CTX);
	assert.deepEqual(rest.calls.filter((call) => call.method === "DELETE").map((call) => call.path), [`/sandboxes/${id}`]);
	assert.equal(rest.sandboxes.get(id).sandbox.status, "terminated");
	assert.equal(await host.get(id, CTX), undefined);
	await host.delete(id, CTX);
	const dropped = restOnly({ dropTerminated: true });
	const made = await dropped.host.create(request(), CTX);
	await dropped.host.delete(made.id, CTX);
	await dropped.host.delete(made.id, CTX);
	assert.equal(dropped.rest.calls.filter((call) => call.method === "DELETE").length, 2, "the second answered 404, which is done");
	const kept = restOnly();
	const other = await kept.host.create(request(), CTX);
	const released = await kept.provider.release({ id: other.id, name: NAME }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(kept.rest.sandboxes.get(other.id).sandbox.status, "terminated");
	assert.equal(kept.rest.calls.at(-1).method, "GET", "the last call is the read-back after the delete");
});

// --- a run's end and the janitor ---

test("a run's end (releaseOlder at its claim's epoch + 1) deletes the run's sandboxes another process made, by their run and epoch, and is fenced by a later claim's; the janitor's sweep deletes a sandbox past the deadline its name carries and keeps one before it", async () => {
	const { rest, provider } = restOnly();
	const soon = new Date(Date.now() + 60_000).toISOString();
	const later = new Date(Date.now() + 3_600_000).toISOString();
	const made = async (computer, run, epoch, deadline) => {
		const file = labelsOf({ "agentrun.computer.name": computer, "agentrun.computer.deadline": deadline, "agentrun.run": run, "agentrun.epoch": epoch });
		return { name: computer, id: await madeElsewhere(rest, nameOf({ computer, run, epoch, deadline }), { file }) };
	};
	const e1 = await made("computer-0000000000e1", "run-1", "1", later);
	const e2 = await made("computer-0000000000e2", "run-1", "2", later);
	const e3 = await made("computer-0000000000e3", "run-1", "3", later);
	const due = await made("computer-0000000000a1", "run-2", "1", soon);
	const live = await made("computer-0000000000a2", "run-3", "1", later);
	const stranger = await madeElsewhere(rest, "a-sandbox-of-the-project", {});
	const status = (id) => rest.sandboxes.get(id).sandbox.status;

	const fenced = await releaseOlder(provider, "run-1", 2);
	assert.equal(fenced.ok, false);
	assert.match(fenced.error.message, /^fenced: /, "the end of claim 1, with claims 2 and 3 there");
	assert.deepEqual([e1, e2, e3].map(({ id }) => status(id)), ["running", "running", "running"], "a fenced end deletes nothing");

	const ended = await releaseOlder(provider, "run-1", 4);
	assert.equal(ended.ok, true, JSON.stringify(ended.error));
	assert.deepEqual(ended.value.released.map(({ name }) => name).sort(), [e1.name, e2.name, e3.name], "the end of claim 3: every claim's at or below it");
	assert.deepEqual([e1, e2, e3].map(({ id }) => status(id)), ["terminated", "terminated", "terminated"]);

	const swept = await sweep(provider, { now: new Date(Date.now() + 120_000) });
	assert.equal(swept.ok, true, JSON.stringify(swept.error));
	assert.deepEqual(swept.value.deleted, [due.name], "past the deadline in its name: deleted");
	assert.deepEqual([status(due.id), status(live.id), status(stranger)], ["terminated", "running", "running"], "before its deadline, or not a computer: left");
});

test("a sandbox whose labels can't be read (suspended after a restart, or its file unreadable) carries its name's run hash as agentrun.run.hash, which serve's janitor reads; a name with no run hash carries none, a name whose hash part doesn't parse is no computer, and a run's end matches neither", async () => {
	const { rest, provider, host } = restOnly();
	const past = new Date(Date.now() - 60_000).toISOString();
	const pastPart = Date.parse(past).toString(36);
	const file = (computer, more = {}) => labelsOf({ "agentrun.computer.name": computer, "agentrun.computer.deadline": past, "agentrun.epoch": "1", ...more });
	const suspended = await madeElsewhere(rest, nameOf({ computer: "computer-0000000000f1", run: "run-1", epoch: "1", deadline: past }), { file: file("computer-0000000000f1", { "agentrun.run": "run-1" }), status: "suspended" });
	const unreadable = await madeElsewhere(rest, nameOf({ computer: "computer-0000000000f2", run: "run-1", epoch: "1", deadline: past }), { file: file("computer-0000000000f2", { "agentrun.run": "run-1" }) });
	const noRun = await madeElsewhere(rest, nameOf({ computer: "computer-0000000000f3", epoch: "1", deadline: past }), { file: file("computer-0000000000f3"), status: "suspended" });
	const badHashes = [];
	for (const [computer, hash] of [["computer-0000000000f4", "abcdefghijklmn0p"], ["computer-0000000000f5", "abc"], ["computer-0000000000f6", `${runHash("run-1")}a`], ["computer-0000000000f7", "abcdefgh-ijklmnop"]]) {
		badHashes.push(await madeElsewhere(rest, `${computer}-r${hash}-e1-d${pastPart}`, { status: "suspended" }));
	}
	rest.proxy.script = (_body, one) => (one.sandbox.id === unreadable ? text(500, "boom") : undefined);
	const HASH = "agentrun.run.hash";

	for (const [id, what] of [[suspended, "suspended"], [unreadable, "its file unreadable"]]) {
		const { labels } = await host.get(id, CTX);
		assert.equal(labels[HASH], runHash("run-1"), `${what}: the name's run hash`);
		assert.equal(labels["agentrun.run"], undefined, `${what}: the run itself is the file's`);
	}
	const bare = (await host.get(noRun, CTX)).labels;
	assert.deepEqual([bare[HASH], bare["agentrun.run"]], [undefined, undefined], "no run hash in the name: neither label");
	for (const id of badHashes) assert.deepEqual((await host.get(id, CTX)).labels, {}, `${rest.sandboxes.get(id).sandbox.name}: no computer`);

	const listed = await provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map(({ ref, labels }) => [ref.name, labels[HASH]]).sort(), [["computer-0000000000f1", runHash("run-1")], ["computer-0000000000f2", runHash("run-1")], ["computer-0000000000f3", undefined]], "every computer listed, by the hash its name holds; the unparsed names are no computers");

	const ended = await releaseOlder(provider, "run-1", 99);
	assert.equal(ended.ok, true, JSON.stringify(ended.error));
	assert.deepEqual(ended.value.released, [], "a run's end reads the run from the file alone: it matches none of them");
	assert.ok([suspended, unreadable, noRun, ...badHashes].every((id) => rest.sandboxes.get(id).sandbox.status !== "terminated"), "nothing deleted");
});

// --- exec over SSH ---

test("exec enables SSH once for this process's key as tl-user through the sandbox's proxy, opens the proxy's TCP tunnel to port 22 with the key and the sandbox id, pins the host key it names, and runs argv with stdin, stdout, stderr and the exit code", async (t) => {
	const { fake, rest, host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	const [a, b] = await Promise.all([run(host, id, ["sh", "-c", "cat; echo err >&2; exit 3"], "héllo"), run(host, id, ["echo", "two"])]);
	assert.deepEqual(a, { code: 3, stdout: "héllo", stderr: "err\n" });
	assert.deepEqual(b, { code: 0, stdout: "two\n", stderr: "" });
	const [enable, ...more] = enables(rest);
	assert.equal(more.length, 0, "two execs at once enable once");
	assert.equal(enable.host, `${id}.${PROXY_DOMAIN}`);
	assert.deepEqual([enable.headers.Authorization, enable.headers["X-Tensorlake-Sandbox-Id"], enable.body.backend_user], [`Bearer ${KEY}`, id, "tl-user"]);
	assert.match(enable.body.proxy_pubkey, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
	assert.ok(fake.ws.opened.length > 0 && fake.ws.opened.every(({ url, headers }) => url === `wss://${id}.${PROXY_DOMAIN}/api/v1/tunnels/tcp?port=22` && headers.Authorization === `Bearer ${KEY}` && headers["X-Tensorlake-Sandbox-Id"] === id), JSON.stringify(fake.ws.opened));
	assert.ok(!fake.sshd.commands.some((command) => command.includes(KEY)), "the API key never goes over SSH");
	// Another provider of the process takes the same key: its enable names the same line.
	const second = new TensorlakeProvider({ ...fake.options, timeouts: { pollMs: 1 } }).host;
	assert.equal((await run(second, id, ["true"])).code, 0);
	assert.equal(enables(rest)[1].body.proxy_pubkey, enable.body.proxy_pubkey);
});

test("an sshd whose host key is not the one the enable named is refused in the handshake, before any login; one of another form, or not enabled, is the vendor's", async (t) => {
	const { fake, rest, host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	const pin = rest.ssh.fingerprint;
	rest.ssh.fingerprint = fingerprintOf(keyPair().public);
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => /verification failed/.test(error.message));
	assert.equal(fake.sshd.state.logins, 0, "no login reached the sshd");
	assert.deepEqual(fake.sshd.commands, [], "no command reached the sshd");
	for (const bad of [`MD5:${"ab:".repeat(15)}ab`, `${pin}=`, 42, ""]) {
		rest.ssh.fingerprint = bad;
		const one = new TensorlakeProvider({ ...fake.options, timeouts: { pollMs: 1 } }).host;
		await assert.rejects(one.exec(id, ["true"], CTX), (error) => error.code === "vendor" && /not OpenSSH's sha256 form/.test(error.message), JSON.stringify(bad));
	}
	rest.ssh.fingerprint = pin;
	rest.fail("POST", /\/ssh\/enable$/, () => json(200, { enabled: false }));
	const off = new TensorlakeProvider({ ...fake.options, timeouts: { pollMs: 1 } }).host;
	await assert.rejects(off.exec(id, ["true"], CTX), (error) => error.code === "vendor" && /SSH is not enabled: false/.test(error.message));
	assert.deepEqual(await run(off, id, ["echo", "ok"]), { code: 0, stdout: "ok\n", stderr: "" }, "a failed enable is let go: the next exec enables again");
});

test("an enable that names no host key (null, or the field left out) is refused as the vendor's before any tunnel opens: no exec runs through an sshd it can't pin, and a create, whose daemon start is an exec, fails", async (t) => {
	/** The enable's own refusal, which names what it answered. */
	const NAMED = /POST \/api\/v1\/ssh\/enable on \S+ answered no host key fingerprint/;
	for (const fingerprint of [null, undefined]) {
		const what = fingerprint === null ? "null" : "left out";
		const { fake, rest, host } = await setup(t);
		const { id } = await host.create(request(), CTX);
		rest.ssh.fingerprint = fingerprint;
		await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "vendor" && NAMED.test(error.message), what);
		assert.equal(enables(rest).length, 1, `${what}: one enable, answered`);
		assert.deepEqual(fake.ws.opened, [], `${what}: no tunnel opened`);
		assert.equal(fake.sshd.state.logins, 0, `${what}: no login reached the sshd`);
		assert.deepEqual(fake.sshd.commands, [], `${what}: no command reached the sshd`);

		const machines = fakeHost();
		const daemon = await setup(t, { backend: machines.host }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		daemon.rest.ssh.fingerprint = fingerprint;
		const made = await daemon.provider.create({ image: IMAGE, lifetimeMs: 600_000, network: "none" }, { requestId: `tensorlake-no-pin-${what}` });
		assert.equal(made.ok, false, `${what}: the create fails`);
		assert.match(made.error.message, NAMED, what);
		assert.deepEqual(daemon.fake.ws.opened, [], `${what}: no tunnel opened for the create`);
		assert.equal(daemon.fake.sshd.state.logins, 0, `${what}: no login reached the create's sshd`);
		assert.deepEqual(daemon.fake.sshd.commands, [], `${what}: no command reached the create's sshd`);
		assert.deepEqual(machines.uploads, [], `${what}: no daemon went up`);
	}
});

test("a login the sshd refuses (another key enabled since) lets the enable go and enables again, once, and the exec runs; two execs refused at once share the one enable in its place", async (t) => {
	const { fake, rest, host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	assert.equal((await run(host, id, ["true"])).code, 0);
	const one = rest.sandboxes.get(id);
	const own = one.sshKey;
	one.sshKey = keyPair().public;
	fake.sshd.dropAll();
	assert.deepEqual(await run(host, id, ["echo", "again"]), { code: 0, stdout: "again\n", stderr: "" });
	assert.equal(enables(rest).length, 2);
	assert.equal(one.sshKey, own);
	one.sshKey = keyPair().public;
	fake.sshd.dropAll();
	const [a, b] = await Promise.allSettled([run(host, id, ["echo", "a"]), run(host, id, ["echo", "b"])]);
	assert.deepEqual([a, b], [
		{ status: "fulfilled", value: { code: 0, stdout: "a\n", stderr: "" } },
		{ status: "fulfilled", value: { code: 0, stdout: "b\n", stderr: "" } },
	]);
	assert.equal(enables(rest).length, 3, "one enable in place of the refused one, for both");
});

/** A provider on the fake whose ssh/enable calls wait at a gate until open(): held resolves once one reaches it. */
async function gatedEnables(t) {
	const fake = await fakeTensorlake();
	let open;
	const gate = new Promise((resolve) => (open = resolve));
	let reached;
	const held = new Promise((resolve) => (reached = resolve));
	t.after(() => {
		open();
		fake.sshd.close();
	});
	const fetch = async (url, init = {}) => {
		if (init.method === "POST" && new URL(url).pathname === "/api/v1/ssh/enable") {
			reached();
			await new Promise((resolve, reject) => {
				const abort = () => reject(init.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
				if (init.signal?.aborted) abort();
				init.signal?.addEventListener("abort", abort, { once: true });
				void gate.then(resolve);
			});
		}
		return fake.rest.fetch(url, init);
	};
	const host = new TensorlakeProvider({ ...fake.options, fetch, timeouts: { pollMs: 1 } }).host;
	const { id } = await host.create(request(), CTX);
	return { host, id, held, open, count: () => enables(fake.rest).length };
}

test("an exec cancelled while it waits on the sandbox's SSH enable stops alone: the enable goes on, and an exec waiting on it beside runs", async (t) => {
	const { host, id, held, open, count } = await gatedEnables(t);
	const cancel = new AbortController();
	const a = host.exec(id, ["echo", "a"], { ...CTX, signal: cancel.signal });
	await held;
	const b = run(host, id, ["echo", "b"]);
	b.catch(() => {}); // awaited below; a red run ends before it
	cancel.abort();
	await assert.rejects(a, (error) => error.name === "AbortError" || error.code === "aborted");
	open();
	assert.deepEqual(await b, { code: 0, stdout: "b\n", stderr: "" });
	assert.equal(count(), 1);
});

test("an exec waiting on an enable another exec started is bounded by its own time: it times out alone, and the other runs once the enable answers", async (t) => {
	const { host, id, held, open, count } = await gatedEnables(t);
	const d = run(host, id, ["echo", "d"]);
	d.catch(() => {}); // awaited below; a red run ends before it
	await held;
	const c = host.exec(id, ["echo", "c"], { timeoutMs: 200 });
	let timer;
	const guard = new Promise((resolve) => (timer = setTimeout(() => resolve("still waiting at 5 s"), 5_000)));
	const outcome = await Promise.race([c.then(() => "ran", (error) => error), guard]);
	clearTimeout(timer);
	assert.ok(outcome instanceof Error && (outcome.name === "TimeoutError" || outcome.code === "timeout"), String(outcome));
	open();
	assert.deepEqual(await d, { code: 0, stdout: "d\n", stderr: "" });
	assert.equal(count(), 1);
});

test("an exec on a sandbox Tensorlake no longer has is not_found; on one suspended, the vendor's in words, no enable sent", async (t) => {
	const { rest, host } = await setup(t);
	await assert.rejects(host.exec("sbxffffffffffffffffffff", ["true"], CTX), (error) => error.code === "not_found");
	const id = await madeElsewhere(rest, nameOf(), { status: "suspended" });
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "vendor" && /reads the sandbox .* suspended, so nothing runs in it/.test(error.message));
	assert.equal(enables(rest).length, 0);
});

test("kill ends the process and every process under it, and wait answers -1; a kill after the end is nothing", async (t) => {
	const { host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	const proc = await host.exec(id, ["sh", "-c", "sleep 300 & echo $!; sleep 301 & echo $!; wait"], CTX);
	await proc.end();
	let out = "";
	const reading = (async () => {
		for await (const chunk of proc.stdout) out += chunk;
	})();
	(async () => {
		for await (const _ of proc.stderr);
	})();
	assert.ok(await until(() => out.trim().split("\n").filter(Boolean).length === 2), "the sleeps started");
	const pids = out.trim().split("\n").map(Number);
	assert.ok(pids.every(alive));
	await proc.kill();
	assert.equal(await proc.wait(), -1);
	await reading;
	assert.ok(await until(() => !pids.some(alive)), "every sleep is gone");
	const done = await host.exec(id, ["true"], CTX);
	await done.end();
	(async () => {
		for await (const _ of done.stdout);
	})();
	(async () => {
		for await (const _ of done.stderr);
	})();
	assert.equal(await done.wait(), 0);
	await done.kill();
});

test("delete ends the sandbox's SSH connections and lets its enable go: a later exec finds it terminated (not_found)", async (t) => {
	const { fake, rest, host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	assert.equal((await run(host, id, ["true"])).code, 0);
	assert.ok(fake.sshd.state.live > 0);
	await host.delete(id, CTX);
	assert.ok(await until(() => fake.sshd.state.live === 0), "the connection closed");
	await assert.rejects(host.exec(id, ["true"], CTX), (error) => error.code === "not_found");
	assert.equal(enables(rest).length, 1);
});

// --- check, the pre-check, conformance ---

test("check takes a Tensorlake image or a registered one by name, at most 16 vCPUs, and 1024 to 8192 MB a vCPU; another image, size or memory is refused before any call", () => {
	const { rest, provider } = restOnly();
	const spec = { lifetimeMs: 600_000, network: "none" };
	for (const image of [IMAGE, "tensorlake/ubuntu-systemd", "my-image", "team/my-image_2"]) assert.deepEqual(provider.check({ ...spec, image }), [], image);
	for (const image of ["ghcr.io/parcha-ai/agentrun-box:abc", "Tensorlake/X", "a b", "-x", "a/b/c/d"]) assert.deepEqual(provider.check({ ...spec, image }).map((one) => one.field), ["image"], image);
	for (const [cpus, memoryMb] of [[1, 1024], [0.5, 1024], [2, 16_384], [16, 65_536], [undefined, 2048], [4, undefined]]) assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus, memoryMb }), [], `${cpus}/${memoryMb}`);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 32 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 0 }).map((one) => one.field), ["cpus"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 4, memoryMb: 2048 }).map((one) => one.field), ["memoryMb"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, cpus: 1, memoryMb: 9000 }).map((one) => one.field), ["memoryMb"]);
	assert.deepEqual(provider.check({ ...spec, image: IMAGE, memoryMb: 512 }).map((one) => one.field), ["memoryMb"]);
	assert.match(provider.check({ ...spec, image: IMAGE, cpus: 4, memoryMb: 2048 })[0].message, /4096 to 32768 MB for 4 vCPUs/);
	assert.equal(rest.calls.length, 0);
});

test("the exec passes every check of the exec pre-check, over real processes behind the tunnel", { timeout: 120_000 }, async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const { host } = await setup(t);
	const { id } = await host.create(request(), CTX);
	const report = await checkExecStream(host, id, { longMs: 2_000, stepMs: 10_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the provider's Core conformance cases pass through the Tensorlake REST calls, the proxy's tunnel and its sshd, the daemon uploaded through stdin, and leave nothing behind", { timeout: 120_000 }, async (t) => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const machines = fakeHost();
	const { rest, provider } = await setup(t, { backend: machines.host }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const report = await runConformance(provider, { image: IMAGE, cases, caseTimeoutMs: 30_000, cleanupTimeoutMs: 10_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(rest.live().length, 0, "every sandbox made was deleted");
	assert.ok(machines.uploads.length > 0 && machines.uploads.every(({ through }) => through === "exec"), "the daemon went through the exec's stdin");
});

test("a create answers the size Tensorlake says the sandbox runs at (its read's resources, O SandboxInfo.resources, required), not a size the spec asked: the descriptor is sized", { timeout: 60_000 }, async (t) => {
	const machines = fakeHost();
	const { rest, provider } = await setup(t, { backend: machines.host }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const made = await provider.create({ image: IMAGE, lifetimeMs: 600_000, network: "none" }, { requestId: "tensorlake-sized" });
	assert.equal(made.ok, true, made.ok ? "" : made.error.message);
	assert.deepEqual(made.value.resources, { cpus: 1, memoryMb: 1024, diskGb: 10 }, "the fake's allocation for a create that named no size");
	assert.equal(TENSORLAKE.sized, true);
	const released = await provider.release(made.value, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(rest.live().length, 0);
});

// --- the registry and the conformance module ---

test("the registry builds Tensorlake from its options alone, and its source reads no environment and writes nowhere", async () => {
	const rest = fakeRest();
	const provider = await registry.providerFor("tensorlake", { apiKey: KEY, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL });
	assert.equal(provider.id, "tensorlake");
	assert.deepEqual(rest.calls, []);
	const source = readFileSync(new URL("../dist/tensorlake.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /COMPUTER_TENSORLAKE_/);
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/);
	assert.doesNotMatch(source, /^\s*import\s[^(]*from\s+["']ssh2["']/m, "no static import of ssh2");
	assert.equal(accountOf(KEY), accountOf(KEY, "https://api.tensorlake.ai/"));
	assert.doesNotMatch(accountOf(KEY), new RegExp(KEY));
});

test("the conformance module reads COMPUTER_TENSORLAKE_* alone, needs its live switch first, and its sweep's host and scope need none", async () => {
	const { live, ...names } = ENV;
	assert.equal(live, "AGENTRUN_COMPUTER_LIVE_TENSORLAKE");
	for (const name of Object.values(names)) assert.match(name, /^COMPUTER_TENSORLAKE_[A-Z0-9_]+$/);
	const env = { [ENV.key]: KEY };
	assert.deepEqual(settingsFromEnv(env), { apiKey: KEY });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: API_URL, [ENV.daemon]: "/tmp/computerd", TENSORLAKE_API_KEY: BARE }), { apiKey: KEY, apiUrl: API_URL, daemonPath: "/tmp/computerd" });
	assert.throws(
		() => settingsFromEnv({ TENSORLAKE_API_KEY: BARE }),
		(error) => /set COMPUTER_TENSORLAKE_API_KEY/.test(error.message) && !error.message.includes(BARE),
	);
	const rest = fakeRest();
	const doubles = { ssh2: { Client: class {} }, fetch: rest.fetch, WebSocket: NoSocket };
	await assert.rejects(conformanceModule.createProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_TENSORLAKE=1/);
	await assert.rejects(conformanceModule.createDriftedProvider({ env, ...doubles }), /set AGENTRUN_COMPUTER_LIVE_TENSORLAKE=1/);
	const provider = await conformanceModule.createProvider({ env: { ...env, [ENV.live]: "1" }, ...doubles });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "a conformance computer lives at most 30 minutes");
	assert.equal(await conformanceModule.conformanceImage({ env: {} }), IMAGE);
	assert.equal(await conformanceModule.conformanceImage({ env: { [ENV.image]: "my-image" } }), "my-image");
	const host = await conformanceModule.createHost({ env, ...doubles });
	assert.equal(host.descriptor.id, "tensorlake");
	assert.equal(sweepScope({ env }), accountOf(KEY));
	assert.doesNotMatch(sweepScope({ env }), new RegExp(KEY));
	assert.notEqual(sweepScope({ env: { ...env, [ENV.key]: BARE } }), sweepScope({ env }), "another key is another project");
	assert.deepEqual(rest.calls, []);
});
