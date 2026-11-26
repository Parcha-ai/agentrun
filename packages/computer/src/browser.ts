// What every browser provider shares: a browser is a vendor's browser session that answers CDP (kind browser, daemon
// none). The provider answers hello and ping itself, from the vendor's API; connect hands over the vendor's signed CDP
// URL, which a driver dials. That URL and the live view's are secrets: they live in memory (a UrlStore), and never reach
// a ref, a list, an error's words or a report.
import { randomBytes } from "node:crypto";
import type { CallOptions } from "./client.js";
import { type ComputerClient, type DaemonMethod, type DaemonMethods, type Group, type HelloResult, PROTOCOL_VERSION } from "./protocol.js";
import type { BrowserFeatures, BrowserSpec, CallContext, ComputerCapabilities, ComputerProvider, ComputerRef, ComputerSpec, Refusal } from "./provider.js";
import { checkGpu, checkLifetime } from "./provider.js";
import { type ComputerError, type ComputerErrorCode, errorOf, fail, ok, type Result } from "./result.js";
import { labelsDiffer } from "./create-requests.js";
import { BROWSER_IMAGE } from "./descriptors/shared.js";

/** A key's or a value's longest, in characters: what both vendors keep of a metadata entry. */
const MAX_LABEL = 256;

/**
 * Where a provider keeps the URLs it was handed, by session id, in memory only: a Map of its own.
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
export type VendorFailure = ComputerError & { readonly cause?: unknown };

/**
 * A failure whose cause rides along out of sight: not enumerable, so it is in no JSON, no log line and no report. With
 * code vendor, vendor (the provider's id) names whose.
 */
export function causedFail(code: ComputerErrorCode, message: string, cause: unknown, vendor: string): Result<never> {
	const failed: Result<never> = { ok: false, error: errorOf(code, message, vendor) };
	if (cause !== undefined && !failed.ok) Object.defineProperty(failed.error, "cause", { value: cause, enumerable: false });
	return failed;
}

/** The error a vendor call threw, behind a failure causedFail made; undefined for any other. */
export const causeOf = (result: Result<unknown>): unknown => (result.ok ? undefined : (result.error as VendorFailure).cause);

