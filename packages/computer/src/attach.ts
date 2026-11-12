// The attach binding (spec/computer/attach.md), serve's side, written against a socket interface so it runs with any
// WebSocket library and in tests with none. A driver on a person's own machine dials wss://<serve>/v2/computers/attach
// with the token it got by pairing, and the same JSON-RPC messages travel as text frames, one message per frame. Serve
// is the caller: it sends hello first, then the run's calls. The AttachHub keeps one live connection per paired
// computer; attachedProvider hands that computer to a run as a provider, one run at a time.
import { PassThrough, type Readable, Writable } from "node:stream";
import { DaemonClient } from "./client.js";
import { type ComputerClient, type HelloResult, PROTOCOL_VERSION } from "./protocol.js";
import { type ComputerCapabilities, type ComputerConnection, type ComputerProvider, type ComputerRef, checkLifetime, kindRefusals } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

export const ATTACH_PATH = "/v2/computers/attach";
/** The WebSocket subprotocol a driver asks for: the protocol version it speaks. Serve answers with it or refuses. */
export const ATTACH_SUBPROTOCOL = `agentrun.computer.${PROTOCOL_VERSION}`;
/** Each side pings this often (WebSocket ping frames, not JSON-RPC), so a NAT keeps the path open. */
export const ATTACH_HEARTBEAT_MS = 20_000;
/** A side that hears nothing, not even a pong, for this long closes the socket with ATTACH_CLOSE.idle. */
export const ATTACH_IDLE_MS = 60_000;
/** A pairing code lives this long, and is good once. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Eight characters a person reads off a screen and types, with no 0, O, 1 or I: "K7PD-W3QX". */
export const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
/** The longest a driver waits between two dials. */
export const ATTACH_REDIAL_MAX_MS = 60_000;

/** Why a socket closed, as its close code. A driver dials again after any code but the four that need a person. */
export const ATTACH_CLOSE = {
	normal: 1000,
	/** Serve is restarting or the driver is quitting. */
	going: 1001,
	/** A binary frame: the binding is text frames only. */
	binary: 1003,
	/** A frame over maxLineBytes. */
	tooBig: 1009,
	/** The computer's hello is not what it paired as (another kind, os or user): pair again. */
	mismatch: 4400,
	/** The token is unknown or was revoked: pair again. */
	unauthorized: 4401,
	/** Nothing heard for ATTACH_IDLE_MS. */
	idle: 4408,
	/** The same computer dialed again; the older socket is closed. */
	replaced: 4409,
	/** The driver speaks another protocol version: update it. */
	protocol: 4426,
} as const;

const STOPS: ReadonlySet<number> = new Set([ATTACH_CLOSE.mismatch, ATTACH_CLOSE.unauthorized, ATTACH_CLOSE.protocol]);

/** Whether a driver dials again after a close with this code; false means a person must act (pair, update). */
export const redials = (code: number): boolean => !STOPS.has(code);

/** How long a driver waits before its redial number `attempt` (from 0): 1 s doubling to ATTACH_REDIAL_MAX_MS, less up to a fifth at random. */
export function redialDelay(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(ATTACH_REDIAL_MAX_MS, 1000 * 2 ** Math.max(0, Math.min(attempt, 16)));
	return Math.round(base * (1 - random() / 5));
}

/** What a driver sends to trade a pairing code for its computer's token: POST /v2/computers/pair. */
export interface PairRequest {
	code: string;
	/** What the person calls the machine: "Ada's MacBook". */
	name: string;
	/** The driver's hello, so serve knows what it pairs: kind, os, groups and features. */
	hello: HelloResult;
}

/** Serve's answer: the computer's id and its token, a secret the driver keeps in the OS's keychain. */
export interface PairResult {
	computer: string;
	token: string;
}

/**
 * One WebSocket as serve holds it, whatever the library: text frames in and out, and its close. The implementation
 * answers pings and sends its own every ATTACH_HEARTBEAT_MS, closes with ATTACH_CLOSE.idle after ATTACH_IDLE_MS of
 * silence, closes a binary frame with ATTACH_CLOSE.binary and one over maxLineBytes with ATTACH_CLOSE.tooBig.
 */
export interface AttachSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
	onText(listener: (text: string) => void): void;
	/** Called once, when the socket closed, by either side or by a drop. */
	onClose(listener: (code: number, reason: string) => void): void;
}

/**
 * A socket as the byte streams of the stdio binding: each frame in becomes a line, each line out a frame. Both serve's
 * client and a driver written in TypeScript (the fake ui driver) speak through it, so the binding adds nothing to the
 * wire. A raw newline in a frame can only be whitespace between JSON tokens, so it is read as a space.
 */
