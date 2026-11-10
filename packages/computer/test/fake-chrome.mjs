// A stand-in for Chrome, for the local browser's tests (local-provider.test.mjs): started as Chrome is, with the
// arguments the supervisor gives, it serves /json/version and a DevTools websocket on a loopback port it picks, writes
// that port to the profile's DevToolsActivePort as Chrome does, and answers every CDP command with an empty result. It
// writes the arguments it was given to argv.json in its profile, and, given a proxy, asks it for a cloud's metadata
// address and for its own loopback port, writing each status line to probe.json, so a test reads what the fence did.
// FAKE_CHROME_MODE: "sandbox" exits as a Chrome that cannot start its sandbox does; anything else starts.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = process.env.FAKE_CHROME_MODE ?? "ok";

if (mode === "sandbox") {
	process.stderr.write("[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see the docs; or run with --no-sandbox.\n");
	process.exit(1);
}
if (args.includes("--dump-dom")) {
	process.stdout.write("<html><head></head><body></body></html>\n");
	process.exit(0);
}

const profile = flag("user-data-dir");
writeFileSync(join(profile, "argv.json"), JSON.stringify(args));
const path = `/devtools/browser/${randomUUID()}`;

/** One text frame, unmasked, as a server sends it. */
function frame(text) {
	const body = Buffer.from(text);
	const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
	return Buffer.concat([head, body]);
}

const server = createServer((req, res) => {
	if (req.url === "/json/version") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${path}` })); // key-gate: loopback-rule a test's fake Chrome on loopback
		return;
	}
	res.statusCode = 404;
	res.end();
});
server.on("upgrade", (req, socket) => {
	if (req.url !== path) return socket.destroy();
	const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	let held = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		held = Buffer.concat([held, chunk]);
		while (held.length >= 6) {
			const opcode = held[0] & 0x0f;
			let length = held[1] & 0x7f;
			let at = 2;
			if (length === 126) {
				length = held.readUInt16BE(2);
				at = 4;
			}
			if (held.length < at + 4 + length) return;
			const mask = held.subarray(at, at + 4);
			const body = Buffer.from(held.subarray(at + 4, at + 4 + length)).map((byte, i) => byte ^ mask[i % 4]);
			held = held.subarray(at + 4 + length);
			if (opcode === 8) return socket.end();
			if (opcode !== 1) continue;
			const message = JSON.parse(body.toString("utf8"));
			socket.write(frame(JSON.stringify({ id: message.id, result: message.method === "Browser.getVersion" ? { product: "FakeChrome/1.0" } : {} })));
		}
	});
	socket.on("error", () => undefined);
});

/** The proxy's status line for a CONNECT to target. */
function through(proxy, target) {
	return new Promise((done) => {
		const { hostname, port } = new URL(proxy);
		const socket = connect(Number(port), hostname, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk;
			if (text.includes("\r\n")) {
				done(text.split("\r\n")[0]);
				socket.destroy();
			}
		});
		socket.on("error", (error) => done(`error ${error.code}`));
		setTimeout(() => {
			done("no answer");
			socket.destroy();
		}, 5_000);
	});
}

server.listen(0, "127.0.0.1", async () => { // key-gate: loopback-rule a test's fake Chrome on loopback
	const { port } = server.address();
	const proxy = flag("proxy-server");
	if (proxy) {
		const probe = { metadata: await through(proxy, "169.254.169.254:80"), loopback: await through(proxy, `127.0.0.1:${port}`) }; // key-gate: denylist a refused test target
		writeFileSync(join(profile, "probe.json"), JSON.stringify(probe));
	}
	writeFileSync(join(profile, "DevToolsActivePort"), `${port}\n${path}`);
});
