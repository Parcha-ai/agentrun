// Credentials come from the host's env and live in this module's memory only: a ref is `{ id, tag }`, and the connect
// URL (it carries a signing key) is held here, found again by `retrieve` after a restart.
import { createReadStream } from "node:fs";
import { fetchUsage, resolvePrices, searchUsage } from "../core/usage.js";
import type { AttachTarget, BrowserProvider, FetchRequest, FetchResult, Geo, LiveView, PriceTable, ProviderCaps, Recording, RemoteFile, SearchRequest, SearchResult, SessionSpec } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { cdpCall, type CdpSession } from "./cdp-call.js";
import { applyBrowserbaseNoProxy, bindConnectDial, installWebSocketWrapper, rewriteConnectUrl, unbindConnectDial } from "./browserbase-net.js";
import { directFetch } from "./http.js";
import { accountKey, assertTag, browserbaseHoldings, defaultSleep, DEFAULT_CONFIRM, extensionArchive, nonEmpty, releaseAndConfirm, tagValue, untilAborted, uploadOnce } from "./shared.js";

export { rewriteConnectUrl, browserbaseNoProxyHosts, applyBrowserbaseNoProxy } from "./browserbase-net.js";

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_RESULTS_MAX = 25;

export type BrowserbaseSdk = {
  sessions: {
    create(body: BrowserbaseSessionBody, options?: RequestOptions): Promise<{ id: string; connectUrl: string }>;
    list(query: { q?: string; status?: string }, options?: RequestOptions): Promise<Array<{ id: string; status?: string; userMetadata?: Record<string, unknown> }>>;
    retrieve(id: string, options?: RequestOptions): Promise<{ id: string; status?: string; connectUrl?: string }>;
    update(id: string, body: { status: "REQUEST_RELEASE" }, options?: RequestOptions): Promise<unknown>;
    debug(id: string, options?: RequestOptions): Promise<{ debuggerFullscreenUrl?: string; debuggerUrl?: string; pages?: Array<{ id?: string; url?: string; title?: string; debuggerFullscreenUrl?: string }> }>;
    recording?: { downloads: { create(id: string): Promise<{ downloads?: RecordingDownload[] }>; list(id: string): Promise<{ downloads?: RecordingDownload[] }> } };
  };
  extensions: { create(body: { file: unknown }, options?: RequestOptions): Promise<{ id: string }> };
  fetchAPI: { create(body: { url: string; allowRedirects?: boolean; proxies?: boolean; format?: string }, options?: RequestOptions): Promise<FetchApiResult> };
  search: { web(body: { query: string; numResults?: number }, options?: RequestOptions): Promise<SearchApiResult> };
  get<T = unknown>(path: string, options?: RequestOptions & { query?: Record<string, unknown>; headers?: Record<string, string>; __binaryResponse?: boolean }): Promise<T>;
};
type FetchApiResult = { statusCode?: unknown; contentType?: unknown; content?: unknown } | null | undefined;
type SearchRow = { url?: unknown; title?: string | null; author?: string | null; publishedDate?: string | null; published?: string | null };
type SearchApiResult = { results?: SearchRow[] } | null | undefined;
type BrowserbaseSessionBody = {
  proxies: boolean | Array<Record<string, unknown>>;
  timeout: number;
  keepAlive: boolean;
  browserSettings: { solveCaptchas: boolean; viewport: SessionSpec["viewport"]; verified?: boolean; context?: { id: string; persist: boolean }; allowedDomains?: string[] };
  userMetadata: Record<string, string>;
  region?: string;
  extensionId?: string;
  projectId?: string;
};
type BrowserbaseConstructor = new (options: { apiKey: string; baseURL?: string; fetch?: unknown }) => BrowserbaseSdk;
type RequestOptions = { maxRetries?: number; timeout?: number; signal?: AbortSignal };
type DownloadRow = { id: string; filename: string; size: number; createdAt?: string };
type RecordingDownload = { pageId?: string; status?: string; downloadUrl?: string };
export type BrowserbaseOptions = {
  /** Reads BROWSERBASE_API_KEY (or BB_API_KEY), _BASE_URL, _CONNECT_BASE_URL, _PROJECT_ID. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  client?: BrowserbaseSdk;
  /** The Stagehand extension's Browserbase id. Default: uploaded once per process. */
  extensionId?: () => Promise<string>;
  prices?: Partial<PriceTable>;
  downloadBehavior?: (dialUrl: string) => Promise<DownloadSetting | void>;
  confirm?: { polls: number; intervalMs: number };
  sleep?: (ms: number) => Promise<void>;
};

/** `Browser.setDownloadBehavior` lasts only as long as the socket that sent it, so the socket stays open until
 *  `close()`. */
export type DownloadSetting = Pick<CdpSession, "close" | "open">;

