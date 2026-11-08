// Browserbase as a computer of kind browser: each computer is a Browserbase session, over Browserbase's v1 REST API with
// fetch (no SDK), or through a BrowserbaseApi a host gives (pi-browser's SDK client). Labels ride the session's own
// userMetadata; attach and list find a session by them; connect hands over the session's signed connectUrl, which a
// driver dials; stream is its live view (the debugger's fullscreen URL). Both URLs are secrets: they stay in memory and
// never reach a ref, a list, an error's words or a report.
//
// Calls: POST /v1/sessions (create, with timeout, keepAlive and userMetadata), GET /v1/sessions/{id} (read),
// GET /v1/sessions?status=&q= (list; q is user_metadata['key']:'value', and a status is always given, since q alone made
// Browserbase answer 504 after 75 s), POST /v1/sessions/{id} with status REQUEST_RELEASE (release), and
// GET /v1/sessions/{id}/debug (the live view). The key is the X-BB-API-Key header.
import { readFileSync } from "node:fs";
import {
	BROWSER_IMAGE,
	type BrowserStream,
	browserClient,
	browserHello,
	BrowserVendorError,
	carries,
	checkBrowser,
	DEFAULT_CONFIRM,
	defaultSleep,
	httpsBase,
	idProblem,
	labelsOf,
	labelsProblem,
	memoryUrls,
	queryable,
	type ReleaseConfirm,
	releaseConfirmed,
	restCall,
	type UrlStore,
	vendorFailure,
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
const NAME = "Browserbase";
export const BROWSERBASE_API_URL = "https://api.browserbase.com";
/** Browserbase's longest session: a timeout of 21,600 s. */
export const BROWSERBASE_MAX_LIFETIME_MS = 6 * 60 * 60_000;
/** Browserbase's shortest session timeout: 60 s. */
export const BROWSERBASE_MIN_LIFETIME_MS = 60_000;
/** The statuses of a session that runs (PENDING bills once it starts); any other has ended. */
const LIVE = new Set(["RUNNING", "PENDING"]);

/** A browser takes no mount. */
export const MOUNT: readonly MountKind[] = [];

/** The one configuration it offers, the kind registry's entry (kinds.ts): a browser with a CDP target and a live view. */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "browser", groups: ["cdp", "stream"] }];

/** A session as Browserbase answers it; only what the provider reads. */
export interface BrowserbaseSession {
	id: string;
	status?: string;
	/** The signed CDP URL: a secret. */
	connectUrl?: string;
	userMetadata?: Record<string, unknown>;
	expiresAt?: string;
}

/** A session's live view as GET /v1/sessions/{id}/debug answers it: every URL in it is a secret. */
export interface BrowserbaseDebug {
	debuggerFullscreenUrl?: string;
	debuggerUrl?: string;
	pages?: Array<{ id?: string; url?: string; title?: string; debuggerFullscreenUrl?: string }>;
}

/**
 * The calls the provider makes, one Browserbase request each, never retried where a retry could open a second paid
 * browser. A failure throws, with the HTTP status as `status` when one came back; the provider returns it as a result
 * whose hidden cause is the thrown error, so a host that gave its own api rethrows its own error.
 */
