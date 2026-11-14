// A stand-in for E2B's envd Process service, enough of it for the real e2b SDK's Connect client to start, feed, close
// and kill a process: Start (server streaming, application/connect+json), SendInput, CloseStdin and SendSignal (unary,
// application/json), as envd's process.proto defines them (the SDK's process_pb, e2b@2.63.0 index.mjs:1721). Each
// Start runs its command line on this machine with bash -c (never a login shell), on pipes, and streams its output as
// envd does: a start event with the pid, data events carrying the bytes read (base64 in Connect's JSON), and an end
// event with the exit code. A client that lets go of the stream leaves the process running, as envd does.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

/** One Connect envelope: a flags byte, the length (big-endian), the JSON. */
function envelope(flags, message) {
	const body = Buffer.from(JSON.stringify(message));
	const head = Buffer.alloc(5);
	head.writeUInt8(flags, 0);
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

const readBody = (req) =>
	new Promise((done, fail) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => done(Buffer.concat(chunks)));
		req.on("error", fail);
	});

/** envd on 127.0.0.1: url, every request it took ({ method, headers, body }), and close(), which kills what it started. */
export async function fakeEnvd() {
	const children = new Map();
	/** Every process group a Start made. */
	const groups = new Set();
	const requests = [];
	const unary = (res, status, message) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(message));
	};
	const server = createServer(async (req, res) => {
		const method = req.url?.replace(/^\/process\.Process\//, "") ?? "";
		const raw = await readBody(req);
		if (method === "Start") {
			const body = JSON.parse(raw.subarray(5).toString("utf8"));
			requests.push({ method, headers: req.headers, body });
			const line = body.process?.args?.[2];
			// bash -c, as envd's /bin/bash -l -c but no login: a line that is one command is exec'd, so the pid is its own.
			// Its own process group, so close() ends whatever it started.
			const child = spawn("bash", ["-c", line], { stdio: [body.stdin ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
			groups.add(child.pid);
			children.set(child.pid, child);
			res.writeHead(200, { "content-type": "application/connect+json" });
			res.on("error", () => {});
			const send = (message) => {
				if (!res.writableEnded && !res.destroyed) res.write(envelope(0, message));
			};
			send({ event: { start: { pid: child.pid } } });
			child.stdout.on("data", (chunk) => send({ event: { data: { stdout: chunk.toString("base64") } } }));
			child.stderr.on("data", (chunk) => send({ event: { data: { stderr: chunk.toString("base64") } } }));
			child.on("close", (code, signal) => {
				children.delete(child.pid);
				if (res.writableEnded || res.destroyed) return;
				res.write(envelope(0, { event: { end: { exitCode: code ?? -1, exited: signal === null, status: signal ? `signal: ${signal}` : `exit status ${code}` } } }));
				res.end(envelope(2, {}));
			});
			return;
		}
		const body = JSON.parse(raw.toString("utf8") || "{}");
		requests.push({ method, headers: req.headers, body });
		const child = children.get(body.process?.pid);
		if (child === undefined) return unary(res, 404, { code: "not_found", message: `process ${body.process?.pid} not found` });
		if (method === "SendInput") {
			child.stdin.write(Buffer.from(body.input?.stdin ?? "", "base64"), () => unary(res, 200, {}));
		} else if (method === "CloseStdin") {
			// A command that exited first has a closed pipe, whose end() never calls back: answered at once, as envd does.
			let answered = false;
			const done = () => {
				if (!answered) unary(res, 200, {});
				answered = true;
			};
			if (child.stdin.destroyed || child.stdin.writableFinished) return done();
			child.stdin.once("close", done).once("error", done);
			child.stdin.end(done);
		} else if (method === "SendSignal") {
			child.kill(body.signal === "SIGNAL_SIGTERM" ? "SIGTERM" : "SIGKILL");
			unary(res, 200, {});
		} else unary(res, 501, { code: "unimplemented", message: `${method} is not in this fake` });
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		async close() {
			for (const pid of groups) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// The group has ended.
				}
			}
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		},
	};
}
