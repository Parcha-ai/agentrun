// A fake Agent37 for the unit tests: its REST API as a fetch (instances made, read, listed, edited and deleted, with
// Agent37's envelopes), and an instance's SSH as a real sshd stand-in, ssh2's Server on loopback, reached through a
// fake WebSocket that checks the edge's X-Agent37-Key and carries the bytes over TCP. A command runs as sshd runs one:
// the login shell's -c, as a session leader of its own (detached). The shell is the test machine's own.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import ssh2 from "ssh2";

export const KEY = "sk_live_fake_agent37_0123456789abcdef";
export const API_URL = "https://api.agent37.test";
export const PROXY = "agent37.test";

const { Server, utils } = ssh2;

/** OpenSSH's MaxSessions default: the sessions one connection takes at once (sshd_config(5)). */
export const MAX_SESSIONS = 10;

/**
 * A key pair in OpenSSH form, as `agent37 ssh-keys add` registers one. ssh2's generator writes a private key its own
 * parser refuses ("Malformed OpenSSH private key") about once in 250 ed25519 pairs, so a pair it can't read back is made again.
 */
export function keyPair() {
	for (;;) {
		const pair = utils.generateKeyPairSync("ed25519");
		if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
	}
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const envelope = (status, code, message) => json(status, { error: { code, message } });

/** At most this many SSH keys on one workspace: the next POST answers 400 invalid_request (docs: agents-api/ssh). */
export const MAX_SSH_KEYS = 20;

/** An OpenSSH public key line's fingerprint as Agent37 answers it: "SHA256:" and the blob's sha256 in base64, unpadded. */
export const fingerprintOf = (line) => `SHA256:${createHash("sha256").update(Buffer.from(line.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "")}`;

/**
 * The REST API. Each instance is the object Agent37 answers (docs: instances/object). fail(method, path, response)
 * answers the next call matching with response once; calls lists every call, its method, path, auth and body.
 * sshKeys: the workspace's registered SSH keys (docs: agents-api/ssh), each { id, name, fingerprint, type, created } as
 * Agent37 lists it, with its public line and liveAt, when it reaches instances made before it: settleMs after its POST.
 * bootKeys: each instance's keys from its boot, the fingerprints registered when it was made. authorizedFor(id): the
 * public lines instance id's sshd takes now.
 */
export function fakeRest({ key = KEY, settleMs = 0 } = {}) {
	const instances = new Map();
	const calls = [];
	const failures = [];
	const sshKeys = [];
	const bootKeys = new Map();
	let next = 0;
	let nextKey = 0;
	const keyOf = (entry) => ({ id: entry.id, name: entry.name, fingerprint: entry.fingerprint, type: entry.type, created: entry.created });
	/** A key registered as if by someone else, at created (s); live on every instance at once unless liveAt says. */
	const register = (line, { name = null, created = Math.floor(Date.now() / 1000), liveAt = 0 } = {}) => {
		const entry = { id: `sshkey_${String(nextKey++).padStart(6, "0")}`, object: "ssh_key", name, fingerprint: fingerprintOf(line), type: line.split(" ")[0], created, line, liveAt };
		sshKeys.push(entry);
		return entry;
	};
	const authorizedFor = (id) => sshKeys.filter((entry) => entry.liveAt <= Date.now() || (bootKeys.get(id) ?? new Set()).has(entry.fingerprint)).map((entry) => entry.line);
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
		if (pathname === "/v1/ssh-keys" && method === "GET") return json(200, { object: "list", data: [...sshKeys].reverse().map(keyOf) });
		if (pathname === "/v1/ssh-keys" && method === "POST") {
			const line = typeof body?.public_key === "string" ? body.public_key.trim() : "";
			if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( \S+)?$/.test(line) || utils.parseKey(line) instanceof Error) return envelope(400, "invalid_request", "public_key must be one OpenSSH public key line");
			const fingerprint = fingerprintOf(line);
			if (sshKeys.some((entry) => entry.fingerprint === fingerprint)) return envelope(409, "ssh_key_exists", "An SSH key with this fingerprint already exists in this workspace");
			if (sshKeys.length >= MAX_SSH_KEYS) return envelope(400, "invalid_request", `A workspace can have at most ${MAX_SSH_KEYS} SSH keys`);
			const entry = register(line, { name: typeof body.name === "string" ? body.name : null, liveAt: Date.now() + settleMs });
			return json(201, keyOf(entry));
		}
		const sshKey = /^\/v1\/ssh-keys\/([^/]+)$/.exec(pathname);
		if (sshKey && method === "DELETE") {
			const at = sshKeys.findIndex((entry) => entry.id === sshKey[1]);
			if (at < 0) return envelope(404, "not_found", `No such SSH key: ${sshKey[1]}`);
			sshKeys.splice(at, 1);
			return json(200, { id: sshKey[1], object: "ssh_key", deleted: true });
		}
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
			// An instance made after a key is registered has it from boot (docs: agents-api/ssh).
			bootKeys.set(id, new Set(sshKeys.map((entry) => entry.fingerprint)));
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
		sshKeys,
		register,
		authorizedFor,
		fail: (method, path, response) => failures.push({ method, path, response }),
	};
}

/**
 * An instance's sshd: ssh2's Server on 127.0.0.1, taking the one public key given, as root. Each exec runs under
 * `bash -c` (root's login shell on Agent37's base template), detached so it leads its own session as sshd's does, and
 * its exit-status, or exit-signal, is sent as OpenSSH sends them. commands lists each command line; state.logins counts
 * the handshakes that ended in a login, state.live the connections open now, state.sessions the sessions open now. A
 * connection takes MAX_SESSIONS sessions at once and refuses the next, as OpenSSH's sshd does by default (MaxSessions).
 * refuseSessions(n) refuses the next n session channels besides, dropAll() cuts every connection from the server's
 * side, and close() ends them all, then the server. accept(ctx), when given, decides each login in place of the one
 * key as root (Morph's gateway: its own username, any key); run(command, stream), when given, may answer a command
 * itself (true), in place of bash. authorized(id), when given, is the public lines instance id's sshd takes as root now
 * (fakeRest's authorizedFor: the workspace's registered keys), the instance named by the client's port in routes, which
 * fakeWebSocket fills; state.denied counts the logins refused.
 */
