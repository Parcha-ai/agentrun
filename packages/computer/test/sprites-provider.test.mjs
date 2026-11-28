// SpritesProvider's host against a stand-in for the Sprites API (fake-sprites.mjs: a fetch for its REST calls and a
// WebSocket for its exec socket's binary frames, its commands scripted or run on a backend here): what the host sends for
// create, get, list, delete and exec, how it reads the answers and the frames back, the exec pre-check over it, and the
// provider's Core conformance cases through it. The adapter's lifecycle is tested once, against its fake host
// (hosted-provider.test.mjs); Fly's own is proven live.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { fakeHost } from "./fake-host.mjs";
import { fakeSprites, TOKEN } from "./fake-sprites.mjs";

const { SpritesProvider, create } = await import("../dist/sprites.js");
const { SPRITES } = await import("../dist/descriptors/index.js");
const { packLabels } = await import("../dist/hosted/values.js");
const { checkExecStream, formatExecStream } = await import("../dist/conformance/exec-stream.js");
const { SPRITES_ENV: ENV, settingsFromEnv, createProvider, createHost, conformanceImage, sweepScope } = await import("../dist/conformance/sprites.js");

const CTX = { timeoutMs: 5_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const HAS_PROC = existsSync("/proc/self/stat");
const DAY_MS = 24 * 3_600_000;
const request = (more = {}) => ({ name: NAME, image: "default", labels: { agentrun: NAME }, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false, ...more });
const dir = mkdtempSync(join(tmpdir(), "computer-sprites-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };

function spritesOf(options, more = {}) {
	const vendor = fakeSprites(options);
	const provider = new SpritesProvider({ token: TOKEN, fetch: vendor.fetch, webSocket: vendor.webSocket, timeouts: { pollMs: 1 }, ...more });
	return { vendor, provider, host: provider.host };
}

/** A whole stream's text. */
const textOf = async (stream) => Buffer.concat(await stream.toArray()).toString("utf8");
/** The one session the fake holds, once its socket opened. */
const sessionOf = async (vendor) => {
	while (vendor.sessions.size === 0) await new Promise((resolve) => setImmediate(resolve));
	return [...vendor.sessions.values()].at(-1);
};

test("the descriptor: a sandbox under SPRITES_TOKEN, every network form through init, no mount, Fly's own image as the default; the host a janitor's microVM with packed labels", () => {
	assert.equal(SPRITES.id, "sprites");
	assert.equal(SPRITES.label, "Fly Sprites");
	assert.deepEqual(SPRITES.keys, [{ name: "SPRITES_TOKEN", option: "token", required: true }]);
	assert.deepEqual([SPRITES.network, SPRITES.mounts, SPRITES.defaultImage, SPRITES.prepareImage], [["none", "open", "allow"], [], { sandbox: "default" }, undefined]);
	const { host } = spritesOf();
	assert.deepEqual(host.facts, { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: 30 * DAY_MS, arch: "amd64", vendorAgentPorts: [], labels: { packed: { valueBytes: 52 } } });
	assert.throws(() => new SpritesProvider({ token: "" }), /options\.token, a Sprites API token, is required/);
	assert.throws(() => new SpritesProvider({ token: TOKEN, apiUrl: "http://api.sprites.dev" }), /the Sprites API URL must be https/);
});

test("create posts the name and the labels as name=value strings, nothing else, and answers the name as the id", async () => {
	const { vendor, host } = spritesOf();
	assert.deepEqual(await host.create(request({ labels: { agentrun: NAME, "agentrun-0": "abc" } }), CTX), { id: NAME });
	const [call] = vendor.calls;
	assert.deepEqual([call.method, call.path, call.body], ["POST", "/v1/sprites", { name: NAME, labels: [`agentrun=${NAME}`, "agentrun-0=abc"] }]);
	assert.deepEqual(vendor.sprites.get(NAME).sprite.labels, [`agentrun=${NAME}`, "agentrun-0=abc"]);
});

test("labels: the adapter's and the caller's go packed into strings of 64 bytes at most, and read back exactly through the provider's list", async () => {
	const { vendor, provider, host } = spritesOf();
	const labels = { ...LABELS, "agentrun.run": "run-1", "agentrun.epoch": "2", "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.network": "none", team: "x".repeat(200) };
	const packed = packLabels(labels, NAME, host.facts.labels);
	assert.equal(packed.problem, undefined);
	await host.create(request({ labels: packed.labels }), CTX);
	const stored = vendor.sprites.get(NAME).sprite.labels;
	assert.ok(stored.every((one) => Buffer.byteLength(one) <= 64 && /^[a-z0-9-]+=[A-Za-z0-9_-]*$/.test(one)), stored.join(" "));
	const listed = await provider.list({ "agentrun.run": "run-1" });
	assert.equal(listed.ok, true, JSON.stringify(listed.error));
	assert.deepEqual(listed.value.map((info) => [info.ref, info.labels]), [[{ id: NAME, name: NAME }, labels]]);
});

test("a create of a name the account holds is exists (unverified until the live run: Fly's 409); a rate cap is a limit; a token Fly refuses is denied, never echoed", async () => {
	const { host } = spritesOf();
	await host.create(request(), CTX);
	await assert.rejects(host.create(request(), CTX), (error) => error.code === "exists" && /409: sprite_exists: A sprite named computer-0123456789ab already exists/.test(error.message));
	const limited = spritesOf({ rateLimited: true }).host;
	await assert.rejects(limited.create(request(), CTX), (error) => error.code === "limit" && /sprite_creation_rate_limited/.test(error.message));
	const vendor = fakeSprites();
	const denied = new SpritesProvider({ token: "fake-test-key-other", fetch: vendor.fetch, webSocket: vendor.webSocket }).host;
	await assert.rejects(denied.list({}, CTX), (error) => error.code === "denied" && !error.message.includes("fake-test-key-other"));
});

test("get reads a sprite by name: running, warm and cold are running (an exec wakes one asleep); another status is stopped in Fly's words; a name Fly lacks is none", async () => {
	const { vendor, host } = spritesOf();
	await host.create(request(), CTX);
	const { sprite } = vendor.sprites.get(NAME);
	assert.deepEqual(await host.get(NAME, CTX), { id: NAME, labels: { agentrun: NAME }, state: "running", createdAt: new Date(sprite.created_at) });
	for (const [status, state] of Object.entries({ running: "running", warm: "running", cold: "running", destroying: "stopped" })) {
		sprite.status = status;
		const read = await host.get(NAME, CTX);
		assert.equal(read.state, state, status);
		if (status === "destroying") assert.equal(read.why, "Fly reads its status as destroying");
	}
	assert.equal(await host.get("computer-ffffffffffff", CTX), undefined);
});

test("list asks for the computers' name prefix, every page, and keeps only the sprites that carry the asked labels: a listing that answers more is filtered here", async () => {
	const { vendor, host } = spritesOf({ pageSize: 2 });
	for (let i = 0; i < 4; i++) await host.create(request({ name: `computer-00000000000${i}`, labels: { agentrun: `computer-00000000000${i}` } }), CTX);
	vendor.add("computer-other00000", ["agentrun=computer-other00000", "team=x"]);
	vendor.add("computer-unlabeled0");
	vendor.add("my-app", ["agentrun=computer-000000000002"]);
	const one = await host.list({ agentrun: "computer-000000000002" }, CTX);
	assert.deepEqual(one.map((machine) => machine.id), ["computer-000000000002", "computer-unlabeled0"], "ours, and one Fly listed with no labels, which get then judges");
	const pages = vendor.calls.filter((call) => call.path === "/v1/sprites" && call.method === "GET");
	assert.deepEqual(pages.map((call) => call.query.continuation_token), [undefined, "2", "4"]);
	assert.deepEqual(pages[0].query, { prefix: "computer-", max_results: "500" });
	assert.equal((await host.list({}, CTX)).length, 6, "every computer- sprite when no label is asked");
});

test("delete deletes by name and reads back as none; a name Fly no longer has is done; release deletes and waits for the readback", async () => {
	const { vendor, provider, host } = spritesOf();
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	await host.delete(NAME, CTX);
	assert.deepEqual([vendor.calls.at(-1).method, vendor.calls.at(-1).path], ["DELETE", `/v1/sprites/${NAME}`]);
	assert.equal(await host.get(NAME, CTX), undefined);
	await host.delete(NAME, CTX);
	await host.create(request({ labels: packLabels(LABELS, NAME, host.facts.labels).labels }), CTX);
	const released = await provider.release({ id: NAME, name: NAME }, "delete");
	assert.equal(released.ok, true, JSON.stringify(released.error));
	assert.equal(vendor.sprites.has(NAME), false);
	assert.equal(vendor.calls.at(-1).method, "GET", "the last call is the read-back after the delete");
});

test("exec opens the exec socket with argv as its cmd words, stdin on and a short run after a disconnect; stdin goes as 0x00 frames, end as 0x04; 0x01 and 0x02 are stdout and stderr, 0x03 the exit", async () => {
	const { vendor, host } = spritesOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat", "-"], CTX);
	const ws = vendor.calls.find((call) => call.method === "WS");
	assert.equal(ws.path, `/v1/sprites/${NAME}/exec`);
	assert.deepEqual(ws.query, { cmd: ["cat", "-"], path: "cat", stdin: "true", max_run_after_disconnect: "10s" });
	assert.ok(ws.url.startsWith("wss://api.sprites.dev/"), ws.url);
	assert.equal(vendor.sockets[0].binaryType, "arraybuffer");
	const session = await sessionOf(vendor);
	await proc.write(Buffer.from("héllo"));
	await proc.write(Buffer.from(" world"));
	await proc.end();
	assert.deepEqual([Buffer.concat(session.stdin).toString("utf8"), session.ended], ["héllo world", true]);
	session.out("stdout", "out ");
	session.out("stderr", "err");
	session.out("stdout", "more");
	session.exit(3);
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], ["out more", "err", 3]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(vendor.sockets[0].readyState, 3, "the socket closes once the exit is read");
});

test("a character split across two frames arrives whole, on stdout and on stderr", async () => {
	const { vendor, host } = spritesOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["cat"], CTX);
	const session = await sessionOf(vendor);
	const text = "é😀ü\r\nend";
	const bytes = Buffer.from(text, "utf8");
	session.out("stdout", bytes, { pieces: [...bytes].map(() => 1) });
	session.out("stderr", Buffer.from("😀"), { pieces: [1, 2, 1] });
	session.exit(0);
	assert.deepEqual([await textOf(proc.stdout), await textOf(proc.stderr), await proc.wait()], [text, "😀", 0]);
});

test("75 s of silence on the exec socket is no end: the process still runs, and the output after it comes, then the exit", async (t) => {
	const { vendor, host } = spritesOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sleep", "100"], CTX);
	const session = await sessionOf(vendor);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	let settled;
	proc.wait().then((code) => (settled = code), (error) => (settled = error));
	const out = textOf(proc.stdout);
	for (let at = 0; at < 75; at++) {
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(1_000);
	}
	assert.equal(settled, undefined, "the process still runs after 75 s of nothing");
	assert.equal(vendor.calls.filter((call) => call.method === "WS").length, 1, "one socket, never opened again");
	session.out("stdout", "late");
	session.exit(0);
	assert.equal(await out, "late");
	assert.equal(await proc.wait(), 0);
});

test("kill is the session's kill call, SIGKILL, by the id session_info named; then the socket closes", async () => {
	const { vendor, host } = spritesOf();
	await host.create(request(), CTX);
	const proc = await host.exec(NAME, ["sleep", "600"], CTX);
	const session = await sessionOf(vendor);
	await new Promise((resolve) => setImmediate(resolve));
	await proc.kill();
	const call = vendor.calls.at(-1);
	assert.deepEqual([call.method, call.path, call.query], ["POST", `/v1/sprites/${NAME}/exec/${session.id}/kill`, { signal: "SIGKILL" }]);
	assert.equal(session.killed, "SIGKILL");
	assert.deepEqual([vendor.sockets[0].readyState, vendor.sockets[0].closedWith], [3, 1000]);
});

test("an exec on a name Fly lacks is not_found: the socket never opens, and get says why", async () => {
	const { host } = spritesOf();
	await assert.rejects(host.exec("computer-ffffffffffff", ["true"], CTX), (error) => error.code === "not_found" && /no sprite computer-ffffffffffff/.test(error.message));
});

test("check takes Fly's own image alone and no size: another image, cpus or memoryMb is refused before any call", () => {
	const { vendor, provider } = spritesOf();
	const spec = { lifetimeMs: 600_000, network: "none" };
	assert.deepEqual(provider.check({ ...spec, image: "default" }), []);
	assert.deepEqual(provider.check(spec), []);
	assert.deepEqual(provider.check({ ...spec, image: "ghcr.io/parcha-ai/agentrun-box:abc" }).map((one) => one.field), ["image"]);
	assert.deepEqual(provider.check({ ...spec, image: "default", cpus: 2, memoryMb: 4096 }).map((one) => one.field), ["cpus", "memoryMb"]);
	assert.equal(vendor.calls.length, 0);
});

test("the exec passes every check of the exec pre-check, over real processes behind the exec socket's frames", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	t.after(() => local.stopAll());
	const { host } = spritesOf({ backend: local });
	await host.create(request(), CTX);
	const report = await checkExecStream(host, NAME, { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 });
	assert.equal(report.pass, true, formatExecStream(report));
});

