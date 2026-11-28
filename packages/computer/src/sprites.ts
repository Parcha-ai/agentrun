// The Fly Sprites host: a Linux sandbox on a sprite, a Firecracker microVM Fly keeps by name, over the Sprites API
// (https://api.sprites.dev, a Bearer token). Sources: D = docs.sprites.dev (the API reference, its OpenAPI and AsyncAPI
// files), S = superfly/sprites-js, Fly's own client. A sprite's name is the request's, so the machine's id is its name.
// Its labels are a list of `name=value` strings (S CreateSpriteRequest), so the adapter packs the map into it. The exec
// is the exec WebSocket (D exec), its binary frames read and written as they are, never the SDK's text helpers: framedExec's
// pieces. A sprite has no timer of its own, so the janitor ends it by its deadline label.
//
// Unverified until the live run: the arch (amd64); a label string's room (64 bytes, as Fly Machines' metadata); a
// create of a name the account holds answers 409 (read as exists); delete is done once its 204 answers (the adapter
// reads it back gone either way); no vendor agent listens on TCP (Fly's in the VM answers on a unix socket); the exec
// socket stays open through 75 s of silence with no ping of ours (Node's WebSocket sends none); a sprite with an exec
// running never sleeps; the exec user is root or has passwordless sudo.
import { SPRITES, SPRITES_IMAGE } from "./descriptors/sprites.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { orThrow, pause } from "./hosted/process.js";
import { HostedProvider, type HostedOptions } from "./hosted/provider.js";
import { allPages, httpsBase, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dateOf } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok } from "./result.js";

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a stand-in in tests. */
export interface SpritesSocket {
	binaryType: string;
	/** 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: number;
	/** Bytes sent and not yet on the wire: a write waits while it is high. */
	readonly bufferedAmount: number;
	send(data: Uint8Array): void;
	close(code?: number): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
}

export type SpritesSocketFactory = (url: string, init: { headers: Record<string, string> }) => SpritesSocket;

/** The Sprites provider's options: the token, then the shared adapter's (HostedOptions). */
export interface SpritesProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** A Sprites API token. The caller passes it; this provider never reads it from the environment. */
	token: string;
	/** The API's root; default https://api.sprites.dev. */
	apiUrl?: string;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** For tests: every exec socket opens through it. Default Node's global WebSocket. */
	webSocket?: SpritesSocketFactory;
}

export async function create(options: SpritesProviderOptions): Promise<SpritesProvider> {
	return new SpritesProvider(options);
}

export const conformance = () => import("./conformance/sprites.js");

export const DEFAULT_API_URL = "https://api.sprites.dev";
/** Every computer's name starts with this (MachineRequest.name), so a listing asks for computers alone. */
const NAME_PREFIX = "computer-";
const DAY_MS = 24 * 60 * 60_000;
/** A sprite lives until it is deleted (D lifecycle), so the cap is the janitor's convention. */
const MAX_LIFETIME_MS = 30 * DAY_MS;
const CALL_MS = 30_000;
/** A listing's page, the most D allows. */
const PAGE = 500;
/** A stdin frame's bytes, and the socket's backlog a write waits under. */
const STDIN_BYTES = 64 * 1024;
const BACKLOG_BYTES = 1024 * 1024;
/** How long Fly lets a command run on after its socket is gone (D exec, a Go duration): the bridge's reader is gone too. */
const AFTER_DISCONNECT = "10s";
/** The exec socket's frames (D exec): the first byte names the stream. */
const FRAME = { stdin: 0, stdout: 1, stderr: 2, exit: 3, eof: 4 } as const;

/** A sprite as the API answers it (S SpriteInfo), as far as this host reads it. */
type Sprite = { name: string; status?: string; labels?: string[]; created_at?: string };
/**
 * A command as the exec pieces hold it: its socket, its events not yet read, and its session once Fly names it (named
 * settles then, or when the socket closes first).
 */
type Exec = { socket: SpritesSocket; queue: FramedEvent[]; closed: boolean; failure?: Error; session?: string; named: Promise<void>; wake: () => void };

