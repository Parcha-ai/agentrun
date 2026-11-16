// A dial host (src/host.ts, facts.connect "dial") for the adapter's tests: the fake host (fake-host.mjs) with no exec and
// no upload, whose create "boots" each machine's agentrun-dial from its boot env: init started by AGENTRUN_INIT_ARGS, the
// daemon's sha256 held to the one the server serves, then a dial of the server's attach route with AGENTRUN_ATTACH_TOKEN
// over an in-memory socket, where the fake host's daemon answers. The server is here too: machine tokens in memory, an
// AttachHub, and the attach route's token check (a token it refuses is closed 4401 before any hello). No network.
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
 * A dial host and its server. daemon: the bytes the server's daemon route serves (a machine whose AGENTRUN_DAEMON_SHA256
 * is another runs nothing and never dials); dials: false for machines that never dial (a server they cannot reach); the
 * rest are fakeHost's options. provider(options) makes a provider over it given this server; kit() is its DialKit, for
 * provider.dial-token.
 */
export function fakeDialHost({ daemon, dials = true, helloMs = 1_000, ...options } = {}) {
	const tokens = new MemoryMachineTokens();
	const hub = new AttachHub({ helloMs });
	const served = createHash("sha256").update(daemon).digest("hex");
	/** The server's attach route: a refused token closes 4401 before any hello; a taken one goes to the hub as its machine. */
	const attach = (token, socket) => {
		const minted = tokens.check(token);
		if (minted === undefined) return socket.close(ATTACH_CLOSE.unauthorized, "no machine has this token");
		void hub.accept(mintedComputer(minted.machine, minted.mint), socket);
	};
	const fake = fakeHost({
		...options,
		facts: { connect: "dial", ...options.facts },
		onBoot(m) {
			if (!dials || m.boot.AGENTRUN_DAEMON_SHA256 !== served) return;
			// The machine is of the host's arch, and its daemon's hello says so.
			m.box.hello = { ...m.box.hello, arch: fake.host.facts.arch };
			const [server, machine] = socketPair();
			serveDaemon(machine, (request) => fake.answer(m, request));
			fake.dialed.push({ machine: m.id, url: m.boot.AGENTRUN_ATTACH_URL });
			attach(m.boot.AGENTRUN_ATTACH_TOKEN, server);
		},
	});
	fake.dialed = [];
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
