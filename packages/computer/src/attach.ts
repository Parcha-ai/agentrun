// The attach binding (spec/computer/attach.md), serve's side, written against a socket interface so it runs with any
// WebSocket library and in tests with none. A driver on a person's own machine dials wss://<serve>/v2/computers/attach
// with the token it got by pairing, and the same JSON-RPC messages travel as text frames, one message per frame. Serve
// is the caller: it sends hello first, then the run's calls. The AttachHub keeps one live connection per paired
// computer; attachedProvider hands that computer to a run as a provider, one run at a time.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PassThrough, type Readable, Writable } from "node:stream";
import { DaemonClient } from "./client.js";
import { kindServed } from "./kinds.js";
import { EPOCH_LABEL, epochOf } from "./labels.js";
import { checkMount, type MountReadBack, WORKSPACE } from "./mount.js";
import { type ComputerClient, type ComputerKind, type ComputerOs, type DaemonMethod, type DaemonMethods, type HelloResult, PROTOCOL_VERSION } from "./protocol.js";
import { type ComputerCapabilities, type ComputerConnection, type ComputerProvider, type ComputerRef, checkLifetime, kindRefusals, runLifetimeMs } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

export const ATTACH_PATH = "/v2/computers/attach";
/** Where a hosted machine that dials fetches the server's computerd for its arch (?arch=amd64|arm64), with its token. */
export const DAEMON_PATH = "/v2/computers/daemon";
/** The WebSocket subprotocol a driver asks for: the protocol version it speaks. Serve answers with it or refuses. */
export const ATTACH_SUBPROTOCOL = `agentrun.computer.${PROTOCOL_VERSION}`;
/** Each side pings this often (WebSocket ping frames, not JSON-RPC), so a NAT keeps the path open. */
export const ATTACH_HEARTBEAT_MS = 20_000;
/** A side that hears nothing, not even a pong, for this long closes the socket with ATTACH_CLOSE.idle. */
export const ATTACH_IDLE_MS = 60_000;
/** Serve waits this long for a new socket's hello answer; a socket whose driver pings but never answers is closed idle. */
export const ATTACH_HELLO_MS = 10_000;
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
	/** The computer's hello is not what it paired as (another kind, os or arch): pair again. */
	mismatch: 4400,
	/** The token is unknown or was revoked: pair again. */
	unauthorized: 4401,
	/** Nothing heard for ATTACH_IDLE_MS, or no answer to serve's hello within ATTACH_HELLO_MS. */
	idle: 4408,
	/** The same computer dialed again; the older socket is closed. */
	replaced: 4409,
	/** The driver speaks another protocol version, or its hello lacks a group its kind needs (kindServed): update it. */
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
	/** What it paired as: its hello at pairing. A later hello of another kind, os or arch is refused (ATTACH_CLOSE.mismatch). */
	hello: HelloResult;
	labels: Record<string, string>;
	/** A hosted machine that dials with a minted token (mintedComputer), not a person's: its hello keeps its arch too. */
	minted?: true;
}

/** What a hosted machine's token is minted for: the computer its hello must say it is, and when the token stops. */
export interface MachineMint {
	kind: ComputerKind;
	os: ComputerOs;
	/** Go's name, as hello says it: amd64, arm64. */
	arch: string;
	/** The machine's backstopAt: past it the token is refused, whatever else holds. */
	expiresAt: Date;
	/** The run the machine works for, as its create's labels name it (RUN_LABEL): what a server's words about its dial
	 *  name. Absent for a computer of no run. */
	run?: string;
}

/** A machine token's shape, as a RegExp source without anchors or flags: `art_` and 43 base64url characters (32 bytes).
 *  computerd takes this alone (daemon/internal/attach/attach.go tokenPattern, the same source anchored); a scrub
 *  builds its global RegExp from it. */
export const MACHINE_TOKEN_SOURCE = "art_[A-Za-z0-9_-]{43}";

/** A new machine token, a paired computer's or a hosted machine's: `art_` and 32 random bytes in base64url
 *  (MACHINE_TOKEN_SOURCE). */
export const newMachineToken = (): string => `art_${randomBytes(32).toString("base64url")}`;

/**
 * The tokens of hosted machines that dial (spec/computer/attach.md, Hosted machines that dial), as the server's store
 * keeps them: HostedProvider mints one at each dial create and revokes it at the delete. A token is newMachineToken's;
 * the store keeps only its sha256, bound to the machine and its mint, and never logs it. The
 * server's attach upgrade and its daemon route take it while it is neither revoked nor past expiresAt, and hand its
 * socket to the AttachHub as mintedComputer(machine, mint). machine is the computer's name, computer-<12 hex digits>,
 * from its create's request id (computerNameFor): what the provider's connect and release are given.
 */