/** Fly's statuses: cold and warm are a sprite asleep, which the next exec wakes. */
const STATES: Readonly<Record<string, Machine["state"]>> = { running: "running", warm: "running", cold: "running" };

/** `name=value` strings as a map; a string with no `=` is none of ours. */
const labelsOf = (strings: readonly string[] = []): Record<string, string> => Object.fromEntries(strings.filter((one) => one.includes("=")).map((one) => [one.slice(0, one.indexOf("=")), one.slice(one.indexOf("=") + 1)]));

function machineOf(sprite: Sprite): Machine {
	const state = STATES[sprite.status ?? ""];
	const created = dateOf(sprite.created_at);
	return {
		id: sprite.name,
		labels: labelsOf(sprite.labels),
		// One Fly reads in a status this host doesn't know is listed, so the janitor still ends it.
		state: state ?? "stopped",
		...(state === undefined ? { why: `Fly reads its status as ${sprite.status ?? "none"}` } : {}),
		...(created ? { createdAt: created } : {}),
	};
}

class SpritesHost implements MachineHost {
	readonly descriptor = SPRITES;
	readonly facts: HostFacts = { daemon: "child", isolation: "microvm", lifetime: "janitor", maxLifetimeMs: MAX_LIFETIME_MS, arch: "amd64", vendorAgentPorts: [], labels: { packed: { valueBytes: 52 } } };
	readonly #api: Rest;
	readonly #token: string;
	readonly #wsUrl: string;
	readonly #webSocket: SpritesSocketFactory;

