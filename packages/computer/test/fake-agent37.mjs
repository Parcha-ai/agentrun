// A fake Agent37 for the unit tests: its REST API as a fetch (instances made, read, listed, edited and deleted, with
// Agent37's envelopes), and an instance's SSH as a real sshd stand-in, ssh2's Server on loopback, reached through a
// fake WebSocket that checks the edge's X-Agent37-Key and carries the bytes over TCP. A command runs as sshd runs one:
// the login shell's -c, as a session leader of its own (detached). The shell is the test machine's own.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import ssh2 from "ssh2";

export const KEY = "sk_live_fake_agent37_0123456789abcdef";
export const API_URL = "https://api.agent37.test";
export const PROXY = "agent37.test";

const { Server, utils } = ssh2;

/** A key pair in OpenSSH form, as `agent37 ssh-keys add` registers one. */
export function keyPair() {
	return utils.generateKeyPairSync("ed25519");
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const envelope = (status, code, message) => json(status, { error: { code, message } });

/**
 * The REST API. Each instance is the object Agent37 answers (docs: instances/object). fail(method, path, response)
 * answers the next call matching with response once; calls lists every call, its method, path, auth and body.
 */
export function fakeRest({ key = KEY } = {}) {
	const instances = new Map();
	const calls = [];
	const failures = [];
	let next = 0;
	const fetch = async (url, init = {}) => {
		const { pathname } = new URL(url);
		const method = init.method ?? "GET";
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		const auth = init.headers?.Authorization;
		calls.push({ method, path: pathname, auth, body });
		if (!url.startsWith(`${API_URL}/`)) return json(502, { error: "bad_gateway" });
		const failing = failures.findIndex((one) => one.method === method && one.path.test(pathname));
		if (failing >= 0) {
			const [{ response }] = failures.splice(failing, 1);
			return typeof response === "function" ? response() : response;
		}
		if (auth !== `Bearer ${key}`) return envelope(401, "invalid_api_key", "Invalid API key");
		if (pathname === "/v1/instances" && method === "POST") {
			const id = `fake${String(next++).padStart(6, "0")}`;
			const shape = body.resources ?? { cpu: 2, memory: 4 };
			const instance = {
				id,
				object: "instance",
				name: body.name ?? null,
				status: "running",
				status_reason: null,
				template: body.template,
				image_digest: `sha256:${"d".repeat(64)}`,
				type: body.type ?? "default",
				region: body.region ?? "us",
				resources: { ...shape, disk: 4 },
				metadata: body.metadata ?? {},
				network: body.network ?? "allow-all",
				public_ports: body.public_ports ?? [],
				auto_sleep: body.auto_sleep ?? true,
				mount_path: "/home/node",
				created: 1_800_000_000,
			};
			instances.set(id, instance);
			return json(201, instance);
		}
		if (pathname === "/v1/instances" && method === "GET") return json(200, { data: [...instances.values()].reverse() });
		const match = /^\/v1\/instances\/([^/]+)$/.exec(pathname);
		const instance = match ? instances.get(match[1]) : undefined;
		if (!match) return envelope(404, "not_found", "No such route");
		if (!instance) return envelope(404, "not_found", `No such instance: ${match[1]}`);
		if (method === "GET") return json(200, instance);
		if (method === "DELETE") {
			instances.delete(instance.id);
			return json(200, { id: instance.id, object: "instance", deleted: true });
		}
		if (method === "PATCH") {
			if (body.metadata !== undefined) {
				if (Buffer.byteLength(JSON.stringify(body.metadata)) > 4096) return envelope(400, "invalid_request", "metadata must be 4096 bytes or fewer when serialized");
				instance.metadata = body.metadata;
			}
			return json(200, instance);
		}
		return envelope(400, "invalid_request", `No ${method} here`);
	};
	return {
		fetch,
		instances,
		calls,
		fail: (method, path, response) => failures.push({ method, path, response }),
	};
}

/**
 * An instance's sshd: ssh2's Server on 127.0.0.1, taking the one public key given, as root. Each exec runs under
 * `bash -c` (root's login shell on Agent37's base template), detached so it leads its own session as sshd's does, and
 * its exit-status, or exit-signal, is sent as OpenSSH sends them. commands lists each command line.
 */
export async function fakeSshd({ publicKey }) {
	const host = keyPair();
	const allowed = utils.parseKey(publicKey);
	const commands = [];
	const children = new Set();
	const server = new Server({ hostKeys: [host.private] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			const key = ctx.method === "publickey" ? ctx.key : undefined;
			const same = key && ctx.username === "root" && key.algo === allowed.type && key.data.length === allowed.getPublicSSH().length && timingSafeEqual(key.data, allowed.getPublicSSH());
			if (!same) return ctx.reject(["publickey"]);
			if (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
			ctx.accept();
		});
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec, _reject, { command }) => {
					commands.push(command);
					const stream = acceptExec();
					const child = spawn("bash", ["-c", command], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
					children.add(child);
					child.stdout.pipe(stream, { end: false });
					child.stderr.pipe(stream.stderr, { end: false });
					stream.pipe(child.stdin);
					child.stdin.on("error", () => {});
					stream.on("error", () => {});
					let outs = 2;
					let exit;
					const finish = () => {
						if (outs > 0 || exit === undefined) return;
						if (exit.signal) stream.exit(exit.signal.replace(/^SIG/, ""), false, "");
						else stream.exit(exit.code);
						stream.end();
					};
					child.stdout.on("end", () => {
						outs--;
						finish();
					});
					child.stderr.on("end", () => {
						outs--;
						finish();
					});
					child.on("exit", (code, signal) => {
						children.delete(child);
						exit = { code, signal };
						finish();
					});
				});
			});
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: server.address().port,
		commands,
		close: async () => {
			for (const child of children) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Gone.
				}
			}
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/**
 * A WebSocket class as Node's global one is used here: the edge refuses a key that is not the workspace's (closed with
 * 1008 before it opens, as Agent37's edge closes it), then every binary frame rides a TCP connection to port. opened lists
 * each URL and its headers.
 */
