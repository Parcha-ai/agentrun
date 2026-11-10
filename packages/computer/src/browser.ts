// What every browser provider shares: a browser is a vendor's browser session that answers CDP (kind browser, daemon
// none). The provider answers hello and ping itself, from the vendor's API; connect hands over the vendor's signed CDP
// URL, which a driver dials. That URL and the live view's are secrets: they live in memory (a UrlStore), and never reach
// a ref, a list, an error's words or a report.
import { randomBytes } from "node:crypto";
import type { CallOptions } from "./client.js";
import type { ComputerClient, DaemonMethod, DaemonMethods, Group, HelloResult } from "./protocol.js";
import type { ComputerCapabilities, ComputerSpec, Refusal } from "./provider.js";
import { checkLifetime } from "./provider.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { BROWSER_IMAGE } from "./descriptors/shared.js";

/** The one image a browser computer runs: the vendor's own Chromium (the browser descriptors' default). */
export { BROWSER_IMAGE };

/** A key's or a value's longest, in characters: what both vendors keep of a metadata entry. */
const MAX_LABEL = 256;

/**
 * Where a provider keeps the URLs it was handed, by session id, in memory only. Default a Map of its own; a host that
 * builds one provider per call passes one store to all of them (pi-browser's process-wide holdings).
 */
export interface UrlStore {
	get(id: string): string | undefined;
	set(id: string, url: string): void;
	delete(id: string): void;
}

export const memoryUrls = (): UrlStore => {
	const urls = new Map<string, string>();
	return { get: (id) => urls.get(id), set: (id, url) => void urls.set(id, url), delete: (id) => void urls.delete(id) };
};

/** A browser's live view: the fullscreen URL, and, where the vendor gives them, the framed one and each tab's. Every URL is a secret. */
export interface BrowserStream {
	url: string;
	expiresAt?: Date;
	framed?: string;
	pages?: Array<{ id: string | null; url: string | null; title: string | null; fullscreen: string | null }>;
}

/** How a release is confirmed: the vendor read back this many times at most, this far apart, until the session ended. */
export interface ReleaseConfirm {
	polls: number;
	intervalMs: number;
}
export const DEFAULT_CONFIRM: ReleaseConfirm = { polls: 6, intervalMs: 500 };
export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A vendor call's failure as the provider returns it: a code and words, and the error the call threw, for a caller that rethrows it as it was. */
export type VendorFailure = { code: ComputerErrorCode; message: string; readonly cause?: unknown };

/** A failure whose cause rides along out of sight: not enumerable, so it is in no JSON, no log line and no report. */
export function vendorFail(code: ComputerErrorCode, message: string, cause?: unknown): Result<never> {
	const failed = fail(code, message);
	if (cause !== undefined && !failed.ok) Object.defineProperty(failed.error, "cause", { value: cause, enumerable: false });
	return failed;
}

/** The error a vendor call threw, behind a failure vendorFail made; undefined for any other. */
export const causeOf = (result: Result<unknown>): unknown => (result.ok ? undefined : (result.error as VendorFailure).cause);

/** The code a vendor's HTTP status reads as. */
export function statusCode(status: number | undefined, vendor: "browserbase" | "kernel"): ComputerErrorCode {
	if (status === 401 || status === 403) return "denied";
	if (status === 404) return "not_found";
	if (status === 429) return "limit";
	return vendor;
}