export interface MachineTokens {
	/** A new token for the machine, replacing any it had. */
	mint(machine: string, mint: MachineMint): Promise<string>;
	/** The machine's token refused from now on; a machine with none is done. */
	revoke(machine: string): Promise<void>;
	/** Why the server refused the machine's dial, in its words (a relay to the runner that minted the token, serve's
	 *  dial-relay.ts, that it could not make): they name the machine's run, then the machine, and never its token.
	 *  Undefined while none was refused. A create waiting for the machine's socket ends in these words. */
	refused(machine: string): Promise<string | undefined>;
}

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * MachineTokens in one process's memory, as serve's store keeps them (the sha256 alone): for tests and a conformance
 * kit. check is what the server's attach and daemon routes ask of a token.
 */
export class MemoryMachineTokens implements MachineTokens {
	readonly #held = new Map<string, { machine: string; mint: MachineMint }>();
	readonly #hashOf = new Map<string, string>();

	// No await in either: a mint replaces the machine's token at once, so two of one machine leave one token, not two.
	async mint(machine: string, mint: MachineMint): Promise<string> {
		this.#drop(machine);
		const token = newMachineToken();
		this.#held.set(sha256(token), { machine, mint: { ...mint } });
		this.#hashOf.set(machine, sha256(token));
		return token;
	}

	async revoke(machine: string): Promise<void> {
		this.#drop(machine);
	}

	// One process: its own attach route takes every dial, and no relay to a runner apart is refused.
	async refused(_machine: string): Promise<string | undefined> {
		return undefined;
	}

	#drop(machine: string): void {
		this.#held.delete(this.#hashOf.get(machine) ?? "");
		this.#hashOf.delete(machine);
	}

	/** The machine and mint a token is good for at `at`: undefined for one unknown, revoked, or past its expiresAt. */
	check(token: string, at = new Date()): { machine: string; mint: MachineMint } | undefined {
		const held = this.#held.get(sha256(token));
		return held === undefined || at.getTime() > held.mint.expiresAt.getTime() ? undefined : held;
	}
}

/** A minted machine as the AttachHub takes its socket: under the machine's name, its hello held to the mint. */
export function mintedComputer(machine: string, { kind, os, arch }: Pick<MachineMint, "kind" | "os" | "arch">): PairedComputer {
	return { id: machine, name: machine, hello: { protocol: PROTOCOL_VERSION, version: "", os, kind, arch, groups: [] }, labels: {}, minted: true };
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
	// Serve names no OS and no driver app: one way to update, in the same words for every computer. A minted machine
	// fetched this server's own computerd at boot, so another build there is not one this server gave it.
	const update = paired.minted ? `${paired.name} runs a computerd that is not this server's build: create the computer again` : `update the driver on ${paired.name} (the download is on the console's Computers page)`;
	const said = hello as Partial<Record<keyof HelloResult, unknown>> | null;
	if (typeof said !== "object" || said === null || typeof said.protocol !== "string" || typeof said.version !== "string") {
		return { code: ATTACH_CLOSE.protocol, message: `${paired.name}'s driver answered hello without its protocol and version: ${update}` };
	}
	if (hello.protocol !== PROTOCOL_VERSION) {
		const newer = laterProtocol(hello.protocol, PROTOCOL_VERSION) ? "the server is older: it is updated by whoever runs it" : update;
		return { code: ATTACH_CLOSE.protocol, message: `${paired.name}'s driver ${hello.version} speaks protocol ${hello.protocol}, and this server ${PROTOCOL_VERSION}: ${newer}` };
	}
	// Every field serve reads off a live hello (the provider's capabilities, the kind check): one missing is refused
	// here, never met later as a throw.
	const missing = [
		...(typeof said.os === "string" ? [] : ["os"]),
		...(typeof said.kind === "string" ? [] : ["kind"]),
		...(typeof said.arch === "string" ? [] : ["arch"]),
		...(Array.isArray(said.groups) && said.groups.every((group) => typeof group === "string") ? [] : ["groups"]),
	];
	if (missing.length > 0) {
		return { code: ATTACH_CLOSE.protocol, message: `${paired.name}'s driver ${hello.version} answered a protocol ${PROTOCOL_VERSION} hello without ${missing.join(", ")}: ${update}` };
	}
	if (paired.minted) {
		// A minted desktop says linux until its display answers: its create starts the X server over this socket (desktop.ts).
		const kind = hello.kind === paired.hello.kind || (paired.hello.kind === "desktop" && hello.kind === "linux");
		if (!kind || hello.os !== paired.hello.os || hello.arch !== paired.hello.arch) {
			const was = paired.hello;
			return { code: ATTACH_CLOSE.mismatch, message: `${paired.name} was made a ${was.os} ${was.kind} on ${was.arch} and says ${hello.os} ${hello.kind} on ${hello.arch}: its token is that machine's alone` };
		}
	} else if (hello.kind !== paired.hello.kind || hello.os !== paired.hello.os || (hello.arch !== paired.hello.arch && paired.hello.os !== "macos")) {
		// Its arch too, so a token copied to a machine of another arch is refused; but a Mac's: its driver may move from
		// amd64 (under Rosetta) to arm64 on the same machine.
		const was = paired.hello;
		return { code: ATTACH_CLOSE.mismatch, message: `${paired.name} paired as a ${was.os} ${was.kind} on ${was.arch} and now says ${hello.os} ${hello.kind} on ${hello.arch}: pair it again` };
	}
	// A computer that lacks a group its kind needs can't be given to an agent: refused at connect, in the hello's own
	// words for what it is, never at a run's first call.
	const lacks = kindServed(hello);
	if (lacks.length > 0) {
		return { code: ATTACH_CLOSE.protocol, message: `${paired.name} says it is a ${hello.os} ${hello.kind} but declares no ${lacks.join(", ")}: ${update}` };
	}
	return undefined;
}

