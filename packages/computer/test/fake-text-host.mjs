// A text-only vendor whose exec comes in pieces, as a REST API's does, and the hosts a vendor writes over it with
// framedExec (src/hosted/framed-exec.ts) and the REST client (src/hosted/rest.ts). The vendor is an HTTP server on
// loopback: POST /machines/:id/processes {argv} starts a process and answers {id}; GET /processes/:id/events streams its
// events as NDJSON, {stream, text} then {exit}, from its start; POST /processes/:id/stdin {text} is one write. Output
// is text in JSON strings (decoded as UTF-8, as a vendor's are), and there is no end of stdin and no kill.
// The same events come as server-sent events two more ways:
//  - GET /processes/:id/sse, as Together's: `id: <n>` and `data: {type, output}`, then `event: exit` with
//    `data: {exitCode}`, a `retry:` first and a `: keep-alive` comment each 500 ms;
//  - POST /machines/:id/runs {argv}, as Render's: the process starts and the answer is its stream, `event: output` with
//    `data: {stream, data}`, then `event: exit` with `data: {exit_code}`. Such a process has no id, so no write reaches it.
//
// The processes behind the server are another MachineHost's exec: fake-exec-host.mjs's, real processes on this machine,
// for the exec pre-check; or fake-host.mjs's machines in memory, for the adapter's create, under withSh, which plays the
// sh the pid wrapper and the kill need.
import { createServer } from "node:http";
import { fifoStdin, framedExec, PID_KILL, PID_WRAPPER } from "../dist/hosted/framed-exec.js";
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

/** One server-sent event of a Together-shaped stream, numbered. */
const togetherEvent = (event, at) =>
	"exit" in event ? `id: ${at}\nevent: exit\ndata: ${JSON.stringify({ exitCode: event.exit })}\n\n` : `id: ${at}\ndata: ${JSON.stringify({ type: event.stream, output: event.text })}\n\n`;
/** One server-sent event of a Render-shaped stream. */
const renderEvent = (event) => ("exit" in event ? `event: exit\ndata: ${JSON.stringify({ exit_code: event.exit })}\n\n` : `event: output\ndata: ${JSON.stringify({ stream: event.stream, data: event.text })}\n\n`);

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
	/** A process's events as they come, kept from its start for the stream that reads them. */
	const recordOf = (proc) => {
		const record = { proc, events: [], ended: false, wake: () => {} };
		const add = (event) => {
			record.events.push(event);
			record.wake();
		};
		const pump = async (stream, name) => {
			const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
			for await (const chunk of stream) {
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
		const run = /^\/machines\/([^/]+)\/runs$/.exec(pathname);
		const events = /^\/processes\/(\d+)\/(events|sse)$/.exec(pathname);
		const stdin = /^\/processes\/(\d+)\/stdin$/.exec(pathname);
		try {
			if (req.method === "POST" && started) {
				const { argv } = await body(req);
				const proc = await backend.exec(started[1], argv, { timeoutMs: 10_000 });
				const id = String(++next);
				processes.set(id, recordOf(proc));
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
			} else if (req.method === "POST" && run) {
				const { argv } = await body(req);
				const record = recordOf(await backend.exec(run[1], argv, { timeoutMs: 10_000 }));
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				await streamTo(res, record, renderEvent);
			} else if (req.method === "GET" && events && processes.has(events[1])) {
				const record = processes.get(events[1]);
				if (events[2] === "events") {
					res.writeHead(200, { "Content-Type": "application/x-ndjson" });
					await streamTo(res, record, (event) => `${JSON.stringify(event)}\n`);
				} else {
					res.writeHead(200, { "Content-Type": "text/event-stream" }).write("retry: 3000\n\n");
					await streamTo(res, record, togetherEvent, ": keep-alive\n\n");
				}
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

/** The host's exec over the vendor's Together-shaped server-sent events: the same calls, with `sse` reading the events. */
export function sseExec(base) {
	const api = rest({ base, headers: () => ({}), vendor: "fake-sse", timeoutMs: 10_000 });
	return (id, argv, ctx) =>
		framedExec(
			{
				start: async (argv, ctx) => orThrow(await api.json("POST", api.url(`/machines/${id}/processes`), { json: { argv }, timeoutMs: ctx.timeoutMs }, ctx.signal)).id,
				events: async function* (pid) {
					for await (const { event, data } of sse(orThrow(await api.stream("GET", api.url(`/processes/${pid}/sse`))).body)) {
						const value = JSON.parse(data);
						yield event === "exit" ? { exit: value.exitCode } : { stream: value.type, text: value.output };
					}
				},
				write: async (pid, text) => void orThrow(await api.call("POST", api.url(`/processes/${pid}/stdin`), { json: { text } })),
			},
			argv,
			ctx,
		);
}

/** The host's exec over the vendor's Render-shaped runs, which take no stdin: one call starts and streams, fifoStdin writes. */
export function fifoExec(base) {
	const api = rest({ base, headers: () => ({}), vendor: "fake-render", timeoutMs: 10_000 });
	return (id, argv, ctx) =>
		framedExec(
			fifoStdin({
				start: async (argv, ctx) => orThrow(await api.stream("POST", api.url(`/machines/${id}/runs`), { json: { argv }, timeoutMs: ctx.timeoutMs }, ctx.signal)).body,
				events: async function* (body) {
					for await (const { event, data } of sse(body)) {
						const value = JSON.parse(data);
						yield event === "exit" ? { exit: value.exit_code } : { stream: value.stream, text: value.data };
					}
				},
			}),
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
