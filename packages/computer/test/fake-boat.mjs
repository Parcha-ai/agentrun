// A stand-in for boat's REST API (https://boat.dev/api/v1, its OpenAPI file): a fetch that answers in boat's envelopes
// ({ok, type, ...} and {ok:false, type:"sandbox.error", status, code, message, error:{...}, requestId}), and each
// sandbox's SSH as a real sshd stand-in on loopback (fakeSshd, ssh2's Server), started at the sandbox's first
// POST /sandboxes/{id}/sshkey and taking the keys posted there for the user `user`, who has passwordless sudo and is
// not root. The parts the docs leave open are this fake's guesses, each pinned as unverified in src/boat.ts: a deleted
// sandbox reads 404 at once; the host key is an OpenSSH line; sshEndpoint carries the port.
//
// A command runs as bash runs it here (real processes) unless a backend is given (fake-host.mjs: the adapter's fake
// machines, for the conformance suite): then the PID wrapper's line is the fake's own, and a kill by that pid kills the
// backend's process.
import { PID_KILL, PID_WRAPPER } from "../dist/hosted/scripts.js";
import ssh2 from "ssh2";
import { fakeSshd } from "./fake-agent37.mjs";
import { wordsOf } from "./fake-shell.mjs";

export const KEY = "fake-test-key-boat";
export const API_URL = "https://boat.test/api/v1";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const SIZES = { small: [2, 4], default: [4, 8], large: [8, 16], xlarge: [16, 32] };
const QUERY = new Set(["limit", "cursor", "state", "name", "namePrefix", "stoppedBefore", "dataExpired", "label", "include"]);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, code, message, details) => json(status, { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status, ...(details ? { details } : {}) }, requestId: "req_fake0001" });

/**
 * The fake. pageSize is the listing's; readyAfter is how many reads of a new sandbox answer provisioning before it
 * reads ready; ignoresLabels makes a listing answer every sandbox whatever labels it asks (a host must filter);
 * rateLimited makes every create a 429 rate_limited; hostKey "other" answers a host key that is not the sshd's,
 * "none" leaves hostKey out, "second" gives each sshd an ed25519 and an ECDSA host key and answers the ECDSA one's
 * line, and a function answers what it returns for the sandbox's sshd as hostKey (undefined leaves it out);
 * setHostKey(hostKey) changes it for the answers after. snapshots names the account's saved snapshots, which `from` may name. calls lists each REST call, its method,
 * path, query (label as a list), headers and body. sshUser false leaves sshUser out of the sshkey answer, as the
 * schema allows. clock is the time boat's auto-stop reads (default the wall clock): a sandbox past its archiveAfter
 * reads archived, as boat stops it then whatever ran in it (docs: auto-stop); a create with no ttlSeconds gets 3600.
 */
