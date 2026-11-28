// A fake InstaBox for the unit tests: its REST API as a fetch, in the shapes of its API reference and OpenAPI
// (https://api.instabox.sh/v1/openapi.json): a create that answers an operation and needs an Idempotency-Key, machines
// read by id or name, listed by metadata and deleted with X-Confirm-Delete, SSH tokens, and the {error: {code, message}}
// envelope; and its SSH gateway as ssh2's Server on loopback (fake-agent37.mjs's sshd), which takes a token as the
// username with no key (SSH's none auth) and presents the host key whose sha256 the token's answer names. The parts the
// docs leave open are this fake's guesses, each pinned as unverified in src/instabox.ts: a taken name answers 409; the
// gateway takes none auth with the token.
//
// A command runs as the test machine's bash (the exec pre-check), or on backend's exec (fake-host.mjs's machines, for the
// conformance suite) under withSh, which plays the pid wrapper and its kill. gateway.script(command, stream, machine),
// when set, may answer a command itself (true).
import ssh2 from "ssh2";
import { fakeSshd, fingerprintOf } from "./fake-agent37.mjs";
import { wordsOf } from "./fake-shell.mjs";
import { withSh } from "./fake-text-host.mjs";

export const KEY = "fake-test-key-instabox";
export const API_URL = "https://api.instabox.test";

/** The fields POST /v1/machines takes (docs: create fields); another is 400 unknown_field. */
const FIELDS = new Set(["name", "templateId", "snapshotId", "vcpus", "memMiB", "metadata", "autoSuspendAfterSeconds", "maxRunMinutes", "deleteAfterSeconds", "archiveSeconds", "guestUser", "vault", "secrets", "env", "failFast", "desiredState", "persistentDiskGiB"]);
/** The sizes a paid plan may name (docs: sizes): vCPUs and memory in MiB. */
const SIZES = new Set(["2/4096", "4/8192", "8/16384", "16/32768", "32/65536"]);
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, code, message, more = {}) => json(status, { error: { code, message, requestId: "req_fake", retryable: status === 429 || status === 503, ...more } });
const base32 = (n, width) => n.toString(32).padStart(width, "0");

/**
 * The REST API. Each machine answers creating once, then running and ready. pageSize is the listing's; ignoreFilter
 * makes the listing answer every machine whatever metadata it asks for, records of deleted ones too (over-return); busyDeletes is how many deletes
 * answer 409 operation_conflict first (the create's operation still running); deletingReads is how many reads a deleted
 * machine answers deleting before 404, and keepDeleted keeps it after as a record in state deleted. plan "free" refuses
 * an idle pause other than 1800 s (403 spec_not_allowed). fail(method, path, response) answers the next call matching
 * once; calls lists every call, its method, path, query, headers and body.
 */