interface Live {
	socket: AttachSocket;
	client: ComputerClient;
	hello: HelloResult;
	/** The order the computer dialed in: a socket replaces only one dialed before it. */
	dial: number;
	/** When its hello was taken and it went live. */
	since: Date;
}

/**
 * Serve's attached computers in one process: the live connection of each, by its id. Serve's attach route checks the
 * token, finds the paired computer and hands the socket to accept. A computer has one connection, serve's, which every
 * caller shares (one run holds the computer at a time); a new socket from the same computer replaces the old one.
 */
export class AttachHub {
	readonly #live = new Map<string, Live>();
	/** The run holding each computer: the hold's own token, its labels, and its deadline with the timer that ends it. */
	readonly #claims = new Map<string, { hold: string; labels: Record<string, string>; deadline?: Date; timer?: ReturnType<typeof setTimeout> }>();
	/** The call still running on each computer that changes it (changing): no hold on it ends before it has ended. A
	 *  create sends them one at a time, and none after its abort. */
	readonly #changing = new Map<string, Promise<unknown>>();
	/** The sockets still saying hello, by computer: a revoke closes them too, so none comes back after it. */
	readonly #pending = new Map<string, Set<AttachSocket>>();
	/** Each computer's connections given out, by the function that closes one. */
	readonly #given = new Map<string, Set<() => void>>();
	/** The dials taken so far, in order, across every computer: a dial's number is taken before its hello is awaited. */
	#dials = 0;
	/** How long a new socket's hello may take (ATTACH_HELLO_MS; shorter in tests). */
	readonly #helloMs: number;

	constructor({ helloMs = ATTACH_HELLO_MS }: { helloMs?: number } = {}) {
		this.#helloMs = helloMs;
	}