export function fakeBoat({ backend, pageSize = 2, readyAfter = 1, ignoresLabels = false, rateLimited = false, hostKey = "own", snapshots = [], sshUser = true, clock = { now: () => Date.now() } } = {}) {
	let answering = hostKey;
	const sandboxes = new Map();
	const idempotent = new Map();
	const calls = [];
	let next = 0;

	const idOf = () => {
		let n = next++;
		let id = "";
		for (let at = 0; at < 8; at++) {
			id = ALPHABET[n % ALPHABET.length] + id;
			n = Math.floor(n / ALPHABET.length);
		}
		return `bx_${id}`;
	};

	/** A sandbox of the account made outside this provider, as boat lists it. */
	const add = (name, labels = {}, state = "ready") => {
		const id = idOf();
		const sandbox = { id, name, state, labels, type: "small", vcpu: 2, memoryGB: 4, ip: "127.0.0.1", sshEndpoint: null, createdAt: new Date(clock.now()).toISOString(), archiveAfter: new Date(clock.now() + 3_600_000).toISOString(), ttlSeconds: 3600, desktopAvailable: false, snapshotAvailable: false };
		sandboxes.set(id, { sandbox, reads: readyAfter, keys: [] });
		return sandbox;
	};
	/** archiveAfter for a ttlSeconds from now: null for none. */
	const archiveAt = (ttl) => (ttl === null ? null : new Date(clock.now() + ttl * 1000).toISOString());
	/** boat's auto-stop, read when a sandbox is: past its archiveAfter, a live sandbox is archived. */
	const autoStop = (sandbox) => {
		if (["ready", "idle", "running"].includes(sandbox.state) && sandbox.archiveAfter !== null && clock.now() >= Date.parse(sandbox.archiveAfter)) sandbox.state = "archived";
		return sandbox;
	};

	/** One command on a backend machine, as its sshd would run `line`: the wrapper's pid line the fake's, a kill by it the backend's kill. */
	const pids = new Map();
	const runOn = (one) => (line, stream) => {
		const words = wordsOf(line);
		if (words[0] === "sh" && words[1] === "-c" && words[2] === PID_KILL) {
			void (async () => {
				await pids.get(words[4])?.kill();
				stream.exit(0);
				stream.end();
			})();
			return true;
		}
		const wrapped = PID_WRAPPER.every((word, at) => words[at] === word);
		void (async () => {
			const pid = String(4000 + pids.size);
			const proc = await backend.exec(one.backendId, wrapped ? words.slice(PID_WRAPPER.length) : words, { timeoutMs: 10_000 });
			pids.set(pid, proc);
			if (wrapped) stream.stderr.write(`${pid} 1\n`);
			let writes = Promise.resolve();
			stream.on("data", (bytes) => {
				stream.pause();
				writes = writes.then(() => proc.write(new Uint8Array(bytes))).catch(() => {}).finally(() => stream.resume());
			});
			stream.on("end", () => (writes = writes.then(() => proc.end()).catch(() => {})));
			stream.on("error", () => {});
			const pump = async (from, to) => {
				for await (const chunk of from) if (!to.write(Buffer.from(chunk))) await new Promise((drained) => to.once("drain", drained));
			};
			await Promise.all([pump(proc.stdout, stream), pump(proc.stderr, stream.stderr)]);
			const code = await proc.wait();
			stream.exit(code < 0 ? 255 : code);
			stream.end();
		})();
		return true;
	};

	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const query = Object.fromEntries([...searchParams.keys()].map((name) => [name, name === "label" ? searchParams.getAll(name) : searchParams.get(name)]));
		const path = pathname.replace(/^\/api\/v1/, "");
		calls.push({ method, path, query, headers, body });
		if (headers.authorization !== `Bearer ${KEY}`) return refuse(401, "unauthorized", "Missing or invalid API key");
		const named = /^\/sandboxes\/([^/]+)(\/sshkey)?$/.exec(path);
		const one = named ? sandboxes.get(decodeURIComponent(named[1])) : undefined;

		if (method === "POST" && path === "/sandboxes") {
			if (rateLimited) return refuse(429, "rate_limited", "Too many sandbox starts: 12 a minute");
			const key = headers["idempotency-key"];
			const text = JSON.stringify(body ?? {});
			const earlier = key === undefined ? undefined : idempotent.get(key);
			if (earlier !== undefined) {
				if (earlier.text !== text) return refuse(409, "idempotency_key_reused", "This Idempotency-Key was used with another request body");
				const again = sandboxes.get(earlier.id);
				return json(202, { ok: true, type: "sandbox.created", status: again.sandbox.state === "provisioning" ? "provisioning" : "ready", ttlSeconds: again.sandbox.ttlSeconds, sandbox: again.sandbox });
			}
			const labels = body?.labels ?? {};
			const bad = Object.entries(labels).find(([name, value]) => !LABEL_KEY.test(name) || typeof value !== "string" || Buffer.byteLength(value) > 256);
			if (Object.keys(labels).length > 20 || bad) return refuse(400, "invalid_request", `labels: ${bad ? `the label ${bad[0]} is not one boat takes` : "at most 20"}`);
			const type = body?.type ?? "default";
			if (!(type in SIZES)) return refuse(400, "invalid_request", `type: ${type} is not a size`);
			if (body?.ttlSeconds !== undefined && body.ttlSeconds !== null && !(Number.isInteger(body.ttlSeconds) && body.ttlSeconds >= 1 && body.ttlSeconds <= 2_592_000)) return refuse(400, "invalid_request", "ttlSeconds: 1 to 2592000");
			if (body?.from !== undefined && !snapshots.includes(body.from) && !/^bsh_/.test(body.from)) return refuse(404, "snapshot_not_found", `No saved snapshot ${body.from}`);
			const sandbox = add(body?.name ?? `Sandbox ${new Date().toISOString()}`, labels, "provisioning");
			const [vcpu, memoryGB] = SIZES[type];
			const ttl = body?.ttlSeconds === undefined ? 3600 : body.ttlSeconds;
			Object.assign(sandbox, { type, vcpu, memoryGB, ttlSeconds: ttl, archiveAfter: archiveAt(ttl) });
			const held = sandboxes.get(sandbox.id);
			held.body = body;
			if (key !== undefined) idempotent.set(key, { text, id: sandbox.id });
			if (backend?.create) held.backendId = (await backend.create({ name: body?.name ?? sandbox.id, image: body?.from ?? "ubuntu-24.04", labels, lifetimeMs: ttl * 1000, backstopAt: new Date(Date.now() + 3_600_000).toISOString(), egress: false }, { timeoutMs: 10_000 })).id;
			return json(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: ttl, sandbox });
		}

		if (method === "GET" && path === "/sandboxes") {
			const unknown = Object.keys(query).find((name) => !QUERY.has(name));
			if (unknown) return refuse(400, "invalid_query", `Unknown query parameter ${unknown}`);
			const asked = (query.label ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]);
			const all = [...sandboxes.values()]
				.map(({ sandbox }) => autoStop(sandbox))
				.filter((sandbox) => sandbox.name.startsWith(query.namePrefix ?? "") && (query.name === undefined || sandbox.name === query.name))
				.filter((sandbox) => ignoresLabels || asked.every(([name, value]) => sandbox.labels[name] === value));
			const limit = Math.min(Number(query.limit ?? 100), 200, pageSize);
			const from = Number(query.cursor ?? 0);
			const more = from + limit < all.length;
			return json(200, { ok: true, type: "sandbox.list", sandboxes: all.slice(from, from + limit), pageInfo: { nextCursor: more ? String(from + limit) : null, hasMore: more, limit } });
		}

		if (named && !named[2] && method === "GET") {
			if (one === undefined) return refuse(404, "not_found", "Sandbox not found");
			if (one.sandbox.state === "provisioning" && --one.reads < 0) one.sandbox.state = "ready";
			return json(200, { ok: true, type: "sandbox.info", sandbox: autoStop(one.sandbox) });
		}

		if (named && !named[2] && method === "PATCH") {
			if (one === undefined) return refuse(404, "not_found", "Sandbox not found");
			if (body?.labels !== undefined) one.sandbox.labels = body.labels ?? {};
			if (body?.ttlSeconds !== undefined) Object.assign(one.sandbox, { ttlSeconds: body.ttlSeconds, archiveAfter: archiveAt(body.ttlSeconds) });
			return json(200, { ok: true, type: "sandbox.info", sandbox: one.sandbox });
		}

		if (named && !named[2] && method === "DELETE") {
			if (one === undefined) return refuse(404, "not_found", "Sandbox not found");
			if (headers["x-ascii-confirm-delete"] !== one.sandbox.id) return refuse(409, "delete_confirmation_required", "Send X-Ascii-Confirm-Delete with the sandbox id");
			sandboxes.delete(one.sandbox.id);
			await one.sshd?.close();
			if (backend?.delete && one.backendId) await backend.delete(one.backendId, { timeoutMs: 10_000 });
			const operation = { id: `bdop_${"0".repeat(28)}${String(next++).padStart(4, "0")}`, kind: "sandbox", targetId: one.sandbox.id, reason: "explicit", status: "pending", attemptCount: 0, requestedAt: new Date().toISOString(), completedAt: null };
			return json(202, { ok: true, type: "deletion.accepted", operation });
		}

		if (named?.[2] && method === "POST") {
			if (one === undefined) return refuse(404, "not_found", "Sandbox not found");
			if (!["ready", "idle", "running"].includes(autoStop(one.sandbox).state)) return refuse(409, "sandbox_not_ready", `The sandbox is ${one.sandbox.state}`);
			const parsed = typeof body?.key === "string" ? ssh2.utils.parseKey(body.key) : undefined;
			if (parsed === undefined || parsed instanceof Error || parsed.isPrivateKey()) return refuse(400, "invalid_request", "key: a public SSH key in OpenSSH format");
			if (!one.keys.includes(body.key)) one.keys.push(body.key);
			one.sshd ??= await fakeSshd({ authorized: () => one.keys, username: "user", sudo: true, ...(hostKey === "second" ? { hostKeyTypes: ["ed25519", "ecdsa"] } : {}), ...(backend ? { run: runOn(one) } : {}) });
			const shown = typeof answering === "function" ? answering(one.sshd) : answering === "other" ? await otherHostKey() : answering === "second" ? one.sshd.hostKeys[1] : answering === "none" ? undefined : one.sshd.hostKey;
			return json(200, { ok: true, type: "ssh_key.configured", success: true, machineIp: "127.0.0.1", ...(sshUser ? { sshUser: "user" } : {}), sshEndpoint: `127.0.0.1:${one.sshd.port}`, ...(shown === undefined ? {} : { hostKey: shown }) });
		}

		return refuse(404, "not_found", `no route ${method} ${path}`);
	};

	return {
		fetch,
		calls,
		sandboxes,
		add,
		/** The command lines sandbox id's sshd ran, sudo and all. */
		commands: (id) => sandboxes.get(id)?.sshd?.commands ?? [],
		sshd: (id) => sandboxes.get(id)?.sshd,
		setHostKey: (value) => (answering = value),
		/** Every sandbox's sshd closed: a test's cleanup. */
		close: async () => {
			for (const one of sandboxes.values()) await one.sshd?.close();
		},
	};
}

/** A host key of no sshd here: what an impostor's would be. */
async function otherHostKey() {
	return ssh2.utils.generateKeyPairSync("ed25519").public;
}