	constructor(options: { token: string; apiUrl: string; fetch?: typeof fetch; webSocket: SpritesSocketFactory }) {
		this.#token = options.token;
		this.#wsUrl = options.apiUrl.replace(/^https/, "wss");
		this.#webSocket = options.webSocket;
		this.#api = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${this.#token}`, Accept: "application/json" }),
			vendor: "sprites",
			...(options.fetch ? { fetch: options.fetch } : {}),
			timeoutMs: CALL_MS,
			retry: { attempts: 3, baseMs: 500 },
			// The error body is {error: <code>, message} (D errors); a rate or a concurrency cap is a limit whatever its status.
			explain: ({ status, bytes, what }) => {
				const body = jsonOf(bytes) as { error?: unknown; message?: unknown } | null;
				const words = [body?.error, body?.message].filter((part) => typeof part === "string" && part !== "").join(": ");
				const limit = body?.error === "sprite_creation_rate_limited" || body?.error === "concurrent_sprite_limit_exceeded";
				return { ...(limit ? { code: "limit" as const } : {}), message: `${what} answered ${status}${words ? `: ${words}` : ""}` };
			},
		});
	}

	async #call(method: string, path: string, query: Record<string, string>, ctx: HostCall, init: RestInit = {}): Promise<{ status: number; body: unknown }> {
		const search = new URLSearchParams(query).toString();
		const answer = orThrow(await this.#api.call(method, `${this.#api.url(path)}${search ? `?${search}` : ""}`, { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal));
		return { status: answer.status, body: jsonOf(answer.bytes) };
	}

	/** POST /v1/sprites: the request's name and its labels as `name=value` strings. Fly answers at once, the name the id. */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const labels = Object.entries(req.labels).map(([name, value]) => `${name}=${value}`);
		await this.#call("POST", "/v1/sprites", {}, ctx, { json: { name: req.name, labels }, named: true });
		return { id: req.name };
	}

	/** GET /v1/sprites/{name}; a 404 is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const read = await this.#call("GET", `/v1/sprites/${encodeURIComponent(id)}`, {}, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		return read.status === 404 ? undefined : machineOf(read.body as Sprite);
	}

	/**
	 * GET /v1/sprites by the computers' name prefix, every page; then the asked labels, here, since Fly filters by none. One
	 * listed with no labels is kept: the adapter reads each by get and keeps those that carry them.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const page = async (cursor?: string) => {
			const { body } = await this.#call("GET", "/v1/sprites", { prefix: NAME_PREFIX, max_results: String(PAGE), ...(cursor ? { continuation_token: cursor } : {}) }, ctx, { retry: true });
			const read = body as { sprites?: Sprite[]; has_more?: boolean; next_continuation_token?: string | null };
			return ok({ items: read.sprites ?? [], ...(read.has_more && read.next_continuation_token ? { next: read.next_continuation_token } : {}) });
		};
		const asked = Object.entries(labels);
		return orThrow(await allPages<Sprite>(page, 100, { vendor: "sprites", what: "GET /v1/sprites" }))
			.filter((sprite) => sprite.name.startsWith(NAME_PREFIX))
			.map(machineOf)
			.filter((machine) => Object.keys(machine.labels).length === 0 || asked.every(([name, value]) => machine.labels[name] === value));
	}

	/** DELETE /v1/sprites/{name}; one Fly no longer has is done. The adapter reads it back gone. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/v1/sprites/${encodeURIComponent(id)}`, {}, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
	}

	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		return framedExec<Exec>(
			{
				start: (words, ctx) => this.#open(id, words, ctx),
				events: (exec) => this.#events(exec),
				write: async (exec, text) => {
					const bytes = Buffer.from(text, "utf8");
					for (let at = 0; at < bytes.length; at += STDIN_BYTES) {
						if (exec.socket.readyState !== 1) throw new Error("the exec socket is closed");
						exec.socket.send(framed(FRAME.stdin, bytes.subarray(at, at + STDIN_BYTES)));
						while (exec.socket.bufferedAmount > BACKLOG_BYTES && exec.socket.readyState === 1) await pause(5);
					}
				},
				end: async (exec) => {
					if (exec.socket.readyState === 1) exec.socket.send(framed(FRAME.eof));
				},
				// The session's kill call (D exec kill), SIGKILL, by the id Fly's session_info named; then the socket closes. A kill
				// that comes after the open and before session_info waits for it (at most CALL_MS): closing alone would leave the
				// command to run on for AFTER_DISCONNECT.
				kill: async (exec) => {
					try {
						if (exec.session === undefined) await settledWithin(exec.named, CALL_MS);
						if (exec.session !== undefined) await this.#call("POST", `/v1/sprites/${encodeURIComponent(id)}/exec/${encodeURIComponent(exec.session)}/kill`, { signal: "SIGKILL" }, { timeoutMs: CALL_MS });
					} finally {
						exec.socket.close(1000);
					}
				},
			},
			argv,
			ctx,
		);
	}

	/**
	 * Opens the exec socket: argv as its cmd words, argv[0] its path, stdin on, and a short run after a disconnect. Answers
	 * once it is open. One that never opens says whether the sprite is there: a refused upgrade's status never reaches a
	 * WebSocket client.
	 */
	async #open(id: string, argv: readonly string[], ctx: HostCall): Promise<Exec> {
		const url = new URL(`${this.#wsUrl}/v1/sprites/${encodeURIComponent(id)}/exec`);
		for (const word of argv) url.searchParams.append("cmd", word);
		url.searchParams.set("path", argv[0] ?? "");
		url.searchParams.set("stdin", "true");
		url.searchParams.set("max_run_after_disconnect", AFTER_DISCONNECT);
		const socket = this.#webSocket(url.href, { headers: { Authorization: `Bearer ${this.#token}` } });
		socket.binaryType = "arraybuffer";
		let named!: () => void;
		const exec: Exec = { socket, queue: [], closed: false, named: new Promise<void>((done) => (named = done)), wake: () => {} };
		const push = (event: FramedEvent) => {
			exec.queue.push(event);
			exec.wake();
		};
		let opened!: (failure?: Error) => void;
		const open = new Promise<Error | undefined>((done) => (opened = done));
		socket.addEventListener("open", () => opened());
		socket.addEventListener("message", ({ data }) => {
			if (typeof data === "string") {
				const message = jsonOf(Buffer.from(data)) as { type?: unknown; session_id?: unknown; exit_code?: unknown } | null;
				if (message?.type === "session_info" && (typeof message.session_id === "string" || typeof message.session_id === "number")) {
					exec.session = String(message.session_id);
					named();
				} else if (message?.type === "exit" && typeof message.exit_code === "number") push({ exit: message.exit_code });
				return;
			}
			const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
			if (bytes === undefined || bytes.length === 0) return;
			const payload = Buffer.from(bytes.buffer, bytes.byteOffset + 1, bytes.length - 1);
			if (bytes[0] === FRAME.stdout || bytes[0] === FRAME.stderr) push({ stream: bytes[0] === FRAME.stdout ? "stdout" : "stderr", base64: payload.toString("base64") });
			else if (bytes[0] === FRAME.exit) push({ exit: payload[0] ?? 0 });
		});
		socket.addEventListener("error", (event) => {
			exec.failure ??= new Error(`the exec socket failed${event.message ? `: ${event.message}` : ""}`);
			opened(exec.failure);
		});
		socket.addEventListener("close", ({ code }) => {
			exec.closed = true;
			opened(new Error(`the exec socket closed before it opened (code ${code ?? "none"})`));
			named();
			exec.wake();
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<Error>((done) => {
			timer = setTimeout(() => done(new HostError("timeout", `the exec socket of ${id} did not open within ${Math.round(ctx.timeoutMs / 1000)} s`)), ctx.timeoutMs);
			ctx.signal?.addEventListener("abort", () => done(new HostError("aborted", `the exec socket of ${id} was aborted`)), { once: true });
		});
		const failed = await Promise.race([open, bound]).finally(() => clearTimeout(timer));
		if (failed === undefined) return exec;
		socket.close(1000);
		if (failed instanceof HostError) throw failed;
		if ((await this.get(id, { timeoutMs: CALL_MS })) === undefined) throw new HostError("not_found", `no sprite ${id}`);
		throw new HostError("vendor", `${failed.message} (sprite ${id})`);
	}

	/** The command's events as the socket gives them, until its exit or the socket's close; the socket closes after. */
	async *#events(exec: Exec): AsyncGenerator<FramedEvent> {
		try {
			for (;;) {
				const event = exec.queue.shift();
				if (event !== undefined) {
					yield event;
					if ("exit" in event) return;
					continue;
				}
				if (exec.closed) {
					if (exec.failure) throw exec.failure;
					return;
				}
				await new Promise<void>((done) => (exec.wake = done));
			}
		} finally {
			if (exec.socket.readyState < 2) exec.socket.close(1000);
		}
	}

	/** A sprite has Fly's own size and image: a spec that names another is refused. */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = (["cpus", "memoryMb"] as const).filter((field) => spec[field] !== undefined).map((field) => ({ field, message: `a sprite's size is Fly's own: leave out ${field}` }));
		if (spec.image !== undefined && spec.image !== SPRITES_IMAGE) refusals.push({ field: "image", message: `a sprite starts from Fly's own Ubuntu image alone, "${SPRITES_IMAGE}"` });
		return refusals;
	}
}

