// adbCli, the phone provider's real adb transport, on a port other than adb's default. A stand-in adb CLI (a script
// that records its argv) and a stand-in adb server (a loopback socket on a port the system picks, port 0, so no test
// races another for it) show that every spawned adb names the same server the socket requests go to. No wall-clock
// wait: each call is awaited to its end.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { adbCli, ADB_SERVER_PORT } = await import("../dist/phone-harness.js");

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
				// adb's framing is four hex digits of length: anything else is not an adb client, and its connection ends.
				const head = buffer.subarray(0, 4).toString("latin1");
				if (!/^[0-9a-fA-F]{4}$/.test(head)) return void socket.destroy();
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

test("the stand-in adb server closes a connection whose length is not four hex digits, and takes nothing from it: a stray client never makes it loop", { timeout: 10_000 }, async () => {
	// Another process may reach the stand-in's port (one it used before, now the system's to give again) with bytes that
	// are not adb's framing. The stand-in must end that connection, not read a NaN length forever until the heap runs out.
	const server = await adbServer();
	try {
		const ended = await new Promise((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port: server.port });
			socket.on("connect", () => socket.write("GET / HTTP/1.1\r\n\r\n"));
			socket.on("close", () => resolve("closed"));
			socket.on("error", reject);
		});
		assert.equal(ended, "closed");
		assert.deepEqual(server.requests, [], "nothing taken as a request");
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
