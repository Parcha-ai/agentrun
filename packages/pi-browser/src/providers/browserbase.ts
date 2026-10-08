// Browserbase as a lease provider. Credentials come from the host's env and live in this module's memory only: a ref is
// `{ id, tag }`, and the connect URL (it carries a signing key) is held here, found again by `retrieve` after a restart.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchUsage, resolvePrices, searchUsage } from "../core/usage.js";
import type { AttachTarget, BrowserProvider, FetchRequest, FetchResult, Geo, LiveView, PriceTable, ProviderCaps, Recording, RemoteFile, SearchRequest, SearchResult, SessionSpec } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { cdpCall, type CdpSession } from "./cdp-call.js";
import { applyBrowserbaseNoProxy, bindConnectDial, directFetch, installWebSocketWrapper, rewriteConnectUrl, unbindConnectDial } from "./browserbase-net.js";

export { rewriteConnectUrl, browserbaseNoProxyHosts, applyBrowserbaseNoProxy } from "./browserbase-net.js";

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_RESULTS_MAX = 25;

/** The Browserbase REST surface used here. The real one is `new Browserbase({ apiKey, baseURL })`; tests inject a fake. */
export type BrowserbaseSdk = {
  sessions: {
    create(body: Record<string, any>, options?: RequestOptions): Promise<{ id: string; connectUrl: string }>;
    list(query: { q?: string; status?: string }, options?: RequestOptions): Promise<Array<{ id: string; status?: string; userMetadata?: Record<string, unknown> }>>;
    retrieve(id: string, options?: RequestOptions): Promise<{ id: string; status?: string; connectUrl?: string }>;
    update(id: string, body: { status: "REQUEST_RELEASE" }, options?: RequestOptions): Promise<unknown>;
    debug(id: string, options?: RequestOptions): Promise<{ debuggerFullscreenUrl?: string; debuggerUrl?: string; pages?: Array<{ id?: string; url?: string; title?: string; debuggerFullscreenUrl?: string }> }>;
    recording?: { downloads: { create(id: string): Promise<{ downloads?: RecordingDownload[] }>; list(id: string): Promise<{ downloads?: RecordingDownload[] }> } };
  };
  extensions: { create(body: { file: unknown }, options?: RequestOptions): Promise<{ id: string }> };
  fetchAPI: { create(body: { url: string; allowRedirects?: boolean; proxies?: boolean; format?: string }, options?: RequestOptions): Promise<any> };
  search: { web(body: { query: string; numResults?: number }, options?: RequestOptions): Promise<any> };
  /** The SDK's generic GET, for routes it has no method for (per-file downloads). */
  get(path: string, options?: RequestOptions & { query?: Record<string, unknown>; headers?: Record<string, string>; __binaryResponse?: boolean }): Promise<any>;
};
type RequestOptions = { maxRetries?: number; timeout?: number; signal?: AbortSignal };
type DownloadRow = { id: string; filename: string; size: number; createdAt?: string };
type RecordingDownload = { pageId?: string; status?: string; downloadUrl?: string };
export type BrowserbaseOptions = {
  /** BROWSERBASE_API_KEY (or BB_API_KEY), BROWSERBASE_BASE_URL and BROWSERBASE_CONNECT_BASE_URL (the credential proxy),
   *  BROWSERBASE_PROJECT_ID (a direct key only). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  client?: BrowserbaseSdk;
  /** The Stagehand extension's Browserbase id. Default: uploaded once per process. */
  extensionId?: () => Promise<string>;
  /** Prices of the calls this provider answers (fetch, search); list prices unless the host knows its plan. */
  prices?: Partial<PriceTable>;
  /** Test seam: how attach tells the browser to keep downloads (default: `setDownloadBehavior`, whose socket attach holds open until release). */
  downloadBehavior?: (dialUrl: string) => Promise<DownloadSetting | void>;
  /** How long a release waits for the provider to report the session stopped. */
  confirm?: { polls: number; intervalMs: number };
  sleep?: (ms: number) => Promise<void>;
};