export interface BrowserbaseApi {
	create(body: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserbaseSession>;
	/** undefined when Browserbase does not know the session (404). */
	retrieve(id: string, signal?: AbortSignal): Promise<BrowserbaseSession | undefined>;
	list(query: { status: "RUNNING" | "PENDING"; q?: string }, signal?: AbortSignal): Promise<BrowserbaseSession[]>;
	/** "gone" when Browserbase does not know the session (404). */
	release(id: string, signal?: AbortSignal): Promise<"gone" | "asked">;
	debug(id: string, signal?: AbortSignal): Promise<BrowserbaseDebug>;
}

/** Browserbase's v1 REST API over fetch: the default api. */
export function browserbaseRest({ apiKey, apiUrl = BROWSERBASE_API_URL, projectId, fetch: fetcher = fetch }: { apiKey: string; apiUrl?: string; projectId?: string; fetch?: typeof fetch }): BrowserbaseApi {
	const o = { vendor: NAME, fetch: fetcher, base: httpsBase(apiUrl, "the Browserbase API URL"), headers: { "X-BB-API-Key": apiKey } };
	const session = (call: string, json: unknown, status: number) => {
		if (typeof (json as BrowserbaseSession | null)?.id !== "string") throw new BrowserVendorError(NAME, call, status, "not_a_session");
		return json as BrowserbaseSession;
	};
	return {
		async create(body, signal) {
			const call = "POST /v1/sessions";
			const answer = await restCall(o, "POST", "/v1/sessions", call, { body, ...(signal ? { signal } : {}) });
			if (answer.status === 404) throw new BrowserVendorError(NAME, call, 404);
			return session(call, answer.json, answer.status);
		},
		async retrieve(id, signal) {
			const call = "GET /v1/sessions/{id}";
			const answer = await restCall(o, "GET", `/v1/sessions/${encodeURIComponent(id)}`, call, signal ? { signal } : {});
			return answer.status === 404 ? undefined : session(call, answer.json, answer.status);
		},
		async list(query, signal) {
			const call = "GET /v1/sessions";
			const params = new URLSearchParams({ status: query.status, ...(query.q === undefined ? {} : { q: query.q }) });
			const answer = await restCall(o, "GET", "/v1/sessions", call, { query: params, ...(signal ? { signal } : {}) });
			// A list is never "not found": a 404 is a wrong base URL, and an empty answer would hide every session.
			if (answer.status === 404) throw new BrowserVendorError(NAME, call, 404);
			if (!Array.isArray(answer.json)) throw new BrowserVendorError(NAME, call, answer.status, "not_a_list");
			return answer.json as BrowserbaseSession[];
		},
		async release(id, signal) {
			const call = "POST /v1/sessions/{id}";
			const body = { status: "REQUEST_RELEASE", ...(projectId ? { projectId } : {}) };
			const answer = await restCall(o, "POST", `/v1/sessions/${encodeURIComponent(id)}`, call, { body, ...(signal ? { signal } : {}) });
			return answer.status === 404 ? "gone" : "asked";
		},
		async debug(id, signal) {
			const call = "GET /v1/sessions/{id}/debug";
			const answer = await restCall(o, "GET", `/v1/sessions/${encodeURIComponent(id)}/debug`, call, signal ? { signal } : {});
			if (answer.status === 404) throw new BrowserVendorError(NAME, call, 404);
			return (answer.json ?? {}) as BrowserbaseDebug;
		},
	};
}

export interface BrowserbaseProviderOptions {
	/** With apiUrl and fetch, the REST api is built from it; required unless api is given. */
	apiKey?: string;
	/** Named in every create and release; a key behind a credential proxy names none. */
	projectId?: string;
	apiUrl?: string;
	fetch?: typeof fetch;
	/** The calls, a host's own (pi-browser's SDK client); default the REST api. */
	api?: BrowserbaseApi;
	/** Where the signed connect URLs are held; default a Map of this provider's own. */
	urls?: UrlStore;
	confirm?: ReleaseConfirm;
	sleep?: (ms: number) => Promise<void>;
}

/** What a host may add to a session's create body: Browserbase's own settings (proxies, browserSettings, region, extensionId, a context). */
export type BrowserbaseSessionSettings = Record<string, unknown>;

const refOf = (s: BrowserbaseSession): ComputerRef => ({ id: s.id, name: s.id });
const deadlineOf = (s: BrowserbaseSession) => {
	const at = typeof s.expiresAt === "string" ? new Date(s.expiresAt) : undefined;
	return at !== undefined && Number.isFinite(at.getTime()) ? at : undefined;
};

/** Computers that are Browserbase sessions. */
export class BrowserbaseProvider implements ComputerProvider {
	readonly id = "browserbase";
	readonly version = VERSION;
	readonly #api: BrowserbaseApi;
	readonly #projectId: string | undefined;
	readonly #urls: UrlStore;
	readonly #confirm: ReleaseConfirm;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor({ apiKey, projectId, apiUrl, fetch: fetcher, api, urls, confirm = DEFAULT_CONFIRM, sleep = defaultSleep }: BrowserbaseProviderOptions) {
		if (api === undefined && (typeof apiKey !== "string" || apiKey === "")) throw new Error("set options.apiKey to a Browserbase API key, or options.api to a host's own Browserbase calls: the provider reads no environment");
		this.#projectId = projectId || undefined;
		this.#api = api ?? browserbaseRest({ apiKey: apiKey as string, ...(apiUrl ? { apiUrl } : {}), ...(this.#projectId ? { projectId: this.#projectId } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
		this.#urls = urls ?? memoryUrls();
		this.#confirm = confirm;
		this.#sleep = sleep;
	}

