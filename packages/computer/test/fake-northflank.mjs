// A stand-in for the Northflank API (https://api.northflank.com): a fetch that answers its REST calls in the shapes of
// Northflank's own client (@northflank/js-client: {data, pagination} answers, {error: {status, message}} refusals), and a
// WebSocket factory for its command-exec socket, whose messages are JSON text as the client's ExecCommandStandard reads
// them: the client's init (the token in it), payload and stdInEnd; the server's init answer, stdOut, stdErr, completion
// and error. Output and input ride as latin1 strings, one code point a byte, as the client sends them with encoding
// latin1. The parts the docs leave open are this fake's guesses, each pinned as unverified in src/northflank.ts: a taken
// name answers 409; a deleted service answers 404; output may trail the completion message until the socket closes.
//
// A command runs on backend.exec when a backend is given (fake-exec-host.mjs: real processes here; fake-host.mjs under
// withSh: the adapter's fake machines, for the conformance suite); else it is scripted: the test sends its output and its
// end (session(id).out, .complete, .close). A scripted command under the pid wrapper writes its pid line first, as sh
// would, and the wrapper's kill script ends it.
import { PID_KILL, PID_WRAPPER } from "../dist/hosted/scripts.js";

export const TOKEN = "fake-test-key-northflank";
export const PROJECT = "my-sandboxes";
export const PLANS = ["nf-compute-100-2", "nf-compute-200", "nf-compute-400", "nf-compute-800-16"];

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, message) => json(status, { error: { status, message, id: `nf-error-${status}` } });

/** One exec socket, the client's side as Node's WebSocket shows it; the server's side is the session that holds it. */
class FakeSocket {
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
		if (typeof data !== "string") throw new Error("Northflank's exec messages are JSON text");
		this.server.message(JSON.parse(data));
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
 * The fake. pageSize is the listing's; teamId, when given, is the team every path must name (an organisation token's);
 * rateLimited makes every create a 429. add() makes a service of the project this provider did not make.
 */
