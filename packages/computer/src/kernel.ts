// Kernel as a computer of kind browser: each computer is a Kernel browser, over Kernel's REST API with fetch (no SDK). Labels
// ride the browser's own tags; attach and list find a browser by them; connect hands over its cdp_ws_url, which a driver dials; stream is its browser_live_view_url. Both
// URLs are secrets: they stay in memory and never reach a ref, a list, an error's words or a report.
//
// Calls: POST /browsers (create, with timeout_seconds and tags), GET /browsers/{id} (read; 404 or deleted_at once
// deleted), GET /browsers?status=all&tags[key]=value&limit&offset (list, every state, the deleted dropped by deleted_at;
// paged by X-Has-More and X-Next-Offset), and
// DELETE /browsers/{id} (release). The key is a bearer token.
//
// A session's own options (spec.browser): viewport and headless ride the create body (stealth false: Kernel's stealth
// mode brings its own proxy, which nothing here prices yet, so it is not declared); a profile is a
// Kernel profile by name, { name: pointer, save_changes: save }, made first if Kernel does not know it (GET
// /profiles/{name}, then POST /profiles; a 409 is another process making it). Profiles: POST /profiles { name } and
// DELETE /profiles/{name}.
//
// Kernel's timeout_seconds is an idle timeout: Kernel ends a browser that long after its last CDP or live-view
// connection closes, and sets no wall clock. So lifetimeMs is the longest a browser lives unwatched, at most Kernel's
// largest idle timeout (72 h), and list reads no deadline.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { KERNEL } from "./descriptors/kernel.js";
import { BROWSER_IMAGE } from "./descriptors/shared.js";
import {
	type BrowserComputerProvider,
	type BrowserProfiles,
	cdpUrlProblem,
	type BrowserStream,
	browserClient,
	browserHello,
	BrowserVendorError,
	CREATE_LABEL,
	carries,
	causeOf,
	checkBrowser,
	createUncertain,
	DEFAULT_CONFIRM,
	ATTEMPT_LABEL,
	convergedBrowser,
	type HeldBrowser,
	heldBrowser,
	newAttempt,
	defaultSleep,
	idProblem,
	labelsOf,
	labelsProblem,
	memoryUrls,
	pointerOk,
	queryable,
	type ReleaseConfirm,
	RECOVER_MS,
	recoverCreate,
	leftToConverge,
	releaseConfirmed,
	boundedRelease,
	restCall,
	type RestInit,
	type RestReply,
	type UrlStore,
	causedFail,
	vendorFailure,
	withoutCreateLabel,
} from "./browser.js";
import { CreateRequests, endedWords, labelsDiffer, otherSpecWords } from "./create-requests.js";
import { httpsBase } from "./hosted/rest.js";
import type { KindCapabilities } from "./kinds.js";
import {
	type AttachedComputer,
	type BrowserFeatures,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreateContext,
	type CreatedComputer,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
	type ReleaseHow,
	runLifetimeMs,
} from "./provider.js";
import { failFor, ok, type Result, vendorFail } from "./result.js";
import { connectionError } from "./test-connection.js";

/** This module's failures: one with code vendor names Kernel. */
const fail = failFor("kernel");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NAME = "Kernel";
export const KERNEL_API_URL = "https://api.onkernel.com";
/** The domain a Kernel CDP URL is on (wss://<host>.kernel.sh:8443, read live 11-08; its API is onkernel.com): cdpUrlProblem holds it there. */
export const KERNEL_CDP_DOMAIN = "kernel.sh";
const CDP_DOMAIN = KERNEL_CDP_DOMAIN;
/** Kernel's shortest and longest idle timeout. */
export const KERNEL_MIN_LIFETIME_MS = 10_000;
export const KERNEL_MAX_LIFETIME_MS = 259_200_000;
/** The most pages a list reads before it fails rather than run on. */
const MAX_PAGES = 100;


/** A browser as Kernel answers it; only what the provider reads. */
export interface KernelBrowser {
	session_id?: unknown;
	/** The signed CDP URL: a secret. */
	cdp_ws_url?: unknown;
	/** The live view's URL: a secret. */
	browser_live_view_url?: unknown;
	tags?: unknown;
	/** When Kernel made the browser. */
	created_at?: unknown;
	deleted_at?: unknown;
}