	/**
	 * A browser: Browserbase ends a session at its timeout (lifetime vendor), at most 6 h; it reaches the open web; each
	 * session is its own VM. Browserbase keeps a session's downloads, but the protocol has no method that reads them yet,
	 * so downloads is not declared.
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
			maxLifetimeMs: BROWSERBASE_MAX_LIFETIME_MS,
			release: ["delete"],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		return checkBrowser(spec, this.capabilities(), NAME, BROWSERBASE_MIN_LIFETIME_MS);
	}

	/**
	 * Makes a session at most once: with keepAlive, so a dropped CDP client never ends it, the lifetime as its timeout in
	 * whole seconds, and the labels as its userMetadata. settings are Browserbase's own create fields a host adds (a
	 * proxy, a viewport, an extension); what the protocol sets wins over them.
	 */
	async create(spec: ComputerSpec, { signal, settings = {} }: { signal?: AbortSignal; settings?: BrowserbaseSessionSettings } = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before Browserbase was called");
		const body = {
			...settings,
			timeout: Math.ceil(spec.lifetimeMs / 1000),
			keepAlive: true,
			userMetadata: { ...spec.labels },
			...(this.#projectId ? { projectId: this.#projectId } : {}),
		};
		let made: BrowserbaseSession;
		try {
			made = await this.#api.create(body, signal);
		} catch (error) {
			return vendorFailure("browserbase", NAME, "POST /v1/sessions", error);
		}
		if (idProblem(made?.id, NAME) !== undefined || typeof made.connectUrl !== "string" || made.connectUrl === "") {
			return fail("browserbase", "Browserbase POST /v1/sessions answered with no session to connect to");
		}
		this.#urls.set(made.id, made.connectUrl);
		return ok(refOf(made));
	}

	/**
	 * Settings' test: one read of the project's running sessions (GET /v1/sessions?status=RUNNING), which makes nothing.
	 * A refused key is unauthorized and a Browserbase not reached unreachable; the words name the call, never the key.
	 */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		let running: BrowserbaseSession[];
		try {
			running = await this.#api.list({ status: "RUNNING" }, signal);
		} catch (error) {
			const failed = vendorFailure("browserbase", NAME, "GET /v1/sessions", error);
			if (failed.ok) return failed;
			const reached = (error as { status?: unknown } | null)?.status !== undefined || failed.error.code === "aborted";
			return fail(reached ? connectionError(failed.error).code : "unreachable", failed.error.message);
		}
		const n = Array.isArray(running) ? running.length : 0;
		return ok({ detail: `Browserbase answered: ${n} running ${n === 1 ? "session" : "sessions"} in the project` });
	}

