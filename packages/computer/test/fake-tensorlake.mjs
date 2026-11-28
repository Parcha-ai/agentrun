// A fake Tensorlake for the unit tests, in the shapes of its OpenAPI (https://docs.tensorlake.ai/api-reference/openapi.yaml):
// the sandbox API as a fetch (POST /sandboxes with wait false answering 202 pending, GET by id or name, GET /sandboxes
// paged by next_cursor and leaving out terminated ones, an idempotent DELETE, text/plain refusals), and each sandbox's
// proxy on <id>.sandbox.tensorlake.test (ssh/enable, processes/run's server-sent events, the {error, code} refusals);
// the TCP tunnel as fake-agent37.mjs's WebSocket, which admits the project's Bearer key with the sandbox's id, to an
// sshd (fake-agent37.mjs's) that takes, as tl-user, the one key the sandbox's last ssh/enable named. The parts the docs
// leave open are this fake's guesses, each pinned as unverified in src/tensorlake.ts: a taken name answers 409; the
// processes API runs sudo with no password; an enable with another key replaces the one before.
//
// processes/run interprets the two scripts src/tensorlake.ts sends, the labels file's write and read, against a file per
// sandbox; proxy.script(body, one, signal), when set, may answer a run itself (an array of events, or a Response). A command over
// SSH runs as the test machine's bash (the exec pre-check), or on backend's exec (fake-host.mjs's machines, for the
// conformance suite) under withSh.
import ssh2 from "ssh2";
import { fakeSshd, fakeWebSocket, fingerprintOf } from "./fake-agent37.mjs";
import { onBackend } from "./fake-instabox.mjs";
import { withSh } from "./fake-text-host.mjs";

export const KEY = "fake-test-key-tensorlake";
export const API_URL = "https://api.tensorlake.test";
export const PROXY_DOMAIN = "sandbox.tensorlake.test";

/** The fields POST /sandboxes takes (O CreateSandboxRequest), as far as this fake reads them; another is 400. */
const FIELDS = new Set(["name", "image", "resources", "timeout_secs", "network", "auto_resume", "wait", "max_pending_secs", "entrypoint", "secret_names", "snapshot_id"]);
/** A name as this fake takes it (unverified: a DNS label). */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const proxyError = (status, code, error) => json(status, { error, code });
const base36 = (n, width) => n.toString(36).padStart(width, "0");
/** Sandbox ids count up across every fake of the process, as a project's do: the provider keeps labels by id process-wide. */
let next = 1;

