// The client end of a daemon connection, over any readable and writable byte stream.
import type { Readable, Writable } from "node:stream";
import {
	CANCEL_METHOD,
	type ComputerClient,
	type DaemonErrorKind,
	type DaemonMethod,
	type DaemonMethods,
	JSONRPC_CODES,
	MAX_LINE_BYTES,
} from "./protocol.js";
import { type ComputerError, type ComputerErrorCode, fail, ok, type Result } from "./result.js";

export interface DaemonStream {
	readable: Readable;
	writable: Writable;
}

export interface CallOptions {
	signal?: AbortSignal;
}

type ReplyError = { code?: unknown; message?: unknown; data?: { kind?: unknown } };

const KINDS: ReadonlySet<string> = new Set<DaemonErrorKind>([
	"not_found",
	"invalid",
	"timeout",
	"aborted",
	"denied",
	"limit",
	"unsupported",
	"exists",
	"not_dir",
	"is_dir",
]);

/** A daemon's error reply as a ComputerError: its kind when it names one, else what its JSON-RPC code means. */
function fromReply(error: ReplyError): ComputerError {
	const message = typeof error.message === "string" ? error.message : "the daemon answered with an error";
	const kind = error.data?.kind;
	if (typeof kind === "string" && KINDS.has(kind)) return { code: kind as ComputerErrorCode, message };
	if (error.code === JSONRPC_CODES.methodNotFound) return { code: "unsupported", message };
	if (error.code === JSONRPC_CODES.requestCancelled) return { code: "aborted", message };
	return { code: "invalid", message };
}

/**
 * Calls a daemon's methods. Each call gets its own id; replies may come in any order. An aborted call sends
 * $/cancelRequest and returns `aborted` at once; the daemon still ends what the call started. When the stream ends,
 * every pending and later call fails with `gone`. A line that is not a reply to a pending call is dropped.
 */
export class DaemonClient implements ComputerClient {
	readonly #writable: Writable;
	readonly #readable: Readable;
	readonly #pending = new Map<number, (result: Result<unknown>) => void>();
	#nextId = 1;
	#chunks: Buffer[] = [];
	#buffered = 0;
	#gone: ComputerError | undefined;

	constructor({ readable, writable }: DaemonStream) {
		this.#readable = readable;
		this.#writable = writable;
		readable.on("data", (chunk: Buffer | string) => this.#read(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
		readable.on("end", () => this.#end("the daemon's stream ended"));
		readable.on("close", () => this.#end("the daemon's stream closed"));
		readable.on("error", (error) => this.#end(`the daemon's stream failed: ${error.message}`));
		writable.on("error", (error) => this.#end(`the daemon's stream failed: ${error.message}`));
	}

	async call<M extends DaemonMethod>(
		method: M,
		params: DaemonMethods[M]["params"],
		options: CallOptions = {},
	): Promise<Result<DaemonMethods[M]["result"]>> {
		const { signal } = options;
		if (this.#gone) return { ok: false, error: this.#gone };
		if (signal?.aborted) return fail("aborted", `${method} was aborted before it was sent`);
		const id = this.#nextId++;
		const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		if (Buffer.byteLength(line) - 1 > MAX_LINE_BYTES) return fail("limit", `the ${method} request is over the 1 MiB line limit`);
		return new Promise((resolve) => {
			const onAbort = () => {
				if (!this.#pending.delete(id)) return;
				this.#write({ jsonrpc: "2.0", method: CANCEL_METHOD, params: { id } });
				resolve(fail("aborted", `${method} was aborted`));
			};
			this.#pending.set(id, (result) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(result as Result<DaemonMethods[M]["result"]>);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#writable.write(line);
		});
	}

	/** Ends the connection: pending and later calls fail with `gone`. */
	close(): void {
		this.#end("the connection was closed");
		this.#writable.end();
		this.#readable.destroy();
	}

	#write(message: unknown): void {
		if (!this.#gone && this.#writable.writable) this.#writable.write(`${JSON.stringify(message)}\n`);
	}

	#read(chunk: Buffer): void {
		let start = 0;
		let at: number;
		while (!this.#gone && (at = chunk.indexOf(0x0a, start)) >= 0) {
			const piece = chunk.subarray(start, at);
			start = at + 1;
			if (this.#buffered + piece.length > MAX_LINE_BYTES) return this.#overflow();
			const line = this.#chunks.length === 0 ? piece : Buffer.concat([...this.#chunks, piece]);
			this.#chunks = [];
			this.#buffered = 0;
			this.#line(line.toString("utf8"));
		}
		if (this.#gone || start === chunk.length) return;
		this.#buffered += chunk.length - start;
		if (this.#buffered > MAX_LINE_BYTES) return this.#overflow();
		this.#chunks.push(chunk.subarray(start));
	}

	#overflow(): void {
		this.#chunks = [];
		this.#buffered = 0;
		this.#end("the daemon sent a line over the 1 MiB limit");
		this.#readable.destroy();
	}

	#line(text: string): void {
		let message: { id?: unknown; result?: unknown; error?: ReplyError | null };
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof message?.id !== "number") return;
		const settle = this.#pending.get(message.id);
		if (settle === undefined) return;
		this.#pending.delete(message.id);
		settle(message.error != null ? { ok: false, error: fromReply(message.error) } : ok(message.result));
	}

	#end(why: string): void {
		if (this.#gone) return;
		const gone: ComputerError = { code: "gone", message: why };
		this.#gone = gone;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const settle of pending) settle({ ok: false, error: gone });
	}
}
