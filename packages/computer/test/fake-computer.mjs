// A fake provider whose computers are records in memory, each with a fake daemon on an in-memory stream: hello, ping,
// exec.run (which echoes its arguments) and files.mkdir. Every other method is unsupported. No Docker, no daemon.
import { PassThrough } from "node:stream";
import { DaemonClient } from "../dist/index.js";

const fail = (code, message) => ({ ok: false, error: { code, message } });
const ok = (value) => ({ ok: true, value });
const b64 = (text) => Buffer.from(text).toString("base64");

/** A daemon's end of a connection: answers each request line. */
function fakeDaemon(hello, onClose) {
	const toDaemon = new PassThrough();
	const fromDaemon = new PassThrough();
	let buffered = "";
	toDaemon.on("data", (chunk) => {
		buffered += chunk.toString("utf8");
		let at;
		while ((at = buffered.indexOf("\n")) >= 0) {
			const request = JSON.parse(buffered.slice(0, at));
			buffered = buffered.slice(at + 1);
			if (typeof request.id !== "number") continue;
			const reply = (body) => fromDaemon.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`);
			if (request.method === "hello") reply({ result: hello });
			else if (request.method === "ping") reply({ result: {} });
			else if (request.method === "exec.run") {
				reply({ result: { exitCode: 0, stdout: b64(`${request.params.argv.slice(1).join(" ")}\n`), stderr: "", timedOut: false, truncated: false } });
			} else if (request.method === "files.mkdir") reply({ result: {} });
			else reply({ error: { code: -32601, message: `${request.method} is not a method` } });
		}
	});
	toDaemon.on("finish", onClose);
	return { readable: fromDaemon, writable: toDaemon };
}

/**
 * The provider, and what it saw: `made` (every computer's name and labels), `alive()` (names not yet deleted),
 * `calls` (list and release calls), `open()` (connections not yet closed).
 */
export function fakeComputers({
	id = "fake",
	version = "1.0.0",
	daemon = ["exec", "files", "processes"],
	hello = {},
	network = ["none"],
	lifetime = "janitor",
	failCreate,
	keepOnRelease = false,
} = {}) {
	const computers = new Map();
	const made = [];
	const calls = [];
	let connections = 0;
	let next = 0;
	const provider = {
		id,
		version,
		capabilities: () => ({ lifetime, network, isolation: "container", os: "linux", daemon }),
		check(spec) {
			const refusals = [];
			if (!(Number.isSafeInteger(spec.lifetimeMs) && spec.lifetimeMs > 0)) refusals.push({ field: "lifetimeMs", message: "lifetimeMs is required" });
			const kind = typeof spec.network === "string" ? spec.network : "allow";
			if (!network.includes(kind)) refusals.push({ field: "network", message: `network ${kind} is not offered` });
			return refusals;
		},
		async create(spec) {
			if (failCreate) return fail("refused", failCreate);
			const refusals = provider.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((r) => r.message).join("; "));
			const name = `fake-${++next}`;
			const record = { ref: { id: `id-${next}`, name }, labels: { ...spec.labels }, network: spec.network, deadline: new Date(Date.now() + spec.lifetimeMs), state: "running" };
			computers.set(name, record);
			made.push({ name, labels: record.labels });
			return ok(record.ref);
		},
		async attach(ref) {
			const found = [...computers.values()].filter((c) =>
				"id" in ref ? c.ref.id === ref.id : Object.entries(ref.labels).every(([k, v]) => c.labels[k] === v),
			);
			if (found.length === 0) return fail("not_found", "no such computer");
			if (found.length > 1) return fail("invalid", `${found.length} computers match`);
			return ok(found[0].ref);
		},
		async list(labels) {
			calls.push(["list", labels]);
			const found = [...computers.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v));
			return ok(found.map((c) => ({ ref: c.ref, labels: c.labels, deadline: c.deadline, state: c.state, network: c.network })));
		},
		async network(ref, policy) {
			const record = computers.get(ref.name);
			if (!record) return fail("not_found", `no computer ${ref.name}`);
			if (policy !== undefined && policy !== record.network) return fail("refused", "the network is fixed");
			return ok(record.network);
		},
		async connect(ref) {
			if (!computers.has(ref.name)) return fail("not_found", `no computer ${ref.name}`);
			const value = { version, os: "linux", arch: "amd64", capabilities: daemon, ...hello };
			connections++;
			let closed = false;
			const client = new DaemonClient(
				fakeDaemon(value, () => {
					if (!closed) connections--;
					closed = true;
				}),
			);
			return ok({ client, hello: value, close: async () => client.close() });
		},
		async release(ref, how) {
			calls.push(["release", ref.name, how]);
			const record = computers.get(ref.name);
			if (record && how === "stop") record.state = "stopped";
			if (record && how === "delete" && !keepOnRelease) computers.delete(ref.name);
			return ok(undefined);
		},
	};
	return { provider, made, calls, alive: () => [...computers.keys()], open: () => connections };
}