/** A body of server-sent events, one data line each. */
export function events(list) {
	const body = list.map((one) => `data: ${JSON.stringify(one)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The API and the proxies. Each sandbox answers pending for pendingReads reads, then running. pageSize is the listing's;
 * overList makes the listing answer terminated sandboxes too; dropTerminated makes a deleted sandbox read 404 at once,
 * else it reads terminated. capacity: false terminates each new sandbox no_capacity on its first read. fail(method,
 * path, response) answers the next call matching once; calls lists every call, its method, host, path, query, headers
 * and body. ssh.fingerprint is what ssh/enable answers as host_key_fingerprint; null names none.
 */
export function fakeRest({ key = KEY, pageSize = 2, pendingReads = 1, overList = false, dropTerminated = false, capacity = true, backend } = {}) {
	const sandboxes = new Map();
	const calls = [];
	const failures = [];
	const ssh = { fingerprint: null };
	const proxy = { script: undefined };
	const find = (idOrName) => sandboxes.get(idOrName) ?? [...sandboxes.values()].find((one) => one.sandbox.name === idOrName && one.sandbox.status !== "terminated");
	const view = (one) => structuredClone(one.sandbox);

	const create = async (body) => {
		const unknown = Object.keys(body).find((field) => !FIELDS.has(field));
		if (unknown) return text(400, `unknown field ${unknown}`);
		if (body.name !== undefined && !NAME.test(body.name)) return text(400, "name must be a DNS label of lowercase letters, digits and -");
		if (body.name !== undefined && find(body.name)) return text(409, `sandbox with name ${body.name} already exists`);
		const { cpus = 1, memory_mb: memory = 1024 } = body.resources ?? {};
		if (memory < 1024 * cpus || memory > 8192 * cpus) return text(400, `memory_mb must be between 1024 and 8192 per CPU, got ${memory} for ${cpus}`);
		const id = `sbx${base36(next++, 20)}`;
		const sandbox = {
			id,
			name: body.name ?? null,
			namespace: "default",
			image: body.image ?? "tensorlake/ubuntu-minimal",
			status: "pending",
			pending_reason: "scheduling",
			created_at: Date.now(),
			resources: { cpus, memory_mb: memory, disk_mb: 10_240 },
			timeout_secs: body.timeout_secs ?? 600,
			sandbox_url: `https://${id}.${PROXY_DOMAIN}`,
			ingress_endpoint: `https://${id}.${PROXY_DOMAIN}`,
			auto_resume: body.auto_resume ?? true,
		};
		const one = { sandbox, body, reads: pendingReads, file: undefined, sshKey: undefined, sshUser: undefined };
		sandboxes.set(id, one);
		if (backend?.create) one.backendId = (await backend.create({ name: id, image: sandbox.image, labels: {}, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false }, { timeoutMs: 10_000 })).id;
		if (body.wait === false) return json(202, { sandbox_id: id, name: sandbox.name, state: "pending" });
		sandbox.status = "running";
		return json(200, { sandbox_id: id, status: "running", ingress_endpoint: sandbox.ingress_endpoint });
	};

	const terminate = async (one, reason = "deleted") => {
		Object.assign(one.sandbox, { status: "terminated", termination_reason: reason, sandbox_url: null });
		one.sshKey = undefined;
		if (backend?.delete && one.backendId) await backend.delete(one.backendId, { timeoutMs: 10_000 });
		if (dropTerminated) sandboxes.delete(one.sandbox.id);
	};

	/** processes/run: the labels file's write and read, as src/tensorlake.ts sends them; anything else exits 127. */
	const run = (one, body) => {
		const started = { handle: `p${next++}`, pid: 4242, started_at: Date.now() };
		const [sudo, ...args] = [body.command, ...(body.args ?? [])];
		if (sudo !== "sudo" || args[0] !== "-n" || args[1] !== "sh" || args[2] !== "-c") return events([started, { line: `sh: ${sudo}: not run here`, timestamp: Date.now(), stream: "stderr" }, { exit_code: 127, signal: null, oom_killed: false }]);
		const [script, , ...positional] = args.slice(3);
		if (script.includes("printf %s")) {
			one.file = positional[0];
			return events([started, { exit_code: 0, signal: null, oom_killed: false }]);
		}
		if (script.startsWith("[ -f ")) {
			if (one.file === undefined) return events([started, { exit_code: 3, signal: null, oom_killed: false }]);
			// The processes API answers output as lines, their line ends dropped (O SandboxProcessOutputEvent).
			const lines = one.file.split("\n").map((line) => ({ line, timestamp: Date.now(), stream: "stdout" }));
			return events([started, ...lines, { exit_code: 0, signal: null, oom_killed: false }]);
		}
		return events([started, { line: "unknown script", timestamp: Date.now(), stream: "stderr" }, { exit_code: 127, signal: null, oom_killed: false }]);
	};

	const proxied = async (host, method, pathname, headers, body, signal) => {
		const id = host.slice(0, -PROXY_DOMAIN.length - 1);
		const one = sandboxes.get(id);
		if (headers.Authorization !== `Bearer ${key}`) return proxyError(401, "UNAUTHORIZED", "invalid API key");
		if (headers["X-Tensorlake-Sandbox-Id"] !== id) return proxyError(400, "BAD_REQUEST", "X-Tensorlake-Sandbox-Id does not match the host");
		if (one === undefined || one.sandbox.status === "terminated") return proxyError(404, "SANDBOX_NOT_FOUND", `sandbox ${id} not found`);
		if (one.sandbox.status === "suspended" && !one.sandbox.auto_resume) return proxyError(409, "SANDBOX_AUTO_RESUME_DISABLED", `sandbox ${id} is suspended and auto_resume is disabled`);
		if (one.sandbox.status !== "running") return proxyError(502, "SANDBOX_NOT_RUNNING", `sandbox ${id} is ${one.sandbox.status}`);
		if (method === "POST" && pathname === "/api/v1/ssh/enable") {
			if (typeof body?.proxy_pubkey !== "string" || !body.proxy_pubkey.startsWith("ssh-")) return proxyError(400, "BAD_REQUEST", "proxy_pubkey must be an OpenSSH public key");
			// Unverified: an enable with another key replaces the one before.
			one.sshKey = body.proxy_pubkey;
			one.sshUser = body.backend_user ?? "tl-user";
			return json(200, { enabled: true, pid: 77, host_key_fingerprint: ssh.fingerprint });
		}
		if (method === "POST" && pathname === "/api/v1/processes/run") {
			const own = await proxy.script?.(body, one, signal);
			if (own instanceof Response) return own;
			if (Array.isArray(own)) return events(own);
			return run(one, body);
		}
		return proxyError(404, "NOT_FOUND", `no route ${method} ${pathname}`);
	};

	const fetch = async (url, init = {}) => {
		const { host, pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const headers = { ...init.headers };
		const raw = typeof init.body === "string" ? init.body : undefined;
		const body = raw === undefined ? undefined : JSON.parse(raw);
		calls.push({ method, host, path: pathname, query: Object.fromEntries(searchParams), headers, body });
		const failing = failures.findIndex((one) => one.method === method && one.path.test(pathname));
		if (failing >= 0) {
			const [{ response }] = failures.splice(failing, 1);
			return typeof response === "function" ? response(init) : response;
		}
		if (host.endsWith(`.${PROXY_DOMAIN}`)) return proxied(host, method, pathname, headers, body, init.signal);
		if (!url.startsWith(`${API_URL}/`)) return text(502, "bad gateway");
		if (headers.Authorization !== `Bearer ${key}`) return text(401, "Unauthorized: invalid API key");
		if (method === "POST" && pathname === "/sandboxes") return create(body ?? {});
		if (method === "GET" && pathname === "/sandboxes") {
			const all = [...sandboxes.values()].filter((one) => overList || one.sandbox.status !== "terminated");
			const from = Number(searchParams.get("cursor") ?? 0);
			const size = Math.min(pageSize, Number(searchParams.get("limit") ?? 100));
			const more = from + size < all.length;
			return json(200, { sandboxes: all.slice(from, from + size).map(view), ...(more ? { next_cursor: String(from + size) } : {}) });
		}
		const named = /^\/sandboxes\/([^/]+)$/.exec(pathname);
		if (named) {
			const one = find(decodeURIComponent(named[1]));
			if (one === undefined) return text(404, `sandbox ${decodeURIComponent(named[1])} not found`);
			if (method === "GET") {
				if (one.sandbox.status === "pending" && !capacity) await terminate(one, "no_capacity");
				else if (one.sandbox.status === "pending" && one.reads-- <= 0) Object.assign(one.sandbox, { status: "running", pending_reason: null });
				return json(200, view(one));
			}
			if (method === "DELETE") {
				if (one.sandbox.status !== "terminated") await terminate(one);
				return new Response(null, { status: 200 });
			}
		}
		return text(404, `no route ${method} ${pathname}`);
	};
	return { fetch, calls, sandboxes, ssh, proxy, find, live: () => [...sandboxes.values()].filter((one) => one.sandbox.status !== "terminated"), fail: (method, path, response) => failures.push({ method, path, response }) };
}

