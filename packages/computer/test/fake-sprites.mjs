// A stand-in for the Sprites API (https://api.sprites.dev): a fetch that answers its REST calls in the shapes of its
// reference and of Fly's own client (superfly/sprites-js), and a WebSocket factory for its exec socket, whose frames are
// binary as Fly's are: the client's 0x00 stdin and 0x04 end of stdin, the server's 0x01 stdout, 0x02 stderr and 0x03
// exit, with JSON text messages beside them (session_info first, exit last). The parts the docs leave open are this
// fake's guesses, each pinned as unverified in src/sprites.ts: a taken name answers 409; a listing by prefix may answer
// sprites that are not ours; a delete is done at its 204.
//
// A command runs on backend.exec when a backend is given (fake-exec-host.mjs: real processes here; fake-host.mjs: the
// adapter's fake machines, for the conformance suite); else it is scripted: the test sends its output and its exit
// (session(id).out / .exit).
export const TOKEN = "fake-test-key-sprites";

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, error, message) => json(status, { error, message });
const labelsOf = (strings = []) => Object.fromEntries(strings.map((one) => [one.slice(0, one.indexOf("=")), one.slice(one.indexOf("=") + 1)]));

/** One exec socket, the client's side as Node's WebSocket shows it; the server's side is the session that holds it. */
class FakeSocket {
	binaryType = "blob";
	readyState = 0;
	bufferedAmount = 0;
	#listeners = { open: [], message: [], close: [], error: [] };
	constructor(server) {
		this.server = server;
	}
	addEventListener(type, listener) {
		this.#listeners[type].push(listener);
	}
	/** An event on the client's side, after what is already queued, as a socket's are. */
	emit(type, event = {}) {
		setImmediate(() => {
			for (const listener of this.#listeners[type]) listener(event);
		});
	}
	send(data) {
		if (this.readyState !== 1) throw new Error("WebSocket is not open");
		this.server.frame(new Uint8Array(data));
	}
	close(code = 1005) {
		if (this.readyState >= 2) return;
		this.readyState = 3;
		this.closedWith = code;
		this.emit("close", { code });
		this.server.closed();
	}
}

/**
 * The fake. pageSize is the listing's (at most max_results); others are sprites of the account not made by this
 * provider (another prefix match, no labels or other labels), which a listing answers too; rateLimited makes every
 * create a 429 sprite_creation_rate_limited.
 */
export function fakeSprites({ backend, pageSize = 2, rateLimited = false } = {}) {
	const sprites = new Map();
	const sessions = new Map();
	const sockets = [];
	const calls = [];
	let next = 1000;

	const add = (name, labels = []) => {
		const sprite = { id: `sprite-${++next}`, name, organization: "fake-org", status: "warm", created_at: new Date(Date.now()).toISOString(), updated_at: new Date(Date.now()).toISOString(), url: `https://${name}.sprites.app`, ...(labels.length > 0 ? { labels } : {}) };
		sprites.set(name, { sprite });
		return sprite;
	};

	/** A session's record: the frames it was sent, how its stdin ended, and the calls a test makes to it. */
	const sessionOf = (socket, name, argv) => {
		const record = { id: String(++next), name, argv, socket, stdin: [], ended: false, killed: undefined, closed: false };
		const frame = (stream, bytes) => {
			const out = new Uint8Array(bytes.length + 1);
			out[0] = stream;
			out.set(bytes, 1);
			// Binary frames come as ArrayBuffer once the client asked for that, as a Blob before (Node's default).
			socket.emit("message", { data: socket.binaryType === "arraybuffer" ? out.buffer : new Blob([out]) });
		};
		record.out = (stream, data, { pieces = [data.length] } = {}) => {
			const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
			let at = 0;
			for (const size of pieces) {
				frame(stream === "stdout" ? 1 : 2, bytes.subarray(at, at + size));
				at += size;
			}
		};
		record.exit = (code) => {
			frame(3, new Uint8Array([code]));
			socket.emit("message", { data: JSON.stringify({ type: "exit", exit_code: code }) });
		};
		record.frame = async (bytes) => {
			if (bytes[0] === 0) {
				record.stdin.push(Buffer.from(bytes.subarray(1)));
				await record.started;
				await record.proc?.write(bytes.subarray(1));
			} else if (bytes[0] === 4) {
				record.ended = true;
				await record.started;
				await record.proc?.end();
			}
		};
		return record;
	};

	const run = async (record, id) => {
		record.started = backend.exec(id, record.argv, { timeoutMs: 10_000 });
		const proc = await record.started;
		record.proc = proc;
		const pump = async (stream, name) => {
			for await (const chunk of stream) record.out(name, chunk);
		};
		await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
		const code = await proc.wait();
		if (record.socket.readyState === 1) record.exit(code < 0 ? 255 : code);
	};

	const webSocket = (url, init) => {
		const { pathname, searchParams } = new URL(url);
		const call = { method: "WS", path: pathname, query: { cmd: searchParams.getAll("cmd"), path: searchParams.get("path"), stdin: searchParams.get("stdin"), max_run_after_disconnect: searchParams.get("max_run_after_disconnect") }, url };
		calls.push(call);
		let record;
		const socket = new FakeSocket({
			frame: (bytes) => {
				const done = record?.frame(bytes);
				done?.catch(() => {});
			},
			closed: () => {
				if (record) record.closed = true;
			},
		});
		sockets.push(socket);
		const named = /^\/v1\/sprites\/([^/]+)\/exec$/.exec(pathname);
		const one = named && sprites.get(decodeURIComponent(named[1]));
		setImmediate(() => {
			// A refused upgrade: the client sees an error and a close, never the status.
			if (init?.headers?.Authorization !== `Bearer ${TOKEN}` || !one || url.startsWith("wss:") === false) {
				socket.readyState = 3;
				socket.emit("error", { message: `Unexpected server response: ${one ? 401 : 404}` });
				socket.emit("close", { code: 1006 });
				return;
			}
			socket.readyState = 1;
			record = sessionOf(socket, one.sprite.name, call.query.cmd);
			sessions.set(record.id, record);
			call.session = record.id;
			socket.emit("open");
			socket.emit("message", { data: JSON.stringify({ type: "session_info", session_id: record.id, command: call.query.path, created: Date.now(), cols: 0, rows: 0, is_owner: true, tty: false }) });
			if (backend) void run(record, one.backendId ?? one.sprite.name);
		});
		return socket;
	};

	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const query = Object.fromEntries(searchParams);
		calls.push({ method, path: pathname, query, body });
		if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return refuse(401, "unauthorized", "Invalid or missing token");
		const named = /^\/v1\/sprites\/([^/]+)$/.exec(pathname);
		const kill = /^\/v1\/sprites\/([^/]+)\/exec\/([^/]+)\/kill$/.exec(pathname);
		if (method === "POST" && pathname === "/v1/sprites") {
			if (rateLimited) return refuse(429, "sprite_creation_rate_limited", "Sprite creation rate limit exceeded: 10 per minute");
			if (sprites.has(body.name)) return refuse(409, "sprite_exists", `A sprite named ${body.name} already exists`);
			if (!Array.isArray(body.labels ?? []) || (body.labels ?? []).some((one) => typeof one !== "string" || one.length > 64)) return refuse(400, "bad_request", "Invalid labels");
			const sprite = add(body.name, body.labels ?? []);
			if (backend?.create) {
				const made = await backend.create({ name: body.name, image: "default", labels: labelsOf(body.labels), lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false }, { timeoutMs: 10_000 });
				sprites.get(body.name).backendId = made.id;
			}
			return json(201, sprite);
		}
		if (method === "GET" && pathname === "/v1/sprites") {
			const all = [...sprites.values()].map(({ sprite }) => sprite).filter((one) => one.name.startsWith(query.prefix ?? ""));
			const from = Number(query.continuation_token ?? 0);
			const size = Math.min(pageSize, Number(query.max_results ?? 50));
			const more = from + size < all.length;
			return json(200, { sprites: all.slice(from, from + size), has_more: more, next_continuation_token: more ? String(from + size) : null, running: 0, warm: all.length, cold: 0 });
		}
		if (named && (method === "GET" || method === "DELETE")) {
			const one = sprites.get(decodeURIComponent(named[1]));
			if (one === undefined) return refuse(404, "not_found", "Sprite not found");
			if (method === "GET") return json(200, one.sprite);
			sprites.delete(one.sprite.name);
			if (backend?.delete) await backend.delete(one.backendId, { timeoutMs: 10_000 });
			return new Response(null, { status: 204 });
		}
		if (kill && method === "POST") {
			const record = sessions.get(decodeURIComponent(kill[2]));
			if (record === undefined || record.name !== decodeURIComponent(kill[1])) return refuse(404, "not_found", "Session not found");
			record.killed = query.signal ?? "SIGTERM";
			await record.started;
			await record.proc?.kill();
			const lines = [{ type: "signal", message: `sent ${record.killed}` }, { type: "killed" }, { type: "complete", exit_code: 137 }];
			return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { status: 200, headers: { "content-type": "application/x-ndjson" } });
		}
		return refuse(404, "not_found", `no route ${method} ${pathname}`);
	};
	return { fetch, webSocket, calls, sprites, sessions, sockets, add, session: (id) => sessions.get(id) };
}
