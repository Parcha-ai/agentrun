// adbCli, the phone provider's real adb transport, on a port other than adb's default. A stand-in adb CLI (a script
// that records its argv) and a stand-in adb server (a loopback socket on a port the system picks, port 0, so no test
// races another for it) show that every spawned adb names the same server the socket requests go to. No wall-clock
// wait: each call is awaited to its end.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { fakePhoneHarness, KEY, PHONED_JAR } from "./fake-phone-harness.mjs";

const { adbCli, ADB_SERVER_PORT, create } = await import("../dist/phone-harness.js");
const { ADB_ENV_NAMES } = await import("../dist/child-env.js");
const conformance = await import("../dist/conformance/phone-harness.js");

const dir = mkdtempSync(join(tmpdir(), "computer-adb-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in adb server: it answers every request OKAY with an empty message, and records each one. */
async function adbServer() {
	const requests = [];
	const server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const head = buffer.subarray(0, 4).toString("latin1");
				// A peer that is not adb (another process on the box probing a new loopback port): its bytes frame nothing.
				if (!/^[0-9a-f]{4}$/i.test(head)) return void socket.destroy();
				const length = Number.parseInt(head, 16);
				if (buffer.length < 4 + length) return;
				requests.push(buffer.subarray(4, 4 + length).toString("utf8"));
				buffer = buffer.subarray(4 + length);
				socket.end("OKAY0000");
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("adbCli on another port: every spawned adb names that port with -P, as every socket request reaches it", async () => {
	const server = await adbServer();
	try {
		assert.notEqual(server.port, ADB_SERVER_PORT, "the stand-in server is not on adb's default port");
		// The stand-in adb CLI: its argv, one JSON line per run.
		const log = join(dir, "argv.log");
		const script = join(dir, "adb");
		writeFileSync(script, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
		chmodSync(script, 0o755);
		const adb = adbCli(script, { port: server.port });
		const listed = await adb.server("host:devices-l", { timeoutMs: 10_000 });
		assert.equal(listed.ok, true, JSON.stringify(listed));
		const ran = await adb.run(["-t", "1", "shell", "echo ok"], { timeoutMs: 10_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		assert.deepEqual(server.requests, ["host:devices-l"], "the socket request reached the server on that port");
		const argvs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const P = ["-P", String(server.port)];
		assert.deepEqual(argvs, [
			[...P, "start-server"],
			[...P, "-t", "1", "shell", "echo ok"],
		]);
	} finally {
		await server.close();
	}
});

/**
 * A stand-in adb server for open(): host:transport-id:7 binds the socket to its phone (OKAY) and any other id is
 * FAIL with words; then a service is OKAY, and the stream that follows is the phone program's: its first line comes in
 * the same chunk as the OKAY, and every line written to it comes back.
 */
async function streamServer() {
	const requests = [];
	const frame = (status, words) => `${status}${Buffer.byteLength(words).toString(16).padStart(4, "0")}${words}`;
	const server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		let streaming = false;
		socket.on("data", (chunk) => {
			if (streaming) return void socket.write(chunk);
			buffer = Buffer.concat([buffer, chunk]);
			while (!streaming && buffer.length >= 4) {
				const length = Number.parseInt(buffer.subarray(0, 4).toString("latin1"), 16);
				if (buffer.length < 4 + length) return;
				const request = buffer.subarray(4, 4 + length).toString("utf8");
				buffer = buffer.subarray(4 + length);
				requests.push(request);
				if (request.startsWith("host:transport-id:")) {
					if (request === "host:transport-id:7") socket.write("OKAY");
					else socket.end(frame("FAIL", `device '${request.slice(18)}' not found`));
				} else {
					streaming = true;
					socket.write("OKAY{\"first\":true}\n");
				}
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("adbCli.open binds a socket to the phone, starts the service, and hands over its stream paused, with nothing of it lost", async () => {
	const server = await streamServer();
	try {
		const script = join(dir, "adb-open");
		writeFileSync(script, `#!${process.execPath}\n`);
		chmodSync(script, 0o755);
		const adb = adbCli(script, { port: server.port });
		const opened = await adb.open("exec:cat", { timeoutMs: 10_000, transport: "7" });
		assert.equal(opened.ok, true, JSON.stringify(opened));
		const stream = opened.value;
		assert.equal(stream.isPaused(), true, "it comes paused: the caller listens first");
		assert.deepEqual(server.requests, ["host:transport-id:7", "exec:cat"]);
		const lines = [];
		let resolveTwo;
		const two = new Promise((resolve) => (resolveTwo = resolve));
		stream.on("data", (chunk) => {
			lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
			if (lines.length >= 2) resolveTwo();
		});
		stream.resume();
		stream.write("{\"echo\":1}\n");
		await two;
		assert.deepEqual(lines, ['{"first":true}', '{"echo":1}'], "the bytes after the OKAY are the stream's first, then its echo");
		stream.destroy();

		const refused = await adb.open("exec:cat", { timeoutMs: 10_000, transport: "9" });
		assert.equal(refused.ok, false);
		assert.deepEqual([refused.error.code, refused.error.message], ["vendor", "the adb server refused host:transport-id:9: device '9' not found"]);
	} finally {
		await server.close();
	}
});

test("adbCli on adb's default port names it too: the CLI would follow ANDROID_ADB_SERVER_PORT, the socket requests would not", async () => {
	const log = join(dir, "argv-default.log");
	const script = join(dir, "adb-default");
	writeFileSync(script, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	chmodSync(script, 0o755);
	const ran = await adbCli(script).run(["-t", "1", "shell", "echo ok"], { timeoutMs: 10_000 });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["-P", String(ADB_SERVER_PORT), "-t", "1", "shell", "echo ok"]);
});

/** A poisoned environment: each of these could send a spawned adb to another server or device than the provider's. */
const POISON = {
	ADB_SERVER_SOCKET: "tcp:203.0.113.7:5037",
	ANDROID_ADB_SERVER_SOCKET: "tcp:203.0.113.7:5037",
	ANDROID_ADB_SERVER_ADDRESS: "203.0.113.7",
	ANDROID_ADB_SERVER_PORT: "1",
	ANDROID_SERIAL: "another-device",
	ADB_VENDOR_KEYS: "/elsewhere",
};
/**
 * A stand-in adb that records the name of every variable it was given, then exits code. Each test hands the spawn an
 * environment of its own, so the record is exactly the cleaned input: nothing of the test runner's environment (CI sets
 * its own AGENTRUN_* names) reaches it, and the assertion reads none of it.
 */
function envRecorder(name, code = 0) {
	const log = join(dir, `${name}.log`);
	const script = join(dir, name);
	writeFileSync(script, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(Object.keys(process.env).sort()));\nprocess.exit(${code});\n`);
	chmodSync(script, 0o755);
	return { script, names: () => JSON.parse(readFileSync(log, "utf8")) };
}
/** The names a spawned adb keeps of an input: those adb reads (ADB_ENV_NAMES), and nothing else. */
const kept = (input) => Object.keys(input).filter((name) => ADB_ENV_NAMES.includes(name)).sort();
/** Names no adb is given: a key-shaped one, and a setting adb never reads. */
const UNLISTED = { FOO_API_KEY: `not-a-secret-${"canary"}`, AGENTRUN_UNRELATED: "dropped" };

test("adbCli spawns adb with what adb reads of the environment it is given alone: no key, no other name, and no ADB_*, ANDROID_ADB_* or ANDROID_SERIAL variable", async () => {
	const adb = envRecorder("adb-env");
	const env = { ...POISON, ...UNLISTED, LANG: "C", ANDROID_HOME: "/opt/android-sdk" };
	const ran = await adbCli(adb.script, { env }).run(["-t", "1", "shell", "echo ok"], { timeoutMs: 10_000 });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.deepEqual(adb.names(), kept(env), "exactly what adb reads of the input");
	assert.deepEqual(kept(env), ["ANDROID_HOME", "LANG"]);
});

test("given no env, adbCli spawns adb with none of this process's environment", async () => {
	const adb = envRecorder("adb-no-env");
	const ran = await adbCli(adb.script).run(["-t", "1", "shell", "echo ok"], { timeoutMs: 10_000 });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.deepEqual(adb.names(), [], "no env: adb was started with this process's environment");
});

test("the provider, its adb given as a path, spawns that adb with what adb reads of the provider's env alone: never a key", async () => {
	// The adb exits 1 at start-server, so connect stops there, before any socket: no adb server is asked.
	const adb = envRecorder("adb-provider", 1);
	const fake = fakePhoneHarness();
	const env = { ...POISON, ...UNLISTED, LANG: "C", ANDROID_SDK_ROOT: "/opt/android-sdk" };
	const provider = await create({ apiKey: KEY, adb: adb.script, env, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep });
	const created = await provider.create({ image: "android", lifetimeMs: 60_000, network: "open" }, { requestId: "adb-provider" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const connected = await provider.connect(created.value);
	assert.match(connected.error?.message ?? "", /adb start-server failed/);
	assert.deepEqual(adb.names(), ["ANDROID_SDK_ROOT", "LANG"], "the provider's adb gets exactly what adb reads of its env");
	await provider.release(created.value, "delete");
});

test("the conformance module's provider spawns adb with what adb reads of its environment alone: the API key, every adb variable and the module's own settings never reach adb", async () => {
	// The adb exits 1 at start-server, so connect stops there, before any socket: no adb server is asked.
	const adb = envRecorder("adb-conformance", 1);
	const fake = fakePhoneHarness();
	const env = {
		...POISON,
		...UNLISTED,
		LANG: "C",
		COMPUTER_PHONE_HARNESS_API_KEY: KEY,
		COMPUTER_PHONE_HARNESS_ADB: adb.script,
		COMPUTER_PHONE_HARNESS_LEDGER: join(dir, "conformance-ledger.json"),
		AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1",
	};
	const provider = await conformance.createProvider({ env, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep });
	const created = await provider.create({ image: "android", lifetimeMs: 60_000, network: "open" }, { requestId: "adb-conformance" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const connected = await provider.connect(created.value);
	assert.equal(connected.ok, false);
	assert.match(connected.error.message, /adb start-server failed/);
	assert.deepEqual(adb.names(), ["LANG"], "what adb reads of the input alone: no adb variable, none of the module's own (the key among them), no other name");
	await provider.release(created.value, "delete");
});

test("the conformance module's adb option, given as a path, spawns that adb with the same names alone", async () => {
	// The module's environment holds every adb variable and its own settings, the key among them; adb comes as a path.
	const adb = envRecorder("adb-option", 1);
	const fake = fakePhoneHarness();
	const env = {
		...POISON,
		...UNLISTED,
		LANG: "C",
		COMPUTER_PHONE_HARNESS_API_KEY: KEY,
		COMPUTER_PHONE_HARNESS_LEDGER: join(dir, "option-ledger.json"),
		AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1",
	};
	const provider = await conformance.createProvider({ env, adb: adb.script, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep });
	const created = await provider.create({ image: "android", lifetimeMs: 60_000, network: "open" }, { requestId: "adb-option" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const connected = await provider.connect(created.value);
	assert.match(connected.error?.message ?? "", /adb start-server failed/);
	assert.deepEqual(adb.names(), ["LANG"], "the path given as the adb option gets what adb reads of the input alone: no adb variable, not the key");
	await provider.release(created.value, "delete");
});

test("the conformance module's adb option, given as a transport, is used as it is", async () => {
	const fake = fakePhoneHarness();
	const env = { COMPUTER_PHONE_HARNESS_API_KEY: KEY, COMPUTER_PHONE_HARNESS_LEDGER: join(dir, "transport-ledger.json"), AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1" };
	const provider = await conformance.createProvider({ env, adb: fake.adb, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep, phoned: PHONED_JAR });
	const created = await provider.create({ image: "android", lifetimeMs: 60_000, network: "open" }, { requestId: "adb-transport" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const connected = await provider.connect(created.value);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.equal(fake.running().length, 1, "the given transport started phoned too");
	assert.ok(fake.serverCalls().some((call) => call.startsWith("host:connect:")), "the given transport carried the connect");
	await connected.value.close();
	await provider.release(created.value, "delete");
});