export function socketStreams(socket: AttachSocket): { readable: Readable; writable: Writable } {
	const readable = new PassThrough();
	let pending = "";
	let open = true;
	socket.onText((text) => {
		if (open) readable.write(`${text.replace(/\r?\n/g, " ")}\n`);
	});
	socket.onClose(() => {
		open = false;
		readable.end();
	});
	const writable = new Writable({
		write(chunk: Buffer | string, _encoding, done) {
			pending += chunk.toString();
			for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				if (open && line.trim() !== "") socket.send(line);
			}
			done();
		},
		final(done) {
			if (open) socket.close(ATTACH_CLOSE.normal, "the connection was closed");
			done();
		},
	});
	return { readable, writable };
}

/** A paired computer, as serve's store keeps it. Its token is not here: serve keeps only the token's hash. */
export interface PairedComputer {
	id: string;
	name: string;
	/** What it paired as: its hello at pairing. A later hello of another kind or os is refused (ATTACH_CLOSE.mismatch). */
	hello: HelloResult;
	labels: Record<string, string>;
}

/** Whether protocol version a ("0.3") comes after b ("0.2"), part by part as numbers. */
function laterProtocol(a: string, b: string): boolean {
	const [x, y] = [a, b].map((version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0));
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

/**
 * Why a hello may not stand for a paired computer, or undefined. The protocol version must be the server's; the
 * driver's own version may be any: a person's installed app updates on its own schedule, and the server cannot
 * replace it the way a provider replaces a copied daemon.
 */
export function helloMismatch(paired: PairedComputer, hello: HelloResult): { code: number; message: string } | undefined {
	if (hello.protocol !== PROTOCOL_VERSION) {
		const newer = laterProtocol(hello.protocol, PROTOCOL_VERSION) ?"the server is older: it is updated by whoever runs it" : `update the driver on ${paired.name} (Computerd: its menu's Check for Updates, or the download on the console's Computers page)`;
		return { code: ATTACH_CLOSE.protocol, message: `${paired.name}'s driver ${hello.version} speaks protocol ${hello.protocol}, and this server ${PROTOCOL_VERSION}: ${newer}` };
	}
	if (hello.kind !== paired.hello.kind || hello.os !== paired.hello.os) {
		return { code: ATTACH_CLOSE.mismatch, message: `${paired.name} paired as a ${paired.hello.os} ${paired.hello.kind} and now says ${hello.os} ${hello.kind}: pair it again` };
	}
	return undefined;
}

interface Live {
	socket: AttachSocket;
	client: ComputerClient;
	hello: HelloResult;
}

/**
 * Serve's attached computers in one process: the live connection of each, by its id. Serve's attach route checks the
 * token, finds the paired computer and hands the socket to accept. A computer has one connection, serve's, which every
 * caller shares (one run holds the computer at a time); a new socket from the same computer replaces the old one.
 */
export class AttachHub {
	readonly #live = new Map<string, Live>();
	readonly #claims = new Map<string, Record<string, string>>();

	/** Takes a computer's new socket: calls hello on it, and keeps it when the hello is what the computer paired as. */
	async accept(paired: PairedComputer, socket: AttachSocket): Promise<Result<HelloResult>> {
		const client = new DaemonClient(socketStreams(socket));
		const hello = await client.call("hello", { client: "agentrun-serve" });
		if (!hello.ok) {
			socket.close(ATTACH_CLOSE.going, `hello failed: ${hello.error.message}`);
			return hello;
		}
		const wrong = helloMismatch(paired, hello.value);
		if (wrong !== undefined) {
			socket.close(wrong.code, wrong.message);
			return fail("refused", wrong.message);
		}
		const older = this.#live.get(paired.id);
		const live: Live = { socket, client, hello: hello.value };
		this.#live.set(paired.id, live);
		older?.socket.close(ATTACH_CLOSE.replaced, "the computer dialed again");
		socket.onClose(() => {
			if (this.#live.get(paired.id) === live) this.#live.delete(paired.id);
		});
		return hello;
	}

	/** Whether the computer is attached now. */
	online(id: string): boolean {
		return this.#live.has(id);
	}

	/** The hello of the computer's live connection: its driver's version and groups now, which an update may change. */
	hello(id: string): HelloResult | undefined {
		return this.#live.get(id)?.hello;
	}

	/** The computer's connection, shared: closing it leaves the socket open. Undefined while it is not attached. */
	connection(id: string): ComputerConnection | undefined {
		const live = this.#live.get(id);
		if (live === undefined) return undefined;
		// Every caller's calls go over the one client; a drop fails them all with gone.
		const shared: ComputerClient = { call: (method, params, options) => live.client.call(method, params, options), close: () => {} };
		return { client: shared, hello: live.hello, close: async () => {} };
	}

	/** Holds the computer for a run, with the run's labels; false when another run holds it. */
	claim(id: string, labels: Record<string, string>): boolean {
		if (this.#claims.has(id)) return false;
		this.#claims.set(id, { ...labels });
		return true;
	}

	/** The labels of the run that holds the computer, or undefined. */
	claimed(id: string): Record<string, string> | undefined {
		return this.#claims.get(id);
	}

	unclaim(id: string): void {
		this.#claims.delete(id);
	}

	/** Ends a computer's attachment: its token was revoked, or the computer was removed. */
	revoke(id: string, why: string): void {
		this.#live.get(id)?.socket.close(ATTACH_CLOSE.unauthorized, why);
		this.#live.delete(id);
		this.#claims.delete(id);
	}
}

/**
 * One paired computer as a provider, id "attached": its capabilities are what it paired as. create claims it for a
 * run (refused while it is offline or another run holds it) and release ends the claim; a person's machine is never
 * made, stopped or deleted by a run. It has no init of ours, so its daemon mode is none.
 */
export function attachedProvider(paired: PairedComputer, hub: AttachHub): ComputerProvider {
	/** What the computer says now: its live hello while attached (an update may add groups), else what it paired as. */
	const now = () => hub.hello(paired.id) ?? paired.hello;
	const capabilities = (): ComputerCapabilities => ({
		kind: paired.hello.kind,
		lifetime: "vendor",
		network: ["open"],
		isolation: "machine",
		os: paired.hello.os,
		daemon: "none",
		groups: [...now().groups],
		maxLifetimeMs: 24 * 60 * 60_000,
		release: ["delete"],
	});
	const ref: ComputerRef = { id: paired.id, name: paired.name };
	const mine = (asked: { id: string }) => asked.id === paired.id;
	const unknown = (id: string) => fail("not_found", `no attached computer ${id}: this provider is ${paired.name}'s (${paired.id})`);
	const offline = () => fail("gone", `${paired.name} is not attached now: open its driver, which dials this server`);
	const holds = (labels: Record<string, string>, wanted: Record<string, string>) => Object.entries(wanted).every(([key, value]) => labels[key] === value);
	return {
		id: "attached",
		// The driver's version is the computer's, whatever it is: the provider never refuses a newer or older build of one
		// protocol, because it cannot replace a person's app the way it replaces a copied daemon.
		get version() {
			return now().version;
		},
		capabilities,
		check: (spec) => [...kindRefusals(capabilities()), ...(spec.owner === undefined ? checkLifetime(spec.lifetimeMs, capabilities()) : [])],
		async create(spec) {
			const refusals = this.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((refusal) => refusal.message).join("; "));
			if (!hub.online(paired.id)) return offline();
			if (!hub.claim(paired.id, spec.labels ?? {})) return fail("refused", `${paired.name} is held by another run: one run at a time`);
			return ok({ ...ref, notes: ["an attached computer is a person's own machine: release ends the run's hold on it, and deletes nothing"] });
		},
		async attach(asked) {
			const found = "id" in asked ? mine(asked) : holds({ ...paired.labels, ...hub.claimed(paired.id) }, asked.labels);
			if (!found) return unknown("id" in asked ? asked.id : JSON.stringify(asked.labels));
			return ok({ ...ref, spec: { image: "attached", user: "the person's own", network: { other: "the machine's own network" }, kind: paired.hello.kind } });
		},
		async list(labels) {
			const have = { ...paired.labels, ...hub.claimed(paired.id) };
			if (!holds(have, labels)) return ok([]);
			return ok([{ ref, labels: have, deadline: undefined, state: hub.online(paired.id) ? ("running" as const) : ("stopped" as const), network: { other: "the machine's own network" } }]);
		},
		async network(asked) {
			return mine(asked) ? ok({ other: "the machine's own network" }) : unknown(asked.id);
		},
		async connect(asked) {
			if (!mine(asked)) return unknown(asked.id);
			const connection = hub.connection(paired.id);
			return connection === undefined ? offline() : ok(connection);
		},
		async release(asked, how) {
			if (!mine(asked)) return unknown(asked.id);
			if (how === "stop") return fail("unsupported", `${paired.name} is a person's own machine: a run releases its hold, and never stops it`);
			hub.unclaim(paired.id);
			return ok(undefined);
		},
	};
}
