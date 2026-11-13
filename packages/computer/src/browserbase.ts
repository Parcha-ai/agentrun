// Browserbase as a computer of kind browser: each computer is a Browserbase session, over Browserbase's v1 REST API with
// fetch (no SDK). Labels ride the session's own userMetadata; attach and list find a session by them; connect hands over the session's signed connectUrl, which a
// driver dials; stream is its live view (the debugger's fullscreen URL). Both URLs are secrets: they stay in memory and
// never reach a ref, a list, an error's words or a report.
//
// Calls: POST /v1/sessions (create, with timeout, keepAlive and userMetadata), GET /v1/sessions/{id} (read),
// GET /v1/sessions?status=&q= (list; q is user_metadata['key']:'value', and a status is always given, since q alone made
// Browserbase answer 504 after 75 s), POST /v1/sessions/{id} with status REQUEST_RELEASE (release), and
// GET /v1/sessions/{id}/debug (the live view). The key is the X-BB-API-Key header.
//
// A session's own options (spec.browser): viewport and a profile ride browserSettings (a profile is a context,
// { id: pointer, persist: save }); stealth is Browserbase's Verified browser with its CAPTCHA solver (verified and
// solveCaptchas; the solver is off otherwise, as Browserbase's default is on). Profiles are contexts: POST /v1/contexts ({ projectId } when the provider has one) and DELETE /v1/contexts/{id}. Downloads are the session's
// synced files: GET /v1/downloads?sessionId=&limit=&offset= (paged by total) and GET /v1/downloads/{id}, the bytes.
//
// A label's key is not its metadata key: Browserbase refuses a dot in a userMetadata key (POST /v1/sessions answered 400
// "Key is not a valid metadata key: agentrun.conformance", found live on 11-08), and the protocol's labels are dotted
// (agentrun.run, agentrun.epoch). metadataKey() writes each "." as "_", and labelKey() reads it back. check() takes a
// label key of letters, digits and dots alone, so no label key holds an "_" and the mapping is one to one; a value with
// ' or \ is refused too, since list's query quotes it.
import { readFileSync } from "node:fs";
import { BROWSERBASE } from "./descriptors/browserbase.js";
import { BROWSER_IMAGE } from "./descriptors/shared.js";
import {
	cdpUrlProblem,
	type BrowserComputerProvider,
	type BrowserDownloads,
	type BrowserFile,
	type BrowserProfiles,
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
	limitedBytes,
	memoryUrls,
	pointerOk,
	queryable,
	type ReleaseConfirm,
	recoverCreate,
	releaseConfirmed,
	restBytes,
	restCall,
	type UrlStore,
	causedFail,
	vendorFailure,
	withoutCreateLabel,
} from "./browser.js";
import type { KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
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

/** This module's failures: one with code vendor names Browserbase. */
const fail = failFor("browserbase");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NAME = "Browserbase";
export const BROWSERBASE_API_URL = "https://api.browserbase.com";
/** The domain a Browserbase CDP URL is on (wss://connect.browserbase.com, read live 11-08): cdpUrlProblem holds it there. */
export const BROWSERBASE_CDP_DOMAIN = "browserbase.com";
const CDP_DOMAIN = BROWSERBASE_CDP_DOMAIN;
/** Browserbase's longest session: a timeout of 21,600 s. */
export const BROWSERBASE_MAX_LIFETIME_MS = 6 * 60 * 60_000;
/** Browserbase's shortest session timeout: 60 s. */
export const BROWSERBASE_MIN_LIFETIME_MS = 60_000;
/** The statuses of a session that runs (PENDING bills once it starts); any other has ended. */
const LIVE = new Set(["RUNNING", "PENDING"]);

/** A label key Browserbase's metadata can carry once its dots are underscores: letters, digits and dots, so the mapping is one to one. */
const LABEL_KEY = /^[A-Za-z0-9.]+$/;

/** The userMetadata key a label key is written under: each "." as "_", since Browserbase refuses a dot there. */
export const metadataKey = (labelKey: string) => labelKey.replaceAll(".", "_");
/** The label key a userMetadata key reads back as: each "_" as ".". */
export const labelKey = (metadataKey: string) => metadataKey.replaceAll("_", ".");

/** Labels as userMetadata. */
const toMetadata = (labels: Record<string, string> = {}) => Object.fromEntries(Object.entries(labels).map(([key, value]) => [metadataKey(key), value]));
/** userMetadata as labels: its string entries, each key read back, the create label among them (what a match reads). */
const metadataLabels = (held: unknown): Record<string, string> => Object.fromEntries(Object.entries(labelsOf(held)).map(([key, value]) => [labelKey(key), value]));
/** userMetadata as the labels list and attach show: without the provider's create label. */
const fromMetadata = (held: unknown): Record<string, string> => withoutCreateLabel(metadataLabels(held));

/** Why labels cannot ride a Browserbase session's userMetadata, in words naming the label; undefined when they can. */
export function browserbaseLabelsProblem(labels: unknown): string | undefined {
	const problem = labelsProblem(labels);
	if (problem) return problem;
	for (const [key, value] of Object.entries(labels as Record<string, string>)) {
		if (!LABEL_KEY.test(key)) return `a Browserbase label's key is letters, digits and dots (each dot is written as "_" in the session's metadata, which refuses a dot), not ${JSON.stringify(key)}`;
		if (/['\\]/.test(value)) return `the label ${JSON.stringify(key)} holds a quote or a backslash, which list's query to Browserbase cannot carry`;
	}
	return undefined;
}

/** A browser takes no mount. */
export const MOUNT: readonly MountKind[] = BROWSERBASE.mounts;

/** The one configuration it offers, its descriptor's: a browser with a CDP target and a live view. */
export const CAPABILITIES: readonly KindCapabilities[] = BROWSERBASE.capabilities;

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

/** One row of a session's downloads, as GET /v1/downloads answers it; only what the provider reads. */
export interface BrowserbaseDownload {
	id: string;
	filename: string;
	size: number;
	createdAt?: string;
}

/**
 * The calls the provider makes, one Browserbase request each, never retried where a retry could open a second paid
 * browser. A failure throws, with the HTTP status as `status` when one came back; the provider returns it as a result
 * whose hidden cause is the thrown error. The context calls back the profiles member, the download calls the downloads
 * member.
 */
export interface BrowserbaseApi {
	create(body: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserbaseSession>;
	/** undefined when Browserbase does not know the session (404). */
	retrieve(id: string, signal?: AbortSignal): Promise<BrowserbaseSession | undefined>;
	list(query: { status: "RUNNING" | "PENDING"; q?: string }, signal?: AbortSignal): Promise<BrowserbaseSession[]>;
	/** "gone" when Browserbase does not know the session (404). */
	release(id: string, signal?: AbortSignal): Promise<"gone" | "asked">;
	debug(id: string, signal?: AbortSignal): Promise<BrowserbaseDebug>;
	/** Makes a context (POST /v1/contexts): its id. */
	createContext(signal?: AbortSignal): Promise<string>;
	/** "gone" when Browserbase does not know the context (404). */
	deleteContext(id: string, signal?: AbortSignal): Promise<"gone" | "deleted">;
	/** One page of a session's downloads, from offset, and how many there are in all. */
	listDownloads(sessionId: string, offset: number, signal?: AbortSignal): Promise<{ downloads: BrowserbaseDownload[]; total: number }>;
	/** A download's bytes, streamed; undefined when Browserbase does not know it (404). */
	readDownload(id: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | undefined>;
}

/** A plain id as Browserbase answers one (a context's, a download's): a token, never a path. */
const plainId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);

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
		async createContext(signal) {
			const call = "POST /v1/contexts";
			const answer = await restCall(o, "POST", "/v1/contexts", call, { body: projectId ? { projectId } : {}, ...(signal ? { signal } : {}) });
			const id = (answer.json as { id?: unknown } | null)?.id;
			if (answer.status === 404 || !plainId(id)) throw new BrowserVendorError(NAME, call, answer.status, "no_context_id");
			return id;
		},
		async deleteContext(id, signal) {
			const answer = await restCall(o, "DELETE", `/v1/contexts/${encodeURIComponent(id)}`, "DELETE /v1/contexts/{id}", signal ? { signal } : {});
			return answer.status === 404 ? "gone" : "deleted";
		},
		async listDownloads(sessionId, offset, signal) {
			const call = "GET /v1/downloads";
			const query = new URLSearchParams({ sessionId, limit: String(DOWNLOADS_PAGE), offset: String(offset) });
			const answer = await restCall(o, "GET", "/v1/downloads", call, { query, ...(signal ? { signal } : {}) });
			// A list is never "not found": a 404 is a wrong base URL, and an empty answer would hide every file.
			if (answer.status === 404) throw new BrowserVendorError(NAME, call, 404);
			const page = answer.json as { downloads?: unknown; total?: unknown } | null;
			if (!Array.isArray(page?.downloads) || !Number.isInteger(page.total)) throw new BrowserVendorError(NAME, call, answer.status, "not_a_list");
			return { downloads: page.downloads as BrowserbaseDownload[], total: page.total as number };
		},
		async readDownload(id, signal) {
			return restBytes(o, `/v1/downloads/${encodeURIComponent(id)}`, "GET /v1/downloads/{id}", signal);
		},
	};
}

/** Rows per downloads page, and the most pages a list reads before it fails rather than run on. */
const DOWNLOADS_PAGE = 100;
const MAX_PAGES = 100;

/** How long after a saving session ends Browserbase may still be writing its context back. */
export const BROWSERBASE_PROFILE_SETTLE_MS = 5_000;
/** The directory Browserbase syncs a session's downloads from: a driver sets the download behaviour into it. */
export const BROWSERBASE_DOWNLOADS_PATH = "downloads";

export interface BrowserbaseProviderOptions {
	/** With apiUrl and fetch, the REST api is built from it. */
	apiKey?: string;
	/** Named in every create and release; none behind a gateway (env), whose key names the project. */
	projectId?: string;
	/** Browserbase's API; default BROWSERBASE_BASE_URL in env (a gateway that fronts it), else Browserbase's own. */
	apiUrl?: string;
	/**
	 * The host's own variables its descriptor declares (hostEnv): BROWSERBASE_BASE_URL, a gateway that fronts the API, and
	 * BROWSERBASE_CONNECT_BASE_URL, one that fronts the sessions' sockets. Behind either, the gateway's key names the
	 * project, so no projectId is sent.
	 */
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	confirm?: ReleaseConfirm;
	sleep?: (ms: number) => Promise<void>;
}

const refOf = (s: BrowserbaseSession): ComputerRef => ({ id: s.id, name: s.id });
const deadlineOf = (s: BrowserbaseSession) => {
	const at = typeof s.expiresAt === "string" ? new Date(s.expiresAt) : undefined;
	return at !== undefined && Number.isFinite(at.getTime()) ? at : undefined;
};

/** Computers that are Browserbase sessions. */
export class BrowserbaseProvider implements ComputerProvider, BrowserComputerProvider {
	readonly id = "browserbase";
	readonly version = VERSION;
	/**
	 * A session ends at its timeout, a wall clock; it may be stealth (Verified, with the CAPTCHA solver); it opens a
	 * context as a profile (written back about 5 s after a saving session ends) and keeps what is saved into downloads/.
	 * capabilities().browser gives it.
	 */
	readonly #browser: BrowserFeatures;
	readonly profiles: BrowserProfiles;
	readonly downloads: BrowserDownloads;
	readonly #api: BrowserbaseApi;
	readonly #projectId: string | undefined;
	readonly #urls: UrlStore;
	readonly #confirm: ReleaseConfirm;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor({ apiKey, projectId, apiUrl, env = {}, fetch: fetcher, confirm = DEFAULT_CONFIRM, sleep = defaultSleep }: BrowserbaseProviderOptions) {
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("set options.apiKey to a Browserbase API key: the provider reads no environment");
		const gateway = env.BROWSERBASE_BASE_URL?.trim() || undefined;
		const behindGateway = Boolean(gateway || env.BROWSERBASE_CONNECT_BASE_URL?.trim());
		this.#projectId = behindGateway ? undefined : projectId || undefined;
		const base = apiUrl || gateway;
		this.#api = browserbaseRest({ apiKey, ...(base ? { apiUrl: base } : {}), ...(this.#projectId ? { projectId: this.#projectId } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
		this.#urls = memoryUrls();
		this.#confirm = confirm;
		this.#sleep = sleep;
		this.#browser = {
			timeout: "wall-clock",
			stealth: true,
			profiles: { settleMs: BROWSERBASE_PROFILE_SETTLE_MS },
			downloads: { path: BROWSERBASE_DOWNLOADS_PATH },
		};
		this.profiles = { create: (context) => this.#createProfile(context), remove: (pointer, context) => this.#removeProfile(pointer, context) };
		this.downloads = { list: (ref, context) => this.#listDownloads(ref, context), read: (ref, name, maxBytes, context) => this.#readDownload(ref, name, maxBytes, context) };
	}

	/**
	 * A browser: Browserbase ends a session at its timeout (lifetime vendor), at most 6 h; it reaches the open web; each
	 * session is its own VM. browser is what its sessions offer beyond the protocol. Its downloads are read through the
	 * downloads member (browser.downloads); the group stays undeclared until the kind registry's entry (kinds.ts)
	 * declares it too.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "browser",
			lifetime: "vendor",
			network: [...BROWSERBASE.network],
			isolation: "vm",
			os: "linux",
			daemon: "none",
			groups: [...(CAPABILITIES[0] as KindCapabilities).groups],
			maxLifetimeMs: BROWSERBASE_MAX_LIFETIME_MS,
			release: ["delete"],
			browser: structuredClone(this.#browser),
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals = checkBrowser(spec, this.capabilities(), NAME, BROWSERBASE_MIN_LIFETIME_MS);
		const labels = (spec as { labels?: unknown } | null)?.labels;
		if (labels !== undefined && !refusals.some((r) => r.field === "labels")) {
			const problem = browserbaseLabelsProblem(labels);
			if (problem) refusals.push({ field: "labels", message: problem });
		}
		return refusals;
	}

	/**
	 * Makes a session at most once: with keepAlive, so a dropped CDP client never ends it, the lifetime as its timeout in
	 * whole seconds, and the labels as its userMetadata. spec.browser is the session's own options, each refused by check()
	 * unless declared.
	 */
	async create(spec: ComputerSpec, context: CreateContext): Promise<Result<CreatedComputer>> {
		const signal = context?.signal;
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before Browserbase was called");
		const browser = spec.browser;
		const written = { [CREATE_LABEL]: createLabelValue(), ...spec.labels };
		// Browserbase solves CAPTCHAs unless told not to: a browser's options say so either way, the solver only with stealth.
		const browserSettings = {
			...(browser?.viewport ? { viewport: { width: browser.viewport.width, height: browser.viewport.height } } : {}),
			...(browser !== undefined ? { solveCaptchas: browser.stealth === true } : {}),
			...(browser?.stealth ? { verified: true } : {}),
			...(browser?.profile ? { context: { id: browser.profile.pointer, persist: browser.profile.save } } : {}),
		};
		const body = {
			...(Object.keys(browserSettings).length > 0 ? { browserSettings } : {}),
			timeout: Math.ceil(runLifetimeMs(spec) / 1000),
			keepAlive: true,
			userMetadata: toMetadata(written),
			...(this.#projectId ? { projectId: this.#projectId } : {}),
		};
		let made: BrowserbaseSession;
		try {
			made = await this.#api.create(body, signal);
		} catch (error) {
			const failed = vendorFailure("browserbase", NAME, "POST /v1/sessions", error);
			if (failed.ok || !createUncertain(error)) return failed;
			// The session may have been made though its answer never came: found by its create label, never made again.
			return causedFail(failed.error.code, `${failed.error.message}; ${await this.#recover(written)}`, causeOf(failed), "browserbase");
		}
		if (idProblem(made?.id, NAME) !== undefined) {
			return vendorFail("browserbase",`Browserbase POST /v1/sessions answered with no session id, so there is no session to connect to; ${await this.#recover(written)}`);
		}
		const unusable = cdpUrlProblem(made.connectUrl, NAME, CDP_DOMAIN);
		if (unusable !== undefined) {
			// The session is made and billed (keepAlive, up to its timeout): released here, not left to a later sweep.
			const released = await this.release(refOf(made), "delete");
			return vendorFail("browserbase",`Browserbase POST /v1/sessions made a session with no CDP URL to hand over: ${unusable}; ${released.ok ? "the session was released" : `the session was not released (${released.error.code}), and its labels let a sweep find it`}`);
		}
		this.#urls.set(made.id, made.connectUrl as string);
		return ok(refOf(made));
	}

	/** A new context, a profile's pointer: one POST /v1/contexts, never retried. */
	async #createProfile({ signal }: CallContext = {}): Promise<Result<string>> {
		try {
			return ok(await this.#api.createContext(signal));
		} catch (error) {
			return vendorFailure("browserbase", NAME, "POST /v1/contexts", error);
		}
	}

	/** Deletes the context; one Browserbase no longer knows is removed. The words never carry the pointer. */
	async #removeProfile(pointer: string, { signal }: CallContext = {}): Promise<Result<void>> {
		if (!pointerOk(pointer)) return fail("invalid", "a profile's pointer is a plain token, as profiles.create gave it");
		try {
			await this.#api.deleteContext(pointer, signal);
			return ok(undefined);
		} catch (error) {
			return vendorFailure("browserbase", NAME, "DELETE /v1/contexts/{id}", error);
		}
	}

	/** Every row of a session's downloads, page by page until total; a page that cannot be read fails the whole list. */
	async #downloadRows(id: string, signal?: AbortSignal): Promise<Result<BrowserbaseDownload[]>> {
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		const rows: BrowserbaseDownload[] = [];
		for (let pages = 0; pages < MAX_PAGES; pages++) {
			let got: { downloads: BrowserbaseDownload[]; total: number };
			try {
				got = await this.#api.listDownloads(id, rows.length, signal);
			} catch (error) {
				return vendorFailure("browserbase", NAME, "GET /v1/downloads", error);
			}
			for (const row of got.downloads) {
				if (!plainId(row?.id) || typeof row.filename !== "string" || row.filename === "" || !Number.isFinite(row.size) || row.size < 0) {
					return vendorFail("browserbase", "Browserbase GET /v1/downloads answered a row that is not a download");
				}
			}
			rows.push(...got.downloads);
			if (got.downloads.length === 0 || rows.length >= got.total) return ok(rows);
		}
		return vendorFail("browserbase", `Browserbase kept answering more pages of downloads past ${MAX_PAGES}`);
	}

	async #listDownloads(ref: ComputerRef, { signal }: CallContext = {}): Promise<Result<BrowserFile[]>> {
		const rows = await this.#downloadRows(ref?.id, signal);
		if (!rows.ok) return rows;
		// Browserbase suffixes each name with a timestamp, so a name is one file in a session.
		return ok(rows.value.map((d) => ({ name: d.filename, sizeBytes: d.size, modifiedAt: typeof d.createdAt === "string" ? d.createdAt : null })));
	}

	/** A download's bytes by its name: refused past maxBytes before it is fetched when its size says so, and cut once the stream passes it. */
	async #readDownload(ref: ComputerRef, name: string, maxBytes: number, { signal }: CallContext = {}): Promise<Result<AsyncIterable<Uint8Array>>> {
		if (!Number.isInteger(maxBytes) || maxBytes < 0) return fail("invalid", "maxBytes is a whole number of bytes");
		const rows = await this.#downloadRows(ref?.id, signal);
		if (!rows.ok) return rows;
		const row = rows.value.find((d) => d.filename === name);
		if (row === undefined) return fail("not_found", `the Browserbase session ${ref.id} downloaded no file named ${JSON.stringify(name)}`);
		if (row.size > maxBytes) return fail("limit", `the download ${JSON.stringify(name)} is ${row.size} bytes, larger than the ${maxBytes}-byte limit`);
		let body: AsyncIterable<Uint8Array> | undefined;
		try {
			body = await this.#api.readDownload(row.id, signal);
		} catch (error) {
			return vendorFailure("browserbase", NAME, "GET /v1/downloads/{id}", error);
		}
		if (body === undefined) return fail("not_found", `Browserbase no longer holds the download ${JSON.stringify(name)}`);
		return ok(limitedBytes(body, maxBytes, `the download ${JSON.stringify(name)}`));
	}

	/**
	 * The sessions a lost create made, released: what recoverCreate says of them. They are found as list finds any, by
	 * the labels the create wrote (its create label first, so the query names it, then the run's), through #sessions and
	 * its metadata-key mapping: another session of the same run carries a create label of its own and is left alone.
	 */
	#recover(labels: Record<string, string>): Promise<string> {
		const find = async (signal: AbortSignal): Promise<Result<string[]>> => {
			const found = await this.#sessions(labels, signal);
			return found.ok ? ok(found.value.map((s) => s.id)) : found;
		};
		return recoverCreate("session", find, (id) => this.release({ id, name: id }, "delete"), this.#sleep);
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

	/** The session, when Browserbase still runs it; not_found in words when it does not know it, gone when it has ended. */
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
		if (!LIVE.has(found.status ?? "")) return fail("gone", `the Browserbase session ${id} has ended (${found.status ?? "no status"}): only a running session is attached or connected to`);
		return ok(found);
	}

	async #alive(id: string, signal?: AbortSignal): Promise<Result<boolean>> {
		const found = await this.#running(id, signal);
		if (found.ok) return ok(true);
		return found.error.code === "not_found" || found.error.code === "gone" ? ok(false) : found;
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
		const problem = browserbaseLabelsProblem(labels);
		if (problem) return fail("invalid", problem);
		if (Object.keys(labels).length === 0) return fail("invalid", "list and attach take at least one label: a Browserbase project holds sessions this provider did not make");
		const first = Object.entries(labels).find(queryable);
		const q = first === undefined ? undefined : `user_metadata['${metadataKey(first[0])}']:'${first[1]}'`;
		let pages: BrowserbaseSession[][];
		try {
			pages = await Promise.all((["RUNNING", "PENDING"] as const).map((status) => this.#api.list({ status, ...(q === undefined ? {} : { q }) }, signal)));
		} catch (error) {
			return vendorFailure("browserbase", NAME, "GET /v1/sessions", error);
		}
		const seen = new Set<string>();
		return ok(pages.flat().filter((s) => typeof s?.id === "string" && LIVE.has(s.status ?? "") && carries(metadataLabels(s.userMetadata), labels) && !seen.has(s.id) && seen.add(s.id)));
	}

	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const found = await this.#sessions(labels, signal);
		if (!found.ok) return found;
		return ok(found.value.map((s) => ({ ref: refOf(s), labels: fromMetadata(s.userMetadata), deadline: deadlineOf(s), state: "running", network: "open" })));
	}

	/** Always open: a Browserbase browser reaches the open web, and a change is refused in words. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		if (policy !== undefined && policy !== "open") return fail("refused", `a Browserbase browser's network is open; it cannot be set to ${JSON.stringify(policy)}`);
		const found = await this.#running(ref?.id, signal);
		return found.ok ? ok("open") : found;
	}

	/**
	 * The session's signed CDP URL, held since create or read from Browserbase, and a client that answers hello and ping.
	 * The session is read first, held URL or not: one that has ended, or that Browserbase no longer knows though its URL is
	 * held, is gone, never handed over. Dials nothing: the URL is the driver's to dial.
	 */
	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const id = ref?.id;
		const problem = idProblem(id, NAME);
		if (problem) return fail("invalid", problem);
		let url = this.#urls.get(id);
		const found = await this.#running(id);
		if (!found.ok) {
			// A vendor that did not answer leaves the held URL for the next connect; a session it ended takes it along.
			if (found.error.code !== "not_found" && found.error.code !== "gone") return found;
			if (url === undefined) return found;
			this.#urls.delete(id);
			return fail("gone", found.error.code === "gone" ? found.error.message : `the Browserbase session ${id} is gone: ${found.error.message}`);
		}
		if (url === undefined) {
			if (typeof found.value.connectUrl !== "string" || found.value.connectUrl === "") return fail("not_found", `the Browserbase session ${id} is not available for connection`);
			url = found.value.connectUrl;
		}
		// Whatever held it (create, a read, a host's url store), a URL a driver would dial is wss: on Browserbase's own domain.
		const unusable = cdpUrlProblem(url, NAME, CDP_DOMAIN);
		if (unusable !== undefined) return vendorFail("browserbase",`the Browserbase session ${id} is not handed over: ${unusable}`);
		this.#urls.set(id, url);
		const hello = browserHello(VERSION, this.capabilities().groups);
		const client = browserClient(hello, (signal) => this.#alive(id, signal));
		return ok({ client, hello, cdp: { url }, close: async () => client.close() });
	}

	/** Asks Browserbase to release the session and waits until it reads as ended; one already ended or unknown is released. */
	async release(ref: ComputerRef, how: ReleaseHow, { signal }: CallContext = {}): Promise<Result<void>> {
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
 * The provider, built from its options alone, the key included (options.apiKey); it reads no environment, and throws in words when the key is missing, never echoing one.
 */
export function create(options: BrowserbaseProviderOptions): BrowserbaseProvider {
	return new BrowserbaseProvider(options ?? ({} as BrowserbaseProviderOptions));
}

/** The conformance CLI's module for Browserbase: its live switch, its image and its notes. */
export const conformance = () => import("./conformance/browserbase.js");
