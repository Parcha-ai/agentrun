// The phone kind's provider (src/phone.ts) on the phone harness's cloud Android, against a fake of its HTTPS API (an
// injected fetch) and of the phone it rents (an injected adb runner), test/fake-phone-harness.mjs. No port is opened, no
// adb runs, and no test waits on the wall clock: the fake's clock moves on when the provider sleeps.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { kindRefusals } from "../dist/index.js";
import { ADB_CODE, ADB_HOST, fakeClock, fakePhoneHarness, ITEMS, KEY, SCREEN, SEARCH_FIELD, SETTINGS } from "./fake-phone-harness.mjs";

const phone = await import("../dist/phone-harness.js");
const { create, MOUNT, memoryLedger, adbCli, PHONE_GROUPS } = phone;
const conformance = await import("../dist/conformance/phone-harness.js");

const dir = mkdtempSync(join(tmpdir(), "computer-phone-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const SPEC = { image: "android", lifetimeMs: 10 * 60_000, network: "open" };

/** A provider over a fresh fake, with its ledger. */
async function setup(fakeOptions = {}, options = {}) {
	const fake = fakePhoneHarness(fakeOptions);
	const ledger = options.ledger ?? memoryLedger();
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger, now: fake.clock.now, sleep: fake.clock.sleep, ...options });
	return { fake, provider, ledger };
}

/** The width and height a PNG's IHDR names, and its first pixel's RGBA when it is 8-bit RGBA with filter 0. */
function png(bytes) {
	assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "a PNG signature");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function shot(client, params = {}) {
	const first = await client.call("screen.shot", params);
	assert.equal(first.ok, true, JSON.stringify(first));
	const parts = [Buffer.from(first.value.data, "base64")];
	let eof = first.value.eof;
	while (!eof) {
		const more = await client.call("screen.read", { id: first.value.id, offset: Buffer.concat(parts).length });
		assert.equal(more.ok, true, JSON.stringify(more));
		parts.push(Buffer.from(more.value.data, "base64"));
		eof = more.value.eof;
	}
	const bytes = Buffer.concat(parts);
	assert.equal(bytes.length, first.value.size, "the bytes read add up to size");
	return { ...first.value, image: png(bytes), bytes };
}

const noKey = (value) => assert.ok(!JSON.stringify(value).includes(KEY), `the key is not in ${JSON.stringify(value).slice(0, 300)}`);