/** The socket that holds `Browser.setDownloadBehavior`. The setting lasts only as long as the socket that sent it (a Chrome
 *  that got it on a socket since closed saves nothing where it said), so the socket stays open until `close()`. */
export type DownloadSetting = Pick<CdpSession, "close" | "open">;

/** Tell the browser to save downloads into `downloadPath` (default: the relative path `downloads`, Browserbase's rule for
 *  synced downloads) and keep the socket that told it open. A session created with keepAlive survives that socket closing. */
export const setDownloadBehavior = (url: string, options: { downloadPath?: string; timeoutMs?: number } = {}): Promise<DownloadSetting> =>
  cdpCall(url, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: options.downloadPath ?? "downloads", eventsEnabled: true }, options.timeoutMs);

export type BrowserbaseProvider = BrowserProvider & { readonly name: "browserbase" };

const CAPS: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: 21_600, survivesDisconnect: true, releaseIsAsync: true, extension: "uploaded-per-launch" };
const nonEmpty = (v: unknown): string => String(v ?? "").trim();
const notFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/** A proxy geolocation as Browserbase takes it: country is the ISO alpha-2 code, state a US state abbreviation, city
 *  upper-case with underscores. Without a two-letter country there is no geolocation at all, never a partial one. */
export function browserbaseGeolocation(raw: Partial<Geo> | null | undefined): Geo | null {
  const country = nonEmpty(raw?.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const out: Geo = { country };
  const state = nonEmpty(raw?.state).toUpperCase();
  if (/^[A-Z]{2}$/.test(state)) out.state = state;
  const city = nonEmpty(raw?.city).toUpperCase().replace(/[\s-]+/g, "_").replace(/[^A-Z_]/g, "");
  if (city) out.city = city;
  return out;
}

/** The `proxies` field of a session body: a geolocated Browserbase proxy when one is asked for, the plain boolean otherwise. */
export function proxiesField(proxies: SessionSpec["proxies"]): boolean | Array<Record<string, unknown>> {
  if (!proxies) return false;
  const geo = typeof proxies === "object" ? browserbaseGeolocation(proxies.geolocation) : null;
  return geo ? [{ type: "browserbase", geolocation: geo }] : true;
}

/** Metadata values are `[A-Za-z0-9._:-]` and at most 60 characters; the tag is exact (a query matches it whole). */
const metaValue = (v: string): string => String(v || "").replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 60) || "unknown";

export function sessionCreateBody(spec: SessionSpec, extra: { extensionId?: string; projectId?: string } = {}): Record<string, any> {
  const settings: Record<string, any> = {
    solveCaptchas: spec.captcha,
    viewport: spec.viewport,
    ...(spec.verified ? { verified: true } : {}),
    ...(spec.contextId ? { context: { id: spec.contextId, persist: true } } : {}),
    ...(spec.navigation?.allow?.length ? { allowedDomains: spec.navigation.allow } : {}),
  };
  const userMetadata = Object.fromEntries(Object.entries(spec.metadata).map(([k, v]) => [k, metaValue(v)]));
  return {
    proxies: proxiesField(spec.proxies),
    timeout: spec.maxLifetimeS,
    // Without keepAlive Browserbase ends a session when any CDP client disconnects, so a crash, a second client or a closed
    // observer would cost the session; with it only an explicit release (or the timeout) does.
    keepAlive: true,
    browserSettings: settings,
    userMetadata: { ...userMetadata, agentrun_tag: spec.tag },
    ...(spec.region ? { region: spec.region } : {}),
    ...(extra.extensionId ? { extensionId: extra.extensionId } : {}),
    ...(extra.projectId ? { projectId: extra.projectId } : {}),
  };
}

/** The Stagehand extension archive that ships with the installed Stagehand. */
function extensionArchive(): string {
  return nonEmpty(process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH) || path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "assets", "stagehand-extension.zip");
}

