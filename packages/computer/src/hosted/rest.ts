// A vendor's REST API, once: fetch with the key in a header, JSON or form both ways, one bound, a retry rule the vendor
// chooses, and a failure that names the method, path and status and never a header. The status table and the
// cursor-page loop are here too, so a REST vendor writes only its own words and its own retry rule.
import { type ComputerError, type ComputerErrorCode, errorOf, fail, ok, type Result, vendorFail } from "../result.js";
import { pause } from "./process.js";

/**
 * A status as a code: 401 and 403 denied, 404 and 410 not found, 408 timeout, 402/429/507 limit, 400/409/422 invalid,
 * else vendor; 409 is exists on a call that carries the machine's name (RestInit.named).
 */
export function httpCode(status: number, named = false): ComputerErrorCode {
	if (status === 401 || status === 403) return "denied";
	if (status === 404 || status === 410) return "not_found";
	if (status === 408) return "timeout";
	if (status === 402 || status === 429 || status === 507) return "limit";
	if (status === 409) return named ? "exists" : "invalid";
	if (status === 400 || status === 422) return "invalid";
	return "vendor";
}

export interface RestAnswer {
	status: number;
	bytes: Uint8Array;
}

export interface RestInit {
	json?: unknown;
	form?: FormData;
	/** A body sent as it is (a file's bytes). */
	bytes?: Uint8Array<ArrayBuffer>;
	timeoutMs?: number;
	/**
	 * true: send again on no answer, 429 and 5xx (only for a call that may run twice). A function: send again only on an
	 * answer it says is a refusal that did not run the call, never on no answer or a timeout.
	 */
	retry?: boolean | ((status: number, bytes: Uint8Array) => boolean);
	/** Whether an answer of this status is a value, with its status, not a failure (not retried). Default: a 2xx. */
	accept?: (status: number) => boolean;
	/**
	 * The call carries the machine's name (a create by MachineRequest.name): its 409 is the vendor's word that a machine
	 * has that name, exists, which the adapter reads as the machine its listing by the name finds.
	 */
	named?: boolean;
	/** Headers of this call alone, over the client's: an idempotency key, a delete's confirmation. */
	headers?: Record<string, string>;
}

export interface RestOptions {
	/** The API's root; trailing slashes are cut. `rest.url(path)` joins it. */
	base: string;
	/** The headers of every call (the key, Accept, a source tag). A body's Content-Type is added. */
	headers: () => Record<string, string>;
	/** The provider's id: names a failure of code vendor. */
	vendor: string;
	fetch?: typeof fetch;
	/** The bound of a call that gives none. */
	timeoutMs: number;
	/** A signal that fires after ms, which bounds a call; default a timer. Tests give one they fire. */
	timeout?: (ms: number) => AbortSignal;
	retry?: { attempts: number; baseMs: number; pause?: (ms: number, signal?: AbortSignal) => Promise<void> };
	/** The vendor's own code or words for an answer that is not accepted; what it leaves out is httpCode and `what: status text`. */
	explain?: (answer: { status: number; bytes: Uint8Array; text: string; what: string }) => { code?: ComputerErrorCode; message?: string };
}

const decoder = new TextDecoder();

/** The JSON a body holds; null for none or for text that is not JSON. */
export function jsonOf(bytes: Uint8Array): unknown {
	const text = decoder.decode(bytes);
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Whether fetch failed on a redirect it was told not to follow. */
function redirected(cause: unknown): boolean {
	const inner = (cause as { cause?: unknown } | null)?.cause;
	return /redirect/i.test(`${(cause as Error | null)?.message ?? ""} ${(inner as Error | null)?.message ?? ""}`);
}

/**
 * A call's failure. `redirect` marks one the API answered with a redirect, refused unfollowed: its answer is unread,
 * so the vendor may have acted on the call (a 303 after a create is the usual answer to a POST).
 */
export interface RestError extends ComputerError {
	redirect?: true;
}

/**
 * An answer's body. One that is not a 2xx keeps its status when its words break off, unless the bound or the caller cut
 * them: the status is the vendor's answer, the words only explain it.
 */
async function bytesOf(response: Response, cut: AbortSignal): Promise<Uint8Array> {
	try {
		return new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		if (response.ok || cut.aborted) throw error;
		return new Uint8Array();
	}
}

/** An accepted answer whose body is read as it comes: an event stream. */
export interface RestStream {
	status: number;
	body: AsyncIterable<Uint8Array>;
}

export interface Rest {
	url(path: string): string;
	call(method: string, url: string, init?: RestInit, signal?: AbortSignal): Promise<Result<RestAnswer, RestError>>;
	/** call, with the body read as JSON (null for none). */
	json(method: string, url: string, init?: RestInit, signal?: AbortSignal): Promise<Result<unknown, RestError>>;
	/**
	 * call, with an accepted answer's body handed back unread, as it comes (a process's events). The bound covers the
	 * answer's start alone: the body has none but the caller's signal, which ends it too.
	 */
	stream(method: string, url: string, init?: RestInit, signal?: AbortSignal): Promise<Result<RestStream, RestError>>;
}

const NO_BODY: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} };