test("create(options) builds the phone-harness provider from its options alone: an Android phone the provider answers for, no daemon, no mount", async () => {
	assert.deepEqual(MOUNT, []);
	assert.equal(phone.ENV, undefined, "the provider file names no environment variable");
	assert.equal(phone.fromEnv, undefined);
	const { provider } = await setup();
	assert.equal(provider.id, "phone-harness");
	const caps = provider.capabilities();
	assert.deepEqual(
		{ kind: caps.kind, os: caps.os, daemon: caps.daemon, lifetime: caps.lifetime, network: caps.network, release: caps.release, groups: caps.groups, isolation: caps.isolation },
		{ kind: "android", os: "android", daemon: "none", lifetime: "vendor", network: ["open"], release: ["delete"], groups: PHONE_GROUPS, isolation: "vm" },
	);
	assert.deepEqual(PHONE_GROUPS, ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"]);
	assert.equal(caps.maxLifetimeMs, 30 * 60_000, "30 min by default");
	assert.deepEqual(kindRefusals(caps), []);
	assert.equal(provider.extend, undefined, "the phone harness has no extend");
	await assert.rejects(create({ fetch: () => assert.fail("no call") }), /options\.apiKey/);
	await assert.rejects(create({ apiKey: KEY, platform: "ios" }), /^Error: platform "ios" is not offered yet: the phone-harness provider rents a cloud Android; an iPhone is a later change$/);
	await assert.rejects(create({ apiKey: KEY, platform: "windows" }), /platform "windows"/);
});

test("check() refuses in words what a cloud phone cannot be, with no call", async () => {
	const { provider, fake } = await setup();
	assert.deepEqual(provider.check(SPEC), []);
	const field = (spec) => provider.check(spec).map((r) => r.field);
	assert.deepEqual(field({ ...SPEC, network: "none" }), ["network"]);
	assert.deepEqual(field({ ...SPEC, network: { allow: ["example.com"] } }), ["network"]);
	assert.deepEqual(field({ ...SPEC, lifetimeMs: 30 * 60_000 + 1 }), ["lifetimeMs"]);
	assert.deepEqual(field({ ...SPEC, user: "0" }), ["user"]);
	assert.deepEqual(field({ ...SPEC, cpus: 2, memoryMb: 1024, pids: 10, workdir: "/x" }), ["cpus", "memoryMb", "pids", "workdir"]);
	assert.deepEqual(field({ ...SPEC, mount: { kind: "bind", path: "/tmp" } }), ["mount"]);
	assert.ok(provider.check({ ...SPEC, network: "none" })[0].message.length > 0);
	const refused = await provider.create({ ...SPEC, network: "none" });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.deepEqual(fake.requests(), []);
});

test("create rents a cloud Android for the lifetime, waits until it is ready, and keeps its labels in the ledger; list, attach and release read them back", async () => {
	const { provider, fake, ledger } = await setup({ readyAfter: 3 });
	const created = await provider.create({ ...SPEC, lifetimeMs: 90_500, labels: { run: "r1", role: "a" } });
	assert.equal(created.ok, true, JSON.stringify(created));
	const { id, name } = created.value;
	assert.equal(name, id);
	const [post, ...gets] = fake.requests();
	assert.deepEqual([post.method, post.path, post.body], ["POST", "/sessions", { platform: "android", kind: "emulator", timeout_seconds: 91 }]);
	assert.match(post.headers["idempotency-key"], /^[A-Za-z0-9_-]{16,128}$/);
	assert.equal(post.headers.authorization, `Bearer ${KEY}`);
	assert.deepEqual(gets.map((r) => `${r.method} ${r.path}`), [`GET /sessions/${id}`, `GET /sessions/${id}`, `GET /sessions/${id}`], "polled until ready");
	const entry = await ledger.get(id);
	assert.deepEqual(entry.labels, { run: "r1", role: "a" });
	assert.equal(entry.image, "android");
	assert.equal(entry.deadline, new Date(fake.sessions.get(id).expires_at * 1000).toISOString());

	// Another session on the account, which this provider did not make, is never listed, attached or released.
	fake.sessions.set("sess_other", { id: "sess_other", state: "ready", platform: "android", kind: "emulator", expires_at: fake.clock.now() / 1000 + 600 });
	const listed = await provider.list({ run: "r1" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(
		listed.value.map((info) => [info.ref.name, info.state, info.network, info.labels.role, info.deadline?.toISOString()]),
		[[id, "running", "open", "a", entry.deadline]],
	);
	assert.deepEqual((await provider.list({ run: "r2" })).value, []);
	const attached = await provider.attach({ labels: { run: "r1" } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec, { image: "android", user: "2000:2000", network: "open", deadline: new Date(entry.deadline), kind: "android" });
	assert.equal((await provider.attach({ id })).ok, true);
	const foreign = await provider.attach({ id: "sess_other" });
	assert.equal(foreign.error.code, "not_found");
	assert.match(foreign.error.message, /sess_other is not a phone this provider made/);

	const stop = await provider.release(created.value, "stop");
	assert.equal(stop.error.code, "unsupported");
	assert.match(stop.error.message, /no stop/);
	assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	assert.equal(fake.sessions.has(id), false);
	assert.equal(await ledger.get(id), undefined, "the ledger forgets it");
	assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined }, "a delete of one already gone is ok");
	assert.equal(fake.sessions.has("sess_other"), true);
	assert.deepEqual((await provider.list({ run: "r1" })).value, []);
});

test("release ends only a phone the ledger names: another session on the account is refused not_found with no DELETE, and one already gone is ok", async () => {
	const { provider, fake } = await setup();
	fake.sessions.set("sess_other", { id: "sess_other", state: "ready", platform: "android", kind: "emulator", expires_at: fake.clock.now() / 1000 + 600 });
	const foreign = await provider.release({ id: "sess_other", name: "sess_other" }, "delete");
	assert.equal(foreign.ok, false, JSON.stringify(foreign));
	assert.equal(foreign.error.code, "not_found");
	assert.match(foreign.error.message, /^sess_other is not a phone this provider made: it is not ended$/);
	assert.equal(fake.sessions.has("sess_other"), true, "the other session still runs");
	assert.deepEqual(await provider.release({ id: "sess_gone", name: "sess_gone" }, "delete"), { ok: true, value: undefined }, "a phone no one holds any more is ok to release");
	assert.deepEqual(fake.requests().filter((r) => r.method === "DELETE"), [], "no DELETE for an id the ledger does not name");
});

test("a session the service ended is gone to attach and list, and the ledger forgets it", async () => {
	const { provider, fake, ledger } = await setup();
	const created = await provider.create({ ...SPEC, labels: { run: "r1" } });
	const other = await provider.create({ ...SPEC, labels: { run: "r1" } });
	fake.sessions.delete(created.value.id);
	fake.sessions.delete(other.value.id);
	assert.equal((await provider.attach({ id: created.value.id })).error.code, "gone");
	assert.deepEqual((await ledger.list()).map((e) => e.id), [other.value.id], "attach forgot the one it found gone");
	assert.deepEqual((await provider.list({ run: "r1" })).value, []);
	assert.deepEqual(await ledger.list(), [], "and list the other");
});

test("the service's refusals are words with a code, and never the key", async () => {
	for (const [start, code, words] of [
		["busy", "limit", /every phone is busy; try again in 30 s/],
		["limit", "limit", /the account's sessions are full \(session_limit\)/],
		["credit", "denied", /insufficient credits/],
	]) {
		const { provider } = await setup({ start });
		const created = await provider.create(SPEC);
		assert.equal(created.ok, false, start);
		assert.equal(created.error.code, code, start);
		assert.match(created.error.message, words);
		noKey(created);
	}
	const fake = fakePhoneHarness();
	const wrongKey = await create({ apiKey: "another-fake-key", fetch: fake.fetch, adb: fake.adb, now: fake.clock.now, sleep: fake.clock.sleep });
	const denied = await wrongKey.create(SPEC);
	assert.equal(denied.error.code, "denied");
	assert.match(denied.error.message, /^POST \/sessions: the phone harness refused the API key \(401\): invalid API key$/);
	assert.ok(!denied.error.message.includes("another-fake-key"));
});

test("a phone that fails or is not ready within readyMs is ended, in words", async () => {
	const failed = await setup({ start: "error" });
	const broke = await failed.provider.create(SPEC);
	assert.equal(broke.error.code, "phone");
	assert.match(broke.error.message, /^the phone sess_0001 did not start: the emulator did not boot; it was ended$/);
	assert.equal(failed.fake.sessions.size, 0);
	assert.deepEqual(await failed.ledger.list(), []);

	const slow = await setup({ readyAfter: 1000 }, { readyMs: 10_000 });
	const late = await slow.provider.create(SPEC);
	assert.equal(late.error.code, "timeout");
	assert.match(late.error.message, /^the phone sess_0001 was not ready within 10 s; it was ended$/);
	assert.equal(slow.fake.sessions.size, 0);
});

/** A timer the test fires: each request's bound, as the provider asked for it, with no wall clock. */
function testTimers() {
	const made = [];
	const timeout = (ms) => {
		const controller = new AbortController();
		made.push({ ms, fire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")) });
		return controller.signal;
	};
	return { timeout, made };
}

// The hang guard only bounds a failure: on a pass nothing waits on a timer.
test("each API request has its own bound: a stalled readiness read is cut off by what readyMs has left, and the phone is ended", { timeout: 10_000 }, async () => {
	const { timeout, made } = testTimers();
	let stalledNow;
	const stalled = new Promise((resolve) => (stalledNow = resolve));
	let reads = 0;
	const stall = ({ method, path }) => method === "GET" && path === "/sessions/sess_0001" && ++reads === 3 && (stalledNow(), true);
	const { provider, fake } = await setup({ readyAfter: 10, stall }, { readyMs: 10_000, pollMs: 2000, requestMs: 30_000, timeout });
	const pending = provider.create(SPEC);
	await stalled;
	// Two reads and two polls of 2 s: the third read may take the 6 s readyMs has left, not the 30 s of any request.
	assert.deepEqual(made.map((one) => one.ms), [30_000, 10_000, 8_000, 6_000]);
	made.at(-1).fire();
	const late = await pending;
	assert.equal(late.ok, false, JSON.stringify(late));
	assert.equal(late.error.code, "timeout");
	assert.match(late.error.message, /^the phone sess_0001 was not ready within 10 s: GET \/sessions\/sess_0001: the phone harness did not answer within 6 s; it was ended$/);
	assert.equal(fake.sessions.size, 0, "the phone was ended");
	assert.equal(made.at(-1).ms, 30_000, "the DELETE has a bound of its own");
});

test("a POST that stalls is cut off by its bound and recovered by its Idempotency-Key, never posted again", { timeout: 10_000 }, async () => {
	const { timeout, made } = testTimers();
	let stalledNow;
	const stalled = new Promise((resolve) => (stalledNow = resolve));
	const stall = ({ method, path }) => method === "POST" && path === "/sessions" && (stalledNow(), true);
	const { provider, fake } = await setup({ stall }, { requestMs: 30_000, timeout });
	const pending = provider.create(SPEC);
	await stalled;
	// The stalled POST never reached the fake's sessions: recovery finds nothing, and says so in words.
	made.at(-1).fire();
	const created = await pending;
	assert.equal(created.ok, false, JSON.stringify(created));
	assert.match(created.error.message, /^POST \/sessions: the phone harness did not answer within 30 s; and the service has no session for the request/);
	const key = fake.requests()[0].headers["idempotency-key"];
	assert.deepEqual(fake.requests().map((r) => `${r.method} ${r.path}`), ["POST /sessions", `GET /sessions/requests/${key}`]);
	assert.ok(made.every((one) => one.ms === 30_000), "the POST and the recovery each have a bound");
});

test("a create whose answer was lost is recovered by its Idempotency-Key, never by a second POST", async () => {
	const { provider, fake } = await setup({ loseAnswer: true });
	const created = await provider.create(SPEC);
	assert.equal(created.ok, true, JSON.stringify(created));
	const posts = fake.requests().filter((r) => r.method === "POST" && r.path === "/sessions");
	assert.equal(posts.length, 1);
	const key = posts[0].headers["idempotency-key"];
	assert.ok(fake.requests().some((r) => r.path === `/sessions/requests/${key}`));
	assert.equal(fake.sessions.size, 1);
});

test("a create whose answer and whose recovery were both lost leaves no orphan: list finds the phone by its Idempotency-Key, and release ends it", async () => {
	const { provider, fake, ledger } = await setup({ loseAnswer: true, loseRecovery: true });
	// Another session on the account, under another request key: never adopted.
	fake.sessions.set("sess_other", { id: "sess_other", state: "ready", platform: "android", kind: "emulator", expires_at: fake.clock.now() / 1000 + 600, request_key: "b".repeat(32) });
	const created = await provider.create({ ...SPEC, labels: { run: "r1" } });
	assert.equal(created.ok, false, "the create could not be told about");
	const [made] = [...fake.sessions.values()].filter((s) => s.id !== "sess_other");
	assert.ok(made, "the phone harness made the phone all the same");
	const posted = fake.requests().find((r) => r.method === "POST" && r.path === "/sessions");
	assert.equal(made.request_key, posted.headers["idempotency-key"]);

	// The sweep's view: list finds it under the run's labels, by the key the ledger kept before the POST.
	const listed = await provider.list({ run: "r1" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.deepEqual(listed.value.map((info) => info.ref.id), [made.id]);
	assert.deepEqual((await ledger.list()).map((entry) => entry.id), [made.id], "the ledger now names the phone by its id");
	assert.deepEqual(await provider.release(listed.value[0].ref, "delete"), { ok: true, value: undefined });
	assert.deepEqual([...fake.sessions.keys()], ["sess_other"], "the orphan is ended; the other session is untouched");
	assert.deepEqual(await ledger.list(), []);
});

test("a create cancelled after the service admitted its POST recovers the phone by its Idempotency-Key and ends it: none is left running", async () => {
	const controller = new AbortController();
	const { provider, fake, ledger } = await setup({ cancelPost: () => controller.abort() });
	const created = await provider.create({ ...SPEC, labels: { run: "r1" } }, { signal: controller.signal });
	assert.equal(created.ok, false, JSON.stringify(created));
	assert.equal(created.error.code, "aborted");
	assert.match(created.error.message, /sess_0001/, "the words name the phone that was made");
	assert.match(created.error.message, /it was ended$/);
	const key = fake.requests().find((r) => r.method === "POST").headers["idempotency-key"];
	assert.deepEqual(
		fake.requests().map((r) => `${r.method} ${r.path}`),
		["POST /sessions", `GET /sessions/requests/${key}`, "DELETE /sessions/sess_0001"],
		"recovered by its key, never posted again, and ended",
	);
	assert.equal(fake.sessions.size, 0, "no phone is left running");
	assert.deepEqual(await ledger.list(), [], "and the ledger names none");
});

test("connect reaches the phone over adb with its unlock code, which no result or error ever holds; hello is the provider's", async () => {
	const { provider, fake } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	// The phone harness's own link: a DNS name, a port, and a ph_ code (OpenAPI SessionAdb), as a live run gave it.
	// The endpoint goes to the adb server over its socket; the unlock is the shell service `shell:unlock <code>` on a
	// socket the server bound to the phone (the fake's record keeps the code out); every spawned adb names the phone by
	// its transport id.
	const endpoint = `${ADB_HOST}:${22220 + 1}`;
	// connect asks first (shell:echo ph-ok), unlocks only a transport that answers locked, then probes.
	assert.deepEqual(fake.serverCalls().slice(0, 4), [`host:connect:${endpoint}`, "host:devices-l", "host:transport-id:1 shell:echo ph-ok", "host:transport-id:1 shell:unlock [code]"]);
	assert.deepEqual(fake.adbCalls()[0], ["-t", "1", "shell", "echo ph-ok"]);
	assert.deepEqual(fake.shells().slice(0, 3), ["echo ph-ok", `unlock ${ADB_CODE}`, "echo ph-ok"]);
	assert.deepEqual(connected.value.hello, { version: provider.version, os: "android", kind: "android", arch: "amd64", groups: PHONE_GROUPS });
	assert.deepEqual((await connected.value.client.call("hello", { client: "test" })).value, connected.value.hello);
	assert.deepEqual(await connected.value.client.call("ping", {}), { ok: true, value: {} });
	await connected.value.close();
	assert.equal((await connected.value.client.call("ping", {})).error.code, "gone");

	const locked = await setup({ code: "ph_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
	const lockedRef = (await locked.provider.create(SPEC)).value;
	const refused = await locked.provider.connect(lockedRef);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /refused its unlock code: wrong code$/);
	assert.ok(!JSON.stringify(refused).includes(ADB_CODE), "the unlock code is never in an error");
	assert.ok(!JSON.stringify(refused).includes("ph_"), "nor any part of it");

	const arm = await setup({ abi: "arm64-v8a" });
	const armHello = (await arm.provider.connect((await arm.provider.create(SPEC)).value)).value.hello;
	assert.equal(armHello.arch, "arm64");
});

test("two connections to one phone share its adb transport: the second does not unlock again, and closing one leaves the other working", async () => {
	// Live run 4: a second connect reused the adb server's transport, already unlocked; its `unlock` reached the phone's
	// own sh ("not found"), and the disconnect after that failure dropped the transport the first connection used.
	const { provider, fake } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const first = await provider.connect(ref);
	assert.equal(first.ok, true, JSON.stringify(first));
	const second = await provider.connect(ref);
	assert.equal(second.ok, true, JSON.stringify(second));
	assert.deepEqual(
		fake.shells().filter((command) => /^unlock /.test(command)),
		[`unlock ${ADB_CODE}`],
		"the transport is unlocked once: the second connection finds it unlocked",
	);
	for (const connection of [first.value, second.value]) assert.equal((await connection.client.call("apps.list", {})).ok, true);
	const endpoint = `${ADB_HOST}:${22220 + 1}`;
	const disconnects = () => fake.serverCalls().filter((call) => call === `host:disconnect:${endpoint}`).length;
	await first.value.close();
	assert.equal(disconnects(), 0, "the second connection still holds the transport");
	const still = await second.value.client.call("apps.list", {});
	assert.equal(still.ok, true, JSON.stringify(still));
	await second.value.close();
	assert.equal(disconnects(), 1, "the last holder lets it go, once");
	assert.equal(fake.phone.connected.size, 0);
	// A connection made after that connects and unlocks afresh: the vendor's lock is per connection.
	const third = await provider.connect(ref);
	assert.equal(third.ok, true, JSON.stringify(third));
	assert.equal(fake.shells().filter((command) => /^unlock /.test(command)).length, 2);
	await third.value.close();
});

test("no spawned adb's argv holds the unlock code or the phone's endpoint, which /proc shows to every user of the host", async () => {
	const { provider, fake } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	const { client } = connected.value;
	assert.equal((await client.call("screen.shot", {})).ok, true);
	assert.equal((await client.call("input.actions", { actions: [{ type: "tap", at: [10, 10] }] })).ok, true);
	assert.equal((await client.call("apps.ui_tree", {})).ok, true);
	await connected.value.close();
	const port = String(22220 + 1);
	for (const argv of fake.adbCalls()) {
		for (const arg of argv) {
			assert.ok(!arg.includes(ADB_CODE) && !arg.includes("ph_"), `an adb argv holds the unlock code: ${JSON.stringify(argv).replace(ADB_CODE, "[code]")}`);
			assert.ok(!arg.includes(ADB_HOST) && arg !== port && !arg.endsWith(`:${port}`), `an adb argv holds the phone's endpoint: ${JSON.stringify(argv)}`);
		}
	}
	assert.ok(fake.shells().includes(`unlock ${ADB_CODE}`), "the phone was unlocked all the same");
	assert.deepEqual(fake.phone.connected.size, 0, "and close let the transport go");
});

test("a connect that fails once adb reached the phone lets the transport go: the adb server keeps nothing of it", async () => {
	// A phone that stays locked: the unlock code it takes is another.
	const { provider, fake } = await setup({ code: "ph_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
	const { value: ref } = await provider.create(SPEC);
	const refused = await provider.connect(ref);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /refused its unlock code/);
	assert.equal(fake.phone.connected.size, 0, "no transport is left on the adb server");
	assert.equal(fake.serverCalls().at(-1), `host:disconnect:${ADB_HOST}:${22220 + 1}`);
	// A drifted phone, unlocked and then refused after its hello, lets it go too.
	const other = fakePhoneHarness();
	const drifted = await create({ apiKey: KEY, fetch: other.fetch, adb: other.adb, now: other.clock.now, sleep: other.clock.sleep, daemonVersion: "0.0.0-drift" });
	const twin = (await drifted.create(SPEC)).value;
	const refusedTwin = await drifted.connect(twin);
	assert.equal(refusedTwin.error.code, "refused");
	assert.equal(other.phone.connected.size, 0);
});

test("the adb server's answers are read as its socket protocol frames them: OKAY or FAIL, then a hex length and the message", () => {
	const frame = (status, message) => Buffer.from(`${status}${Buffer.byteLength(message).toString(16).padStart(4, "0")}${message}`);
	assert.deepEqual(phone.adbAnswer(frame("OKAY", "connected to live.phone-harness.test:22221"), "host:connect"), { ok: true, value: "connected to live.phone-harness.test:22221" });
	assert.deepEqual(phone.adbAnswer(Buffer.from("OKAY"), "host:disconnect"), { ok: true, value: "" });
	const refused = phone.adbAnswer(frame("FAIL", "no such device"), "host:disconnect");
	assert.deepEqual(refused, { ok: false, error: { code: "phone", message: "the adb server refused host:disconnect: no such device" } });
	assert.equal(phone.adbAnswer(Buffer.from("HTTP/1.1 400"), "host:devices-l").error.code, "phone");
	// A service is named in words by its kind and first word, never by its code or endpoint.
	assert.equal(phone.serviceWords(`shell:unlock ${ADB_CODE}`), "shell:unlock");
	assert.equal(phone.serviceWords(`host:connect:${ADB_HOST}:22221`), "host:connect");
	assert.equal(phone.serviceWords("host:devices-l"), "host:devices-l");
});

test("without adb on this machine, connect says what to install", async () => {
	const fake = fakePhoneHarness();
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: adbCli(join(dir, "no-such-adb")), now: fake.clock.now, sleep: fake.clock.sleep });
	const { value: ref } = await provider.create(SPEC);
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, false);
	assert.equal(connected.error.code, "not_found");
	assert.match(connected.error.message, /^the phone provider needs adb \(Android platform-tools\) on this machine/);
});

test("the client answers the phone groups over adb: a screenshot, touch, keys, buttons and apps; a pinch, a pointer and a shell are refused in words", async () => {
	const { provider, fake } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const { value: connection } = await provider.connect(ref);
	const { client } = connection;
	const call = async (method, params) => {
		const result = await client.call(method, params);
		assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
		return result.value;
	};

	const full = await shot(client);
	assert.deepEqual([full.width, full.height, full.scale], [SCREEN.width, SCREEN.height, 1]);
	assert.deepEqual([full.image.width, full.image.height], [SCREEN.width, SCREEN.height]);
	const part = await shot(client, { region: [10, 20, 100, 50] });
	assert.deepEqual([part.width, part.height, part.image.width, part.image.height], [100, 50, 100, 50]);
	assert.equal((await client.call("screen.shot", { region: [300, 600, 100, 100] })).error.code, "invalid", "a region off the screen");

	// Settings, launched and in front; its top list in the tree.
	assert.deepEqual(await call("apps.launch", { id: SETTINGS }), {});
	const listed = await call("apps.list", {});
	assert.ok(listed.apps.some((app) => app.id === SETTINGS));
	assert.equal(listed.foreground, SETTINGS);
	const tree = await call("apps.ui_tree", {});
	assert.equal(tree.truncated, false);
	const all = [];
	const walk = (n) => {
		all.push(n);
		n.children.forEach(walk);
	};
	walk(tree.root);
	assert.equal(tree.nodes, all.length);
	assert.equal(tree.root.role, "android.widget.FrameLayout");
	assert.deepEqual(tree.root.bounds, [0, 0, SCREEN.width, SCREEN.height]);
	const display = all.find((n) => n.text === ITEMS[0]);
	assert.deepEqual(display, { role: "android.widget.TextView", id: "android:id/title", text: ITEMS[0], bounds: [72, 112, 240, 32], enabled: true, clickable: false, focused: false, selected: false, checked: false, scrollable: false, children: [] });

	const before = fake.shells().length;
	assert.deepEqual(
		await call("input.actions", {
			actions: [
				{ type: "tap", at: [40, 50] },
				{ type: "tap", at: [5, 6], count: 2 },
				{ type: "long_press", at: [7, 8] },
				{ type: "swipe", path: [[180, 500], [180, 200]], ms: 300 },
				{ type: "swipe", path: [[1, 2], [3, 4], [5, 6]] },
				{ type: "button", name: "back" },
				{ type: "button", name: "home" },
				{ type: "button", name: "app_switch" },
				{ type: "type", text: "Hello, it's 1\n" },
				{ type: "key", keys: ["enter"], repeat: 2 },
				{ type: "key", keys: ["a"] },
				{ type: "key", keys: ["%"] },
				{ type: "wait", ms: 250 },
			],
		}),
		{ done: 13 },
	);
	assert.deepEqual(fake.shells().slice(before), [
		"input tap 40 50",
		"input tap 5 6",
		"input tap 5 6",
		"input swipe 7 8 7 8 800",
		"input swipe 180 500 180 200 300",
		"input motionevent DOWN 1 2;input motionevent MOVE 3 4;input motionevent MOVE 5 6;input motionevent UP 5 6",
		"input keyevent KEYCODE_BACK",
		"input keyevent KEYCODE_HOME",
		"input keyevent KEYCODE_APP_SWITCH",
		"input text 'Hello,%sit'\\''s%s1'",
		"input keyevent KEYCODE_ENTER",
		"input keyevent KEYCODE_ENTER",
		"input keyevent KEYCODE_ENTER",
		"input keyevent KEYCODE_A",
		"input text '%'",
	]);

	// A batch is checked whole before anything runs: an unknown key, a pinch, a pointer action, a combo or a hold.
	const ran = fake.shells().length;
	for (const [action, kind, words] of [
		[{ type: "key", keys: ["Hyper_Q"] }, "invalid", /"Hyper_Q" is not a key/],
		[{ type: "pinch", at: [10, 10], scale: 2 }, "unsupported", /pinch: a cloud Android takes one finger through adb/],
		[{ type: "click", at: [10, 10] }, "unsupported", /\(click\) needs input\.pointer, which this computer does not declare/],
		[{ type: "key", keys: ["ctrl", "a"] }, "unsupported", /a combo of keys/],
		[{ type: "hold", keys: ["shift"], ms: 100 }, "unsupported", /hold/],
	]) {
		const refused = await call("input.actions", { actions: [{ type: "tap", at: [1, 1] }, action] });
		assert.equal(refused.done, 0, JSON.stringify(action));
		assert.equal(refused.failed?.index, 1);
		assert.equal(refused.failed?.kind, kind, JSON.stringify(refused));
		assert.match(refused.failed.message, words);
	}
	assert.equal(fake.shells().length, ran, "nothing ran of a refused batch");

	assert.deepEqual(await call("apps.terminate", { id: SETTINGS }), {});
	assert.equal(fake.shells().at(-1), `am force-stop ${SETTINGS}`);
	assert.notEqual((await call("apps.list", {})).foreground, SETTINGS);
	const missing = await client.call("apps.launch", { id: "com.example.none" });
	assert.equal(missing.error.code, "not_found");
	assert.equal((await client.call("apps.launch", { id: "bad id; rm -rf /" })).error.code, "invalid", "an app id is checked before it reaches a shell");

	for (const method of ["exec.run", "files.read", "process.start", "tar.pull.begin", "apps.install", "deadline.extend", "no.such.method"]) {
		const refused = await client.call(method, {});
		assert.equal(refused.error.code, "unsupported", method);
		assert.ok(refused.error.message.length > 0);
	}
	assert.match((await client.call("exec.run", { argv: ["id"], timeoutMs: 1000 })).error.message, /a phone has no shell in the computer protocol/);
});

// The hang guard only bounds a failure: on a pass the batch answers in microtasks, with no timer.
test("a cancelled input batch stops at the action it is on: a wait ends when the signal fires, and no later command runs", { timeout: 10_000 }, async () => {
	// A wait the cancel interrupts: once armed, the clock's sleep never ends by itself, so only the signal can end it.
	const clock = fakeClock();
	let armed = false;
	let began;
	const waiting = new Promise((resolve) => (began = resolve));
	const sleep = (ms) => (armed ? (began(ms), new Promise(() => {})) : clock.sleep(ms));
	const { provider, fake } = await setup({ clock }, { sleep });
	const { value: ref } = await provider.create(SPEC);
	const { client } = (await provider.connect(ref)).value;
	armed = true;
	const controller = new AbortController();
	const call = client.call("input.actions", { actions: [{ type: "wait", ms: 5000 }, { type: "tap", at: [100, 300] }] }, { signal: controller.signal });
	assert.equal(await waiting, 5000, "the wait began");
	controller.abort();
	const waited = await call;
	assert.equal(waited.ok, true, JSON.stringify(waited));
	assert.equal(waited.value.done, 0);
	assert.deepEqual([waited.value.failed?.index, waited.value.failed?.kind], [0, "aborted"]);
	assert.match(waited.value.failed.message, /^action 0: .*aborted/);
	assert.equal(fake.shells().filter((command) => command.startsWith("input tap")).length, 0, "no tap ran");

	// A cancel during a command: the batch stops before the next one.
	const other = fakePhoneHarness();
	const cancel = new AbortController();
	const adb = {
		server: other.adb.server,
		run: async (args, options) => {
			const ran = await other.adb.run(args, options);
			if (args.at(-1)?.startsWith("input tap")) cancel.abort();
			return ran;
		},
	};
	const second = await create({ apiKey: KEY, fetch: other.fetch, adb, ledger: memoryLedger(), now: other.clock.now, sleep: other.clock.sleep });
	const { value: phone2 } = await second.create(SPEC);
	const { client: client2 } = (await second.connect(phone2)).value;
	const tapped = await client2.call("input.actions", { actions: [{ type: "tap", at: [100, 300] }, { type: "tap", at: [100, 300] }, { type: "button", name: "back" }] }, { signal: cancel.signal });
	assert.equal(tapped.ok, true, JSON.stringify(tapped));
	assert.equal(tapped.value.done, 1);
	assert.deepEqual([tapped.value.failed?.index, tapped.value.failed?.kind], [1, "aborted"]);
	assert.equal(other.shells().filter((command) => command.startsWith("input tap")).length, 1, "one tap ran, the second did not");
	assert.equal(other.shells().filter((command) => command.startsWith("input keyevent")).length, 0, "nor the button after it");
});

test("typing into Settings' search reads back from the tree", async () => {
	const { provider } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const { client } = (await provider.connect(ref)).value;
	await client.call("apps.launch", { id: SETTINGS });
	await client.call("input.actions", { actions: [{ type: "tap", at: [100, 40] }, { type: "type", text: "Hello, agentrun! 123" }] });
	const tree = (await client.call("apps.ui_tree", {})).value;
	const find = (n) => (n.id === SEARCH_FIELD ? n : n.children.map(find).find(Boolean));
	assert.equal(find(tree.root)?.text, "Hello, agentrun! 123");
});

test("apps.launch puts the named app in front, even when its task holds another app's activity on top", async () => {
	// Android 15 (phone probe 2): Settings' search is another package's activity on top of Settings' task. After a
	// force-stop of Settings, a plain `am start` resumes that task with search in front; a cleared task starts Settings.
	const { provider, fake } = await setup();
	const { value: ref } = await provider.create(SPEC);
	const { client } = (await provider.connect(ref)).value;
	await client.call("apps.launch", { id: SETTINGS });
	await client.call("input.actions", { actions: [{ type: "tap", at: [100, 40] }] });
	assert.equal((await client.call("apps.list", {})).value.foreground, "com.android.settings.intelligence", "search is in front");
	await client.call("apps.terminate", { id: SETTINGS });
	assert.deepEqual(await client.call("apps.launch", { id: SETTINGS }), { ok: true, value: {} });
	assert.equal((await client.call("apps.list", {})).value.foreground, SETTINGS, "the app named is in front");
	assert.match(fake.shells().filter((command) => command.startsWith("am start")).at(-1), /^am start -W --activity-clear-task -n com\.android\.settings\/\.Settings$/);
});

test("a drifted twin's phone is refused at connect, in the drift check's words", async () => {
	const fake = fakePhoneHarness();
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, now: fake.clock.now, sleep: fake.clock.sleep };
	const provider = await create(options);
	const drifted = await create({ ...options, daemonVersion: "0.0.0-drift" });
	const { value: ref } = await drifted.create(SPEC);
	const refused = await drifted.connect(ref);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, new RegExp(`hello: the daemon reports version 0\\.0\\.0-drift, expected ${provider.version.replaceAll(".", "\\.")}`));
});

test("a ledger put that fails once the phone's id is known ends the phone and answers in words: at the first put, and at the last one once ready", async () => {
	for (const [nth, when] of [
		[1, "the put of the id the POST answered"],
		[2, "the put of the deadline once ready"],
	]) {
		// The pending entry is written; the nth put of the session's own entry fails.
		const base = memoryLedger();
		let puts = 0;
		const ledger = {
			...base,
			put: (entry) => {
				if (entry.request === undefined && ++puts === nth) throw new Error("the disk is full");
				return base.put(entry);
			},
		};
		const { provider, fake } = await setup({ readyAfter: 2 }, { ledger });
		let created;
		await assert.doesNotReject(async () => (created = await provider.create(SPEC)), when);
		assert.equal(created.ok, false, `${when}: ${JSON.stringify(created)}`);
		assert.equal(created.error.code, "phone", when);
		assert.match(created.error.message, /the phone ledger could not be written: the disk is full; the phone was ended$/, when);
		assert.ok(fake.requests().some((r) => r.method === "DELETE" && r.path === "/sessions/sess_0001"), `${when}: DELETE sent`);
		assert.equal(fake.sessions.size, 0, `${when}: no phone is left running`);
	}
});

test("an unreadable ledger is a result in words from list and testConnection, never a throw; create makes no phone without one", async () => {
	const broken = join(dir, "broken-ledger.json");
	writeFileSync(broken, "{ not json");
	for (const ledger of [conformance.fileLedger(broken), { put: () => { throw new Error("the store is down"); }, get: () => { throw new Error("the store is down"); }, list: () => { throw new Error("the store is down"); }, remove: () => { throw new Error("the store is down"); } }]) {
		const { provider, fake } = await setup({}, { ledger });
		const listed = await provider.list({});
		assert.equal(listed.ok, false);
		assert.equal(listed.error.code, "phone");
		assert.match(listed.error.message, /^the phone ledger could not be read: /);
		const tested = await provider.testConnection();
		assert.equal(tested.ok, false);
		assert.match(tested.error.message, /^the phone ledger could not be read: /);
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false);
		assert.match(made.error.message, /^the phone ledger could not be (read|written): /);
		assert.ok(!fake.requests().some((r) => r.method === "POST"), "no phone is rented that the ledger could not keep");
	}
});

test("a file ledger loses no phone when processes and calls put at once: every entry lands", async () => {
	// Each put reads the whole file, adds one entry and renames a new file into place: two writers that read the same
	// file each drop the other's entry, and that phone is billed with no ledger naming it.
	const path = join(dir, "concurrent-ledger.json");
	const module = new URL("../dist/conformance/phone-harness.js", import.meta.url).href;
	const writers = 6;
	const each = 30;
	const script = `const { fileLedger } = await import(process.argv[1]); const ledger = fileLedger(process.argv[2]); const who = process.argv[3]; await Promise.all(Array.from({ length: ${each} }, (_, i) => ledger.put({ id: who + "-" + i, labels: {}, image: "android", deadline: "2026-11-08T12:00:00.000Z" })));`;
	const ran = await Promise.all(
		Array.from({ length: writers }, (_, w) => new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", script, module, path, `w${w}`], (error, stdout, stderr) => resolve({ error, stderr })))),
	);
	for (const { error, stderr } of ran) assert.equal(error, null, stderr);
	const ids = (await conformance.fileLedger(path).list()).map((entry) => entry.id).sort();
	assert.equal(ids.length, writers * each, `every put landed: ${ids.length} of ${writers * each}`);
});

test("the conformance module reads its own COMPUTER_PHONE_HARNESS_* names, never PHONE_HARNESS_API_KEY, and keeps its ledger in a file", async () => {
	assert.deepEqual(conformance.PHONE_ENV, {
		key: "COMPUTER_PHONE_HARNESS_API_KEY",
		platform: "COMPUTER_PHONE_HARNESS_PLATFORM",
		adb: "COMPUTER_PHONE_HARNESS_ADB",
		ledger: "COMPUTER_PHONE_HARNESS_LEDGER",
		live: "AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS",
	});
	assert.equal(conformance.ENV, conformance.PHONE_ENV);
	assert.deepEqual(conformance.settingsFromEnv({ PHONE_HARNESS_API_KEY: KEY }), {}, "the bare vendor name is not read");
	const path = join(dir, "ledger.json");
	assert.deepEqual(conformance.settingsFromEnv({ COMPUTER_PHONE_HARNESS_API_KEY: KEY, COMPUTER_PHONE_HARNESS_PLATFORM: "android", COMPUTER_PHONE_HARNESS_ADB: "/opt/adb", COMPUTER_PHONE_HARNESS_LEDGER: path }), {
		apiKey: KEY,
		platform: "android",
		adb: "/opt/adb",
		ledgerPath: path,
	});
	await assert.rejects(conformance.createProvider({ env: { COMPUTER_PHONE_HARNESS_API_KEY: KEY } }), /set AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS=1/);

	const ledger = conformance.fileLedger(path);
	await ledger.put({ id: "sess_1", labels: { run: "r" }, image: "android", deadline: "2026-11-08T12:10:00.000Z" });
	assert.deepEqual(await conformance.fileLedger(path).get("sess_1"), { id: "sess_1", labels: { run: "r" }, image: "android", deadline: "2026-11-08T12:10:00.000Z" });
	assert.equal((readFileSync(path).length > 0), true);
	assert.deepEqual((await ledger.list()).map((e) => e.id), ["sess_1"]);
	await ledger.remove("sess_1");
	assert.deepEqual(await conformance.fileLedger(path).list(), []);

	const fake = fakePhoneHarness({ clock: fakeClock() });
	const through = { fetch: fake.fetch, adb: fake.adb, now: fake.clock.now, sleep: fake.clock.sleep };
	const built = await conformance.createProvider({ env: { COMPUTER_PHONE_HARNESS_API_KEY: KEY, AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1", COMPUTER_PHONE_HARNESS_LEDGER: path }, ...through });
	assert.equal(built.id, "phone-harness");
	assert.equal(built.capabilities().maxLifetimeMs, 10 * 60_000, "a conformance run's phones live at most 10 min");
	const drifted = await conformance.createDriftedProvider({ env: { COMPUTER_PHONE_HARNESS_API_KEY: KEY, AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1", COMPUTER_PHONE_HARNESS_LEDGER: path }, ...through });
	assert.equal(drifted.version, built.version, "the twin is the same provider; only its phone's hello reports another version");
	const twin = (await drifted.create(SPEC)).value;
	assert.match((await drifted.connect(twin)).error.message, /hello: the daemon reports version \S+, expected /);
	await drifted.release(twin, "delete");
	assert.equal(await conformance.conformanceImage(), "android");
});
