// Kernel as a computer of kind browser: each computer is a Kernel browser, over Kernel's REST API with fetch (no SDK),
// or through a KernelRequest a host gives (pi-browser's own). Labels ride the browser's own tags; attach and list find a
// browser by them; connect hands over its cdp_ws_url, which a driver dials; stream is its browser_live_view_url. Both
// URLs are secrets: they stay in memory and never reach a ref, a list, an error's words or a report.
//
// Calls: POST /browsers (create, with timeout_seconds and tags), GET /browsers/{id} (read; 404 or deleted_at once
// deleted), GET /browsers?status=active&tags[key]=value&limit&offset (list, paged by X-Has-More and X-Next-Offset), and
// DELETE /browsers/{id} (release). The key is a bearer token.
//
// Kernel's timeout_seconds is an idle timeout: Kernel ends a browser that long after its last CDP or live-view
// connection closes, and sets no wall clock. So lifetimeMs is the longest a browser lives unwatched, at most Kernel's
// largest idle timeout (72 h), and list reads no deadline.
import { readFileSync } from "node:fs";
import {
	cdpUrlProblem,
	BROWSER_IMAGE,
	type BrowserStream,
	browserClient,
	browserHello,
	BrowserVendorError,
	CREATE_LABEL,
	carries,
	causeOf,
	checkBrowser,
	createLabelValue,
	createUncertain,
	DEFAULT_CONFIRM,
	defaultSleep,
	httpsBase,
	idProblem,
	labelsOf,
	labelsProblem,
	memoryUrls,
	queryable,
	type ReleaseConfirm,
	recoverCreate,
	releaseConfirmed,
	restCall,
	type RestReply,
	type UrlStore,
	vendorFail,
	vendorFailure,
	withoutCreateLabel,
} from "./browser.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type {
	AttachedComputer,
	CallContext,
	ComputerCapabilities,
	ComputerConnection,
	ComputerInfo,
	ComputerProvider,
	ComputerRef,
	ComputerSpec,
	CreatedComputer,
	NetworkPolicy,
	NetworkSpec,
	Refusal,
} from "./provider.js";
import { fail, ok, type Result } from "./result.js";
import { connectionError } from "./test-connection.js";

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

/** A browser takes no mount. */
export const MOUNT: readonly MountKind[] = [];

/** The one configuration it offers, the kind registry's entry (kinds.ts): a browser with a CDP target and a live view. */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "browser", groups: ["cdp", "stream"] }];

/** A browser as Kernel answers it; only what the provider reads. */
export interface KernelBrowser {
	session_id?: unknown;
	/** The signed CDP URL: a secret. */
	cdp_ws_url?: unknown;
	/** The live view's URL: a secret. */
	browser_live_view_url?: unknown;
	tags?: unknown;
	deleted_at?: unknown;
}

/**
 * One Kernel request, never retried: a create sent twice would be a second paid browser. It answers 404 as a reply,
 * and throws on any other failure, with the HTTP status as `status`; the provider returns that as a result whose hidden
 * cause is the thrown error, so a host that gave its own request rethrows its own error.
 */
export type KernelRequest = (method: string, route: string, init?: { body?: unknown; query?: URLSearchParams; signal?: AbortSignal }) => Promise<RestReply>;

/** Kernel's REST API over fetch: the default request. */
export function kernelRest({ apiKey, apiUrl = KERNEL_API_URL, fetch: fetcher = fetch }: { apiKey: string; apiUrl?: string; fetch?: typeof fetch }): KernelRequest {
	const o = { vendor: NAME, fetch: fetcher, base: httpsBase(apiUrl, "the Kernel API URL"), headers: { Authorization: `Bearer ${apiKey}` } };
	return (method, route, init = {}) => restCall(o, method, route, `${method} ${callName(route)}`, init);
}

/** A route as a failure names it: ids out, so no session id reads as a secret's neighbour. */
const callName = (route: string) => route.replace(/\/browsers\/[^/?]+/, "/browsers/{id}");
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export interface KernelProviderOptions {
	/** With apiUrl and fetch, the REST request is built from it; required unless request is given. */
	apiKey?: string;
	apiUrl?: string;
	fetch?: typeof fetch;
	/** One Kernel request, a host's own; default the REST one. */
	request?: KernelRequest;
	/** Where the signed CDP URLs are held; default a Map of this provider's own. */
	urls?: UrlStore;
	/** Where the live views' URLs are held; default a Map of this provider's own. */
	liveUrls?: UrlStore;
	confirm?: ReleaseConfirm;
	sleep?: (ms: number) => Promise<void>;
}

