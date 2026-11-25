// A dial host (src/host.ts, facts.connect "dial") for the adapter's tests: the fake host (fake-host.mjs) with no exec and
// no upload, whose create "boots" each machine's agentrun-dial from its boot env: init started by AGENTRUN_INIT_ARGS, the
// daemon's sha256 held to the one the server serves, then a dial of the server's attach route with AGENTRUN_ATTACH_TOKEN
// over an in-memory socket, where the fake host's daemon answers. The server is here too: machine tokens in memory, an
// AttachHub, and the attach route's token check (a token it refuses is closed 4401 before any hello). No network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ATTACH_CLOSE, AttachHub, MemoryMachineTokens, mintedComputer } from "../dist/index.js";
import { HostedProvider } from "../dist/hosted/provider.js";
import { fakeHost } from "./fake-host.mjs";

/** The public address the fake's provider is given: http on 127.0.0.1, which a dial provider takes in tests alone. */
export const PUBLIC_URL = "http://127.0.0.1:8080";

/** Two ends of one socket, delivering in order, closing both ends at once (attach.test.mjs's). */
export function socketPair() {
	const ends = [
		{ text: [], closes: [] },
		{ text: [], closes: [] },
	];
	let closed;
	const side = (me, peer) => ({
		send(text) {
			if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text)));
		},
		close(code, reason) {
			if (closed) return;
			closed = { code, reason };
			queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
		},
		onText(listener) {
			me.text.push(listener);
		},
		onClose(listener) {
			me.closes.push(listener);
		},
		get closed() {
			return closed;
		},
	});
	return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}

