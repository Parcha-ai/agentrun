// A text-only vendor whose exec comes in pieces, as a REST API's does, and the host a vendor writes over it with
// framedExec (src/hosted/framed-exec.ts) and the REST client (src/hosted/rest.ts). The vendor is an HTTP server on
// loopback: POST /machines/:id/processes {argv} starts a process and answers {id}; GET /processes/:id/events streams its
// events as NDJSON, {stream, text} then {exit}, from its start; POST /processes/:id/stdin {text} is one write. Output
// is text in JSON strings (decoded as UTF-8, as a vendor's are), and there is no end of stdin and no kill.
//
// The processes behind the server are another MachineHost's exec: fake-exec-host.mjs's, real processes on this machine,
// for the exec pre-check; or fake-host.mjs's machines in memory, for the adapter's create, under withSh, which plays the
// sh the pid wrapper and the kill need.
import { createServer } from "node:http";
import { ndjson, framedExec } from "../dist/hosted/framed-exec.js";
import { orThrow } from "../dist/hosted/process.js";
import { rest } from "../dist/hosted/rest.js";

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
			const decoder = new TextDecoder();
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
		const events = /^\/processes\/(\d+)\/events$/.exec(pathname);
		const stdin = /^\/processes\/(\d+)\/stdin$/.exec(pathname);
		try {
			if (req.method === "POST" && started) {
				const { argv } = await body(req);
				const proc = await backend.exec(started[1], argv, { timeoutMs: 10_000 });
				const id = String(++next);
				processes.set(id, recordOf(proc));
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
			} else if (req.method === "GET" && events && processes.has(events[1])) {
				const record = processes.get(events[1]);
				res.writeHead(200, { "Content-Type": "application/x-ndjson" });
				for (let at = 0; ; ) {
					while (at < record.events.length) res.write(`${JSON.stringify(record.events[at++])}\n`);
					if (record.ended || res.destroyed) break;
					await new Promise((done) => (record.wake = done));
				}
				res.end();
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

const WRAPPER = 'echo "$$" >&2; exec "$@"';

/**
 * fake-host.mjs's exec with the sh framedExec's pid wrapper and its kill need, which its machines in memory have none
 * of: `sh -c <wrapper> sh argv...` runs argv with a pid of its own first on stderr, and `kill -KILL <pid>` kills it.
 */
export function withSh(host) {
	const running = new Map();
	let pids = 1000;
	return async (id, argv, ctx) => {
		if (argv[0] === "kill" && argv[1] === "-KILL") {
			await running.get(argv[2])?.kill();
			const none = async function* () {};
			return { stdout: none(), stderr: none(), write: async () => {}, end: async () => {}, wait: async () => 0, kill: async () => {} };
		}
		if (argv[0] !== "sh" || argv[2] !== WRAPPER) return host.exec(id, argv, ctx);
		const proc = await host.exec(id, argv.slice(4), ctx);
		const pid = String(++pids);
		running.set(pid, proc);
		void proc.wait().then(() => running.delete(pid));
		return {
			...proc,
			stderr: (async function* () {
				yield new Uint8Array(Buffer.from(`${pid}\n`));
				yield* proc.stderr;
			})(),
		};
	};
}