export async function fakeSshd({ publicKey, accept, run, authorized, routes }) {
	const host = keyPair();
	const allowed = publicKey === undefined ? undefined : utils.parseKey(publicKey);
	const commands = [];
	const children = new Set();
	const clients = new Set();
	const state = { logins: 0, live: 0, sessions: 0, refusing: 0, denied: 0 };
	const server = new Server({ hostKeys: [host.private] }, (client, info) => {
		clients.add(client);
		state.live++;
		client.on("close", () => {
			clients.delete(client);
			state.live--;
		});
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			if (accept !== undefined) return accept(ctx) ? ctx.accept() : ctx.reject(["publickey"]);
			const key = ctx.method === "publickey" ? ctx.key : undefined;
			const takes = authorized === undefined ? [allowed] : authorized(routes?.get(info.port)).map((line) => utils.parseKey(line));
			const match = key && ctx.username === "root" ? takes.find((one) => key.algo === one.type && key.data.length === one.getPublicSSH().length && timingSafeEqual(key.data, one.getPublicSSH())) : undefined;
			if (!match || (ctx.signature && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) {
				if (ctx.method === "publickey") state.denied++;
				return ctx.reject(["publickey"]);
			}
			ctx.accept();
		});
		client.on("ready", () => {
			state.logins++;
			let open = 0;
			client.on("session", (accept, reject) => {
				if (state.refusing > 0 || open >= MAX_SESSIONS) {
					if (open < MAX_SESSIONS) state.refusing--;
					return reject();
				}
				const session = accept();
				open++;
				state.sessions++;
				session.on("close", () => {
					open--;
					state.sessions--;
				});
				session.on("exec", (acceptExec, _reject, { command }) => {
					commands.push(command);
					const stream = acceptExec();
					if (run?.(command, stream)) return;
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
	const dropAll = () => {
		for (const client of clients) client.end();
	};
	return {
		port: server.address().port,
		commands,
		state,
		refuseSessions: (count) => (state.refusing = count),
		dropAll,
		close: async () => {
			for (const child of children) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Gone.
				}
			}
			dropAll();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/**
 * A WebSocket class as Node's global one is used here: the edge refuses a key that is not the workspace's (closed with
 * 1008 before it opens, as Agent37's edge closes it), then every binary frame rides a TCP connection to port. opened lists
 * each URL and its headers.
 */
export function fakeWebSocket({ port, key = KEY, routes }) {
	const opened = [];
	/** How many of the next tunnels fail to open (an error, then 1006), as a fresh instance's edge did once live. */
	const state = { failing: 0, hanging: 0 };
	/** The tunnels closed by their caller, each with its readyState when it was closed. */
	const closedBy = [];
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
				if (state.hanging > 0) {
					// Stays opening until its caller closes it.
					state.hanging--;
					return;
				}
				this.#socket = connect(port, "127.0.0.1", () => {
					// The instance this tunnel reaches, by the sshd's view of the connection: its client port.
					routes?.set(this.#socket.localPort, new URL(url).hostname.split("-")[0]);
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
			closedBy.push(this.readyState);
			const opening = this.readyState === 0;
			this.readyState = 2;
			if (this.#socket) this.#socket.end();
			else if (opening) setImmediate(() => this.#close(1006, ""));
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
	return { WebSocket: FakeWebSocket, opened, closedBy, failNext: (count) => (state.failing = count), hangNext: (count) => (state.hanging = count) };
}

/** All three, wired: a REST API, an sshd taking a fresh key, and the WebSocket to it. */
export async function fakeAgent37() {
	const rest = fakeRest();
	const pair = keyPair();
	const sshd = await fakeSshd({ publicKey: pair.public });
	const ws = fakeWebSocket({ port: sshd.port });
	return { rest, sshd, ws, sshKey: pair.private, options: { apiKey: KEY, sshKey: pair.private, ssh2, fetch: rest.fetch, WebSocket: ws.WebSocket, apiUrl: API_URL, proxyDomain: PROXY } };
}

/**
 * All three, wired as a workspace whose instances' sshd takes only the keys registered on it (POST /v1/ssh-keys): a key
 * reaches an instance made before it settleMs after its registration, and one made after it from boot. options carry
 * the API key alone, no SSH key.
 */
export async function fakeWorkspace({ settleMs = 0 } = {}) {
	const rest = fakeRest({ settleMs });
	const routes = new Map();
	const sshd = await fakeSshd({ authorized: rest.authorizedFor, routes });
	const ws = fakeWebSocket({ port: sshd.port, routes });
	return { rest, sshd, ws, options: { apiKey: KEY, ssh2, fetch: rest.fetch, WebSocket: ws.WebSocket, apiUrl: API_URL, proxyDomain: PROXY } };
}

/**
 * A store of a provider's own secrets in memory, as a server's sealed one is used: get by name, and putIfAbsent, which
 * keeps the first value under a name and answers the one kept. puts lists each write asked.
 */
export function memorySecrets() {
	const held = new Map();
	const puts = [];
	return {
		held,
		puts,
		get: async (name) => held.get(name),
		putIfAbsent: async (name, value) => {
			puts.push(name);
			if (!held.has(name)) held.set(name, value);
			return held.get(name);
		},
	};
}