/** Into `downloadPath` (default `downloads`, Browserbase's synced-downloads rule); the socket stays open. */
export const setDownloadBehavior = (url: string, options: { downloadPath?: string; timeoutMs?: number } = {}): Promise<DownloadSetting> =>
  cdpCall(url, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: options.downloadPath ?? "downloads", eventsEnabled: true }, options.timeoutMs);

export type BrowserbaseProvider = BrowserProvider & { readonly name: "browserbase" };

const CAPS: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: 21_600, survivesDisconnect: true, releaseIsAsync: true, extension: "uploaded-per-launch" };
const notFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/** ISO alpha-2 country, US state abbreviation, upper-case city; no two-letter country, no geolocation. */
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

export function proxiesField(proxies: SessionSpec["proxies"]): boolean | Array<Record<string, unknown>> {
  if (!proxies) return false;
  const geo = typeof proxies === "object" ? browserbaseGeolocation(proxies.geolocation) : null;
  return geo ? [{ type: "browserbase", geolocation: geo }] : true;
}

export function sessionCreateBody(spec: SessionSpec, extra: { extensionId?: string; projectId?: string } = {}): BrowserbaseSessionBody {
  const settings: BrowserbaseSessionBody["browserSettings"] = {
    solveCaptchas: spec.captcha,
    viewport: spec.viewport,
    ...(spec.verified ? { verified: true } : {}),
    ...(spec.contextId ? { context: { id: spec.contextId, persist: true } } : {}),
    ...(spec.navigation?.allow?.length ? { allowedDomains: spec.navigation.allow } : {}),
  };
  const userMetadata = Object.fromEntries(Object.entries(spec.metadata).map(([k, v]) => [k, tagValue(v)]));
  return {
    proxies: proxiesField(spec.proxies),
    timeout: spec.maxLifetimeS,
    // Without keepAlive Browserbase ends a session when any CDP client disconnects (a crash, a second client, a closed
    // observer); with it only an explicit release or the timeout does.
    keepAlive: true,
    browserSettings: settings,
    userMetadata: { ...userMetadata, agentrun_tag: spec.tag },
    ...(spec.region ? { region: spec.region } : {}),
    ...(extra.extensionId ? { extensionId: extra.extensionId } : {}),
    ...(extra.projectId ? { projectId: extra.projectId } : {}),
  };
}

const { connectUrls, settings, opening, uploads } = browserbaseHoldings;
const endSetting = (id: string) => { settings.get(id)?.close(); settings.delete(id); };
const forget = (id: string) => { const url = connectUrls.get(id); if (url) unbindConnectDial(url); connectUrls.delete(id); };