/** Waits for a promise to settle, or for ms, whichever comes first; the timer goes either way. */
async function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([promise, new Promise<void>((done) => (timer = setTimeout(done, ms)))]).finally(() => clearTimeout(timer));
}

/** One exec frame: its stream's byte, then the bytes. */
function framed(stream: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
	const frame = new Uint8Array(bytes.length + 1);
	frame[0] = stream;
	frame.set(bytes, 1);
	return frame;
}

/** Computers that are sprites, on the shared adapter: a sandbox from Fly's own image ("default"), no desktop. */
export class SpritesProvider extends HostedProvider {
	constructor(options: SpritesProviderOptions) {
		const { token, apiUrl = DEFAULT_API_URL, fetch, webSocket, maxLifetimeMs = MAX_LIFETIME_MS, ...rest } = options ?? ({} as SpritesProviderOptions);
		if (typeof token !== "string" || token === "") throw new Error("options.token, a Sprites API token, is required: the provider reads no environment, so the caller passes it");
		super(
			new SpritesHost({
				token,
				apiUrl: httpsBase(apiUrl, "the Sprites API URL"),
				...(fetch ? { fetch } : {}),
				webSocket: webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as SpritesSocket),
			}),
			{ ...rest, maxLifetimeMs },
		);
	}
}
