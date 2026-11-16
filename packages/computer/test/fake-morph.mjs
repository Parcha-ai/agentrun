// A fake Morph Cloud for the unit tests: its REST API as a fetch, in the OpenAPI's shapes (InstanceModel, SnapshotModel,
// FastAPI's { detail } errors; https://cloud.morph.so/api/openapi.json), and its SSH gateway as ssh2's Server on
// loopback (fake-agent37.mjs's sshd) that takes the user "<instance id>:<key>" with any public key, as Morph's does. A
// command runs as the test machine's bash, except the box build's (anything under /tmp/agentrun-box), which the gateway
// answers itself, so a test never runs install.sh here.
import ssh2 from "ssh2";
import { fakeSshd } from "./fake-agent37.mjs";

export const KEY = "morph_fake_key_0123456789abcdef";
export const API_URL = "https://morph.test/api";

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const detail = (status, words) => json(status, { detail: words });

/**
 * The REST API. Instances answer pending once, then ready. ttl decides what POST /instance/{id}/ttl counts from: "now"
 * (default) or "added" (the old end plus the seconds). fail(method, path, response) answers the next call matching with
 * response once; calls lists every call, its method, path, query, auth and body.
 */
export function fakeRest({ key = KEY, ttl = "now" } = {}) {
	const instances = new Map();
	const snapshots = new Map();
	const calls = [];
	const failures = [];
	let next = 0;
	const now = () => Math.floor(Date.now() / 1000);
	const ttlOf = (seconds, action, from = now()) => ({ ttl_seconds: seconds ?? null, ttl_expire_at: seconds == null ? null : from + seconds, ttl_action: action ?? "stop" });
	const snapshot = (fields) => {
		const made = { id: `snapshot_${String(next++).padStart(6, "0")}`, object: "snapshot", created: now() + next, status: "ready", digest: null, metadata: {}, spec: { vcpus: 1, memory: 128, disk_size: 700 }, refs: { image_id: "morphvm-minimal" }, ttl: { ttl_seconds: null }, ...fields };
		snapshots.set(made.id, made);
		return made;
	};
	const fetch = async (url, init = {}) => {
		const { pathname, searchParams } = new URL(url);
		const method = init.method ?? "GET";
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		const auth = init.headers?.Authorization;
		calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), auth, body });
		if (!url.startsWith(`${API_URL}/`)) return detail(502, "bad gateway");
		const failing = failures.findIndex((one) => one.method === method && one.path.test(pathname));
		if (failing >= 0) {
			const [{ response }] = failures.splice(failing, 1);
			return typeof response === "function" ? response() : response;
		}
		if (auth !== `Bearer ${key}`) return detail(401, "Invalid API key");
		const path = pathname.slice("/api".length);
		if (path === "/instance" && method === "POST") {
			if (!snapshots.has(body?.snapshot_id)) return detail(404, `Snapshot ${body?.snapshot_id} not found`);
			const id = `morphvm_${String(next++).padStart(8, "0")}`;
			const instance = { id, object: "instance", created: now(), status: "pending", metadata: body.metadata ?? {}, spec: { vcpus: 2, memory: 4096, disk_size: 16384 }, refs: { snapshot_id: body.snapshot_id, image_id: "morphvm-minimal" }, networking: { internal_ip: "10.0.0.2", http_services: [] }, ttl: ttlOf(body.ttl_seconds, body.ttl_action), wake_on: {} };
			instances.set(id, instance);
			return json(200, instance);
		}
		if (path === "/instance" && method === "GET") return json(200, { object: "list", data: [...instances.values()] });
		if (path === "/snapshot" && method === "POST") return json(200, snapshot({ status: "pending", digest: body.digest ?? null, metadata: body.metadata ?? {}, spec: { vcpus: body.vcpus, memory: body.memory, disk_size: body.disk_size }, refs: { image_id: body.image_id } }));
		if (path === "/snapshot" && method === "GET") {
			const digest = searchParams.get("digest");
			return json(200, { object: "list", data: [...snapshots.values()].filter((one) => digest === null || one.digest === digest) });
		}
		const one = /^\/snapshot\/([^/]+)$/.exec(path);
		if (one) {
			const found = snapshots.get(one[1]);
			if (!found) return detail(404, "Snapshot not found");
			if (method === "DELETE") {
				snapshots.delete(found.id);
				return new Response(null, { status: 204 });
			}
			const answer = { ...found };
			if (found.status === "pending") found.status = "ready";
			return json(200, answer);
		}
		const match = /^\/instance\/([^/]+)(\/[a-z]+)?$/.exec(path);
		const instance = match ? instances.get(match[1]) : undefined;
		if (!match) return detail(404, "Not Found");
		if (!instance) return detail(404, `Instance ${match[1]} not found`);
		const [, , action] = match;
		if (action === undefined && method === "GET") {
			const answer = { ...instance };
			if (instance.status === "pending") instance.status = "ready";
			return json(200, answer);
		}
		if (action === undefined && method === "DELETE") {
			instances.delete(instance.id);
			return new Response(null, { status: 204 });
		}
		if (action === "/ttl" && method === "POST") {
			const from = ttl === "added" ? (instance.ttl.ttl_expire_at ?? now()) : now();
			instance.ttl = ttlOf(body.ttl_seconds, body.ttl_action ?? instance.ttl.ttl_action, from);
			return json(200, instance);
		}
		if (action === "/metadata" && method === "POST") {
			instance.metadata = { ...instance.metadata, ...body };
			return json(200, instance);
		}
		if (action === "/snapshot" && method === "POST") return json(200, snapshot({ digest: body?.digest ?? null, metadata: body?.metadata ?? {}, refs: { image_id: "morphvm-minimal" } }));
		return detail(405, "Method Not Allowed");
	};
	return {
		fetch,
		instances,
		snapshots,
		calls,
		snapshot,
		fail: (method, path, response) => failures.push({ method, path, response }),
	};
}

/**
 * The SSH gateway: a login is "<id>:<key>" for an instance the REST API has, with any public key. The box build's
 * commands are answered here: the pid line, stdin read to its end, then exit build.exit (0) for install.sh and 0 else;
 * build.commands lists them, build.uploads the bytes of each upload, as base64 text.
 */
export async function fakeGateway(rest, { key = KEY } = {}) {
	const build = { commands: [], uploads: [], exit: 0 };
	const logins = [];
	const sshd = await fakeSshd({
		accept: (ctx) => {
			logins.push({ username: ctx.username, method: ctx.method });
			const [id, given] = ctx.username.split(/:(.*)/s);
			return ctx.method === "publickey" && given === key && rest.instances.has(id);
		},
		run: (command, stream) => {
			if (!command.includes("/tmp/agentrun-box")) return false;
			build.commands.push(command);
			stream.stderr.write("4242 4242\n");
			const input = [];
			stream.on("data", (data) => input.push(data));
			stream.on("end", () => {
				if (input.length > 0) build.uploads.push(Buffer.concat(input).toString("latin1"));
				stream.exit(command.includes("install.sh &&") ? build.exit : 0);
				stream.end();
			});
			return true;
		},
	});
	return { sshd, build, logins };
}

/** Both, wired: the provider's options reach the fake REST API and the gateway on loopback. */
export async function fakeMorph(options = {}) {
	const rest = fakeRest(options);
	const gateway = await fakeGateway(rest, options);
	return { rest, ...gateway, options: { apiKey: KEY, ssh2, fetch: rest.fetch, apiUrl: API_URL, sshHost: "127.0.0.1", sshPort: gateway.sshd.port } };
}
