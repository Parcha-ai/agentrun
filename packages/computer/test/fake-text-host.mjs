// A text-only vendor whose exec comes in pieces, as a REST API's does, and the hosts a vendor writes over it with
// framedExec (src/hosted/framed-exec.ts) and the REST client (src/hosted/rest.ts). The vendor is an HTTP server on
// loopback: POST /machines/:id/processes {argv} starts a process and answers {id}; GET /processes/:id/events streams its
// events as NDJSON, {stream, text} then {exit}, from its start; POST /processes/:id/stdin {text} is one write. Output
// is text in JSON strings (decoded as UTF-8, as a vendor's are), and there is no end of stdin and no kill.
//
// Beside it, Hyperbrowser's process API, whose events are server-sent events of the output's bytes:
// POST /machines/:id/sandbox/processes {command} runs the sh command and answers its stream, `event: started` with
// `data: {id, pid}`, then `event: output` with `data: {seq, stream, encoding: "base64", data}`, where stream is stdout,
// stderr or the runtime's own `system` lines, then `event: done` with `data: {exit_code, last_seq, output_truncated}`,
// and a `: keepalive` comment each 500 ms of none (Hyperbrowser's is each 15 s). POST /sandbox/processes/:id/stdin
// {data, encoding: "base64", eof} is one write, or the end of stdin; DELETE /sandbox/processes/:id kills it.
//
// The processes behind the server are another MachineHost's exec: fake-exec-host.mjs's, real processes on this machine,
// for the exec pre-check; or fake-host.mjs's machines in memory, for the adapter's create, under withSh, which plays the
// sh the pid wrapper and the kill need.
import { createServer } from "node:http";
import { framedExec, PID_KILL, PID_WRAPPER } from "../dist/hosted/framed-exec.js";
import { orThrow } from "../dist/hosted/process.js";
import { ndjson, rest, sse } from "../dist/hosted/rest.js";

/** A process's events written to res as they come, each by `line`, until its exit; `idle` is written each 500 ms of none. */
async function streamTo(res, record, line, idle) {
	const timer = idle === undefined ? undefined : setInterval(() => record.wake(), 500);
	try {
		for (let at = 0; ; ) {
			if (at === record.events.length && idle !== undefined) res.write(idle);
			while (at < record.events.length) res.write(line(record.events[at], at++));
			if (record.ended || res.destroyed) break;
			await new Promise((done) => (record.wake = done));
		}
	} finally {
		clearInterval(timer);
	}
	res.end();
}

/** One server-sent event of a Hyperbrowser-shaped stream, the at-th of the process's events. */
const hyperbrowserEvent = (event, at) =>
	"exit" in event
		? `event: done\ndata: ${JSON.stringify({ exit_code: event.exit, last_seq: at - 1, output_truncated: false })}\n\n`
		: `event: output\ndata: ${JSON.stringify({ seq: at, stream: event.stream, encoding: "base64", data: Buffer.from(event.bytes).toString("base64") })}\n\n`;

/** argv as one sh command that runs it in the sh's place, so the vendor's kill reaches it. */
const commandOf = (argv) => `exec ${argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ")}`;

/** The vendor: a server over backend.exec. Answers its base URL, the requests it took, and close(). */
export async function textVendor(backend) {
	const processes = new Map();
	const requests = [];
	let next = 0;
	const body = async (req) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString("utf8");
		return text === "" ? {} : JSON.parse(text);
	};
	/** A process's events as they come, kept from its start for the stream that reads them; `bytes` keeps output as bytes. */
	const recordOf = (proc, bytes = false) => {
		const record = { proc, events: [], ended: false, wake: () => {} };
		const add = (event) => {
			record.events.push(event);
			record.wake();
		};
		const pump = async (stream, name) => {
			const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
			for await (const chunk of stream) {
				if (bytes) {
					add({ stream: name, bytes: chunk });
					continue;
				}
				const text = decoder.decode(chunk, { stream: true });
				if (text !== "") add({ stream: name, text });
			}
			const rest = decoder.decode();
			if (rest !== "") add({ stream: name, text: rest });
		};
		void Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])
			.then(() => proc.wait())
			.then((code) => {
				record.ended = true;
				add({ exit: code });
			});
		return record;
	};
	const server = createServer(async (req, res) => {
		const { pathname } = new URL(req.url, "http://vendor");
		requests.push(`${req.method} ${pathname}`);
		const started = /^\/machines\/([^/]+)\/processes$/.exec(pathname);
		const events = /^\/processes\/(\d+)\/events$/.exec(pathname);
		const stdin = /^\/processes\/(\d+)\/stdin$/.exec(pathname);
		const sandbox = /^\/machines\/([^/]+)\/sandbox\/processes$/.exec(pathname);
		const one = /^\/sandbox\/processes\/(\d+)(\/stdin)?$/.exec(pathname);
		try {
			if (req.method === "POST" && started) {
				const { argv } = await body(req);
				const proc = await backend.exec(started[1], argv, { timeoutMs: 10_000 });
				const id = String(++next);
				processes.set(id, recordOf(proc));
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
			} else if (req.method === "GET" && events && processes.has(events[1])) {
				res.writeHead(200, { "Content-Type": "application/x-ndjson" });
				await streamTo(res, processes.get(events[1]), (event) => `${JSON.stringify(event)}\n`);
			} else if (req.method === "POST" && sandbox) {
				const { command } = await body(req);
				const record = recordOf(await backend.exec(sandbox[1], ["sh", "-c", command], { timeoutMs: 10_000 }), true);
				const id = String(++next);
				processes.set(id, record);
				record.events.unshift({ stream: "system", bytes: Buffer.from(`process ${id} started\n`) });
				res.writeHead(200, { "Content-Type": "text/event-stream" }).write(`event: started\ndata: ${JSON.stringify({ id, pid: 4000 + next })}\n\n`);
				await streamTo(res, record, hyperbrowserEvent, ": keepalive\n\n");
			} else if (req.method === "POST" && one?.[2] && processes.has(one[1])) {
				const { data, eof } = await body(req);
				const record = processes.get(one[1]);
				if (record.ended) res.writeHead(409).end("the process has ended");
				else {
					if (data) await record.proc.write(new Uint8Array(Buffer.from(data, "base64")));
					if (eof) await record.proc.end();
					res.writeHead(204).end();
				}
			} else if (req.method === "DELETE" && one && !one[2] && processes.has(one[1])) {
				await processes.get(one[1]).proc.kill();
				res.writeHead(204).end();
			} else if (req.method === "POST" && stdin && processes.has(stdin[1])) {
				const { text } = await body(req);
				const record = processes.get(stdin[1]);
				if (record.ended) res.writeHead(409).end("the process has ended");
				else {
					await record.proc.write(new Uint8Array(Buffer.from(text, "utf8")));
					res.writeHead(204).end();
				}
			} else res.writeHead(404).end(`no ${req.method} ${pathname}`);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500).end(String(error?.message ?? error));
		}
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(done);
			}),
	};
}

