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

import { fakePhoneHarness, KEY } from "./fake-phone-harness.mjs";

const { adbCli, ADB_SERVER_PORT } = await import("../dist/phone-harness.js");
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
				const length = Number.parseInt(buffer.subarray(0, 4).toString("latin1"), 16);
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
/** A stand-in adb that records the names of the adb variables it was given (and one unrelated one), then exits code. */
function envRecorder(name, code = 0) {
	const log = join(dir, `${name}.log`);
	const script = join(dir, name);
	writeFileSync(
		script,
		`#!${process.execPath}\nconst names = Object.keys(process.env).filter((n) => /ADB|ANDROID_SERIAL|AGENTRUN_|COMPUTER_PHONE_HARNESS/.test(n)).sort();\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(names));\nprocess.exit(${code});\n`,
	);
	chmodSync(script, 0o755);
	return { script, names: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("adbCli spawns adb from the environment it is given, with every ADB_*, ANDROID_ADB_* and ANDROID_SERIAL variable dropped", async () => {
	const adb = envRecorder("adb-env");
	const ran = await adbCli(adb.script, { env: { ...POISON, PATH: process.env.PATH, AGENTRUN_UNRELATED: "kept" } }).run(["-t", "1", "shell", "echo ok"], { timeoutMs: 10_000 });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.deepEqual(adb.names(), ["AGENTRUN_UNRELATED"], "every adb variable is dropped, and the rest of the environment is kept");
});

test("the conformance module's provider spawns adb from its environment with every adb variable and its own settings dropped: the API key never reaches adb", async () => {
	// The adb exits 1 at start-server, so connect stops there, before any socket: no adb server is asked.
	const adb = envRecorder("adb-conformance", 1);
	const fake = fakePhoneHarness();
	const env = {
		...POISON,
		PATH: process.env.PATH,
		AGENTRUN_UNRELATED: "kept",
		COMPUTER_PHONE_HARNESS_API_KEY: KEY,
		COMPUTER_PHONE_HARNESS_ADB: adb.script,
		COMPUTER_PHONE_HARNESS_LEDGER: join(dir, "conformance-ledger.json"),
		AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1",
	};
	const provider = await conformance.createProvider({ env, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep });
	const created = await provider.create({ image: "android", lifetimeMs: 60_000, network: "open" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const connected = await provider.connect(created.value);
	assert.equal(connected.ok, false);
	assert.match(connected.error.message, /adb start-server failed/);
	assert.deepEqual(adb.names(), ["AGENTRUN_UNRELATED"], "no adb variable, and none of the module's own (the key among them)");
	await provider.release(created.value, "delete");
});