/**
 * An API's https base URL: its origin and path, normalized, with no trailing slash. Throws in words on another scheme,
 * loopback http included, so a key never crosses in the clear, and on a user or password, a query or a fragment, which
 * no provider's API takes. Every provider that takes a URL from its caller and sends a key to it takes the URL through
 * it: Agent37, boxd, Browserbase, the Cloudflare relay, Daytona (and the toolbox URL Daytona answers with), Groundbox,
 * Kernel, Modal, Morph, Orgo, the phone harness and smol cloud, and so does each sweep scope that names one. E2B takes a
 * host name and Fly nothing, and each builds its https URL itself.
 */
export function httpsBase(url: string, what: string): string {
	return keyBase(url, what, ["https:"]);
}

/**
 * httpsBase's rule over `schemes` (each as URL.protocol gives it, `https:`): the same refusals in the same words, the
 * same normalized form. For a URL a key goes to whose own protocol allows another scheme: a socket's wss, or the http
 * of an OpenTelemetry collector or of a server on loopback.
 */
export function keyBase(url: string, what: string, schemes: readonly string[]): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Nothing of the string is echoed: it may carry a key in its query.
		throw new Error(`${what} is not a URL`);
	}
	const clear = schemes.includes("http:") || schemes.includes("ws:") ? "" : ", so the key never crosses in the clear";
	if (!schemes.includes(parsed.protocol)) throw new Error(`${what} must be ${schemes.map((scheme) => scheme.replace(/:$/, "")).join(" or ")}${clear}: ${parsed.protocol}`);
	// The words give the origin alone: a user, a password or a query may be a key.
	if (parsed.username !== "" || parsed.password !== "") throw new Error(`${what} takes no user or password, since the key goes to it: ${parsed.origin}`);
	if (parsed.search !== "" || parsed.hash !== "") throw new Error(`${what} takes no query or fragment: ${parsed.origin}`);
	// The normalized form (lower-case scheme and host, a default port dropped), so a consumer that reads the scheme
	// case-sensitively, as nice-grpc does for Modal's server, sees https.
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

export function rest(options: RestOptions): Rest {
	const base = options.base.replace(/\/+$/, "");
	const fetcher = options.fetch ?? fetch;
	const wait = options.retry?.pause ?? pause;

	/** One call, sent again as init.retry says; an accepted answer is what take makes of it, within the call's bound. */
	async function exchange<T>(method: string, url: string, init: RestInit, signal: AbortSignal | undefined, take: (response: Response, cut: AbortSignal) => Promise<T>): Promise<Result<T, RestError>> {
		const what = `${method} ${new URL(url).pathname}`;
		const attempts = init.retry === undefined || init.retry === false || options.retry === undefined ? 1 : options.retry.attempts;
		const timeoutMs = init.timeoutMs ?? options.timeoutMs;
		const accepted = init.accept ?? ((status: number) => status >= 200 && status < 300);
		for (let attempt = 1; ; attempt++) {
			if (signal?.aborted) return fail("aborted", `${what} was aborted`);
			// A bound that lets go once the answer is taken, so a body read after it (a stream's) is never cut by it.
			const timeout = new AbortController();
			const cut = () => timeout.abort();
			const bound = options.timeout?.(timeoutMs);
			const timer = bound === undefined ? setTimeout(cut, timeoutMs) : undefined;
			if (bound?.aborted) cut();
			bound?.addEventListener("abort", cut, { once: true });
			let failure: RestError;
			let retryable: boolean;
			try {
				const headers = { ...options.headers(), ...init.headers, ...(init.json === undefined ? {} : { "Content-Type": "application/json" }) };
				const either = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
				// Never a redirect: a followed one keeps the key, and could carry a call to another host.
				const response = await fetcher(url, {
					method,
					headers,
					body: init.json === undefined ? (init.bytes ?? init.form) : JSON.stringify(init.json),
					redirect: "error",
					signal: either,
				});
				if (accepted(response.status)) return ok(await take(response, either));
				const bytes = await bytesOf(response, either);
				const own = typeof init.retry === "function";
				retryable = own ? (init.retry as (status: number, bytes: Uint8Array) => boolean)(response.status, bytes) : init.retry === true && (response.status === 429 || response.status >= 500);
				const text = decoder.decode(bytes).replace(/\s+/g, " ").slice(0, 300);
				const said = options.explain?.({ status: response.status, bytes, text, what }) ?? {};
				failure = errorOf(said.code ?? httpCode(response.status, init.named), said.message ?? `${what}: ${response.status} ${text}`, options.vendor);
			} catch (cause) {
				if (signal?.aborted) return fail("aborted", `${what} was aborted`);
				// No answer: the request may have reached the vendor, so only a call that may run twice is sent again.
				retryable = init.retry === true;
				if (timeout.signal.aborted) failure = { code: "timeout", message: `${what} did not answer within ${Math.round(timeoutMs / 100) / 10} s` };
				else if (redirected(cause)) {
					const message = `${what}: the API answered with a redirect, which is never followed: it would carry the key`;
					return { ok: false, error: { code: "vendor", vendor: options.vendor, message, redirect: true } };
				}
				else failure = { code: "vendor", vendor: options.vendor, message: `${what}: ${(cause as Error).message}` };
			} finally {
				clearTimeout(timer);
				bound?.removeEventListener("abort", cut);
			}
			if (!retryable || attempt >= attempts) return { ok: false, error: failure };
			await wait((options.retry?.baseMs ?? 0) * 2 ** (attempt - 1), signal);
		}
	}

	const call = (method: string, url: string, init: RestInit = {}, signal?: AbortSignal) =>
		exchange(method, url, init, signal, async (response, cut): Promise<RestAnswer> => ({ status: response.status, bytes: await bytesOf(response, cut) }));

	return {
		url: (path) => `${base}${path}`,
		call,
		async json(method, url, init, signal) {
			const answer = await call(method, url, init, signal);
			return answer.ok ? ok(jsonOf(answer.value.bytes)) : answer;
		},
		stream: (method, url, init = {}, signal) => exchange(method, url, init, signal, async (response): Promise<RestStream> => ({ status: response.status, body: response.body ?? NO_BODY })),
	};
}