/** Why labels are not ones a browser provider writes into a vendor's metadata, in words; undefined when they are. */
export function labelsProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (key === "" || key.length > MAX_LABEL || /[\0-\x1f'\\]/.test(key)) return `a label's name is 1 to ${MAX_LABEL} characters with no quote, backslash or control character, not ${JSON.stringify(key)}`;
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (value.length > MAX_LABEL || value.includes("\0")) return `the label ${key} is at most ${MAX_LABEL} characters with no NUL byte`;
	}
	return undefined;
}

/** A label a vendor's query can carry as it is: plain characters, so a quote never ends the query early. */
export const queryable = ([key, value]: [string, string]) => /^[A-Za-z0-9_.:-]+$/.test(key) && /^[A-Za-z0-9_.:-]+$/.test(value);

/** Whether a session's metadata carries every one of these labels. */
export const carries = (held: unknown, labels: Record<string, string>) =>
	typeof held === "object" && held !== null && Object.entries(labels).every(([key, value]) => (held as Record<string, unknown>)[key] === value);

/** The labels a vendor's metadata holds, its string entries only. */
export const labelsOf = (held: unknown): Record<string, string> =>
	typeof held === "object" && held !== null ? Object.fromEntries(Object.entries(held).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

/**
 * The label every create writes beside the spec's, a value of its own: a create whose reply is lost, or whose caller
 * cancels it, finds the browser it made by this label alone and releases it. The provider's own: check() refuses it in a
 * spec, and no list or attach shows it.
 */
export const CREATE_LABEL = "agentrun.create";

/** Labels without the provider's create label. */
export const withoutCreateLabel = (labels: Record<string, string>): Record<string, string> => {
	const { [CREATE_LABEL]: _, ...rest } = labels;
	return rest;
};

/** A create label's value: 16 hex digits, fresh per create. */
export const createLabelValue = () => randomBytes(8).toString("hex");

/**
 * Whether a create that threw may still have made a browser: anything but the vendor's own 4xx answer (a refusal, which
 * makes nothing). A request not answered, aborted, cut short, or answered 5xx or with a body that is no browser may
 * have been admitted.
 */
export function createUncertain(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	return !(typeof status === "number" && status >= 400 && status < 500);
}

/** How long a lost create's browser is looked for, in all, and how often: a vendor may list it a moment late. */
export const RECOVER_MS = 30_000;
const RECOVER_TRIES = 3;
const RECOVER_GAP_MS = 2_000;

/**
 * After a create whose outcome is unknown: the browsers carrying its create label, found under a signal of the
 * recovery's own (the caller's may be what ended the create), each released. The words say what became of them, for the
 * create's failure; they never carry a URL.
 */
export async function recoverCreate(
	what: string,
	find: (signal: AbortSignal) => Promise<Result<string[]>>,
	release: (id: string) => Promise<Result<void>>,
	sleep: (ms: number) => Promise<void>,
): Promise<string> {
	const signal = AbortSignal.timeout(RECOVER_MS);
	let found: Result<string[]> = ok([]);
	for (let tries = 0; tries < RECOVER_TRIES; tries++) {
		if (tries > 0) await sleep(RECOVER_GAP_MS);
		found = await find(signal);
		if (!found.ok || found.value.length > 0 || signal.aborted) break;
	}
	if (!found.ok) return `the ${what} it may have made could not be looked for (${found.error.message}); its labels let a sweep find it`;
	if (found.value.length === 0) return `no ${what} carries its create label, so none was made or the vendor does not list it yet; its labels let a sweep find it`;
	const words: string[] = [];
	for (const id of found.value) {
		const released = await release(id);
		words.push(released.ok ? `the ${what} it made (${id}) was released` : `the ${what} it made (${id}) was not released (${released.error.code}), and its labels let a sweep find it`);
	}
	return words.join("; ");
}

const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels"]);

/**
 * The checks every browser provider makes before a vendor call: the image is chromium, the lifetime is within the
 * vendor's cap (and at least min), the network is open, the labels are ones the vendor's metadata holds, and no field a
 * browser does not take (a size, a user, a workdir, a mount).
 */
export function checkBrowser(spec: ComputerSpec, capabilities: ComputerCapabilities, vendor: string, minLifetimeMs = 1): Refusal[] {
	const refusals: Refusal[] = [];
	const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
	const { image, lifetimeMs, network, labels } = given;
	if (image !== BROWSER_IMAGE) refusals.push({ field: "image", message: `a ${vendor} computer runs ${vendor}'s own Chromium: image is "${BROWSER_IMAGE}", not ${JSON.stringify(image)}` });
	const lifetime = checkLifetime(lifetimeMs, capabilities);
	refusals.push(...lifetime);
	if (lifetime.length === 0 && (lifetimeMs as number) < minLifetimeMs) {
		refusals.push({ field: "lifetimeMs", message: `lifetimeMs is at least ${minLifetimeMs} ms, ${vendor}'s shortest` });
	}
	if (network !== "open") refusals.push({ field: "network", message: `a ${vendor} browser reaches the open web: network is "open", not ${JSON.stringify(network)}` });
	if (labels !== undefined) {
		const problem = labelsProblem(labels);
		if (problem) refusals.push({ field: "labels", message: problem });
		else if (Object.hasOwn(labels as object, CREATE_LABEL)) refusals.push({ field: "labels", message: `the label ${CREATE_LABEL} is the provider's own: each create writes it, so a lost create finds its browser` });
	}
	for (const [field, value] of Object.entries(given)) {
		if (!SPEC_FIELDS.has(field) && value !== undefined) refusals.push({ field, message: `a ${vendor} browser does not take ${field}` });
	}
	return refusals;
}

/** hello for a browser: the provider's version, linux, kind browser and its groups. The vendor reports no arch. */
export const browserHello = (version: string, groups: Group[]): HelloResult => ({ version, os: "linux", kind: "browser", arch: "unknown", groups: [...groups] });

/**
 * The client of a browser's connection: it answers hello, and ping from the vendor's own read of the session (gone
 * once it has ended); any other method is unsupported, in words, since a browser is driven over CDP.
 */
export function browserClient(hello: HelloResult, alive: (signal?: AbortSignal) => Promise<Result<boolean>>): ComputerClient {
	let closed = false;
	return {
		async call<M extends DaemonMethod>(method: M, _params: DaemonMethods[M]["params"], options: CallOptions = {}): Promise<Result<DaemonMethods[M]["result"]>> {
			if (closed) return fail("gone", "the connection is closed");
			if (method === "hello") return ok(hello as DaemonMethods[M]["result"]);
			if (method === "ping") {
				const now = await alive(options.signal);
				if (!now.ok) return now;
				return now.value ? ok({} as DaemonMethods[M]["result"]) : fail("gone", "the browser session has ended");
			}
			return fail("unsupported", `a browser computer answers hello and ping; ${method} is not one of its methods: drive it over CDP, at the URL connect gives`);
		},
		close() {
			closed = true;
		},
	};
}

/**
 * A release, confirmed: the request is sent twice at most, then the vendor's own read must say the session ended, polled
 * up to confirm.polls times. Done means the vendor says it no longer runs, not that the request was sent; a session the
 * vendor no longer knows ("gone") is released. A session still running is a failure carrying the request's own error.
 */
export async function releaseConfirmed(o: {
	request: () => Promise<Result<"gone" | "asked">>;
	running: () => Promise<Result<boolean>>;
	confirm: ReleaseConfirm;
	sleep: (ms: number) => Promise<void>;
	stillRunning: string;
}): Promise<Result<void>> {
	let failure: Result<never> | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const asked = await o.request();
		if (asked.ok) {
			if (asked.value === "gone") return ok(undefined);
			failure = undefined;
			break;
		}
		failure = asked;
	}
	for (let poll = 0; ; poll++) {
		const now = await o.running();
		if (!now.ok) return now;
		if (!now.value) return ok(undefined);
		if (poll >= o.confirm.polls) return failure ?? fail("timeout", o.stillRunning);
		await o.sleep(o.confirm.intervalMs);
	}
}