/** A browser as #browsers lists it: its id, its tags (the create label left out) and when Kernel made it. */
interface KernelRow {
	id: string;
	tags: Record<string, string>;
	createdAt?: string;
	/** Deleted: listed only when #browsers is asked for the deleted ones too. */
	deleted?: true;
}

/** A browser as its create label finds it. */
const heldOf = ({ id, tags, createdAt }: KernelRow): HeldBrowser => ({ id, labels: tags, ...(createdAt === undefined ? {} : { createdAt }) });

/**
 * One Kernel request, never retried: a create sent twice would be a second paid browser. It answers 404 as a reply,
 * and throws on any other failure, with the HTTP status as `status`; the provider returns that as a result whose hidden
 * cause is the thrown error.
 */
export type KernelRequest = (method: string, route: string, init?: RestInit) => Promise<RestReply>;

/** Kernel's REST API over fetch: the default request. */
export function kernelRest({ apiKey, apiUrl = KERNEL_API_URL, fetch: fetcher = fetch }: { apiKey: string; apiUrl?: string; fetch?: typeof fetch }): KernelRequest {
	const o = { vendor: NAME, fetch: fetcher, base: httpsBase(apiUrl, "the Kernel API URL"), headers: { Authorization: `Bearer ${apiKey}` } };
	return (method, route, init = {}) => restCall(o, method, route, `${method} ${callName(route)}`, init);
}

/** A route as a failure names it: ids and names out, so no session id reads as a secret's neighbour and no profile's name (a pointer) is in words. */
const callName = (route: string) => route.replace(/\/browsers\/[^/?]+/, "/browsers/{id}").replace(/\/profiles\/[^/?]+/, "/profiles/{name}");
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export interface KernelProviderOptions {
	/** With apiUrl and fetch, the REST request is built from it. */
	apiKey?: string;
	/** Kernel's API; default KERNEL_BASE_URL in env (a server behind a gateway that fronts it), else Kernel's own. */
	apiUrl?: string;
	/** The host's own variables its descriptor declares (hostEnv): KERNEL_BASE_URL alone. */
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	confirm?: ReleaseConfirm;
	sleep?: (ms: number) => Promise<void>;
	/**
	 * How long, in all, a cleanup a create runs for itself may take: the release of the browser its POST made once its
	 * caller is gone, or once another create of the request made one first, and the search and release after a lost
	 * reply. Default RECOVER_MS. The caller's signal never cuts it short.
	 */
	cleanupMs?: number;
}

const refOf = (id: string): ComputerRef => ({ id, name: id });

const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;

/** What a Kernel browser offers beyond the protocol, a fresh copy each time. */
const KERNEL_BROWSER = (): BrowserFeatures => ({ timeout: "inactivity", minLifetimeMs: KERNEL_MIN_LIFETIME_MS, profiles: { settleMs: KERNEL.profiles.settleMs }, headless: true });