export function fakeRest({ key = KEY, pageSize = 2, ignoreFilter = false, busyDeletes = 0, deletingReads = 1, keepDeleted = false, plan = "pro", backend } = {}) {
	const machines = new Map();
	const tokens = new Map();
	const idempotent = new Map();
	const calls = [];
	const failures = [];
	const gateway = { host: "127.0.0.1", port: 1, fingerprint: "SHA256:none" };
	let next = 1;
	let busy = busyDeletes;
	const find = (idOrName) => machines.get(idOrName) ?? [...machines.values()].find((one) => one.machine.name === idOrName);
	const view = (one) => structuredClone(one.machine);

	const create = async (body) => {
		const unknown = Object.keys(body).find((field) => !FIELDS.has(field));
		if (unknown) return refuse(400, "unknown_field", `unknown field ${unknown}`);
		if (body.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.name)) return refuse(400, "bad_request", "name must be 1-63 lowercase letters, digits or -");
		if (body.name !== undefined && find(body.name)) return refuse(409, "conflict", `a sandbox named ${body.name} already exists`);
		const metadata = body.metadata ?? {};
		const keys = Object.keys(metadata);
		if (keys.length > 32 || keys.some((one) => !METADATA_KEY.test(one)) || Object.values(metadata).some((value) => typeof value !== "string" || value.length > 512) || JSON.stringify(metadata).length > 8192) return refuse(400, "bad_request", "metadata: 32 keys of 1-64 [A-Za-z0-9_.-], values up to 512 characters, 8 KiB as JSON");
		if ((body.vcpus !== undefined || body.memMiB !== undefined) && !SIZES.has(`${body.vcpus}/${body.memMiB}`)) return refuse(400, "spec_not_allowed", `${body.vcpus} vCPUs and ${body.memMiB} MiB is not a size of your plan`);
		if (body.deleteAfterSeconds !== undefined && !(Number.isSafeInteger(body.deleteAfterSeconds) && body.deleteAfterSeconds >= 60 && body.deleteAfterSeconds <= 86_400)) return refuse(400, "bad_request", "deleteAfterSeconds is 60 to 86400");
		if (plan === "free" && body.autoSuspendAfterSeconds !== undefined && body.autoSuspendAfterSeconds !== 1800) return refuse(403, "spec_not_allowed", "the free plan pauses after 30 idle minutes", { hint: "upgrade to Pro to change the idle pause" });
		const id = `m_${base32(next++, 26)}`;
		const now = new Date();
		const machine = {
			id,
			name: body.name ?? `box-${base32(next, 8)}`,
			state: "creating",
			runtime: { ready: false },
			metadata,
			createdAt: now.toISOString(),
			...(body.deleteAfterSeconds ? { deleteAt: new Date(now.getTime() + body.deleteAfterSeconds * 1000).toISOString() } : {}),
			autoSuspendAfterSeconds: body.autoSuspendAfterSeconds === 0 ? null : (body.autoSuspendAfterSeconds ?? 1800),
			maxRunMinutes: body.maxRunMinutes ?? -1,
			guestUser: "user",
			spec: { vcpus: body.vcpus ?? 4, memMiB: body.memMiB ?? 8192, persistentDiskGiB: 20 },
			template: { id: body.templateId ?? "agent-browser", version: "1", digest: "sha256:fake" },
		};
		const one = { machine, body, reads: 0, deletingReads };
		machines.set(id, one);
		if (backend?.create) one.backendId = (await backend.create({ name: machine.name, image: machine.template.id, labels: {}, lifetimeMs: 600_000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false }, { timeoutMs: 10_000 })).id;
		return json(202, { id: `op_${base32(next++, 26)}`, machineId: id, type: "create", state: "queued", createdAt: now.toISOString() });
	};

	const remove = async (one) => {
		one.machine.state = "deleting";
		one.machine.runtime = { ready: false };
		for (const [token, held] of tokens) if (held.machineId === one.machine.id) tokens.delete(token);
		if (backend?.delete && one.backendId) await backend.delete(one.backendId, { timeoutMs: 10_000 });
		return json(202, { id: `op_${base32(next++, 26)}`, machineId: one.machine.id, type: "delete", state: "queued" });
	};

	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const headers = { ...init.headers };
		const text = typeof init.body === "string" ? init.body : undefined;
		const body = text === undefined ? undefined : JSON.parse(text);
		calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), metadata: searchParams.getAll("metadata"), headers, body });
		if (!url.startsWith(`${API_URL}/`)) return refuse(502, "internal", "bad gateway");
		const failing = failures.findIndex((one) => one.method === method && one.path.test(pathname));
		if (failing >= 0) {
			const [{ response }] = failures.splice(failing, 1);
			return typeof response === "function" ? response() : response;
		}
		if (headers["X-API-Key"] !== key) return refuse(401, "invalid_key", "The API key is not valid");
		const lifecycle = method === "POST" && pathname === "/v1/machines";
		if ((lifecycle || method === "DELETE") && !/\/ssh-tokens/.test(pathname) && !headers["Idempotency-Key"]) return refuse(400, "bad_request", "Idempotency-Key is required");
		if (lifecycle) {
			const held = idempotent.get(headers["Idempotency-Key"]);
			if (held && held.text !== text) return refuse(409, "idempotency_conflict", "this Idempotency-Key was used for another request");
			if (held) return json(held.status, held.body);
			const answer = await create(body ?? {});
			if (answer.ok) idempotent.set(headers["Idempotency-Key"], { text, status: answer.status, body: await answer.clone().json() });
			return answer;
		}
		if (method === "GET" && pathname === "/v1/machines") {
			const asked = searchParams.getAll("metadata").map((pair) => [pair.slice(0, pair.indexOf(":")), pair.slice(pair.indexOf(":") + 1)]);
			const all = [...machines.values()].filter((one) => ignoreFilter || (one.machine.state !== "deleted" && asked.every(([name, value]) => one.machine.metadata[name] === value)));
			const from = Number(searchParams.get("cursor") ?? 0);
			const size = Math.min(pageSize, Number(searchParams.get("limit") ?? 50));
			const more = from + size < all.length;
			return json(200, { machines: all.slice(from, from + size).map(view), nextCursor: more ? String(from + size) : null });
		}
		const named = /^\/v1\/machines\/([^/]+)$/.exec(pathname);
		if (named) {
			const one = find(decodeURIComponent(named[1]));
			if (one === undefined) return refuse(404, "not_found", "sandbox not found");
			if (method === "GET") {
				const answer = view(one);
				if (one.machine.state === "creating") Object.assign(one.machine, { state: "running", runtime: { ready: true } });
				else if (one.machine.state === "deleting" && one.deletingReads-- <= 0) {
					if (keepDeleted) one.machine.state = "deleted";
					else machines.delete(one.machine.id);
				}
				return json(200, answer);
			}
			if (method === "DELETE") {
				const confirm = headers["X-Confirm-Delete"];
				if (confirm !== one.machine.id && confirm !== one.machine.name) return refuse(409, "delete_confirmation_required", `send X-Confirm-Delete: ${one.machine.id}`);
				if (busy > 0) {
					busy--;
					return refuse(409, "operation_conflict", "another operation is running on this sandbox");
				}
				if (one.machine.state === "deleting" || one.machine.state === "deleted") return json(202, { id: `op_${base32(next++, 26)}`, machineId: one.machine.id, type: "delete", state: "succeeded" });
				return remove(one);
			}
		}
		const minting = /^\/v1\/machines\/([^/]+)\/ssh-tokens$/.exec(pathname);
		if (minting && method === "POST") {
			const one = find(decodeURIComponent(minting[1]));
			if (one === undefined || one.machine.state === "deleting" || one.machine.state === "deleted") return refuse(404, "not_found", "sandbox not found");
			const token = `ibssh_${base32(next++, 26)}`;
			const id = `cn_${base32(next++, 26)}`;
			tokens.set(token, { id, machineId: one.machine.id, body });
			return json(201, { id, name: body?.name ?? "", machineId: one.machine.id, host: gateway.host, port: gateway.port, token, command: `ssh -p ${gateway.port} ${token}@${gateway.host}`, expiresAt: new Date(Date.now() + (body?.ttlSeconds ?? 604_800) * 1000).toISOString(), hostKeyFingerprint: gateway.fingerprint });
		}
		const revoking = /^\/v1\/machines\/([^/]+)\/ssh-tokens\/([^/]+)$/.exec(pathname);
		if (revoking && method === "DELETE") {
			for (const [token, held] of tokens) if (held.id === revoking[2]) tokens.delete(token);
			return new Response(null, { status: 204 });
		}
		return refuse(404, "not_found", `no route ${method} ${pathname}`);
	};
	return { fetch, calls, machines, tokens, gateway, find, fail: (method, path, response) => failures.push({ method, path, response }) };
}