	/** The session, when Browserbase still runs it; not_found in words when it does not know it or it has ended. */
	async #running(id: string, signal?: AbortSignal): Promise<Result<BrowserbaseSession>> {
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		let found: BrowserbaseSession | undefined;
		try {
			found = await this.#api.retrieve(id, signal);
		} catch (error) {
			return vendorFailure("browserbase", NAME, "GET /v1/sessions/{id}", error);
		}
		if (found === undefined) return fail("not_found", `no Browserbase session has the id ${id}`);
		if (!LIVE.has(found.status ?? "")) return fail("not_found", `the Browserbase session ${id} has ended (${found.status ?? "no status"}): only a running session is attached or connected to`);
		return ok(found);
	}

	async #alive(id: string, signal?: AbortSignal): Promise<Result<boolean>> {
		const found = await this.#running(id, signal);
		if (found.ok) return ok(true);
		return found.error.code === "not_found" ? ok(false) : found;
	}

	#attached(s: BrowserbaseSession): AttachedComputer {
		const deadline = deadlineOf(s);
		return { ...refOf(s), spec: { image: BROWSER_IMAGE, user: "unknown", network: "open", kind: "browser", ...(deadline ? { deadline } : {}) } };
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const found = await this.#running(given.id as string, signal);
			return found.ok ? ok(this.#attached(found.value)) : found;
		}
		const labels = given.labels as Record<string, string>;
		const listed = await this.#sessions(labels, signal);
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no running Browserbase session has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} Browserbase sessions have the labels ${words}: ${listed.value.map((s) => s.id).join(", ")}`);
		return ok(this.#attached(listed.value[0] as BrowserbaseSession));
	}

	/**
	 * The running and pending sessions with all of these labels. Browserbase is asked by status and by the first label a
	 * query carries as it is; the match is the provider's own, so a lane that drops the query never hands back another's.
	 * Both statuses must answer: a release trusts this list.
	 */
	async #sessions(labels: Record<string, string>, signal?: AbortSignal): Promise<Result<BrowserbaseSession[]>> {
		const problem = labelsProblem(labels);
		if (problem) return fail("invalid", problem);
		if (Object.keys(labels).length === 0) return fail("invalid", "list and attach take at least one label: a Browserbase project holds sessions this provider did not make");
		const first = Object.entries(labels).find(queryable);
		const q = first === undefined ? undefined : `user_metadata['${first[0]}']:'${first[1]}'`;
		let pages: BrowserbaseSession[][];
		try {
			pages = await Promise.all((["RUNNING", "PENDING"] as const).map((status) => this.#api.list({ status, ...(q === undefined ? {} : { q }) }, signal)));
		} catch (error) {
			return vendorFailure("browserbase", NAME, "GET /v1/sessions", error);
		}
		const seen = new Set<string>();
		return ok(pages.flat().filter((s) => typeof s?.id === "string" && LIVE.has(s.status ?? "") && carries(s.userMetadata, labels) && !seen.has(s.id) && seen.add(s.id)));
	}

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const found = await this.#sessions(labels, signal);
		if (!found.ok) return found;
		return ok(found.value.map((s) => ({ ref: refOf(s), labels: labelsOf(s.userMetadata), deadline: deadlineOf(s), state: "running", network: "open" })));
	}

	/** Always open: a Browserbase browser reaches the open web, and a change is refused in words. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (policy !== undefined && policy !== "open") return fail("refused", `a Browserbase browser's network is open; it cannot be set to ${JSON.stringify(policy)}`);
		const found = await this.#running(ref?.id, signal);
		return found.ok ? ok("open") : found;
	}

	/**
	 * The session's signed CDP URL, held since create or read from Browserbase, and a client that answers hello and ping.
	 * Dials nothing: the URL is the driver's to dial.
	 */
	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		let url = this.#urls.get(id);
		if (url === undefined) {
			const found = await this.#running(id);
			if (!found.ok) return found;
			if (typeof found.value.connectUrl !== "string" || found.value.connectUrl === "") return fail("not_found", `the Browserbase session ${id} is not available for connection`);
			url = found.value.connectUrl;
			this.#urls.set(id, url);
		}
		const hello = browserHello(VERSION, this.capabilities().groups);
		const client = browserClient(hello, (signal) => this.#alive(id, signal));
		return ok({ client, hello, cdp: { url }, close: async () => client.close() });
	}

	/** Asks Browserbase to release the session and waits until it reads as ended; one already ended or unknown is released. */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		if (how !== "delete") return fail("refused", `a Browserbase session is released with "delete"; it cannot be stopped and kept, so ${String(how)} is refused and the session is left as it is`);
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		const released = await releaseConfirmed({
			request: async () => {
				try {
					return ok(await this.#api.release(id, signal));
				} catch (error) {
					return vendorFailure("browserbase", NAME, "POST /v1/sessions/{id}", error);
				}
			},
			running: () => this.#alive(id, signal),
			confirm: this.#confirm,
			sleep: this.#sleep,
			stillRunning: `Browserbase session ${id} still running after a release request`,
		});
		if (released.ok) this.#urls.delete(id);
		return released;
	}

	/** The session's live view, which takes input: a view-only one is refused, never handed over as one. */
	async stream(ref: ComputerRef, options: { viewOnly?: boolean } = {}, { signal }: CallContext = {}): Promise<Result<BrowserStream>> {
		if (options.viewOnly) return fail("unsupported", "Browserbase's live view takes input; it has no view-only URL");
		const found = await this.#running(ref?.id, signal);
		if (!found.ok) return found;
		let live: BrowserbaseDebug;
		try {
			live = await this.#api.debug(ref.id, signal);
		} catch (error) {
			return vendorFailure("browserbase", NAME, "GET /v1/sessions/{id}/debug", error);
		}
		if (typeof live?.debuggerFullscreenUrl !== "string" || live.debuggerFullscreenUrl === "") return fail("not_found", `Browserbase gave no live view for the session ${ref.id}`);
		return ok({
			url: live.debuggerFullscreenUrl,
			...(typeof live.debuggerUrl === "string" ? { framed: live.debuggerUrl } : {}),
			pages: (live.pages ?? []).map((p) => ({ id: p.id ?? null, url: p.url ?? null, title: p.title ?? null, fullscreen: p.debuggerFullscreenUrl ?? null })),
		});
	}
}

/**
 * The provider, built from its options alone, the key included (options.apiKey, or options.api / options.request, a
 * host's own transport); it reads no environment, and throws in words when the key is missing, never echoing one.
 */
export function create(options: BrowserbaseProviderOptions): BrowserbaseProvider {
	return new BrowserbaseProvider(options ?? ({} as BrowserbaseProviderOptions));
}

/** The conformance CLI's module for Browserbase: its live switch, its image and its notes. */
export const conformance = () => import("./conformance/browserbase.js");