/** What a host may add to a browser's create body: Kernel's own fields (headless, stealth, viewport, a profile, extensions). */
export type KernelBrowserSettings = Record<string, unknown>;

const refOf = (id: string): ComputerRef => ({ id, name: id });

/** Computers that are Kernel browsers. */
export class KernelProvider implements ComputerProvider {
	readonly id = "kernel";
	readonly version = VERSION;
	readonly #request: KernelRequest;
	readonly #urls: UrlStore;
	readonly #live: UrlStore;
	readonly #confirm: ReleaseConfirm;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor({ apiKey, apiUrl, fetch: fetcher, request, urls, liveUrls, confirm = DEFAULT_CONFIRM, sleep = defaultSleep }: KernelProviderOptions) {
		if (request === undefined && (typeof apiKey !== "string" || apiKey === "")) throw new Error("set options.apiKey to a Kernel API key, or options.request to a host's own Kernel request: the provider reads no environment");
		this.#request = request ?? kernelRest({ apiKey: apiKey as string, ...(apiUrl ? { apiUrl } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
		this.#urls = urls ?? memoryUrls();
		this.#live = liveUrls ?? memoryUrls();
		this.#confirm = confirm;
		this.#sleep = sleep;
	}

	/**
	 * A browser: Kernel ends a browser after its idle timeout (lifetime vendor), at most 72 h; it reaches the open web;
	 * each browser is its own VM. Kernel's replays and file APIs are not wired here, so recordings and downloads are not
	 * declared.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "browser",
			lifetime: "vendor",
			network: ["open"],
			isolation: "vm",
			os: "linux",
			daemon: "none",
			groups: [...(CAPABILITIES[0] as KindCapabilities).groups],
			maxLifetimeMs: KERNEL_MAX_LIFETIME_MS,
			release: ["delete"],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		return checkBrowser(spec, this.capabilities(), NAME, KERNEL_MIN_LIFETIME_MS);
	}

	/**
	 * Makes a browser at most once, with the lifetime as its idle timeout in whole seconds and the labels as its tags.
	 * settings are Kernel's own create fields a host adds; what the protocol sets wins over them.
	 */
	async create(spec: ComputerSpec, { signal, settings = {} }: { signal?: AbortSignal; settings?: KernelBrowserSettings } = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before Kernel was called");
		const createdBy = createLabelValue();
		const body = { ...settings, timeout_seconds: Math.ceil(spec.lifetimeMs / 1000), tags: { ...spec.labels, [CREATE_LABEL]: createdBy } };
		let made: RestReply;
		try {
			made = await this.#request("POST", "/browsers", { body, ...(signal ? { signal } : {}) });
		} catch (error) {
			const failed = vendorFailure("kernel", NAME, "POST /browsers", error);
			if (failed.ok || !createUncertain(error)) return failed;
			// The browser may have been made though its answer never came: found by its create label, never made again.
			return vendorFail(failed.error.code, `${failed.error.message}; ${await this.#recover(createdBy)}`, causeOf(failed));
		}
		const browser = (made.json ?? {}) as KernelBrowser;
		const id = text(browser.session_id);
		const url = text(browser.cdp_ws_url);
		if (made.status === 404) return vendorFailure("kernel", NAME, "POST /browsers", new BrowserVendorError(NAME, "POST /browsers", made.status, "no_session"));
		if (idProblem(id, NAME) !== undefined) {
			const failed = vendorFailure("kernel", NAME, "POST /browsers", new BrowserVendorError(NAME, "POST /browsers", made.status, "no_session"));
			return failed.ok ? failed : fail(failed.error.code, `${failed.error.message}; ${await this.#recover(createdBy)}`);
		}
		const unusable = cdpUrlProblem(url, NAME, CDP_DOMAIN);
		if (unusable !== undefined) {
			// The browser is made and billed until its idle timeout: deleted here, not left to a later sweep.
			const released = await this.release(refOf(id), "delete");
			return fail("kernel", `Kernel POST /browsers made a browser with no CDP URL to hand over: ${unusable}; ${released.ok ? "the browser was released" : `the browser was not released (${released.error.code}), and its tags let a sweep find it`}`);
		}
		this.#urls.set(id, url);
		const live = text(browser.browser_live_view_url);
		if (live !== "") this.#live.set(id, live);
		return ok(refOf(id));
	}

	/** The browsers a create tagged createdBy made, released: what recoverCreate says of them. */
	#recover(createdBy: string): Promise<string> {
		const find = async (signal: AbortSignal): Promise<Result<string[]>> => {
			const call = "GET /browsers";
			let page: RestReply;
			try {
				page = await this.#request("GET", "/browsers", { query: new URLSearchParams({ status: "active", [`tags[${CREATE_LABEL}]`]: createdBy, limit: "100", offset: "0" }), signal });
			} catch (error) {
				return vendorFailure("kernel", NAME, call, error);
			}
			if (page.status === 404 || !Array.isArray(page.json)) return vendorFailure("kernel", NAME, call, new BrowserVendorError(NAME, call, page.status, "not_a_list"));
			const ids = (page.json as KernelBrowser[]).filter((row) => !row?.deleted_at && labelsOf(row?.tags)[CREATE_LABEL] === createdBy).map((row) => text(row.session_id));
			return ok([...new Set(ids.filter((one) => one !== ""))]);
		};
		return recoverCreate("browser", find, (id) => this.release(refOf(id), "delete"), this.#sleep);
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
		if (page.status === 404) return fail("kernel", `Kernel ${call} answered 404: the API URL is not Kernel's`);
		if (!Array.isArray(page.json)) return fail("kernel", `Kernel ${call} answered ${page.status} (not_a_list)`);
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
	 * The live browsers with all of these labels, every page read. Kernel is asked for active browsers by the first label
	 * a query carries as it is; the match is the provider's own, so a lane that drops the filter never hands back
	 * another's. A page that cannot be read fails the whole list: a release trusts it.
	 */
	async #browsers(labels: Record<string, string>, signal?: AbortSignal): Promise<Result<Array<{ id: string; tags: Record<string, string> }>>> {
		const problem = labelsProblem(labels);
		if (problem) return fail("invalid", problem);
		if (Object.keys(labels).length === 0) return fail("invalid", "list and attach take at least one label: a Kernel organization holds browsers this provider did not make");
		const first = Object.entries(labels).find(queryable);
		const found: Array<{ id: string; tags: Record<string, string> }> = [];
		const seen = new Set<string>();
		const call = "GET /browsers";
		for (let offset = 0, pages = 0; pages < MAX_PAGES; pages++) {
			const query = new URLSearchParams({ status: "active", ...(first === undefined ? {} : { [`tags[${first[0]}]`]: first[1] }), limit: "100", offset: String(offset) });
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
				if (id !== "" && !row.deleted_at && carries(row.tags, labels) && !seen.has(id)) {
					seen.add(id);
					found.push({ id, tags: withoutCreateLabel(labelsOf(row.tags)) });
				}
			}
			if (page.headers.get("x-has-more") !== "true") return ok(found);
			const next = Number(page.headers.get("x-next-offset"));
			if (!Number.isInteger(next) || next <= offset) return fail("kernel", "Kernel reported more browsers without the next page's offset");
			offset = next;
		}
		return fail("kernel", `Kernel kept answering more pages of browsers past ${MAX_PAGES}`);
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
		if (unusable !== undefined) return fail("kernel", `the Kernel browser ${id} is not handed over: ${unusable}`);
		this.#urls.set(id, url);
		const hello = browserHello(VERSION, this.capabilities().groups);
		const client = browserClient(hello, (signal) => this.#alive(id, signal));
		return ok({ client, hello, cdp: { url }, close: async () => client.close() });
	}

	/** Deletes the browser and waits until Kernel reads it as gone; one already deleted or unknown is released. */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		if (how !== "delete") return fail("refused", `a Kernel browser is released with "delete"; it cannot be stopped and kept, so ${String(how)} is refused and the browser is left as it is`);
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
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
 * The provider, built from its options alone, the key included (options.apiKey, or options.api / options.request, a
 * host's own transport); it reads no environment, and throws in words when the key is missing, never echoing one.
 */
export function create(options: KernelProviderOptions): KernelProvider {
	return new KernelProvider(options ?? ({} as KernelProviderOptions));
}

/** The conformance CLI's module for Kernel: its live switch, its image and its notes. */
export const conformance = () => import("./conformance/kernel.js");