/** The ssh2 stream of a command run on backend's exec under withSh: stdin in, stdout and stderr out, then its exit. */
export function onBackend(exec, id, command, stream) {
	void (async () => {
		let proc;
		try {
			proc = await exec(id, wordsOf(command), { timeoutMs: 10_000 });
		} catch (error) {
			stream.stderr.write(`${error.message}\n`);
			stream.exit(127);
			return stream.end();
		}
		stream.on("data", (data) => void proc.write(new Uint8Array(data)).catch(() => {}));
		stream.on("end", () => void proc.end().catch(() => {}));
		stream.on("error", () => {});
		const pump = async (from, to) => {
			for await (const chunk of from) to.write(Buffer.from(chunk));
		};
		await Promise.all([pump(proc.stdout, stream), pump(proc.stderr, stream.stderr)]).catch(() => {});
		const code = await proc.wait().catch(() => -1);
		stream.exit(code < 0 ? 255 : code);
		stream.end();
	})();
	return true;
}

/**
 * The SSH gateway: a login is a token the REST API minted for a machine it has, by SSH's none auth (no key). logins
 * lists each attempt, its username and method. A command runs on backend when one is given, else as bash here.
 */
export async function fakeGateway(rest, { backend } = {}) {
	const logins = [];
	const exec = backend ? withSh(backend) : undefined;
	const gateway = { script: undefined };
	const sshd = await fakeSshd({
		accept: (ctx) => {
			logins.push({ username: ctx.username, method: ctx.method });
			const held = rest.tokens.get(ctx.username);
			return ctx.method === "none" && held !== undefined && rest.machines.get(held.machineId)?.machine.state === "running";
		},
		run: (command, stream, { username }) => {
			const machine = rest.machines.get(rest.tokens.get(username)?.machineId);
			if (gateway.script?.(command, stream, machine)) return true;
			return exec ? onBackend(exec, machine?.backendId ?? machine?.machine.id, command, stream) : false;
		},
	});
	Object.assign(rest.gateway, { host: "127.0.0.1", port: sshd.port, fingerprint: fingerprintOf(sshd.hostKey) });
	return Object.assign(gateway, { sshd, logins });
}

/** Both, wired: the provider's options reach the fake REST API, and its tokens name the gateway on loopback. */
export async function fakeInstabox(options = {}) {
	const rest = fakeRest(options);
	const gateway = await fakeGateway(rest, options);
	return { rest, gateway, sshd: gateway.sshd, options: { apiKey: KEY, ssh2, fetch: rest.fetch, apiUrl: API_URL } };
}