/** The code a vendor's HTTP status reads as: one of ours, or vendor. */
export function statusCode(status: number | undefined): ComputerErrorCode {
	if (status === 401 || status === 403) return "denied";
	if (status === 404) return "not_found";
	if (status === 429) return "limit";
	return "vendor";
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
 * The label every create writes beside the spec's, the name of its request (computerNameFor): a create retried, here or
 * in another process, finds the browser the first made by this label (heldBrowser), and a create that made one finds
 * the request's others by it (convergedBrowser). The provider's own: check() refuses it in a spec, and no list or
 * attach shows it.
 */
export const CREATE_LABEL = "agentrun.create";

/**
 * The label each create's POST writes beside the create label, a random value of that POST's own (newAttempt): a create
 * whose reply is lost, or whose caller cancels it, finds the browser its own POST made by this label alone and releases
 * it, never another create's browser of the same request. The provider's own, as the create label is.
 */
export const ATTEMPT_LABEL = "agentrun.attempt";

/** A create attempt's own value of ATTEMPT_LABEL. */
export const newAttempt = (): string => randomBytes(8).toString("hex");

/** Labels without the provider's own, the create and attempt labels. */
export const withoutCreateLabel = (labels: Record<string, string>): Record<string, string> => {
	const { [CREATE_LABEL]: _, [ATTEMPT_LABEL]: __, ...rest } = labels;
	return rest;
};

/** A listed browser's createdAt (ComputerInfo), from the time its vendor says it made it: none where that is absent or
 *  is no time. */
export const createdOf = (at: string | undefined): { createdAt?: Date } => {
	const time = typeof at === "string" && at !== "" ? new Date(at) : undefined;
	return time !== undefined && !Number.isNaN(time.getTime()) ? { createdAt: time } : {};
};

/** A browser a create label found: its id, when the vendor made it (an ISO time, where it says), and its labels. */
export interface HeldBrowser {
	id: string;
	createdAt?: string;
	labels: Record<string, string>;
}

/**
 * The order a request's browsers are read in (heldBrowser, a create's converge): the oldest first, by the time the
 * vendor made each, then by id. The same browsers give the same order in every process.
 */
export const oldestBrowserFirst = (a: HeldBrowser, b: HeldBrowser): number => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id.localeCompare(b.id);

/**
 * The browser a vendor holds for a create's request (provider.md, Idempotent create), among those its create label finds
 * (found, each with its labels as list shows them): undefined when there is none, so create makes it, else the oldest
 * (oldestBrowserFirst), with how its labels differ from the ones asked (labelsDiffer; empty when it is this spec's). A
 * browser's own options are not read back from the vendor, so a create from another process compares the labels alone.
 */
export function heldBrowser(asked: Record<string, string>, found: ReadonlyArray<HeldBrowser>): { id: string; differ: string[] } | undefined {
	const first = [...found].sort(oldestBrowserFirst)[0];
	return first === undefined ? undefined : { id: first.id, differ: labelsDiffer(asked, first.labels, "read back") };
}

/**
 * Where a create that made a browser stands among its request's (provider.md, Idempotent create). Two creates of one
 * request in two processes can both find no browser by the create label and both make one: CreateRequests holds within
 * one provider alone. So after the vendor's answer the label is listed again (listed; mine, made just now, added when it
 * is not listed yet): "mine" when mine is the oldest, so the create answers it; else the older, which the create
 * answers in place of its own once it has released its own. Every process picks the same one from the same listing.
 */
export function convergedBrowser(listed: ReadonlyArray<HeldBrowser>, mine: HeldBrowser): "mine" | HeldBrowser {
	const holders = listed.some((one) => one.id === mine.id) ? [...listed] : [...listed, { ...mine, createdAt: mine.createdAt ?? new Date().toISOString() }];
	const kept = holders.sort(oldestBrowserFirst)[0] as HeldBrowser;
	return kept.id === mine.id ? "mine" : kept;
}

/** A browser of a request as a lost create's recovery reads it, ended ones included: whether it still runs. */
export type MadeBrowser = HeldBrowser & { live: boolean };

/**
 * Whether a lost create's browser (`mine`) is left to another create of its request rather than released: it still runs,
 * no older browser of the request runs (so every converge keeps it), and the request's browsers, ended ones included,
 * hold a newer one, which only another create made: that create's converge may answer mine. A lost create whose browser
 * is the request's only one releases it.
 */
export function leftToConverge(mine: string, made: ReadonlyArray<MadeBrowser>): boolean {
	const own = made.find((one) => one.id === mine);
	if (own === undefined || !own.live) return false;
	if (made.some((one) => one.id !== mine && one.live && oldestBrowserFirst(one, own) < 0)) return false;
	return made.some((one) => one.id !== mine && oldestBrowserFirst(own, one) < 0);
}

/**
 * Where a lost create's browser left to a converge (leftToConverge) stands when the request's browsers are read again:
 * "unread" when the read does not list mine, or lists no newer one (the first read did, so it says nothing); "release"
 * once mine has ended; "answered" when a newer one has ended, since a converge that answers the older ends its own first;
 * "answered-older" when an older one also runs, since that converge may have missed the older and answered mine, or
 * answered the older and left mine held by none; "release" when an older one runs and every newer one runs too;
 * "running" while every newer one still runs, so no converge has answered mine yet.
 */
export function convergeSettled(mine: string, made: ReadonlyArray<MadeBrowser>): Settled {
	const own = made.find((one) => one.id === mine);
	if (own === undefined) return "unread";
	if (!own.live) return "release";
	const newer = made.filter((one) => one.id !== mine && oldestBrowserFirst(own, one) < 0);
	if (newer.length === 0) return "unread";
	const olderRuns = made.some((one) => one.id !== mine && one.live && oldestBrowserFirst(one, own) < 0);
	if (newer.some((one) => !one.live)) return olderRuns ? "answered-older" : "answered";
	return olderRuns ? "release" : "running";
}

/** What a read of a lost create's request says of its browser (convergeSettled). */
type Settled = "answered" | "answered-older" | "running" | "release" | "unread";

/**
 * Whether a create that threw may still have made a browser: anything but the vendor's own 4xx answer (a refusal, which
 * makes nothing). A request not answered, aborted, cut short, or answered 5xx or with a body that is no browser may
 * have been admitted.
 */
export function createUncertain(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	return !(typeof status === "number" && status >= 400 && status < 500);
}

/**
 * How long a lost create's browser is looked for and released, in all, and how often: a vendor may list it a moment
 * late. Also the default bound of every other release a create runs for itself (a provider's cleanupMs).
 */
export const RECOVER_MS = 30_000;
const RECOVER_TRIES = 3;
const RECOVER_GAP_MS = 2_000;

/**
 * After a create whose outcome is unknown: the browsers carrying its create label, found and released under a signal
 * of the recovery's own, `ms` in all (the caller's may be what ended the create). The search, its retries for a vendor
 * that lists late and the reads below wait at most until half of `ms` has passed, each wait RECOVER_GAP_MS or what is
 * left of that half, so the release keeps the other half. Where `made` reads the request's browsers (ended ones
 * included), each found browser's request is read, again after a read that failed or did not list it, and one no read
 * lists is kept: such a read says nothing of who holds it. One older than a browser of its request that has ended
 * (convergeSettled) is kept at once, even when an older one runs, as a converge that answers it ends its own first and
 * one whose list missed the older may have answered it; where an older one runs, the words say it may be held by none.
 * One left to another create's converge (leftToConverge) is otherwise read again, every RECOVER_GAP_MS within that half
 * (once at least), and kept once a newer one has ended or the last read fails or misses a browser the first read
 * listed. One whose newer browsers all still run at the end was answered by no converge (each
 * kept its own) and is released. The words say what became of them, for the create's failure; they never carry a URL.
 */
export async function recoverCreate(
	what: string,
	find: (signal: AbortSignal) => Promise<Result<string[]>>,
	release: (id: string, signal: AbortSignal) => Promise<Result<void>>,
	sleep: (ms: number) => Promise<void>,
	ms = RECOVER_MS,
	made?: (signal: AbortSignal) => Promise<Result<MadeBrowser[]>>,
): Promise<string> {
	const signal = AbortSignal.timeout(ms);
	const settleBy = Date.now() + ms / 2;
	const reads = Math.max(1, Math.floor(ms / 2 / RECOVER_GAP_MS));
	let found: Result<string[]> = ok([]);
	for (let tries = 0; tries < RECOVER_TRIES; tries++) {
		if (tries > 0 && !(await waitWithin(sleep, settleBy, signal))) break;
		found = await find(signal);
		if (!found.ok || found.value.length > 0 || signal.aborted) break;
	}
	if (!found.ok) return `the ${what} it may have made could not be looked for (${found.error.message}); its labels let a sweep find it`;
	if (found.value.length === 0) return `no ${what} carries its create label, so none was made or the vendor does not list it yet; its labels let a sweep find it`;
	const words: string[] = [];
	for (const id of found.value) {
		let unanswered = false;
		if (made !== undefined) {
			const read = await firstRead(id, made, signal, sleep, settleBy, Math.max(1, Math.ceil(ms / 2 / RECOVER_GAP_MS)));
			if (read === undefined) {
				words.push(`the ${what} it made (${id}) may be one another create of its request answered, and the request's browsers could not be read, or did not list it, so nothing says who holds it: it is left running, at most to its lifetime, and its labels let a sweep find it`);
				continue;
			}
			const first = convergeSettled(id, read);
			const answered = first === "answered" || first === "answered-older";
			if (answered || leftToConverge(id, read)) {
				const settled = answered ? first : await settle(id, made, signal, sleep, settleBy, reads);
				if (settled === "answered") {
					words.push(`the ${what} it made (${id}) is older than one of its request that has ended, as a create's converge ends its own when it answers an older one: it is left running for that create, and if that create did not answer it (aborted, or failed once its own had ended, or its reply lost too) it runs to its lifetime, and its labels let a sweep find it`);
					continue;
				}
				if (settled === "answered-older") {
					words.push(`the ${what} it made (${id}) is older than one of its request that has ended, and an older one of its request still runs: the create whose own ended may have missed that one and answered this, so it is left running, and if that create answered the older instead it is held by none and runs to its lifetime; its labels let a sweep find it`);
					continue;
				}
				if (settled === "unread") {
					words.push(`the ${what} it made (${id}) is its request's oldest, which another create of the request may answer, and the request's browsers could not be read again: it is left running, at most to its lifetime, and its labels let a sweep find it`);
					continue;
				}
				unanswered = settled === "running";
			}
		}
		const released = await release(id, signal);
		const why = unanswered ? `, since every newer ${what} of its request still runs and so no other create answered it` : "";
		if (released.ok) words.push(`the ${what} it made (${id}) was released${why}`);
		else if (signal.aborted) words.push(`the ${what} it made (${id}) may still be running: the search and its release did not finish within ${ms / 1000} s, and its labels let a sweep find it`);
		else words.push(`the ${what} it made (${id}) was not released (${released.error.code}), and its labels let a sweep find it`);
	}
	return words.join("; ");
}

/**
 * One wait before a search or a read is tried again: RECOVER_GAP_MS, or what is left until `by` when that is less.
 * False, with no wait, once nothing is left or the recovery's signal has ended.
 */
async function waitWithin(sleep: (ms: number) => Promise<void>, by: number, signal: AbortSignal): Promise<boolean> {
	const left = by - Date.now();
	if (left <= 0 || signal.aborted) return false;
	await sleep(Math.min(RECOVER_GAP_MS, left));
	return true;
}

/**
 * The request's browsers, read at once and then again after each read that failed or did not list `mine` (which the
 * search found, so such a read says nothing of it), `retries` times at most, each after a wait that ends no later than
 * `by` (waitWithin): so a window shorter than two gaps still tries again while time is left. Undefined when no read
 * listed it.
 */
async function firstRead(
	mine: string,
	made: (signal: AbortSignal) => Promise<Result<MadeBrowser[]>>,
	signal: AbortSignal,
	sleep: (ms: number) => Promise<void>,
	by: number,
	retries: number,
): Promise<MadeBrowser[] | undefined> {
	for (let read = 0; read <= retries; read++) {
		if (read > 0 && !(await waitWithin(sleep, by, signal))) break;
		const got = await made(signal);
		if (got.ok && got.value.some((one) => one.id === mine)) return got.value;
	}
	return undefined;
}

/**
 * A left browser's request read again (convergeSettled) after each RECOVER_GAP_MS, until it is answered or released,
 * `reads` times at most and not past `by` (one read at least): "running" when the last read still found every newer
 * browser running, "unread" when the last read failed or missed a browser the first read listed. No wait runs past
 * `by`, so a bound shorter than the gap still reads once within it, and the read and the release keep the time after
 * `by`.
 */
async function settle(
	mine: string,
	made: (signal: AbortSignal) => Promise<Result<MadeBrowser[]>>,
	signal: AbortSignal,
	sleep: (ms: number) => Promise<void>,
	by: number,
	reads: number,
): Promise<Settled> {
	let last: "running" | "unread" = "unread";
	for (let read = 0; read < reads; read++) {
		const left = by - Date.now();
		if ((read > 0 && left < RECOVER_GAP_MS) || signal.aborted) break;
		await sleep(Math.max(0, Math.min(RECOVER_GAP_MS, left)));
		const again = await made(signal);
		if (!again.ok) {
			last = "unread";
			continue;
		}
		const now = convergeSettled(mine, again.value);
		if (now === "unread" || now === "running") {
			last = now;
			continue;
		}
		return now;
	}
	return last;
}

const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels", "gpu", "browser"]);

/**
 * The checks every browser provider makes before a vendor call: the image is chromium, the lifetime is within the
 * vendor's cap (and at least min), the network is open, the labels are ones the vendor's metadata holds, the session's
 * options are ones capabilities().browser declares (browserSpecRefusals), and no field a browser does not take (a size,
 * a user, a workdir, a mount).
 */
export function checkBrowser(spec: ComputerSpec, capabilities: ComputerCapabilities, vendor: string, minLifetimeMs = 1): Refusal[] {
	const refusals: Refusal[] = [];
	const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
	const { image, lifetimeMs, network, labels } = given;
	refusals.push(...browserSpecRefusals(given.browser, capabilities.browser ?? { timeout: "wall-clock" }, vendor));
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
		else {
			for (const own of [CREATE_LABEL, ATTEMPT_LABEL]) {
				if (Object.hasOwn(labels as object, own)) refusals.push({ field: "labels", message: `the label ${own} is the provider's own: each create writes it, so a retried or lost create finds its browser` });
			}
		}
	}
	// A browser declares no gpu: one asked is refused, in the words every provider shares.
	refusals.push(...checkGpu(given.gpu, capabilities));
	for (const [field, value] of Object.entries(given)) {
		if (!SPEC_FIELDS.has(field) && value !== undefined) refusals.push({ field, message: `a ${vendor} browser does not take ${field}` });
	}
	return refusals;
}