export function fakeWebSocket({ port, key = KEY }) {
	const opened = [];
	/** How many of the next tunnels fail to open (an error, then 1006), as a fresh instance's edge did once live. */
	const state = { failing: 0 };
	class FakeWebSocket {
		binaryType = "blob";
		readyState = 0;
		bufferedAmount = 0;
		#listeners = { open: [], message: [], close: [], error: [] };
		#socket;
		constructor(url, init) {
			opened.push({ url, headers: { ...(init?.headers ?? {}) } });
			setImmediate(() => {
				if (init?.headers?.["X-Agent37-Key"] !== key) return this.#close(1008, "invalid key");
				if (state.failing > 0) {
					state.failing--;
					this.#emit("error", { message: "Received network error or non-101 status code." });
					return this.#close(1006, "");
				}
				this.#socket = connect(port, "127.0.0.1", () => {
					this.readyState = 1;
					this.#emit("open", {});
				});
				this.#socket.on("data", (data) => this.#emit("message", { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }));
				this.#socket.on("error", (error) => this.#emit("error", { message: error.message }));
				this.#socket.on("close", () => this.#close(1006, ""));
			});
		}
		addEventListener(type, listener) {
			this.#listeners[type].push(listener);
		}
		send(data) {
			if (this.readyState !== 1) throw new Error("not open");
			this.#socket.write(Buffer.from(data));
		}
		close() {
			if (this.readyState >= 2) return;
			this.readyState = 2;
			this.#socket?.end();
		}
		#close(code, reason) {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.#emit("close", { code, reason });
		}
		#emit(type, event) {
			for (const listener of this.#listeners[type]) listener(event);
		}
	}
	return { WebSocket: FakeWebSocket, opened, failNext: (count) => (state.failing = count) };
}

/** All three, wired: a REST API, an sshd taking a fresh key, and the WebSocket to it. */
export async function fakeAgent37() {
	const rest = fakeRest();
	const pair = keyPair();
	const sshd = await fakeSshd({ publicKey: pair.public });
	const ws = fakeWebSocket({ port: sshd.port });
	return { rest, sshd, ws, sshKey: pair.private, options: { apiKey: KEY, sshKey: pair.private, ssh2, fetch: rest.fetch, WebSocket: ws.WebSocket, apiUrl: API_URL, proxyDomain: PROXY } };
}