export function browserbaseProvider(options: BrowserbaseOptions = {}): BrowserbaseProvider {
  const env = options.env ?? process.env;
  const apiKey = nonEmpty(env.BROWSERBASE_API_KEY) || nonEmpty(env.BB_API_KEY);
  const baseUrl = nonEmpty(env.BROWSERBASE_BASE_URL) || undefined;
  const connectBase = nonEmpty(env.BROWSERBASE_CONNECT_BASE_URL) || null;
  const account = accountKey(baseUrl ?? "", apiKey);
  const held = (id: string) => `${account}|${id}`;
  const sleep = options.sleep ?? defaultSleep;
  const confirm = options.confirm ?? DEFAULT_CONFIRM;
  const prices = resolvePrices(options.prices);

  let sdk: Promise<BrowserbaseSdk> | null = null;
  const client = () => (sdk ??= options.client ? Promise.resolve(options.client) : (async () => {
    applyBrowserbaseNoProxy(env);
    const mod: { default: BrowserbaseConstructor; Browserbase: BrowserbaseConstructor } = await import(["@browserbasehq", "sdk"].join("/"));
    const Browserbase = mod.default ?? mod.Browserbase;
    const fetch = await directFetch();
    return new Browserbase({ apiKey, baseURL: baseUrl, ...(fetch ? { fetch } : {}) });
  })());

  const extension = (): Promise<string> => options.extensionId
    ? options.extensionId()
    : uploadOnce(uploads, account, async () => (await (await client()).extensions.create({ file: createReadStream(extensionArchive()) }, { maxRetries: 0 })).id);

  const rows = async (sessionId: string): Promise<DownloadRow[]> => {
    const all: DownloadRow[] = [];
    for (let offset = 0; ; ) {
      const page = await (await client()).get<{ downloads?: DownloadRow[]; total?: number } | null>("/v1/downloads", { query: { sessionId, limit: 100, offset } });
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
      // must name it.
      const body = sessionCreateBody(spec, { extensionId: await extension(), ...(projectId && !baseUrl && !connectBase ? { projectId } : {}) });
      // At most once: an SDK retry of a create the server already served would open a second paid browser.
      const created = await (await client()).sessions.create(body, { maxRetries: 0, signal });
      connectUrls.set(held(created.id), created.connectUrl);
      return { id: created.id, tag: spec.tag };
    },

    async findByTag(tag, signal) {
      assertTag(tag);
      // `q` alone makes Browserbase answer 504 after 75 s; with a status it answers in about 150 ms. A create whose
      // answer was lost may have left the session PENDING, which still bills once it runs, so both statuses are asked.
      const q = `user_metadata['agentrun_tag']:'${tag}'`;
      const asked = await Promise.all(["RUNNING", "PENDING"].map(async (status) => (await client()).sessions.list({ status, q }, { signal })));
      // The query is the provider's, the match is ours: a lane that ignores `q` must never hand back someone else's
      // session. Both queries must answer: custody releases exactly these ids, so a failed status throws.
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
      // No `extensionId` on connect: the extension rides the create (given the upload id, connect waited 60 s for a
      // worker that never came).
      bindConnectDial(url, connectBase);
      if (connectBase) installWebSocketWrapper();
      const dial = connectBase ? rewriteConnectUrl(url, connectBase) : url;
      // Browserbase syncs a download only when the browser was told to save into `downloads`, which lasts as long as
      // that socket: one socket per session is held until release. A failure costs the files, not the session.
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
      await opening.get(held(ref.id));
      endSetting(held(ref.id));
      await releaseAndConfirm({
        request: async () => {
          try { await (await client()).sessions.update(ref.id, { status: "REQUEST_RELEASE" }, { maxRetries: 0, signal }); }
          catch (error) { if (notFound(error)) return "gone"; throw error; }
        },
        status: () => status(ref, signal),
        forget: () => forget(held(ref.id)),
        confirm,
        sleep,
        stillRunning: `Browserbase session ${ref.id} still running after a release request`,
      });
    },

    async liveView(ref): Promise<LiveView | null> {
      try {
        const live = await (await client()).sessions.debug(ref.id);
        return {
          fullscreen: live.debuggerFullscreenUrl ?? null,
          framed: live.debuggerUrl ?? null,
          pages: (live.pages ?? []).map((p) => ({ id: p.id ?? null, url: p.url ?? null, title: p.title ?? null, fullscreen: p.debuggerFullscreenUrl ?? null })),
        };
      } catch { return null; }
    },

    downloads: {
      // Browserbase suffixes each name with a timestamp, so a name is unique in a session.
      async list(ref): Promise<RemoteFile[]> {
        return (await rows(ref.id)).map((d) => ({ name: d.filename, sizeBytes: d.size, modifiedAt: d.createdAt ?? null }));
      },
      async read(ref, name, maxBytes) {
        const row = (await rows(ref.id)).find((d) => d.filename === name);
        if (!row) throw new Error(`no download ${name} for session ${ref.id}`);
        const response = await (await client()).get<{ body?: AsyncIterable<Uint8Array> } | null>(`/v1/downloads/${encodeURIComponent(row.id)}`, { headers: { Accept: "application/octet-stream" }, __binaryResponse: true });
        if (!response?.body) throw new Error("the download came back empty");
        return (async function* () {
          let total = 0;
          for await (const chunk of response.body!) {
            total += chunk.byteLength;
            if (total > maxBytes) throw new Error(`larger than the ${maxBytes}-byte limit`);
            yield chunk;
          }
        })();
      },
    },

    recordings: {
      // One entry per rendered tab MP4 of an ended session; asking renders them, so a caller polls `list` until it
      // fills.
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
      // The Fetch API reports no final URL.
      return { finalUrl: null, statusCode: Number(result?.statusCode) || null, contentType: typeof result?.contentType === "string" ? result.contentType : null, content: contentText(result?.content), usage: fetchUsage(prices, request.proxies) };
    },

    async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
      signal?.throwIfAborted();
      // The facade validates strictly (query 1 to 200 characters, 1 to 25 results): clamp, so a long query degrades and
      // never throws.
      const query = request.query.slice(0, SEARCH_QUERY_MAX);
      const numResults = Math.max(1, Math.min(SEARCH_RESULTS_MAX, Math.floor(request.n) || 10));
      const result = await untilAborted((async () => (await client()).search.web({ query, numResults }, { signal }))(), signal);
      const rows: SearchRow[] = Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : [];
      return { results: rows.filter((r): r is SearchRow & { url: string } => typeof r?.url === "string").map((r) => ({ url: r.url, title: r.title ?? null, author: r.author ?? null, published: r.publishedDate ?? r.published ?? null })), usage: searchUsage(prices) };
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: unknown) => (typeof c === "string" ? c : typeof (c as { text?: unknown } | null)?.text === "string" ? (c as { text: string }).text : JSON.stringify(c))).join("\n");
  return content && typeof content === "object" ? JSON.stringify(content) : "";
}