/** The JSON value of each line of a body of newline-delimited JSON, as the lines come; a line that is not JSON throws. */
export async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncIterable<unknown> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of body) {
		rest += decoder.decode(chunk, { stream: true });
		let at = rest.indexOf("\n");
		while (at >= 0) {
			const line = rest.slice(0, at).trim();
			rest = rest.slice(at + 1);
			if (line !== "") yield JSON.parse(line);
			at = rest.indexOf("\n");
		}
	}
	rest += decoder.decode();
	if (rest.trim() !== "") yield JSON.parse(rest);
}

/** One event of a text/event-stream body: its type, its data, and the last id and retry the stream had set by then. */
export interface SseEvent {
	/** "message" unless an `event:` field named it. */
	event: string;
	/** Its `data:` fields, joined by "\n". */
	data: string;
	/** The last `id:` so far ("" for none): what a host that resumes a dropped stream asks from. */
	id: string;
	/** The last `retry:` so far, the ms the vendor asks a reconnect to wait. */
	retry?: number;
}

/**
 * The events of a body of server-sent events (text/event-stream), as they come, read as the HTML standard's event
 * stream says: lines end at \r\n, \n or \r; a line that starts with ":" is a comment (a vendor's keep-alive); a blank
 * line ends an event, and one with no data is none. An event the body ends inside is dropped.
 */
export async function* sse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent, void, undefined> {
	// Not ignoreBOM: the standard drops a U+FEFF that starts the stream.
	const decoder = new TextDecoder();
	let rest = "";
	let data: string[] = [];
	let event = "";
	let id = "";
	let retry: number | undefined;
	// The last line ended at a \r that ended what came: a \n that starts what comes next is that \r's, no line of its own.
	let halfCrLf = false;
	const eol = /\r\n|\r|\n/g;
	function* lines(text: string): Generator<SseEvent> {
		if (halfCrLf && text !== "") {
			if (text.startsWith("\n")) text = text.slice(1);
			halfCrLf = false;
		}
		// What is left from before holds no line end: the search starts at what came.
		eol.lastIndex = rest.length;
		rest += text;
		let from = 0;
		for (let end = eol.exec(rest); end !== null; end = eol.exec(rest)) {
			const line = rest.slice(from, end.index);
			from = eol.lastIndex;
			halfCrLf = end[0] === "\r" && from === rest.length;
			if (line === "") {
				if (data.length > 0) yield { event: event || "message", data: data.join("\n"), id, ...(retry === undefined ? {} : { retry }) };
				data = [];
				event = "";
				continue;
			}
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
			if (field === "data") data.push(value);
			else if (field === "event") event = value;
			else if (field === "id" && !value.includes("\0")) id = value;
			else if (field === "retry" && /^[0-9]+$/.test(value)) retry = Number(value);
		}
		rest = rest.slice(from);
	}
	for await (const chunk of body) yield* lines(decoder.decode(chunk, { stream: true }));
	yield* lines(decoder.decode());
}

/**
 * Every item of a paged listing. next gets the cursor of the page to read (none for the first) and answers its items and
 * the cursor of the page after it, or nothing at the end. A cursor that comes back twice, or a listing past max pages,
 * is a failure: this provider would miss machines.
 */
export async function allPages<T>(
	next: (cursor: string | undefined) => Promise<Result<{ items: T[]; next?: string }>>,
	max: number,
	of: { vendor: string; what: string },
): Promise<Result<T[]>> {
	const found: T[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < max; page++) {
		const read = await next(cursor);
		if (!read.ok) return read;
		found.push(...read.value.items);
		const after = read.value.next;
		if (after === undefined || after === "") return ok(found);
		if (seen.has(after)) return vendorFail(of.vendor, `${of.what}'s cursor ${after} came back twice`);
		seen.add(after);
		cursor = after;
	}
	return vendorFail(of.vendor, `${of.what} ran past ${max} pages`);
}
