// A vendor's REST API, once: fetch with the key in a header, JSON or form both ways, one bound, a retry rule the vendor
// chooses, and a failure that names the method, path and status and never a header. The status table and the
// cursor-page loop are here too, so a REST vendor writes only its own words and its own retry rule.
import { type ComputerError, type ComputerErrorCode, errorOf, fail, ok, type Result, vendorFail } from "../result.js";
import { pause } from "./process.js";

/** A status as a code: 401 and 403 denied, 404 and 410 not found, 408 timeout, 402/429/507 limit, 400/409/422 invalid, else vendor. */
export function httpCode(status: number): ComputerErrorCode {
	if (status === 401 || status === 403) return "denied";
	if (status === 404 || status === 410) return "not_found";
	if (status === 408) return "timeout";
	if (status === 402 || status === 429 || status === 507) return "limit";
	if (status === 400 || status === 409 || status === 422) return "invalid";
	return "vendor";
}

export interface RestAnswer {
	status: number;
	bytes: Uint8Array;
}

export interface RestInit {
	json?: unknown;
	form?: FormData;
	timeoutMs?: number;
	/**
	 * true: send again on no answer, 429 and 5xx (only for a call that may run twice). A function: send again only on an
	 * answer it says is a refusal that did not run the call, never on no answer or a timeout.
	 */
	retry?: boolean | ((status: number, bytes: Uint8Array) => boolean);
	/** Whether an answer of this status is a value, with its status, not a failure (not retried). Default: a 2xx. */
	accept?: (status: number) => boolean;
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

export interface Rest {
	url(path: string): string;
	call(method: string, url: string, init?: RestInit, signal?: AbortSignal): Promise<Result<RestAnswer>>;
	/** call, with the body read as JSON (null for none). */
	json(method: string, url: string, init?: RestInit, signal?: AbortSignal): Promise<Result<unknown>>;
}

export function rest(options: RestOptions): Rest {
	const base = options.base.replace(/\/+$/, "");
	const fetcher = options.fetch ?? fetch;
	const wait = options.retry?.pause ?? pause;

	async function call(method: string, url: string, init: RestInit = {}, signal?: AbortSignal): Promise<Result<RestAnswer>> {
		const what = `${method} ${new URL(url).pathname}`;
		const attempts = init.retry === undefined || init.retry === false || options.retry === undefined ? 1 : options.retry.attempts;
		const timeoutMs = init.timeoutMs ?? options.timeoutMs;
		const accepted = init.accept ?? ((status: number) => status >= 200 && status < 300);
		for (let attempt = 1; ; attempt++) {
			if (signal?.aborted) return fail("aborted", `${what} was aborted`);
			const timeout = AbortSignal.timeout(timeoutMs);
			let failure: ComputerError;
			let retryable: boolean;
			try {
				const headers = init.json === undefined ? options.headers() : { ...options.headers(), "Content-Type": "application/json" };
				// Never a redirect: a followed one keeps the key, and could carry a call to another host.
				const response = await fetcher(url, {
					method,
					headers,
					body: init.json === undefined ? init.form : JSON.stringify(init.json),
					redirect: "error",
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (accepted(response.status)) return ok({ status: response.status, bytes });
				const own = typeof init.retry === "function";
				retryable = own ? (init.retry as (status: number, bytes: Uint8Array) => boolean)(response.status, bytes) : init.retry === true && (response.status === 429 || response.status >= 500);
				const text = decoder.decode(bytes).replace(/\s+/g, " ").slice(0, 300);
				const said = options.explain?.({ status: response.status, bytes, text, what }) ?? {};
				failure = errorOf(said.code ?? httpCode(response.status), said.message ?? `${what}: ${response.status} ${text}`, options.vendor);
				// A 429 or a 5xx is the vendor's own trouble, not the call's: transient, whatever the vendor's words made its code.
				if (response.status === 429 || response.status >= 500) failure.transient = true;
			} catch (cause) {
				if (signal?.aborted) return fail("aborted", `${what} was aborted`);
				// No answer: the request may have reached the vendor, so only a call that may run twice is sent again.
				retryable = init.retry === true;
				if (timeout.aborted) failure = { code: "timeout", message: `${what} did not answer within ${timeoutMs / 1000} s`, transient: true };
				else if (redirected(cause)) return vendorFail(options.vendor, `${what}: the API answered with a redirect, which is never followed: it would carry the key`);
				else failure = { code: "vendor", vendor: options.vendor, message: `${what}: ${(cause as Error).message}`, transient: true };
			}
			if (!retryable || attempt >= attempts) return { ok: false, error: failure };
			await wait((options.retry?.baseMs ?? 0) * 2 ** (attempt - 1), signal);
		}
	}

	return {
		url: (path) => `${base}${path}`,
		call,
		async json(method, url, init, signal) {
			const answer = await call(method, url, init, signal);
			return answer.ok ? ok(jsonOf(answer.value.bytes)) : answer;
		},
	};
}

/**
 * Every item of a paged listing. next gets the cursor of the page to read (none for the first) and answers its items and
 * what follows: a cursor string, true for "more, no cursor needed" (a vendor SDK's paginator), or nothing at the end.
 * A cursor that comes back twice, or a listing past max pages, is a failure: this provider would miss machines.
 */
export async function allPages<T>(
	next: (cursor: string | undefined) => Promise<Result<{ items: T[]; next?: string | boolean }>>,
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
		if (after === undefined || after === false || after === "") return ok(found);
		if (typeof after === "string") {
			if (seen.has(after)) return vendorFail(of.vendor, `${of.what}'s cursor ${after} came back twice`);
			seen.add(after);
			cursor = after;
		}
	}
	return vendorFail(of.vendor, `${of.what} ran past ${max} pages`);
}
