// The key lives in this module's memory only, and the CDP URL (it carries Kernel's token) is held here, never in a ref.
// No error carries the key, the URL or Kernel's text: only the call, the status and the code.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AttachTarget, BrowserProvider, LiveView, ProviderCaps, SessionSpec } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { directFetch } from "./http.js";
import { accountKey, assertTag, defaultSleep, DEFAULT_CONFIRM, extensionArchive, kernelHoldings, nonEmpty, releaseAndConfirm, tagValue, untilAborted, uploadOnce } from "./shared.js";

export const KERNEL_BASE_URL = "https://api.onkernel.com";
export const KERNEL_IDLE_MIN_S = 10;
export const KERNEL_IDLE_MAX_S = 259_200;

type KernelRow = { session_id?: unknown; cdp_ws_url?: unknown; browser_live_view_url?: unknown; deleted_at?: unknown; tags?: { agentrun_tag?: unknown }; checksum?: unknown; name?: unknown; id?: unknown; code?: unknown };
type HttpFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; signal?: AbortSignal }) => Promise<Response>;
export type KernelOptions = {
  /** KERNEL_API_KEY and KERNEL_BASE_URL (default https://api.onkernel.com). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Kernel's stealth mode, which also turns on its CAPTCHA solver and its stealth proxy. Default false. */
  stealth?: boolean;
  headless?: boolean;
  /** Default: one stored with the same bytes, else uploaded once per process and account. */
  extension?: () => Promise<KernelExtensionRef>;
  confirm?: { polls: number; intervalMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** Default: a direct undici Agent that never uses HTTP(S)_PROXY; a host behind a proxy passes its own. */
  fetch?: HttpFetch;
};

export type KernelProvider = BrowserProvider & { readonly name: "kernel" };
export type KernelExtensionRef = { id: string } | { name: string };

// Kernel ends a session after `timeout_seconds` with no CDP or live-view connection and sets no wall-clock limit, so
// the lifetime cap is its largest idle timeout.
const CAPS: ProviderCaps = { timeoutModel: "inactivity", maxLifetimeS: KERNEL_IDLE_MAX_S, survivesDisconnect: true, releaseIsAsync: false, extension: "uploaded-per-launch" };

/** The call and the HTTP status, plus Kernel's error code when it is a plain identifier. Kernel's message is never
 *  copied: an echo of the request could carry the key or a URL. */
export class KernelError extends Error {
  readonly status: number | undefined;
  constructor(call: string, status: number | undefined, code?: string, options?: { cause?: unknown }) {
    super(status === undefined ? `Kernel ${call} could not be reached` : `Kernel ${call} answered ${status}${code ? ` (${code})` : ""}`, options);
    this.name = "KernelError";
    this.status = status;
  }
}
const CODE = /^[a-z][a-z_.-]{0,47}$/i;

export function kernelCreateBody(spec: SessionSpec, options: { stealth?: boolean; headless?: boolean; extension?: KernelExtensionRef } = {}): Record<string, unknown> {
  const tags = Object.fromEntries(Object.entries(spec.metadata).map(([k, v]) => [k, tagValue(v)]));
  return {
    headless: options.headless ?? false,
    stealth: options.stealth ?? false,
    // Explicit, never Kernel's default (60 s): a crashed host's browser stops costing money on its own while custody's
    // release is pending.
    timeout_seconds: Math.min(KERNEL_IDLE_MAX_S, Math.max(KERNEL_IDLE_MIN_S, Math.round(spec.idleTimeoutS) || KERNEL_IDLE_MIN_S)),
    viewport: { width: spec.viewport.width, height: spec.viewport.height },
    tags: { ...tags, agentrun_tag: spec.tag },
    ...(options.extension ? { extensions: [options.extension] } : {}),
  };
}

const { cdpUrls, liveUrls, uploads } = kernelHoldings;

export function kernelProvider(options: KernelOptions = {}): KernelProvider {
  const env = options.env ?? process.env;
  const apiKey = nonEmpty(env.KERNEL_API_KEY);
  const baseUrl = (nonEmpty(env.KERNEL_BASE_URL) || KERNEL_BASE_URL).replace(/\/+$/, "");
  const account = accountKey(baseUrl, apiKey);
  const held = (id: string) => `${account}|${id}`;
  const sleep = options.sleep ?? defaultSleep;
  const confirm = options.confirm ?? DEFAULT_CONFIRM;
  let client: Promise<HttpFetch> | null = null;
  const http = () => (client ??= options.fetch ? Promise.resolve(options.fetch) : directFetch().then((f) => (f ?? fetch) as HttpFetch));

  /** One request, never retried: a create served twice would be a second paid browser. On failure only Kernel's `code`
   *  survives; a transport failure keeps its cause chain under a message that names the call alone. */
  async function call<T = KernelRow>(method: string, route: string, init: { body?: unknown; query?: URLSearchParams; signal?: AbortSignal; raw?: { body: Uint8Array; type: string } } = {}): Promise<{ status: number; json: T | null; headers: Headers }> {
    if (!apiKey) throw new Error("the kernel provider needs KERNEL_API_KEY in the env it is given; none is set");
    const name = `${method} ${route.replace(/\/browsers\/[^/?]+/, "/browsers/{id}").replace(/\/extensions\/[^/?]+/, "/extensions/{name}")}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
    let body: Uint8Array | string | undefined;
    if (init.raw) { headers["Content-Type"] = init.raw.type; body = init.raw.body; }
    else if (init.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.body); }
    let response: Response;
    try {
      const query = init.query?.toString();
      response = await (await http())(`${baseUrl}${route}${query ? `?${query}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}), ...(init.signal ? { signal: init.signal } : {}) });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") throw error;
      throw new KernelError(name, undefined, undefined, { cause: error });
    }
    // A success must be read whole: a body that breaks off or is not JSON is a failure, never an empty answer (an empty
    // session list would let a release finish without deleting).
    let text = "";
    try { text = await response.text(); } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") throw error;
      if (response.ok) throw new KernelError(name, response.status, "unreadable_body", { cause: error });
    }
    let json: T | null = null;
    try { json = text ? JSON.parse(text) : null; } catch { if (response.ok) throw new KernelError(name, response.status, "not_json"); }
    if (!response.ok && response.status !== 404) throw new KernelError(name, response.status, typeof (json as KernelRow | null)?.code === "string" && CODE.test((json as { code: string }).code) ? (json as { code: string }).code : undefined);
    return { status: response.status, json, headers: response.headers };
  }

  /** Null only when the whole list was read and none matches: a list cut short is a failure, since a missed copy means
   *  a refused upload or a duplicate. */
  const storedWith = async (sha: string): Promise<KernelExtensionRef | null> => {
    for (let offset = 0, pages = 0; pages < 100; pages += 1) {
      const page = await call<KernelRow[]>("GET", "/extensions", { query: new URLSearchParams({ limit: "100", offset: String(offset) }) });
      if (!Array.isArray(page.json)) throw new KernelError("GET /extensions", page.status, "not_a_list");
      const found = page.json.find((e) => e?.checksum === sha);
      if (found) return nonEmpty(found.name) ? { name: nonEmpty(found.name) } : { id: nonEmpty(found.id) };
      if (page.headers.get("x-has-more") !== "true") return null;
      const next = Number(page.headers.get("x-next-offset"));
      if (!Number.isInteger(next) || next <= offset) throw new KernelError("GET /extensions", page.status, "no_next_offset");
      offset = next;
    }
    throw new Error("Kernel kept answering more pages of stored extensions");
  };

  /** A stored extension with the same bytes serves whatever its name (a plan may store only one, perhaps another
   *  tool's); otherwise one upload per process and account, named by its SHA-256, and a failed one is forgotten. */
  const extension = (): Promise<KernelExtensionRef> => options.extension ? options.extension() : uploadOnce(uploads, account, async () => {
    const zip = await readFile(extensionArchive());
    const sha = createHash("sha256").update(zip).digest("hex");
    const stored = await storedWith(sha);
    if (stored) return stored;
    const name = `agentrun-stagehand-${sha.slice(0, 16)}`;
    const boundary = `agentrun-${randomUUID()}`;
    const part = (headers: string) => Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`);
    const body = Buffer.concat([
      part(`Content-Disposition: form-data; name="name"`), Buffer.from(`${name}\r\n`),
      part(`Content-Disposition: form-data; name="file"; filename="stagehand-extension.zip"\r\nContent-Type: application/zip`), zip, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    try {
      const done = await call("POST", "/extensions", { raw: { body, type: `multipart/form-data; boundary=${boundary}` } });
      if (done.status === 404) throw new KernelError("POST /extensions", 404);
    } catch (error) {
      // Another process stored the same archive meanwhile: that copy serves.
      const raced = (error as KernelError).status === 409 ? await storedWith(sha) : null;
      if (raced) return raced;
      throw error;
    }
    return { name };
  });

  const lookup = async (id: string, signal?: AbortSignal) => call("GET", `/browsers/${encodeURIComponent(id)}`, { signal });
  const forget = (id: string) => { cdpUrls.delete(held(id)); liveUrls.delete(held(id)); };
  const status = async (ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus> => {
    const found = await lookup(ref.id, signal);
    const state = found.status === 404 ? "gone" : found.json?.deleted_at ? "stopped" : "running";
    if (state !== "running") forget(ref.id);
    return state;
  };

  return {
    name: "kernel",
    caps: CAPS,

    async create(spec, signal) {
      // The upload is shared by every create on the account: a cancelled caller stops waiting, the upload goes on for
      // the rest.
      signal?.throwIfAborted();
      const body = kernelCreateBody(spec, { stealth: options.stealth, headless: options.headless, extension: await untilAborted(extension(), signal) });
      // At most once: a lost answer is found again by its tag (findByTag), never by a second create.
      const created = await call("POST", "/browsers", { body, signal });
      const id = nonEmpty(created.json?.session_id);
      const url = nonEmpty(created.json?.cdp_ws_url);
      if (created.status === 404 || !id || !url) throw new KernelError("POST /browsers", created.status, "no_session");
      cdpUrls.set(held(id), url);
      const live = nonEmpty(created.json?.browser_live_view_url);
      if (live) liveUrls.set(held(id), live);
      return { id, tag: spec.tag };
    },

    async findByTag(tag, signal) {
      assertTag(tag);
      // The filter is Kernel's, the match is ours: a lane that ignores it must never hand back someone else's session.
      // Every page must answer: custody releases exactly these ids, so a failed page throws.
      const out: LeaseRef[] = [];
      const seen = new Set<string>();
      for (let offset = 0, pages = 0; pages < 100; pages += 1) {
        const query = new URLSearchParams({ status: "active", [`tags[agentrun_tag]`]: tag, limit: "100", offset: String(offset) });
        const page = await call<KernelRow[]>("GET", "/browsers", { query, signal });
        // A list is never "not found": a 404 here is a wrong base URL, and an empty answer would orphan the tag's
        // sessions.
        if (page.status === 404) throw new KernelError("GET /browsers", 404);
        if (!Array.isArray(page.json)) throw new KernelError("GET /browsers", page.status, "not_a_list");
        const rows = page.json;
        for (const row of rows) {
          const id = nonEmpty(row?.session_id);
          if (id && row?.tags?.agentrun_tag === tag && !row?.deleted_at && !seen.has(id)) { seen.add(id); out.push({ id, tag }); }
        }
        // Kernel pages by headers: X-Has-More, and X-Next-Offset as the next page's absolute start.
        if (page.headers.get("x-has-more") !== "true") return out;
        // More pages with no usable next offset would truncate the set custody releases: a failure, never a partial
        // answer.
        const next = Number(page.headers.get("x-next-offset"));
        if (!Number.isInteger(next) || next <= offset) throw new Error("Kernel reported more sessions for the tag without the next page's offset");
        offset = next;
      }
      throw new Error("Kernel kept answering more pages of sessions for one tag");
    },

    status,

    async attach(ref, signal): Promise<AttachTarget> {
      let url = cdpUrls.get(held(ref.id));
      if (!url) {
        const found = await lookup(ref.id, signal);
        url = found.status === 404 || found.json?.deleted_at ? "" : nonEmpty(found.json?.cdp_ws_url);
        if (!url) throw new Error("Kernel session is not available for connection");
        cdpUrls.set(held(ref.id), url);
      }
      return { sdkCdpUrl: url };
    },

    async liveView(ref): Promise<LiveView | null> {
      try {
        let url = liveUrls.get(held(ref.id));
        if (!url) {
          const found = await lookup(ref.id);
          url = found.status === 404 || found.json?.deleted_at ? "" : nonEmpty(found.json?.browser_live_view_url);
        }
        return url ? { fullscreen: url, framed: null, pages: [] } : null;
      } catch { return null; }
    },

    async release(ref, signal) {
      await releaseAndConfirm({
        request: async () => ((await call("DELETE", `/browsers/${encodeURIComponent(ref.id)}`, { signal })).status === 404 ? "gone" : undefined),
        status: () => status(ref, signal),
        forget: () => forget(ref.id),
        confirm,
        sleep,
        stillRunning: `Kernel session ${ref.id} still running after its delete`,
      });
    },
  };
}