/**
 * A vendor call that failed: the call (a method and a route template, never an id or a URL), the HTTP status when one
 * came back, and the vendor's error code when it is a plain identifier. The vendor's own words are never copied: an echo
 * of the request could carry a key.
 */
export class BrowserVendorError extends Error {
	readonly status: number | undefined;
	readonly code: string | undefined;
	constructor(vendor: string, call: string, status: number | undefined, code?: string, options?: { cause?: unknown }) {
		super(status === undefined ? `${vendor} ${call} could not be reached` : `${vendor} ${call} answered ${status}${code ? ` (${code})` : ""}`, options);
		this.name = "BrowserVendorError";
		this.status = status;
		this.code = code;
	}
}

/** A vendor's error code, kept only when it is a plain identifier. */
export const plainCode = (code: unknown) => (typeof code === "string" && /^[a-z][a-z_.-]{0,47}$/i.test(code) ? code : undefined);

const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";

/**
 * A vendor call's thrown error as a result: aborted, or the code its status reads as, in words that name the call and the
 * status alone. The error itself rides along as the failure's hidden cause (vendorFail).
 */
export function vendorFailure(vendor: "browserbase" | "kernel", name: string, call: string, error: unknown): Result<never> {
	if (isAbort(error)) return vendorFail("aborted", `${name} ${call} was aborted`, error);
	const status = (error as { status?: unknown } | null)?.status;
	const code = typeof status === "number" ? statusCode(status, vendor) : vendor;
	const words = error instanceof BrowserVendorError ? error.message : typeof status === "number" ? `${name} ${call} answered ${status}` : `${name} ${call} failed`;
	return vendorFail(code, words, error);
}

