// A fake of the slice of Modal's JS SDK that ModalProvider takes (modal-client@64880502:js/src), for its unit tests. It
// records every call and plays the SDK's documented behaviour: apps.fromName; images.fromRegistry and
// dockerfileCommands, which build nothing; sandboxes.create, which keeps the tags it is given (sandbox.ts:808-867);
// fromId, which makes a handle with no call (sandbox.ts:960-962); list, of running sandboxes that carry every tag
// asked for (sandbox.ts:1116-1139); a sandbox's getTags, poll (null while it runs), terminate (idempotent here; the
// sandbox finishes with 137, guide/sandboxes "Return Codes"; with `lingers`, as Modal's own end is asynchronous, poll
// reads it running and list still lists it for some reads after) and exec, which throws ConflictError once the sandbox has
// finished (sandbox.ts:2149-2154). exec of the daemon's stdio bridge answers hello, ping and exec.run of the probe as
// computerd would. exec of the provider's upload command reads the daemon from stdin, as `cat` would, prints its sha256
// and installs it only when it is the one the command names, as the script does; a sandbox whose command is the
// provider's entrypoint has no daemon until then. No Modal client is ever constructed here, and nothing reaches the
// network.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const VERSION = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")).version;
export const DAEMON = "/opt/agentrun/computerd";
export const DAEMON_IMAGE = `ghcr.io/example/computerd@sha256:${"a".repeat(64)}`;
/** The first line of each script the provider sends, by which the fake knows it. */
export const ENTRYPOINT_MARK = "# agentrun-computer: entrypoint";
export const UPLOAD_MARK = "# agentrun-computer: upload";
/** A command that is the provider's script: sh -c <script> sh <args>. */
const isScript = (command, mark) => command?.[0] === "sh" && command[1] === "-c" && typeof command[2] === "string" && command[2].startsWith(`${mark}\n`);
export const HELLO = { version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
/** What computerd probe reports in a VM sandbox: Modal's docs show `uname -srn` there as "Linux modal 7.2.6". */
export const VM_KERNEL = "7.2.6";
/** What gVisor reports (guide/troubleshooting: "4.19.0-gvisor"). */
export const GVISOR_KERNEL = "4.19.0-gvisor";

export class NotFoundError extends Error {
	name = "NotFoundError";
}
export class ConflictError extends Error {
	name = "ConflictError";
}
export class InvalidError extends Error {
	name = "InvalidError";
}

let counter = 0;
/** A V1 sandbox id: "sb-" and 22 characters (sandbox.ts:203-211). */
const newId = () => `sb-${String(++counter).padStart(22, "0")}`;

/** A deferred: a promise and the hands that settle it. */
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Bytes as the SDK's binary streams give them: Uint8Array, never Buffer. */
const bytesOf = (text) => new Uint8Array(Buffer.from(text));

/** An async queue of Uint8Array chunks, ended by end(). */
function queue() {
	const chunks = [];
	let wake;
	let ended = false;
	return {
		push(chunk) {
			chunks.push(chunk);
			wake?.();
		},
		end() {
			ended = true;
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			for (;;) {
				if (chunks.length > 0) {
					yield chunks.shift();
					continue;
				}
				if (ended) return;
				await new Promise((resolve) => (wake = resolve));
				wake = undefined;
			}
		},
	};
}

/**
 * The daemon's stdio bridge in one sandbox, as a ContainerProcess in binary mode: requests written to stdin are
 * answered on stdout. `box` holds what this sandbox's daemon reports: hello, and the probe's kernel, uid:gid and reached.
 */
function bridge(box, fake) {
	const stdout = queue();
	const stderr = queue();
	const exited = deferred();
	let buffered = "";
	let closed = false;
	const end = (code) => {
		if (closed) return;
		closed = true;
		stdout.end();
		stderr.end();
		exited.resolve(code);
	};
	// Init not yet listening: the bridge finds no socket, as when it runs before init has made one.
	const listening = box.daemon && !(box.notListening > 0);
	if (box.daemon && box.notListening > 0) box.notListening--;
	if (!listening) {
		stderr.push(bytesOf(`computerd stdio: no daemon listens at /run/agentrun/computerd.sock (connect: no such file or directory)\n`));
		queueMicrotask(() => end(1));
	}
	const answer = (request) => {
		const reply = (body) => stdout.push(bytesOf(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`));
		if (request.method === "hello") return reply({ result: box.hello });
		if (request.method === "ping") return reply({ result: {} });
		if (request.method === "exec.run") {
			fake.execRuns.push({ sandbox: box.id, params: request.params });
			const argv = request.params.argv;
			if (argv[0] === DAEMON && argv[1] === "probe") {
				if (box.probe === "fails") return reply({ result: { exitCode: 2, stdout: "", stderr: Buffer.from("probe: usage\n").toString("base64"), timedOut: false, truncated: false } });
				if (box.probe === "hangs") return;
				const targets = argv.slice(2).filter((_, i) => i % 2 === 1);
				const reached = box.network === "none" ? [] : targets;
				const report = { uid: box.uid, gid: box.gid, kernel: box.kernel, reached: box.reached ?? reached };
				const text = box.probe === "garbled" ? "not json\n" : `${JSON.stringify(report)}\n`;
				return reply({ result: { exitCode: 0, stdout: Buffer.from(text).toString("base64"), stderr: "", timedOut: false, truncated: false } });
			}
			return reply({ result: { exitCode: 0, stdout: Buffer.from(`${argv.join(" ")}\n`).toString("base64"), stderr: "", timedOut: false, truncated: false } });
		}
		return reply({ error: { code: -32601, message: `${request.method} is not a method`, data: { kind: "unsupported" } } });
	};
	const process = {
		stdin: {
			async writeBytes(bytes) {
				if (closed) throw new Error("the stream is closed");
				buffered += Buffer.from(bytes).toString("utf8");
				let at;
				while ((at = buffered.indexOf("\n")) >= 0) {
					const request = JSON.parse(buffered.slice(0, at));
					buffered = buffered.slice(at + 1);
					if (typeof request.id === "number" && listening && !box.silent) answer(request);
				}
			},
			async close() {
				fake.stdinClosed++;
				end(0);
			},
		},
		stdout,
		stderr,
		wait: () => exited.promise,
	};
	box.bridges.push(process);
	return process;
}

/**
 * The provider's upload command in one sandbox, as a ContainerProcess in binary mode: stdin is the daemon, and closing
 * it runs the rest of the script. `how` is the fake's upload option.
 */
function uploader(found, command, fake, how) {
	const stdout = queue();
	const stderr = queue();
	const exited = deferred();
	const chunks = [];
	let closed = false;
	const [daemon, expected] = command.slice(4);
	const finish = (code) => {
		stdout.end();
		stderr.end();
		exited.resolve(code);
	};
	return {
		stdin: {
			async writeBytes(bytes) {
				if (closed) throw new Error("the stream is closed");
				if (!(bytes instanceof Uint8Array)) throw new TypeError("a binary-mode stdin takes Uint8Array");
				chunks.push(Buffer.from(bytes));
			},
			async close() {
				closed = true;
				let bytes = Buffer.concat(chunks);
				fake.uploads.push({ sandbox: found.id, bytes, sizes: chunks.map((chunk) => chunk.length), argv: command });
				if (how === "hang") return;
				if (how === "exit") {
					stdout.push(bytesOf(`writing the daemon to /opt/agentrun/.computerd.part failed\n`));
					stderr.push(bytesOf("cat: write error: No space left on device\n"));
					return finish(4);
				}
				if (how === "corrupt") bytes = Buffer.concat([bytes, Buffer.from("x")]);
				const sha = createHash("sha256").update(bytes).digest("hex");
				stdout.push(bytesOf(`sha256 ${how === "lie" ? "0".repeat(64) : sha}\n`));
				if (sha !== expected) {
					stdout.push(bytesOf(`the daemon written to /opt/agentrun/.computerd.part reads sha256 ${sha}, not ${expected}, so it is not moved into place\n`));
					return finish(5);
				}
				found.box.daemon = true;
				found.installed = { path: daemon, bytes };
				finish(0);
			},
		},
		stdout,
		stderr,
		wait: () => exited.promise,
	};
}

/**
 * A fake Modal client. Options:
 *  - create: "ok" (default), "fail" (throws InvalidError), "slow" (never settles until fake.release()), or "late"
 *    (settles with a sandbox only when fake.release() is called, after the provider gave up);
 *  - box: what each new sandbox's daemon and probe report, over the defaults (a VM kernel, the uid:gid of its
 *    command's --user, nothing reached when network is none);
 *  - tags: tags a new sandbox reports over those it was given (a value of undefined drops one);
 *  - sandboxes: sandboxes there before the test, each { tags, running, box };
 *  - sandboxes: sandboxes there before the test, each { tags, running, box, stuck, appId }; a stuck one runs on
 *    after terminate;
 *  - terminate: "ok" (default) or "fail";
 *  - running: whether a new sandbox runs (default true);
 *  - upload: what the upload command does: "ok" (default), "throw" (exec fails), "exit" (the script exits 4 in words),
 *    "corrupt" (the bytes written differ from those sent), "lie" (prints a sha256 that is not the file's, exits 0), or
 *    "hang" (never exits);
 *  - list: "ok" (default) or "fail" (the listing throws InvalidError);
 *  - lingers: { polls, lists }: after a terminate, poll answers null for the next `polls` polls before the sandbox
 *    finishes with 137, and list still yields it for the next `lists` listings, finished or not (default none);
 *  - bridgeMs: how long exec of the daemon's stdio bridge takes to answer with its process (default at once).
 */
export function fakeModal({ create = "ok", box = {}, tags: tagPatch = {}, sandboxes: seeded = [], terminate = "ok", running = true, upload = "ok", list = "ok", lingers, bridgeMs = 0 } = {}) {
	const calls = [];
	const sandboxes = new Map();
	const fake = { calls, sandboxes, execRuns: [], stdinClosed: 0, held: [], constructed: 0, uploads: [] };
	const record = (...call) => calls.push(call);

	const boxOf = (id, params, extra) => {
		const user = params?.command?.[params.command.indexOf("--user") + 1] ?? "1000:1000";
		const [uid, gid] = user.split(":").map(Number);
		return {
			id,
			// A sandbox started by the provider's entrypoint has no daemon until the upload puts one there.
			daemon: !isScript(params?.command, ENTRYPOINT_MARK),
			hello: { ...HELLO },
			kernel: VM_KERNEL,
			uid,
			gid,
			network: params?.blockNetwork === true ? "none" : "open",
			bridges: [],
			...extra,
		};
	};
	const add = ({ tags = {}, running: on = true, box: extra = {}, params, appId = "ap-computers", stuck = false } = {}) => {
		const id = newId();
		sandboxes.set(id, { id, appId, tags: { ...tags }, running: on, exitCode: on ? null : 0, params, box: boxOf(id, params, extra), terminated: 0, stuck });
		return id;
	};
	for (const one of seeded) add(one);

	const handle = (id) => ({
		sandboxId: id,
		async getTags() {
			record("sandbox.getTags", id);
			const found = sandboxes.get(id);
			if (!found) throw new NotFoundError(`Sandbox ${id} not found`);
			return { ...found.tags };
		},
		async poll() {
			record("sandbox.poll", id);
			const found = sandboxes.get(id);
			if (!found) throw new NotFoundError(`Sandbox ${id} not found`);
			if (found.lingering?.polls > 0) {
				found.lingering.polls--;
				return null;
			}
			if (found.lingering && found.running) Object.assign(found, { running: false, exitCode: 137 });
			return found.running ? null : found.exitCode;
		},
		async terminate() {
			record("sandbox.terminate", id);
			const found = sandboxes.get(id);
			if (!found) throw new NotFoundError(`Sandbox ${id} not found`);
			if (terminate === "fail") throw new Error("terminate failed on the server");
			found.terminated++;
			if (found.running && !found.stuck && lingers && !found.lingering) found.lingering = { polls: lingers.polls ?? 0, lists: lingers.lists ?? 0 };
			else if (found.running && !found.stuck && !lingers) Object.assign(found, { running: false, exitCode: 137 });
		},
		async exec(command, params) {
			record("sandbox.exec", id, command, params);
			const found = sandboxes.get(id);
			if (!found) throw new NotFoundError(`Sandbox ${id} not found`);
			if (!found.running) throw new ConflictError(`Sandbox ${id} has already finished`);
			if (command[0] === DAEMON && command[1] === "stdio" && command.length === 2) {
				if (bridgeMs > 0) await sleep(bridgeMs);
				return bridge(found.box, fake);
			}
			if (isScript(command, UPLOAD_MARK)) {
				if (upload === "throw") throw new Error("exec failed on the server: task command router unavailable");
				return uploader(found, command, fake, upload);
			}
			throw new Error(`the fake runs only the daemon's stdio bridge, not ${command.join(" ")}`);
		},
	});

	const sdk = {
		apps: {
			async fromName(name, params) {
				record("apps.fromName", name, params);
				return { appId: `ap-${name}` };
			},
		},
		images: {
			fromRegistry(tag) {
				record("images.fromRegistry", tag);
				const image = (layers) => ({
					tag,
					layers,
					dockerfileCommands(commands) {
						record("image.dockerfileCommands", commands);
						return image([...layers, commands]);
					},
				});
				return image([]);
			},
		},
		sandboxes: {
			create(app, image, params) {
				record("sandboxes.create", app, image, params);
				const make = () => {
					const id = add({ tags: params.tags, running, params, appId: app.appId });
					const made = sandboxes.get(id);
					for (const [key, value] of Object.entries(tagPatch)) {
						if (value === undefined) delete made.tags[key];
						else made.tags[key] = value;
					}
					Object.assign(made.box, box);
					return handle(id);
				};
				if (create === "fail") return Promise.reject(new InvalidError("Image build failed: COPY --from could not pull the image"));
				if (create === "slow" || create === "late") {
					const held = deferred();
					fake.held.push(held);
					return held.promise.then(() => {
						if (create === "slow") throw new Error("the fake's slow create never answers");
						return make();
					});
				}
				return Promise.resolve(make());
			},
			async fromId(id) {
				record("sandboxes.fromId", id);
				return handle(id);
			},
			list(params) {
				record("sandboxes.list", params);
				const matches = [...sandboxes.values()].filter(
					(one) => (one.running || one.lingering?.lists > 0) && one.appId === params.appId && Object.entries(params.tags ?? {}).every(([k, v]) => one.tags[k] === v),
				);
				for (const one of matches) if (one.lingering?.lists > 0) one.lingering.lists--;
				return (async function* () {
					if (list === "fail") throw new InvalidError("sandbox list refused: permission denied for this app");
					for (const one of matches) yield handle(one.id);
				})();
			},
		},
	};
	/** Lets every held create go on, after the provider gave up on it. */
	fake.release = async () => {
		for (const held of fake.held.splice(0)) held.resolve();
		await sleep(10);
	};
	fake.sdk = sdk;
	fake.add = add;
	/** The calls by their method name, in order. */
	fake.names = () => calls.map(([name]) => name);
	return fake;
}