/**
 * The tunnel and the sshd: a tunnel opens for the project's key with the sandbox's id, to a sandbox that runs with SSH
 * enabled; the sshd takes, as tl-user, the key the sandbox's last enable named. A command runs on backend when one is
 * given, else as bash here; gateway.script(command, stream, one), when set, may answer a command itself (true).
 */
export async function fakeGateway(rest, { key = KEY, backend } = {}) {
	const routes = new Map();
	const exec = backend ? withSh(backend) : undefined;
	const gateway = { script: undefined };
	const sshd = await fakeSshd({
		user: "tl-user",
		routes,
		authorized: (id) => {
			const one = rest.sandboxes.get(id);
			return one?.sshKey && one.sandbox.status === "running" ? [one.sshKey] : [];
		},
		run: (command, stream, { instance }) => {
			const one = rest.sandboxes.get(instance);
			if (gateway.script?.(command, stream, one)) return true;
			return exec ? onBackend(exec, one?.backendId ?? instance, command, stream) : false;
		},
	});
	const ws = fakeWebSocket({
		port: sshd.port,
		routes,
		reach: (url, headers) => {
			const { hostname, pathname, searchParams } = new URL(url);
			const id = hostname.slice(0, -PROXY_DOMAIN.length - 1);
			const one = rest.sandboxes.get(id);
			const admitted = headers.Authorization === `Bearer ${key}` && headers["X-Tensorlake-Sandbox-Id"] === id && pathname === "/api/v1/tunnels/tcp" && searchParams.get("port") === "22";
			return admitted && one?.sandbox.status === "running" ? id : undefined;
		},
	});
	rest.ssh.fingerprint = fingerprintOf(sshd.hostKey);
	return Object.assign(gateway, { sshd, ws, routes });
}

/** Both, wired: the provider's options reach the fake API and proxies, and the WebSocket the tunnel to the sshd. */
export async function fakeTensorlake(options = {}) {
	const rest = fakeRest(options);
	const gateway = await fakeGateway(rest, options);
	return { rest, gateway, sshd: gateway.sshd, ws: gateway.ws, options: { apiKey: KEY, ssh2, fetch: rest.fetch, WebSocket: gateway.ws.WebSocket, apiUrl: API_URL } };
}