	/**
	 * Takes a computer's new socket: calls hello on it, and keeps it when the hello is what the computer paired as. The
	 * newest dial wins whichever hello answers first: a socket whose hello ends after a newer one went live is closed,
	 * never put in its place.
	 */
	async accept(paired: PairedComputer, socket: AttachSocket): Promise<Result<HelloResult>> {
		const dial = ++this.#dials;
		const pending = this.#pending.get(paired.id) ?? new Set<AttachSocket>();
		this.#pending.set(paired.id, pending);
		pending.add(socket);
		const client = new DaemonClient(socketStreams(socket));
		// Listened for before the hello is awaited, so a close in that wait is never missed: it keeps the socket out of
		// #live, or takes it out once in.
		let closed = false;
		let mine: Live | undefined;
		socket.onClose(() => {
			closed = true;
			if (mine !== undefined && this.#live.get(paired.id) === mine) this.#live.delete(paired.id);
		});
		// Bounded: a driver that answers pings but never hello would otherwise hold a socket open forever.
		const hello = await client.call("hello", { client: "agentrun-serve" }, { signal: AbortSignal.timeout(this.#helloMs) });
		const revoked = !pending.delete(socket);
		if (pending.size === 0 && this.#pending.get(paired.id) === pending) this.#pending.delete(paired.id);
		if (revoked) {
			const why = `${paired.name} was removed while it said hello`;
			socket.close(ATTACH_CLOSE.unauthorized, why);
			return fail("refused", why);
		}
		if (!hello.ok && hello.error.code === "aborted") {
			const why = `${paired.name}'s driver did not answer hello within ${this.#helloMs / 1000} s`;
			socket.close(ATTACH_CLOSE.idle, why);
			return fail("timeout", why);
		}
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
		if (older !== undefined && older.dial > dial) {
			const why = `${paired.name} dialed again while this socket said hello, and the newer one is live`;
			socket.close(ATTACH_CLOSE.replaced, why);
			return fail("refused", why);
		}
		if (closed) return fail("gone", `${paired.name}'s socket closed while it said hello`);
		mine = { socket, client, hello: hello.value, dial, since: new Date() };
		this.#live.set(paired.id, mine);
		older?.socket.close(ATTACH_CLOSE.replaced, "the computer dialed again");
		return hello;
	}

	/** Whether the computer is attached now. */
	online(id: string): boolean {
		return this.#live.has(id);
	}

	/** When the computer's live connection said hello and went live; undefined while it is not attached. */
	since(id: string): Date | undefined {
		return this.#live.get(id)?.since;
	}

	/** The hello of the computer's live connection: its driver's version and groups now, which an update may change. */
	hello(id: string): HelloResult | undefined {
		return this.#live.get(id)?.hello;
	}

	/**
	 * A connection over the computer's one socket: closing it leaves the socket open, cancels its calls still running and
	 * refuses its later ones, and the run's release closes every connection it was given, so a run done with the computer
	 * cannot reach it once another run holds it. Undefined while it is not attached.
	 */
	connection(id: string): ComputerConnection | undefined {
		const live = this.#live.get(id);
		if (live === undefined) return undefined;
		const stop = new AbortController();
		const given = this.#given.get(id) ?? new Set<() => void>();
		this.#given.set(id, given);
		const end = () => {
			given.delete(end);
			stop.abort();
		};
		given.add(end);
		// Every caller's calls go over the computer's live socket, looked up per call: a drop fails the calls in flight
		// with gone. A new socket is a new session whose refs, states and handles are its own, and an old one could name
		// something else there: the first call after a redial is refused gone, saying so, and the calls after it go over
		// the new socket.
		let using = live;
		const shared: ComputerClient = {
			call: (method, params, options) => {
				if (stop.signal.aborted) return Promise.resolve(fail("gone", "this connection to the computer was closed: connect again"));
				const now = this.#live.get(id);
				if (now === undefined) return Promise.resolve(fail("gone", "the computer is not attached now: it dials back on its own, so try again shortly"));
				if (now !== using) {
					using = now;
					return Promise.resolve(fail("gone", "the computer dialed back since the last call: its refs, states and handles from before are void, so observe again (this call did not run)"));
				}
				return now.client.call(method, params, { ...options, signal: options?.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]) });
			},
			close: end,
		};
		return { client: shared, hello: live.hello, close: async () => end() };
	}

	/** Closes every connection given out for the computer. */
	#closeGiven(id: string): void {
		for (const end of [...(this.#given.get(id) ?? [])]) end();
		this.#given.delete(id);
	}

	/**
	 * Holds the computer for a run, with the run's labels, until its deadline (an agent's hold has none): there the hold
	 * ends as a release does, closing the run's connections, and the person's machine runs on. False when another run
	 * holds it. The hold's token names this hold and no later one: unclaim with it never ends another run's.
	 */
	claim(id: string, labels: Record<string, string>, deadline?: Date): string | undefined {
		this.#expire(id);
		if (this.#claims.has(id)) return undefined;
		const hold = randomUUID().replaceAll("-", "").slice(0, 16);
		const timer = deadline === undefined ? undefined : setTimeout(() => void this.unclaim(id, hold), Math.max(0, deadline.getTime() - Date.now()));
		timer?.unref?.();
		this.#claims.set(id, { hold, labels: { ...labels }, ...(deadline === undefined ? {} : { deadline, timer }) });
		return hold;
	}

	/** The labels of the run that holds the computer, or undefined. */
	claimed(id: string): Record<string, string> | undefined {
		this.#expire(id);
		return this.#claims.get(id)?.labels;
	}

	/** The token of the hold on the computer now, or undefined. */
	hold(id: string): string | undefined {
		this.#expire(id);
		return this.#claims.get(id)?.hold;
	}

	/** The deadline of the run that holds the computer, or undefined (no hold, or an agent's). */
	deadline(id: string): Date | undefined {
		this.#expire(id);
		return this.#claims.get(id)?.deadline;
	}

	/**
	 * `answer`, a call that changes the computer (a create's files.remove or KILL), kept until it ends: computerd ends
	 * what a cancelled call started, so it has ended only when the computer answers it or its connection closes. No hold
	 * on the computer ends before that (unclaim).
	 */
	changing(id: string, answer: Promise<unknown>): void {
		this.#changing.set(id, answer);
		void answer.finally(() => {
			if (this.#changing.get(id) === answer) this.#changing.delete(id);
		});
	}

	/** Resolves once no call that changes the computer runs (changing), one sent after another's answer too: at once
	 *  while none does. */
	async unchanged(id: string): Promise<void> {
		for (let running = this.#changing.get(id); running !== undefined; running = this.#changing.get(id)) await Promise.allSettled([running]);
	}

	/**
	 * Ends the hold named by its token, and closes the connections it was given: at once, or while a call that changes
	 * the computer still runs (changing), once it has ended, so no next run is given a computer an earlier call still
	 * changes. A token of a hold already ended (a late release, after the deadline gave the computer to another run), or
	 * ended by another unclaim while this one waited, ends nothing: false.
	 */
	async unclaim(id: string, hold: string): Promise<boolean> {
		const held = this.#claims.get(id);
		if (held === undefined || held.hold !== hold) return false;
		// Checked again after each wait: a create still running sends its next remove once the last one answers.
		while (this.#changing.has(id)) {
			await this.unchanged(id);
			if (this.#claims.get(id) !== held) return false;
		}
		clearTimeout(held.timer);
		this.#claims.delete(id);
		this.#closeGiven(id);
		return true;
	}

	/** A hold past its deadline ends at once, whether or not its timer has run yet (once its changing calls end). */
	#expire(id: string): void {
		const held = this.#claims.get(id);
		if (held?.deadline !== undefined && held.deadline.getTime() <= Date.now()) void this.unclaim(id, held.hold);
	}

	/** Ends a computer's attachment: its token was revoked, or the computer was removed. */
	revoke(id: string, why: string): void {
		const pending = this.#pending.get(id);
		this.#pending.delete(id);
		for (const socket of pending ?? []) socket.close(ATTACH_CLOSE.unauthorized, why);
		pending?.clear();
		this.#closeGiven(id);
		this.#live.get(id)?.socket.close(ATTACH_CLOSE.unauthorized, why);
		this.#live.delete(id);
		clearTimeout(this.#claims.get(id)?.timer);
		this.#claims.delete(id);
	}
}

const ATTACHED_NOTE = "an attached computer is a person's own machine: release ends the run's hold on it, and deletes nothing";

/** How a person makes a Linux box's /workspace, in the words a refusal names it by (attach.md, A Linux box). */
const WORKSPACE_FIX = `make ${WORKSPACE} a directory of computerd's user's own, mode 0700, as root: the tmpfiles.d line in spec/computer/attach.md, A Linux box (d ${WORKSPACE} 0700 <user> <user> -), then systemd-tmpfiles --create`;

/**
 * Why the paired Linux box `name`'s /workspace can't hold a run's synced folder, in words naming the fix, or undefined
 * when it can: a directory, never a link (a push follows /workspace itself, then writes only under it, opening each name
 * with O_NOFOLLOW), of the user computerd runs as (the effective uid its /proc/self/status says), with no access for its
 * group or others. Read through `client` (computerd's), which runs nothing on the box.
 */
async function pairedWorkspaceWhy(client: ComputerClient, name: string, signal?: AbortSignal): Promise<Result<string | undefined>> {
	const options = signal ? { signal } : {};
	const status = await client.call("files.read", { path: "/proc/self/status" }, options);
	if (!status.ok) return fail(status.error.code, `reading the user computerd runs as on ${name}: ${status.error.message}`);
	const uid = /^Uid:\s+\d+\s+(\d+)/m.exec(Buffer.from(status.value.data, "base64").toString("utf8"))?.[1];
	if (uid === undefined) return fail("invalid", `${name}'s /proc/self/status names no user computerd runs as`);
	const folder = await client.call("files.stat", { path: WORKSPACE, follow: false }, options);
	if (!folder.ok) return folder.error.code === "not_found" ? ok(`${name} has no ${WORKSPACE}, where a run's synced folder goes: ${WORKSPACE_FIX}`) : fail(folder.error.code, `reading ${WORKSPACE} on ${name}: ${folder.error.message}`);
	const { type, uid: owner, mode } = folder.value;
	if (type === "symlink") return ok(`${WORKSPACE} on ${name} is a link, and a run's synced folder is never written through one: remove it, then ${WORKSPACE_FIX}`);
	if (type !== "dir") return ok(`${WORKSPACE} on ${name} is a ${type}, where a run's synced folder needs a directory: remove it, then ${WORKSPACE_FIX}`);
	if (String(owner) !== uid) return ok(`${WORKSPACE} on ${name} is uid ${owner}'s, not uid ${uid}'s, the user computerd runs as: ${WORKSPACE_FIX}`);
	if ((mode & 0o077) !== 0) return ok(`${WORKSPACE} on ${name} is open to its group or others (mode ${(mode & 0o7777).toString(8).padStart(4, "0")}): ${WORKSPACE_FIX}`);
	return ok(undefined);
}

/**
 * A call that changes the box (files.remove, process.signal), sent with no abort of its own: computerd still ends what a
 * cancelled call started, so the call has ended only when the box answers it or its connection closes. Its answer goes
 * to `changing` (AttachHub.changing), which keeps the box's hold until then. The caller's own wait still ends at
 * `signal`, and none is sent once that has aborted.
 */
function changeBox<M extends DaemonMethod>(client: ComputerClient, changing: (answer: Promise<unknown>) => void, method: M, params: DaemonMethods[M]["params"], signal?: AbortSignal): Promise<Result<DaemonMethods[M]["result"]>> {
	if (signal?.aborted) return Promise.resolve(fail("aborted", `${method} was aborted before it was sent`));
	const answer = client.call(method, params);
	changing(answer);
	if (signal === undefined) return answer;
	const aborted = new Promise<Result<never>>((resolve) => {
		const onAbort = () => resolve(fail("aborted", `${method} was aborted`));
		signal.addEventListener("abort", onAbort, { once: true });
		void answer.finally(() => signal.removeEventListener("abort", onAbort));
	});
	return Promise.race([answer, aborted]);
}

/** Every program computerd still runs on `name` ended, waited for up to 5 s each: the box outlives its runs, and one
 *  run holds it at a time, so a program running at a claim is an earlier run's (a background program left when its hold
 *  ended at its deadline, or its runner was lost), which could read or write the next run's folder. KILL goes to its
 *  process group; init kills what left that group once its guard is gone. Each KILL goes to `changing` (changeBox). */
async function endPrograms(client: ComputerClient, name: string, changing: (answer: Promise<unknown>) => void, signal?: AbortSignal): Promise<Result<void>> {
	const options = signal ? { signal } : {};
	const words = (message: string) => `ending an earlier run's programs on ${name}: ${message}`;
	for (let from = 0; ; ) {
		const listed = await client.call("process.list", { from }, options);
		if (!listed.ok) return fail(listed.error.code, words(listed.error.message));
		for (const program of listed.value.processes.filter((one) => one.running)) {
			const killed = await changeBox(client, changing, "process.signal", { id: program.id, signal: "KILL" }, signal);
			if (!killed.ok && killed.error.code !== "not_found") return fail(killed.error.code, words(killed.error.message));
			const waited = await client.call("process.wait", { id: program.id, timeoutMs: 5_000 }, options);
			if (waited.ok && waited.value.running) return fail("refused", words(`${program.argv.join(" ")} (pid ${program.pid}) is still running 5 s after KILL`));
		}
		if (!listed.value.truncated) return ok(undefined);
		from = listed.value.next;
	}
}

/** Everything in `name`'s /workspace removed, the folder itself kept (only root makes one): each entry of its first
 *  level, a directory with what it holds, a link removed and never followed (files.remove). An entry a remove can't
 *  find (a name that is not UTF-8 reaches the wire changed) is left: a whole listing with one left, or a truncated one
 *  that a pass removes nothing of, refuses the box in words naming what was left. Each remove goes to `changing`
 *  (changeBox): a cancelled one's RemoveAll still deletes on the box. */
async function emptyWorkspace(client: ComputerClient, name: string, changing: (answer: Promise<unknown>) => void, signal?: AbortSignal): Promise<Result<void>> {
	const options = signal ? { signal } : {};
	const words = (message: string) => `emptying ${WORKSPACE} on ${name} of an earlier run's folder: ${message}`;
	for (;;) {
		const listed = await client.call("files.list", { path: WORKSPACE }, options);
		if (!listed.ok) return fail(listed.error.code, words(listed.error.message));
		const left: string[] = [];
		for (const entry of listed.value.entries) {
			const removed = await changeBox(client, changing, "files.remove", { path: entry.path, recursive: true }, signal);
			if (removed.ok) continue;
			if (removed.error.code !== "not_found") return fail(removed.error.code, words(removed.error.message));
			left.push(`${entry.path}: ${removed.error.message}`);
		}
		// A truncated listing is listed again while a pass removes something; what is left past that stays.
		const stuck = listed.value.truncated ? left.length === listed.value.entries.length : left.length > 0;
		if (stuck) return fail("refused", words(`${left.length} entries could not be removed (first: ${left[0] ?? "none listed"})`));
		if (!listed.value.truncated) return ok(undefined);
	}
}

/**
 * One paired computer as a provider, id "attached": its capabilities are what it paired as. create claims it for a
 * run (refused while it is offline or another run holds it) and release ends the claim; a person's machine is never
 * made, stopped or deleted by a run. A desktop or a phone has no init of ours, so its daemon mode is none; a Linux box
 * (kind linux, a sandbox) runs computerd init, a child of its service manager, and takes the run's folder as a synced
 * folder in its /workspace (pairedWorkspaceWhy), read back under the run's claim epoch.
 */
export function attachedProvider(paired: PairedComputer, hub: AttachHub): ComputerProvider {
	/** What the computer says now: its live hello while attached (an update may add groups), else what it paired as. */
	const now = () => hub.hello(paired.id) ?? paired.hello;
	const box = paired.hello.kind === "linux";
	const capabilities = (): ComputerCapabilities => ({
		kind: paired.hello.kind,
		lifetime: "vendor",
		network: ["open"],
		isolation: "machine",
		os: paired.hello.os,
		daemon: box ? "child" : "none",
		groups: [...now().groups],
		// computerd attach dials out, so no agent of ours listens on the box's TCP ports.
		...(box ? { mount: ["sync" as const], vendorAgentPorts: [] } : {}),
		maxLifetimeMs: 24 * 60 * 60_000,
		release: ["delete"],
	});
	const ref: ComputerRef = { id: paired.id, name: paired.name };
	// A run's ref names its hold, `<computer id>.<hold token>`, so a call under a hold that ended (released, or at its
	// deadline) never acts on the next run's: release ends only its own hold, connect and attach refuse a stale one.
	const holdRef = (hold: string): ComputerRef => ({ id: `${paired.id}.${hold}`, name: paired.name });
	const heldRef = () => {
		const hold = hub.hold(paired.id);
		return hold === undefined ? ref : holdRef(hold);
	};
	/** The computer itself, a hold (with whether it is the hold now), or undefined for another provider's id. */
	const named = (asked: { id: string }): { hold?: string; current: boolean } | undefined => {
		if (asked.id === paired.id) return { current: true };
		if (!asked.id.startsWith(`${paired.id}.`)) return undefined;
		const hold = asked.id.slice(paired.id.length + 1);
		return { hold, current: hub.hold(paired.id) === hold };
	};
	const mine = (asked: { id: string }) => named(asked) !== undefined;
	/** The hold each create request made: a request id makes one hold, ever. */
	const holdsBy = new Map<string, string>();
	/** A create still readying the box's synced folder, by its request id: its hold, and the answer a retry meanwhile
	 *  shares once it asks for the same labels. */
	const startingBy = new Map<string, { readonly hold: string; readonly answer: Promise<Result<ComputerRef & { notes: string[] }>> }>();
	const ended = () => fail("gone", `this run's hold on ${paired.name} has ended (released, or at its deadline): another run may hold it now`);
	const unknown = (id: string) => fail("not_found", `no attached computer ${id}: this provider is ${paired.name}'s (${paired.id})`);
	const offline = () => fail("gone", `${paired.name} is not attached now: open its driver, which dials this server`);
	const holds = (labels: Record<string, string>, wanted: Record<string, string>) => Object.entries(wanted).every(([key, value]) => labels[key] === value);
	/** Why a network other than open is refused: a run never narrows a person's own machine's network. */
	const networkRefusal = (asked: unknown) =>
		`${paired.name} is a person's own machine on its own network, which a run cannot block or limit: network ${JSON.stringify(asked)} is refused; ask for network "open"`;
	/** The hold whose create took the run's folder as a synced folder (one run holds the machine at a time). */
	let syncedHold: string | undefined;
	/** The synced folder as the hold's labels record it: under the run's claim epoch. */
	const recorded = (): MountReadBack => {
		const epoch = epochOf(hub.claimed(paired.id));
		return epoch.ok ? { kind: "sync", epoch: epoch.value } : { other: `a synced folder with no epoch to read it back under (${epoch.error.message})` };
	};
	/** The synced folder read back from inside the box: its /workspace as pairedWorkspaceWhy holds it, else in words.
	 *  `fresh`: what an earlier run left is ended and removed first, its programs (endPrograms) and then each entry of the
	 *  folder (a link removed and never followed), so the run's push goes into an empty folder no other run's program
	 *  reaches, as into a hosted computer's new one. Each of those calls that changes the box is the hub's (changing)
	 *  until it has ended, and the connection is closed only then, as a close would drop their answers. */
	const folder = async (signal?: AbortSignal, fresh = false): Promise<Result<MountReadBack>> => {
		const connection = hub.connection(paired.id);
		if (connection === undefined) return offline();
		const changing = (answer: Promise<unknown>) => hub.changing(paired.id, answer);
		try {
			const why = await pairedWorkspaceWhy(connection.client, paired.name, signal);
			if (!why.ok) return why;
			if (why.value !== undefined) return ok({ other: why.value });
			if (fresh) {
				const stopped = await endPrograms(connection.client, paired.name, changing, signal);
				if (!stopped.ok) return stopped;
				const emptied = await emptyWorkspace(connection.client, paired.name, changing, signal);
				if (!emptied.ok) return emptied;
			}
			return ok(recorded());
		} finally {
			void hub.unchanged(paired.id).then(() => connection.close());
		}
	};
	return {
		id: "attached",
		// The driver's version is the computer's, whatever it is: the provider never refuses a newer or older build of one
		// protocol, because it cannot replace a person's app the way it replaces a copied daemon.
		get version() {
			return now().version;
		},
		capabilities,
		check: (spec) => [
			...kindRefusals(capabilities()),
			...(spec.owner === undefined ? checkLifetime(spec.lifetimeMs, capabilities()) : []),
			...(spec.network === "open" ? [] : [{ field: "network", message: networkRefusal(spec.network) }]),
			// A Linux box takes the run's folder as a synced folder alone; a desktop or a phone takes none.
			...checkMount(spec.mount, capabilities().mount),
			...(spec.mount?.kind === "sync" && !epochOf(spec.labels).ok ? [{ field: "labels", message: `a synced folder is made under the run's claim epoch: the label ${EPOCH_LABEL} is required` }] : []),
		],
		async create(spec, context) {
			const refusals = this.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((refusal) => refusal.message).join("; "));
			if (typeof context?.requestId !== "string" || context.requestId === "") return fail("invalid", "create needs a request id (CreateContext.requestId): pass the same one to retry the same request");
			// One hold per request id (provider.md, Idempotent create): a retry while it holds answers it, and after it ended
			// is refused, so a retry never takes the machine from the run that holds it next.
			// A retry while its synced folder is still being readied is checked as one after, then shares that answer.
			const starting = startingBy.get(context.requestId);
			const before = starting?.hold ?? holdsBy.get(context.requestId);
			if (before !== undefined) {
				if (hub.hold(paired.id) !== before) return fail("exists", `${paired.name}'s hold ${before} was made for this request and has ended: create with a new request id`);
				// The hold carries the labels of the request that made it: a retry that asks for other labels is another request.
				const claimed = hub.claimed(paired.id) ?? {};
				const asked = spec.labels ?? {};
				const same = Object.keys(asked).length === Object.keys(claimed).length && holds(claimed, asked);
				if (!same) return fail("exists", `${paired.name}'s hold ${before} was made for this request with other labels: create with a new request id`);
				return starting?.answer ?? ok({ ...holdRef(before), notes: [ATTACHED_NOTE] });
			}
			if (!hub.online(paired.id)) return offline();
			// A run's hold ends at its lifetime, released or not: a run that never releases cannot keep the machine from the next.
			const deadline = spec.owner === undefined ? new Date(Date.now() + runLifetimeMs(spec)) : undefined;
			const hold = hub.claim(paired.id, spec.labels ?? {}, deadline);
			if (hold === undefined) return fail("refused", `${paired.name} is held by another run: one run at a time`);
			if (spec.mount?.kind !== "sync") {
				holdsBy.set(context.requestId, hold);
				return ok({ ...holdRef(hold), notes: [ATTACHED_NOTE] });
			}
			// The run's synced folder goes in the box's /workspace, which must be computerd's user's own directory before
			// anything is pushed there, and is cleared of an earlier run's programs and files: one that is not lets the hold
			// go, in words. A retry of this request meanwhile shares this answer.
			const requestId = context.requestId;
			const answer = (async () => {
				const read = await folder(context.signal, true);
				if (!read.ok || "other" in read.value) {
					// A cancelled create answers at once, but the box may still run a remove or KILL it stopped waiting for: the
					// hold is let go once each has answered or its connection closed (unclaim), so no next run's folder lands
					// under it.
					void hub.unclaim(paired.id, hold);
					return read.ok ? fail("refused", (read.value as { other: string }).other) : read;
				}
				syncedHold = hold;
				holdsBy.set(requestId, hold);
				return ok({ ...holdRef(hold), notes: [ATTACHED_NOTE] });
			})().finally(() => startingBy.delete(requestId));
			startingBy.set(requestId, { hold, answer });
			return answer;
		},
		async attach(asked, context) {
			if ("id" in asked) {
				const which = named(asked);
				if (which === undefined) return unknown(asked.id);
				if (!which.current) return ended();
			} else if (!holds({ ...paired.labels, ...hub.claimed(paired.id) }, asked.labels)) return unknown(JSON.stringify(asked.labels));
			const deadline = hub.deadline(paired.id);
			const found = "id" in asked ? { id: asked.id, name: paired.name } : heldRef();
			// A hold that took the run's folder reads it back from inside the box, as a hosted computer's is.
			const mounted = syncedHold !== undefined && hub.hold(paired.id) === syncedHold ? await folder(context?.signal) : undefined;
			if (mounted !== undefined && !mounted.ok) return mounted;
			return ok({ ...found, spec: { image: "attached", user: "the person's own", network: { other: "the machine's own network" }, kind: paired.hello.kind, ...(deadline === undefined ? {} : { deadline }), ...(mounted === undefined ? {} : { mount: mounted.value }) } });
		},
		async list(labels) {
			const have = { ...paired.labels, ...hub.claimed(paired.id) };
			if (!holds(have, labels)) return ok([]);
			// list runs nothing on the box: a hold's synced folder is the one its labels record.
			const mount = syncedHold !== undefined && hub.hold(paired.id) === syncedHold ? { mount: recorded() } : {};
			return ok([{ ref: heldRef(), labels: have, deadline: hub.deadline(paired.id), state: hub.online(paired.id) ? ("running" as const) : ("stopped" as const), network: { other: "the machine's own network" }, ...mount }]);
		},
		async network(asked, policy) {
			if (!mine(asked)) return unknown(asked.id);
			if (policy !== undefined && policy !== "open") return fail("refused", networkRefusal(policy));
			return ok({ other: "the machine's own network" });
		},
		async connect(asked) {
			const which = named(asked);
			if (which === undefined) return unknown(asked.id);
			if (!which.current) return ended();
			const connection = hub.connection(paired.id);
			return connection === undefined ? offline() : ok(connection);
		},
		async release(asked, how) {
			const which = named(asked);
			if (which === undefined) return unknown(asked.id);
			if (how === "stop") return fail("unsupported", `${paired.name} is a person's own machine: a run releases its hold, and never stops it`);
			if (which.hold === undefined) return fail("invalid", `release names the run's hold on ${paired.name}, the ref create gave (${paired.id}.<hold>), never the computer itself`);
			// A hold already ended is released already: the hold on the computer now, if any, is another run's and stays. A
			// release while a create's remove or KILL still runs on the box answers once the hold has ended, after it.
			await hub.unclaim(paired.id, which.hold);
			return ok(undefined);
		},
	};
}