/** Computers that are Kernel browsers. */
export class KernelProvider implements ComputerProvider, BrowserComputerProvider {
	readonly id = "kernel";
	readonly version = VERSION;
	readonly profiles: BrowserProfiles = { create: (context) => this.#createProfile(context), remove: (pointer, context) => this.#removeProfile(pointer, context) };
	readonly #request: KernelRequest;
	readonly #urls: UrlStore;
	readonly #live: UrlStore;
	readonly #confirm: ReleaseConfirm;
	readonly #sleep: (ms: number) => Promise<void>;
	/** The bound of each cleanup a create runs for itself (cleanupMs). */
	readonly #cleanupMs: number;
	/** Idempotent create's in-process half: one browser per request id (provider.md). */
	readonly #requests = new CreateRequests();
	/** The request's name of each browser this provider made or found for a create, by id: its release ends the request. */
	readonly #requestOf = new Map<string, string>();
	/**
	 * The browser each request's create answered, by the request's name, kept past its release: a request whose browser
	 * ended on its own (its timeout, the vendor) is refused exists, as one released here is, never made again.
	 */
	readonly #madeFor = new Map<string, string>();

	constructor({ apiKey, apiUrl, env = {}, fetch: fetcher, confirm = DEFAULT_CONFIRM, sleep = defaultSleep, cleanupMs = RECOVER_MS }: KernelProviderOptions) {
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("set options.apiKey to a Kernel API key: the provider reads no environment");
		const api = apiUrl || env.KERNEL_BASE_URL?.trim() || undefined;
		this.#request = kernelRest({ apiKey, ...(api ? { apiUrl: api } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
		this.#urls = memoryUrls();
		this.#live = memoryUrls();
		this.#confirm = confirm;
		this.#sleep = sleep;
		this.#cleanupMs = cleanupMs;
	}

	/**
	 * A browser: Kernel ends a browser after its idle timeout (lifetime vendor), at most 72 h; it reaches the open web;
	 * each browser is its own VM. Kernel's replays and file APIs are not wired here, so recordings and downloads are not
	 * declared. Its sessions' timeout is idle time (inactivity); a browser may be headless and opens a profile, which
	 * Kernel has written back once the browser is deleted (settleMs 0). Its stealth mode is not declared.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "browser",
			lifetime: "vendor",
			network: [...KERNEL.network],
			isolation: "vm",
			os: "linux",
			daemon: "none",
			groups: [...(KERNEL.capabilities[0] as KindCapabilities).groups],
			maxLifetimeMs: KERNEL_MAX_LIFETIME_MS,
			release: ["delete"],
			browser: KERNEL_BROWSER(),
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		return checkBrowser(spec, this.capabilities(), NAME, KERNEL_MIN_LIFETIME_MS);
	}

	/**
	 * Makes a browser once per request (provider.md, Idempotent create), with the lifetime as its idle timeout in whole
	 * seconds and the labels as its tags, with the request's name (computerNameFor) as its create label. A request whose
	 * browser Kernel still holds undeleted answers that one, found by its create label; one whose browser was deleted here
	 * is refused exists; a create of a request in flight here waits for the first (CreateRequests). spec.browser is the
	 * session's own options, each refused by check() unless declared; a profile is made first if Kernel does not know it.
	 */
	async create(spec: ComputerSpec, context: CreateContext): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		return this.#requests.create(spec, context, {
			refuse: fail,
			...(refusals.length > 0 ? { refused: refusals.map(({ field, message }) => `${field}: ${message}`).join("; ") } : {}),
			make: async (request) => {
				const made = await this.#createNamed(spec, request, context.signal);
				if (made.ok) this.#madeFor.set(request, made.value.id);
				return made;
			},
		});
	}

	/** Everything create does under the request's name: the browser Kernel holds under it, or a new one. */
	async #createNamed(spec: ComputerSpec, request: string, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		if (signal?.aborted) return fail("aborted", "create was aborted before Kernel was called");
		const held = await this.#browsers({ [CREATE_LABEL]: request }, signal);
		if (!held.ok) return held;
		const found = heldBrowser(spec.labels ?? {}, held.value.map(heldOf));
		if (found !== undefined) {
			if (found.differ.length > 0) return fail("exists", otherSpecWords(`${request} (browser ${found.id})`, "was made", found.differ));
			this.#requestOf.set(found.id, request);
			return ok(refOf(found.id));
		}
		const ended = await this.#ended(spec, request, signal);
		if (ended !== undefined) return ended;
		const options = spec.browser;
		if (options?.profile !== undefined) {
			const ensured = await this.#ensureProfile(options.profile.pointer, signal);
			if (!ensured.ok) return causedFail(ensured.error.code, `the profile could not be made ready: ${ensured.error.message}; no browser was made`, causeOf(ensured), "kernel");
		}
		// The request's label, which a retry and a converge find it by, and this POST's own, which its recovery finds it by.
		const attempt = { [ATTEMPT_LABEL]: newAttempt() };
		const written = { [CREATE_LABEL]: request, ...attempt, ...spec.labels };
		const body = {
			...(options !== undefined ? { stealth: false } : {}),
			...(options?.viewport ? { viewport: { width: options.viewport.width, height: options.viewport.height } } : {}),
			...(options?.headless !== undefined ? { headless: options.headless } : {}),
			...(options?.profile ? { profile: { name: options.profile.pointer, save_changes: options.profile.save } } : {}),
			timeout_seconds: Math.ceil(runLifetimeMs(spec) / 1000),
			tags: written,
		};
		let made: RestReply;
		try {
			made = await this.#request("POST", "/browsers", { body, ...(signal ? { signal } : {}) });
		} catch (error) {
			const failed = vendorFailure("kernel", NAME, "POST /browsers", error);
			if (failed.ok || !createUncertain(error)) return failed;
			// The browser may have been made though its answer never came: found by this POST's attempt label and deleted,
			// and the request is ended, so it is never made again.
			this.#requests.end(request);
			return causedFail(failed.error.code, `${failed.error.message}; ${await this.#recover(attempt, request)}`, causeOf(failed), "kernel");
		}
		const browser = (made.json ?? {}) as KernelBrowser;
		const id = text(browser.session_id);
		const url = text(browser.cdp_ws_url);
		if (made.status === 404) return vendorFailure("kernel", NAME, "POST /browsers", new BrowserVendorError(NAME, "POST /browsers", made.status, "no_session"));
		if (idProblem(id, NAME) !== undefined) {
			const failed = vendorFailure("kernel", NAME, "POST /browsers", new BrowserVendorError(NAME, "POST /browsers", made.status, "no_session"));
			if (failed.ok) return failed;
			this.#requests.end(request);
			return fail(failed.error.code, `${failed.error.message}; ${await this.#recover(attempt, request)}`);
		}
		this.#requests.made(request);
		// Another process's create of this request may have made one too (#converge): the older is answered.
		const converged = await this.#converge(spec, request, { id, tags: {}, ...(text(browser.created_at) === "" ? {} : { createdAt: text(browser.created_at) }) }, signal);
		if (converged !== undefined) return converged;
		this.#requestOf.set(id, request);
		const unusable = cdpUrlProblem(url, NAME, CDP_DOMAIN);
		if (unusable !== undefined) {
			// The browser is made and billed until its idle timeout: deleted here, under the cleanup's own bound.
			const released = await boundedRelease("browser", id, this.#cleanupMs, (bound) => this.release(refOf(id), "delete", { signal: bound }));
			return vendorFail("kernel",`Kernel POST /browsers made a browser with no CDP URL to hand over: ${unusable}; ${released.ok ? "the browser was released" : `the browser was not released (${released.error.message}), and its tags let a sweep find it`}`);
		}
		this.#urls.set(id, url);
		const live = text(browser.browser_live_view_url);
		if (live !== "") this.#live.set(id, live);
		return ok(refOf(id));
	}

	/**
	 * The one browser a request keeps (convergedBrowser): the request's create label listed again once Kernel made mine.
	 * Undefined when mine is the oldest (or the listing fails: the create goes on with its own); an abort deletes mine,
	 * never under the caller's signal, and the create is aborted. Else mine is deleted,
	 * never under the caller's signal, and the older answered: refused exists when it is gone by then, or when its labels
	 * are another spec's.
	 */
	async #converge(spec: ComputerSpec, request: string, mine: KernelRow, signal?: AbortSignal): Promise<Result<CreatedComputer> | undefined> {
		const listed = await this.#browsers({ [CREATE_LABEL]: request }, signal);
		if (!listed.ok) {
			if (listed.error.code !== "aborted" && !signal?.aborted) return undefined;
			// The caller is gone: the browser this POST made is deleted, never under the caller's signal.
			this.#requests.end(request);
			const released = await boundedRelease("browser", mine.id, this.#cleanupMs, (bound) => this.#releaseBrowser(mine.id, bound));
			return fail("aborted", `create was aborted once Kernel had made the browser ${mine.id}; ${released.ok ? "the browser was released" : `the browser could not be released (${released.error.message}), and its tags let a sweep find it`}`);
		}
		const kept = convergedBrowser(listed.value.map(heldOf), heldOf(mine));
		if (kept === "mine") return undefined;
		const released = await boundedRelease("browser", mine.id, this.#cleanupMs, (bound) => this.#releaseBrowser(mine.id, bound));
		if (!released.ok) return fail(released.error.code, `${request} keeps the browser ${kept.id}, the older of its two, and the browser ${mine.id} made for it could not be deleted (${released.error.message})`);
		const alive = await this.#alive(kept.id, signal);
		if (!alive.ok) return alive;
		if (!alive.value) {
			this.#requests.end(request);
			return fail("exists", endedWords(request));
		}
		const differ = labelsDiffer(spec.labels ?? {}, kept.labels, "read back");
		if (differ.length > 0) return fail("exists", otherSpecWords(`${request} (browser ${kept.id})`, "was made", differ));
		this.#requestOf.set(kept.id, request);
		return ok(refOf(kept.id));
	}

	/**
	 * A request this provider answered a browser for before, which its create label no longer finds: refused exists, the
	 * request ended, once Kernel reads that browser as gone too; one it still holds (a listing that left it out) is
	 * answered when its labels are this spec's. Undefined for a request with no browser here yet.
	 */
	async #ended(spec: ComputerSpec, request: string, signal?: AbortSignal): Promise<Result<CreatedComputer> | undefined> {
		const before = this.#madeFor.get(request);
		if (before === undefined) return undefined;
		const read = await this.#running(before, signal);
		if (!read.ok && read.error.code !== "not_found" && read.error.code !== "gone") return read;
		if (!read.ok) {
			this.#requests.end(request);
			return fail("exists", endedWords(request));
		}
		const differ = labelsDiffer(spec.labels ?? {}, withoutCreateLabel(labelsOf(read.value.tags)), "read back");
		if (differ.length > 0) return fail("exists", otherSpecWords(`${request} (browser ${before})`, "was made", differ));
		this.#requestOf.set(before, request);
		return ok(refOf(before));
	}

	/** A browser names only a profile Kernel knows: made if it is not (GET, then POST); a 409 is another process making it. */
	async #ensureProfile(name: string, signal?: AbortSignal): Promise<Result<void>> {
		try {
			const found = await this.#request("GET", `/profiles/${encodeURIComponent(name)}`, signal ? { signal } : {});
			if (found.status !== 404) return ok(undefined);
		} catch (error) {
			return vendorFailure("kernel", NAME, "GET /profiles/{name}", error);
		}
		try {
			const made = await this.#request("POST", "/profiles", { body: { name }, ...(signal ? { signal } : {}) });
			if (made.status === 404) return vendorFailure("kernel", NAME, "POST /profiles", new BrowserVendorError(NAME, "POST /profiles", 404));
			return ok(undefined);
		} catch (error) {
			return statusOf(error) === 409 ? ok(undefined) : vendorFailure("kernel", NAME, "POST /profiles", error);
		}
	}

	/** A new profile under a random name, which is its pointer: one POST /profiles, never retried. */
	async #createProfile({ signal }: CallContext = {}): Promise<Result<string>> {
		const name = `agentrun-${randomBytes(12).toString("hex")}`;
		const call = "POST /profiles";
		let made: RestReply;
		try {
			made = await this.#request("POST", "/profiles", { body: { name }, ...(signal ? { signal } : {}) });
		} catch (error) {
			return vendorFailure("kernel", NAME, call, error);
		}
		if (made.status === 404) return vendorFailure("kernel", NAME, call, new BrowserVendorError(NAME, call, 404));
		if ((made.json as { name?: unknown } | null)?.name !== name) return vendorFail("kernel", `Kernel ${call} answered ${made.status} with another profile's name than the one asked for`);
		return ok(name);
	}

	/** Deletes the profile; one Kernel no longer knows is removed. The words never carry the pointer. */
	async #removeProfile(pointer: string, { signal }: CallContext = {}): Promise<Result<void>> {
		if (!pointerOk(pointer)) return fail("invalid", "a profile's pointer is a plain token, as profiles.create gave it");
		try {
			await this.#request("DELETE", `/profiles/${encodeURIComponent(pointer)}`, signal ? { signal } : {});
			return ok(undefined);
		} catch (error) {
			return vendorFailure("kernel", NAME, "DELETE /profiles/{name}", error);
		}
	}

	/**
	 * The browsers a lost create made, released: what recoverCreate says of them. They are found as list finds any, by the
	 * attempt label its POST wrote (ATTEMPT_LABEL), through #browsers: another create's browser, of this request or
	 * another, carries an attempt label of its own and is left alone, even one another instance has answered. #browsers
	 * reads every state not deleted, so a browser still starting is found and released too.
	 */
	#recover(labels: Record<string, string>, request: string): Promise<string> {
		const find = async (signal: AbortSignal): Promise<Result<string[]>> => {
			const found = await this.#browsers(labels, signal);
			return found.ok ? ok(found.value.map((b) => b.id)) : found;
		};
		const leave = (id: string, signal: AbortSignal) => this.#leftToConverge(request, id, signal);
		return recoverCreate("browser", find, (id, signal) => this.release(refOf(id), "delete", { signal }), this.#sleep, this.#cleanupMs, leave);
	}

	/** Whether a lost create's browser is left to another create of its request (leftToConverge); a listing that fails releases it. */
	async #leftToConverge(request: string, id: string, signal: AbortSignal): Promise<boolean> {
		const made = await this.#browsers({ [CREATE_LABEL]: request }, signal, true);
		return made.ok && leftToConverge(id, made.value.map((row) => ({ ...heldOf(row), live: row.deleted === undefined })));
	}

	/**
	 * Settings' test: one page of the organization's active browsers (GET /browsers?status=active), which makes nothing.
	 * A refused key is unauthorized and a Kernel not reached unreachable; the words name the call, never the key.
	 */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		const call = "GET /browsers";
		let page: RestReply;
		try {
			page = await this.#request("GET", "/browsers", { query: new URLSearchParams({ status: "active", limit: "100", offset: "0" }), ...(signal ? { signal } : {}) });
		} catch (error) {
			const failed = vendorFailure("kernel", NAME, call, error);
			if (failed.ok) return failed;
			const reached = (error as { status?: unknown } | null)?.status !== undefined || failed.error.code === "aborted";
			return fail(reached ? connectionError(failed.error).code : "unreachable", failed.error.message);
		}
		if (page.status === 404) return vendorFail("kernel",`Kernel ${call} answered 404: the API URL is not Kernel's`);
		if (!Array.isArray(page.json)) return vendorFail("kernel",`Kernel ${call} answered ${page.status} (not_a_list)`);
		const n = page.json.length;
		const more = page.headers.get("x-has-more") === "true" ? " or more" : "";
		return ok({ detail: `Kernel answered: ${n}${more} active ${n === 1 && more === "" ? "browser" : "browsers"} in the organization` });
	}

	/** The browser, when Kernel still runs it; not_found in words when it does not know it, gone when it was deleted. */
	async #running(id: string, signal?: AbortSignal): Promise<Result<KernelBrowser>> {
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		let found: RestReply;
		try {
			found = await this.#request("GET", `/browsers/${encodeURIComponent(id)}`, signal ? { signal } : {});
		} catch (error) {
			return vendorFailure("kernel", NAME, "GET /browsers/{id}", error);
		}
		const browser = found.json as KernelBrowser | null;
		if (found.status === 404 || browser === null || typeof browser !== "object") return fail("not_found", `no Kernel browser has the id ${id}`);
		if (browser.deleted_at) return fail("gone", `the Kernel browser ${id} was deleted: only a running browser is attached or connected to`);
		return ok(browser);
	}

	async #alive(id: string, signal?: AbortSignal): Promise<Result<boolean>> {
		const found = await this.#running(id, signal);
		if (found.ok) return ok(true);
		return found.error.code === "not_found" || found.error.code === "gone" ? ok(false) : found;
	}

	#attached(id: string): AttachedComputer {
		return { ...refOf(id), spec: { image: BROWSER_IMAGE, user: "unknown", network: "open", kind: "browser" } };
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const found = await this.#running(given.id as string, signal);
			return found.ok ? ok(this.#attached(given.id as string)) : found;
		}
		const labels = given.labels as Record<string, string>;
		const listed = await this.#browsers(labels, signal);
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no running Kernel browser has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} Kernel browsers have the labels ${words}: ${listed.value.map((b) => b.id).join(", ")}`);
		return ok(this.#attached((listed.value[0] as { id: string }).id));
	}

	/**
	 * The live browsers with all of these labels, every page read. Kernel is asked by the first label a query carries as
	 * it is, in every state (status=all: its filter takes one value, active, deleted or all, and active may leave out a
	 * browser still starting, which bills), and a row with deleted_at is dropped here; so list and attach show a starting
	 * browser, as Browserbase lists a PENDING session, and a lost create's recovery misses none. The match is the
	 * provider's own, so a lane that drops the filter never hands back another's. A page that cannot be read fails the
	 * whole list: a release trusts it. `withDeleted` keeps the deleted rows too, marked deleted (#leftToConverge).
	 */
	async #browsers(labels: Record<string, string>, signal?: AbortSignal, withDeleted = false): Promise<Result<KernelRow[]>> {
		const problem = labelsProblem(labels);
		if (problem) return fail("invalid", problem);
		if (Object.keys(labels).length === 0) return fail("invalid", "list and attach take at least one label: a Kernel organization holds browsers this provider did not make");
		const first = Object.entries(labels).find(queryable);
		const found: KernelRow[] = [];
		const seen = new Set<string>();
		const call = "GET /browsers";
		for (let offset = 0, pages = 0; pages < MAX_PAGES; pages++) {
			const query = new URLSearchParams({ status: "all", ...(first === undefined ? {} : { [`tags[${first[0]}]`]: first[1] }), limit: "100", offset: String(offset) });
			let page: RestReply;
			try {
				page = await this.#request("GET", "/browsers", { query, ...(signal ? { signal } : {}) });
			} catch (error) {
				return vendorFailure("kernel", NAME, call, error);
			}
			// A list is never "not found": a 404 is a wrong base URL, and an empty answer would hide every browser.
			if (page.status === 404) return vendorFailure("kernel", NAME, call, new BrowserVendorError(NAME, call, 404));
			if (!Array.isArray(page.json)) return vendorFailure("kernel", NAME, call, new BrowserVendorError(NAME, call, page.status, "not_a_list"));
			for (const row of page.json as KernelBrowser[]) {
				const id = text(row?.session_id);
				if (id !== "" && (withDeleted || !row.deleted_at) && carries(row.tags, labels) && !seen.has(id)) {
					seen.add(id);
					const createdAt = text(row.created_at);
					found.push({ id, tags: withoutCreateLabel(labelsOf(row.tags)), ...(createdAt === "" ? {} : { createdAt }), ...(row.deleted_at ? { deleted: true as const } : {}) });
				}
			}
			if (page.headers.get("x-has-more") !== "true") return ok(found);
			const next = Number(page.headers.get("x-next-offset"));
			if (!Number.isInteger(next) || next <= offset) return vendorFail("kernel","Kernel reported more browsers without the next page's offset");
			offset = next;
		}
		return vendorFail("kernel",`Kernel kept answering more pages of browsers past ${MAX_PAGES}`);
	}

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const found = await this.#browsers(labels, signal);
		if (!found.ok) return found;
		// Kernel's timeout is idle time, not a wall clock: no deadline to read.
		return ok(found.value.map(({ id, tags }) => ({ ref: refOf(id), labels: tags, deadline: undefined, state: "running", network: "open" })));
	}

	/** Always open: a Kernel browser reaches the open web, and a change is refused in words. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (policy !== undefined && policy !== "open") return fail("refused", `a Kernel browser's network is open; it cannot be set to ${JSON.stringify(policy)}`);
		const found = await this.#running(ref?.id, signal);
		return found.ok ? ok("open") : found;
	}

	/**
	 * The browser's signed CDP URL, held since create or read from Kernel, and a client that answers hello and ping. The
	 * browser is read first, held URL or not: one deleted, or that Kernel no longer knows though its URL is held, is gone,
	 * never handed over.
	 */
	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		let url = this.#urls.get(id);
		const found = await this.#running(id);
		if (!found.ok) {
			// A vendor that did not answer leaves the held URL for the next connect; a browser it deleted takes it along.
			if (found.error.code !== "not_found" && found.error.code !== "gone") return found;
			if (url === undefined) return found;
			this.#urls.delete(id);
			return fail("gone", found.error.code === "gone" ? found.error.message : `the Kernel browser ${id} is gone: ${found.error.message}`);
		}
		if (url === undefined) {
			url = text(found.value.cdp_ws_url);
			if (url === "") return fail("not_found", `the Kernel browser ${id} is not available for connection`);
		}
		// Whatever held it (create, a read, a host's url store), a URL a driver would dial is wss: on Kernel's own domain.
		const unusable = cdpUrlProblem(url, NAME, CDP_DOMAIN);
		if (unusable !== undefined) return vendorFail("kernel",`the Kernel browser ${id} is not handed over: ${unusable}`);
		this.#urls.set(id, url);
		const hello = browserHello(VERSION, this.capabilities().groups);
		const client = browserClient(hello, (signal) => this.#alive(id, signal));
		return ok({ client, hello, cdp: { url }, close: async () => client.close() });
	}

	/** Deletes the browser and waits until Kernel reads it as gone; one already deleted or unknown is released. */
	async release(ref: ComputerRef, how: ReleaseHow, { signal }: CallContext = {}): Promise<Result<void>> {
		if (how !== "delete") return fail("refused", `a Kernel browser is released with "delete"; it cannot be stopped and kept, so ${String(how)} is refused and the browser is left as it is`);
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		// The request's browser is ended here: a later create of it is refused exists, never made again.
		const request = this.#requestOf.get(id);
		if (request !== undefined) this.#requests.end(request);
		const released = await this.#releaseBrowser(id, signal);
		if (released.ok) this.#requestOf.delete(id);
		return released;
	}

	/** Deletes the browser and waits until Kernel reads it as gone; the request it was made for is not ended. */
	async #releaseBrowser(id: string, signal?: AbortSignal): Promise<Result<void>> {
		const released = await releaseConfirmed({
			request: async () => {
				try {
					const answer = await this.#request("DELETE", `/browsers/${encodeURIComponent(id)}`, signal ? { signal } : {});
					return ok(answer.status === 404 ? "gone" : "asked");
				} catch (error) {
					return vendorFailure("kernel", NAME, "DELETE /browsers/{id}", error);
				}
			},
			running: () => this.#alive(id, signal),
			confirm: this.#confirm,
			sleep: this.#sleep,
			stillRunning: `Kernel session ${id} still running after its delete`,
		});
		if (released.ok) {
			this.#urls.delete(id);
			this.#live.delete(id);
		}
		return released;
	}

	/** The browser's live view, which takes input: a view-only one is refused, never handed over as one. */
	async stream(ref: ComputerRef, options: { viewOnly?: boolean } = {}, { signal }: CallContext = {}): Promise<Result<BrowserStream>> {
		if (options.viewOnly) return fail("unsupported", "Kernel's live view takes input; it has no view-only URL here");
		const found = await this.#running(ref?.id, signal);
		if (!found.ok) return found;
		const url = this.#live.get(ref.id) ?? text(found.value.browser_live_view_url);
		if (url === "") return fail("not_found", `Kernel gave no live view for the browser ${ref.id}: a headless browser has none`);
		this.#live.set(ref.id, url);
		return ok({ url });
	}
}

/**
 * The provider, built from its options alone, the key included (options.apiKey); it reads no environment, and throws in words when the key is missing, never echoing one.
 */
export function create(options: KernelProviderOptions): KernelProvider {
	return new KernelProvider(options ?? ({} as KernelProviderOptions));
}

/** The conformance CLI's module for Kernel: its live switch, its image and its notes. */
export const conformance = () => import("./conformance/kernel.js");