/**
 * Why a vendor's CDP URL is not one to hand a driver, in words that never carry it; undefined when it is. It must be wss:
 * (the session's signing key rides it) on the vendor's own domain or a host under it: a vendor answer that named another
 * host would send the driver, and the key, there. The REST call that gave it was https to the vendor's pinned API with
 * redirects refused; this holds the CDP URL itself to the same.
 */
export function cdpUrlProblem(url: unknown, name: string, domain: string): string | undefined {
	const wanted = `wss: on ${domain}`;
	if (typeof url !== "string" || url === "") return `${name} gave no CDP URL (one is ${wanted})`;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `${name}'s CDP URL is not a URL (one is ${wanted})`;
	}
	if (parsed.protocol !== "wss:") return `${name}'s CDP URL is ${parsed.protocol} (one is ${wanted})`;
	const host = parsed.hostname.toLowerCase();
	if (host !== domain && !host.endsWith(`.${domain}`)) return `${name}'s CDP URL is on another host (one is ${wanted})`;
	return undefined;
}

/** What the REST calls share: one request, never retried, read whole; a failure throws a BrowserVendorError. */
export interface RestReply {
	status: number;
	json: unknown;
	headers: { get(name: string): string | null };
}

export async function restCall(
	o: { vendor: string; fetch: typeof fetch; base: string; headers: Record<string, string> },
	method: string,
	route: string,
	call: string,
	init: { body?: unknown; query?: URLSearchParams; signal?: AbortSignal } = {},
): Promise<RestReply> {
	const query = init.query?.toString();
	let response: Response;
	try {
		response = await o.fetch(`${o.base}${route}${query ? `?${query}` : ""}`, {
			method,
			headers: { ...o.headers, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			...(init.signal ? { signal: init.signal } : {}),
			redirect: "error",
		});
	} catch (error) {
		if (isAbort(error)) throw error;
		throw new BrowserVendorError(o.vendor, call, undefined, undefined, { cause: error });
	}
	// A success is read whole: a body cut short or not JSON is a failure, never an empty answer (an empty list would let
	// a release or a sweep trust that nothing is left).
	let text = "";
	try {
		text = await response.text();
	} catch (error) {
		if (isAbort(error)) throw error;
		if (response.ok) throw new BrowserVendorError(o.vendor, call, response.status, "unreadable_body", { cause: error });
	}
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		if (response.ok) throw new BrowserVendorError(o.vendor, call, response.status, "not_json");
	}
	if (!response.ok && response.status !== 404) throw new BrowserVendorError(o.vendor, call, response.status, plainCode((json as { code?: unknown } | null)?.code));
	return { status: response.status, json, headers: response.headers };
}

/** An https base URL, with no trailing slash, so a key never crosses in the clear; throws in words on another. */
export function httpsBase(url: string, what: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${what} is not a URL: ${JSON.stringify(url)}`);
	}
	if (parsed.protocol !== "https:") throw new Error(`${what} must be https, so the key never crosses in the clear: ${parsed.protocol}`);
	return url.replace(/\/+$/, "");
}

/** A vendor's session id as a ref or attach gives it: a plain token, never a path. */
export const idProblem = (id: unknown, vendor: string) =>
	typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? undefined : `${typeof id === "string" ? JSON.stringify(id) : String(id)} is not a ${vendor} session's id`;