/** A daemon's end of a socket: each request answered by answerOf, one JSON-RPC line per frame. */
function serveDaemon(socket, answerOf) {
	socket.onText((text) => {
		const request = JSON.parse(text);
		if (typeof request.id !== "number") return;
		const reply = answerOf(request);
		if (reply !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
	});
}

/**
 * A vendor's machine booted from `env`, the boot env as the vendor's own fake read it from its create (Fly's config.env,
 * Modal's secret, ...), so a vendor's test runs its dial path through to the desktop: agentrun-dial as the fake dial host
 * does it, init started by AGENTRUN_INIT_ARGS with the env's DISPLAY, then a dial of the server's attach route with
 * AGENTRUN_ATTACH_TOKEN, held to `tokens` (a token they refuse never reaches `hub`), where fake-host.mjs's daemon answers:
 * hello says linux until an X server was started through process.start, then desktop. `daemon`: the bytes the server
 * serves; a machine whose AGENTRUN_DAEMON_SHA256 is another runs nothing and never dials. Answers the daemon's machine
 * record (its processes, the X server among them) and the fake that answers for it (its requests).
 */
export function bootDial(env, { tokens, hub }, { daemon, arch = "amd64" }) {
	const box = fakeHost();
	const m = box.add();
	if (env.AGENTRUN_DAEMON_SHA256 !== createHash("sha256").update(daemon).digest("hex")) return { machine: m, box, dialed: false };
	const args = env.AGENTRUN_INIT_ARGS.split(" ");
	const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
	m.init = { deadline: flag("--deadline"), user: flag("--user"), display: env.DISPLAY ?? "", max: flag("--max-deadline"), network: flag("--network"), windowManager: args.includes("--window-manager") };
	const [uid, gid] = m.init.user.split(":").map(Number);
	Object.assign(m.box, { uid, gid });
	m.box.hello = { ...m.box.hello, arch };
	const [server, machine] = socketPair();
	serveDaemon(machine, (request) => box.answer(m, request));
	const minted = tokens.check(env.AGENTRUN_ATTACH_TOKEN);
	if (minted === undefined) server.close(ATTACH_CLOSE.unauthorized, "no machine has this token");
	else void hub.accept(mintedComputer(minted.machine, minted.mint), server);
	return { machine: m, box, dialed: true };
}

/** The dial server a vendor's desktop test gives its provider: machine tokens in memory and a hub, at PUBLIC_URL. */
export const dialServer = () => ({ url: PUBLIC_URL, tokens: new MemoryMachineTokens(), hub: new AttachHub({ helloMs: 1_000 }) });

let desktops = 0;
/**
 * A vendor's desktop, made by `provider` (built from its descriptor's desktop configuration) through the dial path, as a
 * test sees it through to the screen: create made it, its machine (`booted()`, bootDial's answer for it, which the
 * vendor's fake made from what its create was given) started init with DISPLAY :0 and --window-manager and dialed
 * `dial`, the X server started over that socket as computerd's process, and nothing else (computerd starts the window
 * manager); connect's hello says desktop, with the screen and the manager running, and release deletes it. Asserts
 * each, and answers the vendor's ref.
 */
export async function desktopOverDial(provider, dial, booted, spec) {
	const created = await provider.create(spec, { requestId: `desktop-${++desktops}` });
	assert.equal(created.ok, true, created.ok ? "" : `${created.error.code}: ${created.error.message}`);
	const ref = created.value;
	const { machine, dialed } = booted();
	assert.equal(dialed, true, "the machine's daemon is the server's: it dialed");
	assert.equal(machine.init.display, ":0", "init started with the boot env's DISPLAY");
	assert.equal(machine.init.windowManager, true, "init was asked to start the window manager");
	assert.deepEqual(machine.processes.map(({ argv }) => argv[0]), ["Xvfb"], "the X server alone over the socket it dialed: computerd starts the window manager");
	assert.equal(dial.hub.hello(ref.name)?.kind, "linux", "the hub keeps the hello the machine dialed with, before its display");
	const connection = await provider.connect(ref);
	assert.equal(connection.ok, true, connection.ok ? "" : `${connection.error.code}: ${connection.error.message}`);
	assert.equal(connection.value.hello.kind, "desktop");
	assert.ok(connection.value.hello.groups.includes("screen"));
	assert.deepEqual(connection.value.hello.windowManager, { state: "running" });
	await connection.value.close();
	const released = await provider.release(ref, "delete");
	assert.equal(released.ok, true, released.ok ? "" : `${released.error.code}: ${released.error.message}`);
	return ref;
}

/**
 * A dial host and its server. daemon: the bytes the server's daemon route serves (a machine whose AGENTRUN_DAEMON_SHA256
 * is another runs nothing and never dials); dials: false for machines that never dial (a server they cannot reach); the
 * rest are fakeHost's options. provider(options) makes a provider over it given this server; kit() is its DialKit, for
 * provider.dial-token.
 *
 * starts: what each start of a machine's agentrun-dial does, in order (the boot's, then each redial's; past the last,
 * it dials): "dials", or { exit, log } (it exited with that code, having written log), or { log(ms), dialsAfterMs }
 * (it runs, its log what log(ms since its start) answers, and dials after dialsAfterMs, or never without it). Given,
 * the host has dialLog, dialExit and redial over them, and fake.redials records each redial's machine id.
 */
export function fakeDialHost({ daemon, dials = true, starts, helloMs = 1_000, ...options } = {}) {
	const tokens = new MemoryMachineTokens();
	const hub = new AttachHub({ helloMs });
	const served = createHash("sha256").update(daemon).digest("hex");
	/** The server's attach route: a refused token closes 4401 before any hello; a taken one goes to the hub as its machine. */
	const attach = (token, socket) => {
		const minted = tokens.check(token);
		if (minted === undefined) return socket.close(ATTACH_CLOSE.unauthorized, "no machine has this token");
		void hub.accept(mintedComputer(minted.machine, minted.mint), socket);
	};
	const dialOf = (m) => {
		// The machine is of the host's arch, and its daemon's hello says so.
		m.box.hello = { ...m.box.hello, arch: fake.host.facts.arch };
		const [server, machine] = socketPair();
		serveDaemon(machine, (request) => fake.answer(m, request));
		fake.dialed.push({ machine: m.id, url: m.boot.AGENTRUN_ATTACH_URL });
		attach(m.boot.AGENTRUN_ATTACH_TOKEN, server);
	};
	/** The start of agentrun-dial m is on (m.starts), as starts gives it. */
	const startOf = (m) => starts[m.starts] ?? "dials";
	const begin = (m) => {
		m.startedAt = Date.now();
		const start = startOf(m);
		if (start === "dials") dialOf(m);
		else if (start.dialsAfterMs !== undefined) setTimeout(() => m.deleted || dialOf(m), start.dialsAfterMs);
	};
	const fake = fakeHost({
		...options,
		facts: { connect: "dial", ...options.facts },
		onBoot(m) {
			if (!dials || m.boot.AGENTRUN_DAEMON_SHA256 !== served) return;
			if (starts === undefined) return dialOf(m);
			m.starts = 0;
			begin(m);
		},
	});
	fake.dialed = [];
	fake.redials = [];
	if (starts !== undefined) {
		const started = (id) => {
			const m = fake.machines.get(id);
			return m?.starts === undefined ? undefined : m;
		};
		fake.host.dialExit = async (id) => {
			const m = started(id);
			const start = m && startOf(m);
			return typeof start === "object" ? start.exit : undefined;
		};
		fake.host.dialLog = async (id) => {
			const m = started(id);
			if (m === undefined) return undefined;
			const start = startOf(m);
			if (typeof start !== "object") return "";
			return typeof start.log === "function" ? start.log(Date.now() - m.startedAt) : (start.log ?? "");
		};
		fake.host.redial = async (id) => {
			const m = started(id);
			if (m === undefined) throw new Error(`no agentrun-dial was started in ${id}`);
			fake.redials.push(id);
			m.starts += 1;
			begin(m);
		};
	}
	let made;
	return {
		fake,
		tokens,
		hub,
		provider(providerOptions = {}) {
			made = providerOptions;
			return new HostedProvider(fake.host, { dial: { url: PUBLIC_URL, tokens, hub }, ...providerOptions });
		},
		kit: () => ({
			check: (token, at) => tokens.check(token, at)?.machine,
			token: (ref) => fake.calls.findLast(([what, req]) => what === "create" && req.name === ref.name)?.[1].boot?.env.AGENTRUN_ATTACH_TOKEN,
			async dialAs(token, hello) {
				const [server, machine] = socketPair();
				serveDaemon(machine, (request) => (request.method === "hello" ? { result: hello } : { error: { code: -32601, message: `${request.method} is not a method` } }));
				const closed = new Promise((done) => machine.onClose((code) => done(code)));
				attach(token, server);
				return Promise.race([closed, new Promise((done) => setTimeout(done, helloMs * 2))]);
			},
			unreachable() {
				const before = fake.creates();
				return { provider: new HostedProvider(fake.host, { ...made, dial: { tokens, hub } }), creates: () => fake.creates() - before };
			},
		}),
	};
}