test("the provider's Core conformance cases pass through the Sprites REST calls and exec socket, the daemon uploaded through stdin, and leave nothing behind", async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter((one) => one.group === "provider" && one.level === "core" && one.id !== "provider.deadline");
	const machines = fakeHost();
	const { vendor, provider } = spritesOf({ backend: machines.host }, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const report = await runConformance(provider, { image: "default", cases, caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
	assert.ok(report.results.length >= 3, report.results.map(({ id }) => id).join(" "));
	assert.deepEqual(
		report.results.filter(({ status }) => status !== "pass").map(({ id, status, reason }) => `${id} ${status}: ${reason}`),
		[],
	);
	assert.deepEqual(report.cleanup.sweep.stillThere, []);
	assert.equal(vendor.sprites.size, 0, "every sprite made was deleted");
	assert.ok(machines.uploads.length === 0 && vendor.calls.some((call) => call.method === "WS"), "the daemon went through the exec socket's stdin");
});

test("the conformance module reads COMPUTER_SPRITES_* alone, after its live switch; the sweep's host needs none and its scope never shows the token", async () => {
	assert.throws(() => settingsFromEnv({ SPRITES_TOKEN: TOKEN }), (error) => /set COMPUTER_SPRITES_TOKEN/.test(error.message) && !error.message.includes(TOKEN));
	const env = { [ENV.key]: TOKEN };
	assert.deepEqual(settingsFromEnv(env), { token: TOKEN });
	assert.deepEqual(settingsFromEnv({ ...env, [ENV.apiUrl]: "https://api.sprites.test" }), { token: TOKEN, apiUrl: "https://api.sprites.test" });
	await assert.rejects(createProvider({ env }), /set AGENTRUN_COMPUTER_LIVE_SPRITES=1/);
	assert.equal((await createProvider({ env: { ...env, [ENV.live]: "1" } })).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal((await createHost({ env })).descriptor.id, "sprites");
	assert.equal(await conformanceImage({ env: {} }), "default");
	assert.match(sweepScope({ env }), /the Sprites org of the token sha256:[0-9a-f]{12} at https:\/\/api\.sprites\.dev/);
	assert.doesNotMatch(sweepScope({ env }), new RegExp(TOKEN));
	assert.equal((await create({ token: TOKEN })).host.descriptor.label, "Fly Sprites");
});