export function fakeNorthflank({ backend, pageSize = 2, teamId, rateLimited = false } = {}) {
	const services = new Map();
	const sessions = new Map();
	const sockets = [];
	const calls = [];
	let next = 1000;
	const base = `${teamId === undefined ? "" : `/teams/${teamId}`}/projects/${PROJECT}`;

	const add = (name, { annotations, status = "COMPLETED" } = {}) => {
		const at = new Date(Date.now()).toISOString();
		const service = {
			id: name,
			uid: `uid-${++next}`,
			appId: `/fake-team/${PROJECT}/${name}`,
			projectId: PROJECT,
			name,
			tags: [],
			serviceType: "deployment",
			billing: { deploymentPlan: "nf-compute-200" },
			deployment: { instances: 1, external: { imagePath: "nginx:latest" }, ...(annotations ? { metadata: { annotations } } : {}) },
			createdAt: at,
			updatedAt: at,
			status: { deployment: { status, reason: "DEPLOYING", lastTransitionTime: at } },
		};
		services.set(name, { service });
		return service;
	};

	/** The listing's view of a service: no annotations, no dates (ListServicesResult). */
	const listed = ({ id, uid, appId, projectId, name, tags, serviceType, status }) => ({ id, uid, appId, projectId, name, tags, serviceType, disabledCI: true, disabledCD: false, status });

	/** A session's record: the input it was sent, how its stdin ended, and the calls a test makes to it. */
	const sessionOf = (socket, name, context) => {
		const record = { id: String(++next), name, context, argv: context.command, socket, stdin: [], ended: false, killed: false, closed: false };
		const send = (message) => socket.emit("message", { data: JSON.stringify(message) });
		record.send = send;
		record.out = (stream, data, { pieces = [typeof data === "string" ? Buffer.byteLength(data) : data.length] } = {}) => {
			const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
			let at = 0;
			for (const size of pieces) {
				send({ type: stream === "stdout" ? "stdOut" : "stdErr", data: bytes.subarray(at, at + size).toString("latin1") });
				at += size;
			}
		};
		record.complete = (exitCode) => send({ type: "completion", data: { exitCode, status: exitCode === 0 ? "Success" : "Failure" } });
		record.close = () => {
			setImmediate(() => {
				socket.readyState = 3;
				socket.emit("close", { code: 1000 });
				record.closed = true;
			});
		};
		record.end = (exitCode) => {
			record.complete(exitCode);
			record.close();
		};
		record.input = async (message) => {
			if (message.type === "payload") {
				const bytes = Buffer.from(message.data, "latin1");
				record.stdin.push(bytes);
				await record.started;
				await record.proc?.write(new Uint8Array(bytes));
			} else if (message.type === "stdInEnd") {
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
			for await (const chunk of stream) if (record.socket.readyState === 1) record.out(name, chunk);
		};
		await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
		const code = await proc.wait();
		if (record.socket.readyState === 1) record.end(code < 0 ? 255 : code);
	};

	/** A scripted command: the wrapper's pid line comes first; the kill script ends the command it names. */
	const script = (record) => {
		const { argv } = record;
		if (argv[0] === "sh" && argv[2] === PID_KILL) {
			const [pid, start] = argv.slice(4);
			const target = [...sessions.values()].find((one) => one.pid === pid && one.start === start && !one.closed);
			if (target) {
				target.killed = true;
				target.end(137);
			}
			record.end(0);
			return;
		}
		if (argv[0] === "sh" && argv[2] === PID_WRAPPER[2]) {
			record.pid = String(4000 + Number(record.id));
			record.start = String(9000 + Number(record.id));
			record.out("stderr", `${record.pid} ${record.start}\n`);
		}
	};

	const webSocket = (url) => {
		const { pathname, protocol } = new URL(url);
		const call = { method: "WS", path: pathname, url };
		calls.push(call);
		let record;
		const socket = new FakeSocket({
			message: (message) => {
				if (record === undefined) {
					// The first message is the init, with the token in it: one Northflank refuses answers so and closes.
					call.init = message;
					const { auth, context } = message?.data ?? {};
					if (message?.type !== "init" || auth?.type !== "apiToken" || auth?.apiToken !== TOKEN) {
						socket.emit("message", { data: JSON.stringify({ type: "init", data: { auth: "failed", message: "Invalid API token" } }) });
						setImmediate(() => socket.close(1008));
						return;
					}
					record = sessionOf(socket, call.service, context);
					sessions.set(record.id, record);
					call.session = record.id;
					record.send({ type: "init", data: { auth: "successful" } });
					if (backend) void run(record, services.get(call.service)?.backendId ?? call.service);
					else script(record);
					return;
				}
				record.input(message).catch(() => {});
			},
			closed: () => {
				if (record) record.closed = true;
			},
		});
		sockets.push(socket);
		const named = new RegExp(`^/v1/command-exec${base}/services/([^/]+)$`).exec(pathname);
		call.service = named ? decodeURIComponent(named[1]) : undefined;
		setImmediate(() => {
			// A refused upgrade: the client sees an error and a close, never the status.
			if (!named || !services.has(call.service) || protocol !== "wss:") {
				socket.readyState = 3;
				socket.emit("error", { message: "Unexpected server response: 404" });
				socket.emit("close", { code: 1006 });
				return;
			}
			socket.readyState = 1;
			socket.emit("open");
		});
		return socket;
	};

	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const query = Object.fromEntries(searchParams);
		calls.push({ method, path: pathname, query, body });
		if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return refuse(401, "Unauthenticated");
		const one = new RegExp(`^/v1${base}/services/([^/]+)$`).exec(pathname);
		const scale = new RegExp(`^/v1${base}/services/([^/]+)/scale$`).exec(pathname);
		if (method === "POST" && pathname === `/v1${base}/services/deployment`) {
			if (rateLimited) return refuse(429, "Rate limit exceeded");
			if (services.has(body?.name)) return refuse(409, `A service with the name ${body.name} already exists`);
			const { billing, deployment, createOptions } = body ?? {};
			if (!PLANS.includes(billing?.deploymentPlan)) return refuse(400, `Invalid deployment plan ${billing?.deploymentPlan}`);
			if (deployment?.instances !== 1 || typeof deployment?.external?.imagePath !== "string") return refuse(400, "Invalid deployment");
			const annotations = deployment?.metadata?.annotations ?? {};
			if (Object.values(annotations).some((value) => typeof value !== "string")) return refuse(400, "Annotation values must be strings");
			const expiry = createOptions?.expiryTime;
			if (expiry !== undefined && !(Number.isInteger(expiry) && expiry >= 300 && expiry <= 604_800)) return refuse(400, "expiryTime must be between 300 and 604800");
			const service = add(body.name, { annotations, status: "PENDING" });
			service.billing = billing;
			service.deployment = { ...service.deployment, ...deployment };
			if (expiry !== undefined) service.expiryTime = new Date(Date.now() + expiry * 1000).toISOString();
			if (backend?.create) {
				const made = await backend.create({ name: body.name, image: deployment.external.imagePath, labels: {}, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false }, { timeoutMs: 10_000 });
				services.get(body.name).backendId = made.id;
			}
			return json(200, { data: service });
		}
		if (method === "POST" && scale) {
			const held = services.get(decodeURIComponent(scale[1]));
			if (held === undefined) return refuse(404, "Service not found");
			held.service.deployment.instances = body?.instances;
			held.service.status.deployment = { status: "COMPLETED", reason: "SCALING", lastTransitionTime: new Date().toISOString() };
			return json(200, { data: {} });
		}
		if (method === "GET" && pathname === `/v1${base}/services`) {
			const all = [...services.values()].map(({ service }) => listed(service));
			const from = Number(query.cursor ?? 0);
			const size = Math.min(pageSize, Number(query.per_page ?? 50));
			const more = from + size < all.length;
			return json(200, { data: { services: all.slice(from, from + size) }, pagination: { hasNextPage: more, ...(more ? { cursor: String(from + size) } : {}), count: Math.min(size, all.length - from) } });
		}
		if (one && (method === "GET" || method === "DELETE")) {
			const held = services.get(decodeURIComponent(one[1]));
			if (held === undefined) return refuse(404, "Service not found");
			if (method === "GET") return json(200, { data: held.service });
			services.delete(held.service.id);
			if (backend?.delete) await backend.delete(held.backendId, { timeoutMs: 10_000 });
			return json(200, { data: {} });
		}
		return refuse(404, `no route ${method} ${pathname}`);
	};
	return { fetch, webSocket, calls, services, sessions, sockets, add, session: (id) => sessions.get(id) };
}