/** What this process holds for the sessions it created or attached, by account and session id. Module-level, not per provider: a host
 *  may build a fresh provider for the release (custody does), and release must still reach the socket and the binding. */
const connectUrls = new Map<string, string>(); // never written anywhere: the URL carries a signing key
const settings = new Map<string, DownloadSetting>(); // the sockets holding each session's download setting
const opening = new Map<string, Promise<void>>(); // a setting being opened, so concurrent attaches share one socket
const endSetting = (id: string) => { settings.get(id)?.close(); settings.delete(id); };
const forget = (id: string) => { const url = connectUrls.get(id); if (url) unbindConnectDial(url); connectUrls.delete(id); };

const uploads = new Map<string, Promise<string>>();

export function browserbaseProvider(options: BrowserbaseOptions = {}): BrowserbaseProvider {
  const env = options.env ?? process.env;
  const apiKey = nonEmpty(env.BROWSERBASE_API_KEY) || nonEmpty(env.BB_API_KEY);
  const baseUrl = nonEmpty(env.BROWSERBASE_BASE_URL) || undefined;
  const connectBase = nonEmpty(env.BROWSERBASE_CONNECT_BASE_URL) || null;
  // The same account (base URL and key) shares one view of its sessions across provider instances.
  const account = `${baseUrl ?? ""}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
  const held = (id: string) => `${account}|${id}`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const confirm = options.confirm ?? { polls: 6, intervalMs: 500 };
  const prices = resolvePrices(options.prices);

  let sdk: Promise<BrowserbaseSdk> | null = null;
  const client = () => (sdk ??= options.client ? Promise.resolve(options.client) : (async () => {
    applyBrowserbaseNoProxy(env);
    const mod: any = await import(["@browserbasehq", "sdk"].join("/"));
    const Browserbase = mod.default ?? mod.Browserbase;
    const fetch = await directFetch();
    return new Browserbase({ apiKey, baseURL: baseUrl, ...(fetch ? { fetch } : {}) }) as BrowserbaseSdk;
  })());

  /** One upload per process and account: a failed upload is forgotten so the next create tries again. */
  const extension = (): Promise<string> => {
    if (options.extensionId) return options.extensionId();
    let up = uploads.get(account);
    if (!up) {
      up = (async () => (await (await client()).extensions.create({ file: createReadStream(extensionArchive()) }, { maxRetries: 0 })).id)();
      uploads.set(account, up);
      up.catch(() => uploads.delete(account));
    }
    return up;
  };

  /** Every download row of a session, across pages. */
  const rows = async (sessionId: string): Promise<DownloadRow[]> => {
    const all: DownloadRow[] = [];
    for (let offset = 0; ; ) {
      const page = await (await client()).get("/v1/downloads", { query: { sessionId, limit: 100, offset } });
      const got: DownloadRow[] = Array.isArray(page?.downloads) ? page.downloads : [];
      all.push(...got);
      offset += got.length;
      if (!got.length || offset >= Number(page?.total ?? 0)) return all;
    }
  };

  const status = async (ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus> => {
    try {
      const found = await (await client()).sessions.retrieve(ref.id, { signal, timeout: 5_000 });
      return found.status === "RUNNING" ? "running" : found.status === "PENDING" ? "pending" : "stopped";
    } catch (error) {
      if (notFound(error)) return "gone";
      throw error;
    }
  };

  return {
    name: "browserbase",
    caps: CAPS,

    async create(spec, signal) {
      const projectId = nonEmpty(env.BROWSERBASE_PROJECT_ID);
      // Behind the credential proxy the project is inferred from the injected key and must never be named; a direct key
      // has no proxy and must name it.
      const body = sessionCreateBody(spec, { extensionId: await extension(), ...(projectId && !baseUrl && !connectBase ? { projectId } : {}) });
      // At most once: an SDK retry of a create the server already served would open a second paid browser.
      const created = await (await client()).sessions.create(body, { maxRetries: 0, signal });
      connectUrls.set(held(created.id), created.connectUrl);
      return { id: created.id, tag: spec.tag };
    },

    async findByTag(tag, signal) {
      if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("a session tag is [A-Za-z0-9_.-]");
      // `q` alone makes Browserbase answer 504 after 75 s; with a status it answers in about 150 ms. A create whose answer was
      // lost may have left the session PENDING, and it still bills once it runs, so both statuses are asked (never none).
      const q = `user_metadata['agentrun_tag']:'${tag}'`;
      const asked = await Promise.all(["RUNNING", "PENDING"].map(async (status) => (await client()).sessions.list({ status, q }, { signal })));
      // The query is the provider's; the match is ours: a lane that ignores `q` must never hand back someone else's session.
      // Both queries must answer: custody reads this as the complete set (it releases exactly these ids), so a failed status
      // throws instead of returning what the other found.
      const seen = new Set<string>();
      return asked.flat().filter((r) => r.userMetadata?.agentrun_tag === tag && !seen.has(r.id) && seen.add(r.id)).map((r) => ({ id: r.id, tag }));
    },

    status,

    async attach(ref, signal): Promise<AttachTarget> {
      let url = connectUrls.get(held(ref.id));
      if (!url) {
        url = (await (await client()).sessions.retrieve(ref.id, { signal })).connectUrl;
        if (!url) throw new Error("Browserbase session is not available for connection");
        connectUrls.set(held(ref.id), url);
      }
      // The driver keeps the raw URL (the extension in the cloud browser dials it back); only this process's socket is rewritten.
      // No `extensionId`: the extension rides the create. Live (S4), connect given Browserbase's upload id waited 60 s for a
      // service worker that never came; Stagehand's in-browser extension id on Browserbase has not been tried.
      // The target is bound to this session's URL, not to the process: another provider's sockets keep their own proxy.
      bindConnectDial(url, connectBase);
      installWebSocketWrapper();
      const dial = connectBase ? rewriteConnectUrl(url, connectBase) : url;
      // Browserbase syncs a download only when the browser was told to save into `downloads`, and the telling lasts as long as
      // its socket (live, S4 session 7), so one socket per session is held until release; a failure costs the files, not the session.
      const key = held(ref.id);
      if (!settings.get(key)?.open) {
        let pending = opening.get(key);
        if (!pending) {
          pending = (async () => { const setting = await (options.downloadBehavior ?? setDownloadBehavior)(dial).catch(() => undefined); if (setting) settings.set(key, setting); })().finally(() => opening.delete(key));
          opening.set(key, pending);
        }
        await pending;
      }
      return { sdkCdpUrl: url, ...(connectBase ? { dial: { url: dial } } : {}) };
    },

    async release(ref, signal) {
      await opening.get(held(ref.id)); // a socket still being opened is closed too, not left behind
      endSetting(held(ref.id));
      let failure: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { await (await client()).sessions.update(ref.id, { status: "REQUEST_RELEASE" }, { maxRetries: 0, signal }); failure = undefined; break; }
        catch (error) { if (notFound(error)) return void forget(held(ref.id)); failure = error; }
      }
      // The request is asynchronous: released means the provider says the session is no longer running.
      for (let poll = 0; ; poll += 1) {
        const now = await status(ref, signal);
        if (now !== "running" && now !== "pending") return void forget(held(ref.id));
        if (poll >= confirm.polls) throw failure ?? new Error(`Browserbase session ${ref.id} still running after a release request`);
        await sleep(confirm.intervalMs);
      }
    },

    async liveView(ref): Promise<LiveView | null> {
      try {
        const live = await (await client()).sessions.debug(ref.id);
        return {
          fullscreen: live.debuggerFullscreenUrl ?? null,
          framed: live.debuggerUrl ?? null,
          pages: (live.pages ?? []).map((p) => ({ id: p.id ?? null, url: p.url ?? null, title: p.title ?? null, fullscreen: p.debuggerFullscreenUrl ?? null })),
        };
      } catch { return null; } // a convenience: the session works without it
    },

    downloads: {
      // Per-file downloads (`/v1/downloads`): Browserbase suffixes each name with a timestamp, so a name is unique in a session.
      async list(ref): Promise<RemoteFile[]> {
        return (await rows(ref.id)).map((d) => ({ name: d.filename, sizeBytes: d.size, modifiedAt: d.createdAt ?? null }));
      },
      async read(ref, name, maxBytes) {
        const row = (await rows(ref.id)).find((d) => d.filename === name);
        if (!row) throw new Error(`no download ${name} for session ${ref.id}`);
        const response = await (await client()).get(`/v1/downloads/${encodeURIComponent(row.id)}`, { headers: { Accept: "application/octet-stream" }, __binaryResponse: true });
        if (!response?.body) throw new Error("the download came back empty");
        return (async function* () {
          let total = 0;
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            total += chunk.byteLength;
            if (total > maxBytes) throw new Error(`larger than the ${maxBytes}-byte limit`);
            yield chunk;
          }
        })();
      },
    },

    recordings: {
      // One entry per rendered tab MP4 of an ended session; asking renders them, so a caller polls `list` until it fills.
      async list(ref): Promise<Recording[]> {
        const rec = (await client()).sessions.recording?.downloads;
        if (!rec) return [];
        let downloads = (await rec.list(ref.id)).downloads ?? [];
        if (!downloads.length || downloads.some((d) => d.status === "NOT_REQUESTED")) downloads = (await rec.create(ref.id)).downloads ?? downloads;
        return downloads.filter((d) => d.status === "COMPLETED" && d.downloadUrl).map((d) => ({ id: String(d.pageId), startedAt: null, durationS: null }));
      },
      async open(ref, id) {
        const rec = (await client()).sessions.recording?.downloads;
        const found = (await rec?.list(ref.id))?.downloads?.find((d) => String(d.pageId) === id && d.status === "COMPLETED" && d.downloadUrl);
        if (!found?.downloadUrl) throw new Error(`no rendered recording ${id} for session ${ref.id}`);
        const response = await ((await directFetch()) ?? fetch)(found.downloadUrl);
        if (!response.ok || !response.body) throw new Error(`recording download answered ${response.status}`);
        return response.body as ReadableStream<Uint8Array>;
      },
    },

    async fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
      signal?.throwIfAborted();
      const result = await untilAborted((async () => (await client()).fetchAPI.create({ url: request.url, proxies: request.proxies, allowRedirects: true, format: request.format }, { signal }))(), signal);
      // The Fetch API reports no final URL (its response is id, content, contentType, encoding, headers, statusCode).
      return { finalUrl: null, statusCode: Number(result?.statusCode) || null, contentType: typeof result?.contentType === "string" ? result.contentType : null, content: contentText(result?.content), usage: fetchUsage(prices, request.proxies) };
    },

    async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
      signal?.throwIfAborted();
      // The facade validates strictly (query 1 to 200 characters, 1 to 25 results): clamp, so a long query degrades and never throws.
      const query = request.query.slice(0, SEARCH_QUERY_MAX);
      const numResults = Math.max(1, Math.min(SEARCH_RESULTS_MAX, Math.floor(request.n) || 10));
      const result = await untilAborted((async () => (await client()).search.web({ query, numResults }, { signal }))(), signal);
      const rows: any[] = Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : [];
      return { results: rows.filter((r) => typeof r?.url === "string").map((r) => ({ url: r.url, title: r.title ?? null, author: r.author ?? null, published: r.publishedDate ?? r.published ?? null })), usage: searchUsage(prices) };
    },
  };
}

/** The call's result unless `signal` fires first. The facade's fetch and search take no signal, so a cancelled call cannot be
 *  stopped, but its late result must never be returned as if the job still wanted it. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n");
  return content && typeof content === "object" ? JSON.stringify(content) : "";
}