/** The host's exec over the vendor, as a vendor writes it: three calls, framedExec does the rest. */
export function textExec(base) {
	const api = rest({ base, headers: () => ({}), vendor: "fake-text", timeoutMs: 10_000 });
	return (id, argv, ctx) =>
		framedExec(
			{
				start: async (argv, ctx) => orThrow(await api.json("POST", api.url(`/machines/${id}/processes`), { json: { argv }, timeoutMs: ctx.timeoutMs }, ctx.signal)).id,
				events: async function* (pid) {
					for await (const event of ndjson(orThrow(await api.stream("GET", api.url(`/processes/${pid}/events`))).body)) yield event;
				},
				write: async (pid, text) => void orThrow(await api.call("POST", api.url(`/processes/${pid}/stdin`), { json: { text } })),
			},
			argv,
			ctx,
		);
}

/**
 * The host's exec over the vendor's Hyperbrowser-shaped process API, as PROVIDERS.md's example writes it: start reads
 * the stream up to `started` for the id, events goes on with the same stream, base64 output as it is and the runtime's
 * `system` lines dropped.
 */
export function sseExec(base) {
	const api = rest({ base, headers: () => ({}), vendor: "fake-hyperbrowser", timeoutMs: 10_000 });
	const stdin = (id, json) => api.call("POST", api.url(`/sandbox/processes/${id}/stdin`), { json });
	return (machine, argv, ctx) =>
		framedExec(
			{
				async start(argv, ctx) {
					const body = orThrow(await api.stream("POST", api.url(`/machines/${machine}/sandbox/processes`), { json: { command: commandOf(argv) }, timeoutMs: ctx.timeoutMs }, ctx.signal)).body;
					const stream = sse(body);
					const first = await stream.next();
					if (first.done || first.value.event !== "started") throw new Error("the process's stream ended before it started");
					return { id: JSON.parse(first.value.data).id, stream };
				},
				async *events({ stream }) {
					for await (const { event, data } of stream) {
						const value = JSON.parse(data);
						if (event === "done") yield { exit: value.exit_code };
						else if (event === "output" && value.stream !== "system") yield { stream: value.stream, base64: value.data };
					}
				},
				write: async ({ id }, text) => void orThrow(await stdin(id, { data: Buffer.from(text).toString("base64"), encoding: "base64" })),
				end: async ({ id }) => void orThrow(await stdin(id, { eof: true })),
				kill: async ({ id }) => void orThrow(await api.call("DELETE", api.url(`/sandbox/processes/${id}`))),
			},
			argv,
			ctx,
		);
}

/**
 * fake-host.mjs's exec with the sh framedExec's pid wrapper and its kill need, which its machines in memory have none
 * of: the wrapper runs argv with a pid and start time of its own first on stderr, and the kill script kills the process
 * with that pid while its start time matches.
 */
export function withSh(host) {
	const running = new Map();
	let pids = 1000;
	return async (id, argv, ctx) => {
		if (argv[0] === "sh" && argv[2] === PID_KILL) {
			const [pid, start] = argv.slice(4);
			if (running.get(pid)?.start === start) await running.get(pid).proc.kill();
			const none = async function* () {};
			return { stdout: none(), stderr: none(), write: async () => {}, end: async () => {}, wait: async () => 0, kill: async () => {} };
		}
		if (argv[0] !== "sh" || argv[2] !== PID_WRAPPER[2]) return host.exec(id, argv, ctx);
		const proc = await host.exec(id, argv.slice(4), ctx);
		const pid = String(++pids);
		const start = String(5_000 + pids);
		running.set(pid, { proc, start });
		void proc.wait().then(() => running.delete(pid));
		return {
			...proc,
			stderr: (async function* () {
				yield new Uint8Array(Buffer.from(`${pid} ${start}\n`));
				yield* proc.stderr;
			})(),
		};
	};
}