/** hello for a browser: the provider's version, linux, kind browser and its groups. The vendor reports no arch. */
export const browserHello = (version: string, groups: Group[]): HelloResult => ({ protocol: PROTOCOL_VERSION, version, os: "linux", kind: "browser", arch: "unknown", groups: [...groups] });

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
/**
 * A release a create runs for itself (its caller gone, or its browser the newer of the request's two), under a signal of
 * its own that ends after `ms`, never the caller's: one that does not finish by then is a timeout that says the browser
 * may still be running.
 */
export async function boundedRelease(what: string, id: string, ms: number, release: (signal: AbortSignal) => Promise<Result<void>>): Promise<Result<void>> {
	const signal = AbortSignal.timeout(ms);
	const released = await release(signal);
	if (released.ok || !signal.aborted) return released;
	return fail("timeout", `its release did not finish within ${ms / 1000} s, so the ${what} ${id} may still be running`);
}

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
 * status alone. The error itself rides along as the failure's hidden cause (causedFail). vendor is the provider's id.
 */
export function vendorFailure(vendor: string, name: string, call: string, error: unknown): Result<never> {
	if (isAbort(error)) return causedFail("aborted", `${name} ${call} was aborted`, error, vendor);
	const status = (error as { status?: unknown } | null)?.status;
	const code = typeof status === "number" ? statusCode(status) : "vendor";
	const words = error instanceof BrowserVendorError ? error.message : typeof status === "number" ? `${name} ${call} answered ${status}` : `${name} ${call} failed`;
	return causedFail(code, words, error, vendor);
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

/** What a REST call sends: a JSON body, a query and a signal. */
export interface RestInit {
	body?: unknown;
	query?: URLSearchParams;
	signal?: AbortSignal;
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
	init: RestInit = {},
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

/** A vendor's session id as a ref or attach gives it: a plain token, never a path. */
export const idProblem = (id: unknown, vendor: string) =>
	typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? undefined : `${typeof id === "string" ? JSON.stringify(id) : String(id)} is not a ${vendor} session's id`;

/**
 * A GET whose success is bytes, streamed (Accept application/octet-stream); undefined when the vendor answers 404. A
 * redirect is followed once, to https only, and without the key's headers, so a storage host is never handed the key.
 * A failure throws a BrowserVendorError that names the call and the status alone.
 */
export async function restBytes(
	o: { vendor: string; fetch: typeof fetch; base: string; headers: Record<string, string> },
	route: string,
	call: string,
	signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array> | undefined> {
	const get = (url: string, headers: Record<string, string>) =>
		o.fetch(url, { method: "GET", headers: { ...headers, Accept: "application/octet-stream" }, redirect: "manual", ...(signal ? { signal } : {}) });
	const drop = (response: Response) => response.body?.cancel().catch(() => undefined);
	let response: Response;
	try {
		response = await get(`${o.base}${route}`, o.headers);
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await drop(response);
			let next: URL | undefined;
			try {
				next = location ? new URL(location, `${o.base}${route}`) : undefined;
			} catch {
				next = undefined;
			}
			if (next === undefined) throw new BrowserVendorError(o.vendor, call, response.status, "no_location");
			if (next.protocol !== "https:") throw new BrowserVendorError(o.vendor, call, response.status, "redirect_not_https");
			response = await get(next.href, {});
		}
	} catch (error) {
		if (isAbort(error) || error instanceof BrowserVendorError) throw error;
		throw new BrowserVendorError(o.vendor, call, undefined, undefined, { cause: error });
	}
	if (response.status === 404) {
		await drop(response);
		return undefined;
	}
	if (!response.ok) {
		await drop(response);
		throw new BrowserVendorError(o.vendor, call, response.status);
	}
	if (response.body === null) throw new BrowserVendorError(o.vendor, call, response.status, "no_body");
	return response.body as unknown as AsyncIterable<Uint8Array>;
}

/** The bytes as they come, failing in words once they pass maxBytes: what reached the reader before then is all it gets. */
export async function* limitedBytes(body: AsyncIterable<Uint8Array>, maxBytes: number, what: string): AsyncIterable<Uint8Array> {
	let total = 0;
	for await (const chunk of body) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new Error(`${what} is larger than the ${maxBytes}-byte limit`);
		yield chunk;
	}
}

// ---- A browser session's own options (spec.browser), its features (capabilities().browser), and the optional members --

/** One file a session downloaded, as downloads.list gives it. */
export interface BrowserFile {
	name: string;
	sizeBytes: number;
	modifiedAt: string | null;
}

/** Saved profiles: a pointer is a capability (whoever holds it opens the profile), so no error's words carry one. */
export interface BrowserProfiles {
	create(context?: CallContext): Promise<Result<string>>;
	/** A profile the vendor no longer knows is removed. */
	remove(pointer: string, context?: CallContext): Promise<Result<void>>;
}

/** The files a session downloaded, kept by the vendor. */
export interface BrowserDownloads {
	list(ref: ComputerRef, context?: CallContext): Promise<Result<BrowserFile[]>>;
	/** The file's bytes, streamed; the stream fails in words once it passes maxBytes. */
	read(ref: ComputerRef, name: string, maxBytes: number, context?: CallContext): Promise<Result<AsyncIterable<Uint8Array>>>;
}

/**
 * A session as its vendor itself records it, for a host that reconciles its own measure of a session with the vendor's
 * bill: when the vendor says the session started and ended, and the bytes it moved through the vendor's proxy. Each
 * field is null where the vendor's record does not say it (a session still running has no end; a vendor that reports no
 * proxy traffic has no bytes), never a zero standing in for one.
 */
export interface BrowserSessionUsage {
	startedAt: string | null;
	endedAt: string | null;
	proxyBytes: number | null;
}

/**
 * A provider of browsers, with the members its features may bring: profiles where capabilities().browser declares
 * profiles, downloads where it declares downloads. sessionUsage, where the vendor keeps a record of each session it ran:
 * that record, read once (a host reads it when the session is let go); undefined for a session the vendor does not know.
 */
export interface BrowserComputerProvider extends ComputerProvider {
	readonly profiles?: BrowserProfiles;
	readonly downloads?: BrowserDownloads;
	sessionUsage?(ref: ComputerRef, context?: CallContext): Promise<Result<BrowserSessionUsage | undefined>>;
}

/** Whether a provider is a browser provider: its capabilities are of kind browser and declare its sessions' features. */
export function isBrowserProvider(provider: ComputerProvider): provider is BrowserComputerProvider {
	let capabilities: ComputerCapabilities | undefined;
	try {
		capabilities = typeof provider?.capabilities === "function" ? provider.capabilities() : undefined;
	} catch {
		return false;
	}
	const browser = capabilities?.browser as unknown;
	return capabilities?.kind === "browser" && typeof browser === "object" && browser !== null;
}

/** A viewport's longest side, in pixels. */
const MAX_VIEWPORT = 10_000;
const SESSION_FIELDS = new Set(["viewport", "profile", "stealth", "headless"]);

/** A profile's pointer as a provider takes it: a plain token, so it is a path segment and never a path. */
export const pointerOk = (pointer: unknown): pointer is string => typeof pointer === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(pointer);

const only = (value: object, fields: string[]) => Object.keys(value).every((key) => fields.includes(key));

/**
 * Why spec.browser is not one this provider takes, field by field: a malformed option, or one its features
 * (capabilities().browser) do not declare (a flag set false asks for nothing, so it is never refused). The words never
 * carry a pointer.
 */
export function browserSpecRefusals(session: unknown, features: BrowserFeatures, vendor: string): Refusal[] {
	if (session === undefined) return [];
	if (typeof session !== "object" || session === null || Array.isArray(session)) return [{ field: "browser", message: "a browser's options are an object" }];
	const refusals: Refusal[] = [];
	const given = session as Record<string, unknown>;
	for (const [field, value] of Object.entries(given)) {
		if (!SESSION_FIELDS.has(field) && value !== undefined) refusals.push({ field: `browser.${field}`, message: `a browser takes no ${field}` });
	}
	const { viewport, profile } = given;
	if (viewport !== undefined) {
		const side = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_VIEWPORT;
		const v = viewport as { width?: unknown; height?: unknown } | null;
		if (typeof v !== "object" || v === null || !only(v, ["width", "height"]) || !side(v.width) || !side(v.height)) {
			refusals.push({ field: "browser.viewport", message: `a viewport is { width, height }, each a whole number of pixels from 1 to ${MAX_VIEWPORT}` });
		}
	}
	const flags: Array<[keyof BrowserSpec & keyof BrowserFeatures, string]> = [
		["stealth", "stealth mode"],
		["headless", "headless mode"],
	];
	for (const [field, what] of flags) {
		const value = given[field];
		if (value === undefined) continue;
		if (typeof value !== "boolean") refusals.push({ field: `browser.${field}`, message: `${field} is true or false` });
		else if (value && features[field] !== true) refusals.push({ field: `browser.${field}`, message: `a ${vendor} browser has no ${what}, so ${field} is refused` });
	}
	if (profile !== undefined) {
		const p = profile as { pointer?: unknown; save?: unknown } | null;
		if (features.profiles === undefined) refusals.push({ field: "browser.profile", message: `a ${vendor} browser keeps no profile` });
		else if (typeof p !== "object" || p === null || !only(p, ["pointer", "save"]) || !pointerOk(p.pointer) || typeof p.save !== "boolean") {
			refusals.push({ field: "browser.profile", message: "a profile is { pointer, save }: a plain token profiles.create gave, and true or false" });
		}
	}
	return refusals;
}
