// Kernel as a lease provider, over Kernel's REST API through the package's own undici Agent (no Kernel SDK). The key comes
// from the env the host hands in and lives in this module's memory only: a ref is `{ id, tag }`, and the CDP URL (it carries
// Kernel's token) is held here, found again by a lookup after a restart. No error carries the key, the URL or Kernel's own
// text: a failure names the call, the HTTP status and Kernel's error code.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachTarget, BrowserProvider, ProviderCaps, SessionSpec } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { directFetch } from "./http.js";

export const KERNEL_BASE_URL = "https://api.onkernel.com";
/** Kernel's bounds on `timeout_seconds`, the idle time after which it ends a session by itself. */
export const KERNEL_IDLE_MIN_S = 10;
export const KERNEL_IDLE_MAX_S = 259_200;

type HttpFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; signal?: AbortSignal }) => Promise<Response>;
export type KernelOptions = {
  /** KERNEL_API_KEY, and KERNEL_BASE_URL (default https://api.onkernel.com). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Kernel's stealth mode, which also turns on its CAPTCHA solver and its stealth proxy. Default false. */
  stealth?: boolean;
  /** Kernel's headless image (no GUI). Default false, Kernel's own default. */
  headless?: boolean;
  /** The stored Stagehand extension every create names. Default: one stored with the same bytes (any name), else uploaded
   *  once per process and account as `agentrun-stagehand-<sha256 prefix>`. */
  extension?: () => Promise<KernelExtensionRef>;
  /** How long a release waits for Kernel to report the session gone. */
  confirm?: { polls: number; intervalMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** The HTTP client. Default: the package's direct undici Agent, which never goes through HTTP(S)_PROXY; a host behind a
   *  proxy hands in a fetch that does. */
  fetch?: HttpFetch;
};

export type KernelProvider = BrowserProvider & { readonly name: "kernel" };
/** A stored Kernel extension, as a create names it. */
export type KernelExtensionRef = { id: string } | { name: string };

// Kernel ends a session after `timeout_seconds` without a CDP or live-view connection and sets no wall-clock limit, so the
// lifetime cap is its largest idle timeout.
const CAPS: ProviderCaps = { timeoutModel: "inactivity", maxLifetimeS: KERNEL_IDLE_MAX_S, survivesDisconnect: true, releaseIsAsync: false, extension: "uploaded-per-launch" };
const nonEmpty = (v: unknown): string => String(v ?? "").trim();

/** A failed Kernel call: the call and the HTTP status, plus Kernel's error code when it is a plain identifier. Kernel's
 *  message is never copied (an echo of the request could carry the key or a URL). `status` is the classifier's fact. */
export class KernelError extends Error {
  readonly status: number | undefined;
  constructor(call: string, status: number | undefined, code?: string, options?: { cause?: unknown }) {
    super(status === undefined ? `Kernel ${call} could not be reached` : `Kernel ${call} answered ${status}${code ? ` (${code})` : ""}`, options);
    this.name = "KernelError";
    this.status = status;
  }
}
const CODE = /^[a-z][a-z_.-]{0,47}$/i;

/** Tag values are `[A-Za-z0-9._:-]` and at most 60 characters, as on Browserbase; the tag is exact (a filter matches it whole). */
const tagValue = (v: string): string => String(v || "").replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 60) || "unknown";

export function kernelCreateBody(spec: SessionSpec, options: { stealth?: boolean; headless?: boolean; extension?: KernelExtensionRef } = {}): Record<string, unknown> {
  const tags = Object.fromEntries(Object.entries(spec.metadata).map(([k, v]) => [k, tagValue(v)]));
  return {
    headless: options.headless ?? false,
    stealth: options.stealth ?? false,
    // Explicit, never Kernel's default (60 s): the idle time after which Kernel ends a session nobody is connected to, so a
    // crashed host's browser stops costing money on its own while custody's release is pending.
    timeout_seconds: Math.min(KERNEL_IDLE_MAX_S, Math.max(KERNEL_IDLE_MIN_S, Math.round(spec.idleTimeoutS) || KERNEL_IDLE_MIN_S)),
    viewport: { width: spec.viewport.width, height: spec.viewport.height },
    tags: { ...tags, agentrun_tag: spec.tag },
    ...(options.extension ? { extensions: [options.extension] } : {}),
  };
}

/** The Stagehand extension archive that ships with the installed Stagehand. */
function extensionArchive(): string {
  return nonEmpty(process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH) || path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "assets", "stagehand-extension.zip");
}

/** What this process holds for the sessions it created or attached, by account and session id. Module-level, not per
 *  provider: a host may build a fresh provider for the release (custody does). Never written anywhere: the URL carries a token. */
const cdpUrls = new Map<string, string>();
const uploads = new Map<string, Promise<KernelExtensionRef>>();

export function kernelProvider(options: KernelOptions = {}): KernelProvider {
  const env = options.env ?? process.env;
  const apiKey = nonEmpty(env.KERNEL_API_KEY);
  const baseUrl = (nonEmpty(env.KERNEL_BASE_URL) || KERNEL_BASE_URL).replace(/\/+$/, "");
  // The same account (base URL and key) shares one view of its sessions across provider instances.
  const account = `${baseUrl}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
  const held = (id: string) => `${account}|${id}`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const confirm = options.confirm ?? { polls: 6, intervalMs: 500 };
  let client: Promise<HttpFetch> | null = null;
  const http = () => (client ??= options.fetch ? Promise.resolve(options.fetch) : directFetch().then((f) => (f ?? fetch) as HttpFetch));

  /** One request, once: no retry here (a create the server served twice would be a second paid browser). Kernel's body is
   *  read as JSON on success; on failure only its `code` survives, and a transport failure keeps its cause chain (the
   *  classifier's facts) under a message that names the call alone. */
  async function call(method: string, route: string, init: { body?: unknown; query?: URLSearchParams; signal?: AbortSignal; raw?: { body: Uint8Array; type: string } } = {}): Promise<{ status: number; json: any; headers: Headers }> {
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
    // session list would let a release finish without deleting). A failure's body is only searched for its code.
    let text = "";
    try { text = await response.text(); } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") throw error;
      if (response.ok) throw new KernelError(name, response.status, "unreadable_body", { cause: error });
    }
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { if (response.ok) throw new KernelError(name, response.status, "not_json"); }
    if (!response.ok && response.status !== 404) throw new KernelError(name, response.status, typeof json?.code === "string" && CODE.test(json.code) ? json.code : undefined);
    return { status: response.status, json, headers: response.headers };
  }

  /** A stored extension whose bytes are `sha` (Kernel's checksum is the SHA-256 of the archive as uploaded), whatever its
   *  name, read across every page; null only when the whole list was read and none is. A list cut short is a failure: a
   *  missed copy would mean an upload the plan may refuse, or a duplicate. */
  const storedWith = async (sha: string): Promise<KernelExtensionRef | null> => {
    for (let offset = 0, pages = 0; pages < 100; pages += 1) {
      const page = await call("GET", "/extensions", { query: new URLSearchParams({ limit: "100", offset: String(offset) }) });
      if (!Array.isArray(page.json)) throw new KernelError("GET /extensions", page.status, "not_a_list");
      const found = page.json.find((e: any) => e?.checksum === sha);
      if (found) return nonEmpty(found.name) ? { name: nonEmpty(found.name) } : { id: nonEmpty(found.id) };
      if (page.headers.get("x-has-more") !== "true") return null;
      const next = Number(page.headers.get("x-next-offset"));
      if (!Number.isInteger(next) || next <= offset) throw new KernelError("GET /extensions", page.status, "no_next_offset");
      offset = next;
    }
    throw new Error("Kernel kept answering more pages of stored extensions");
  };

  /** The Stagehand extension every create names. A stored one with the same bytes serves whatever its name: a plan may
   *  store only one extension, and it may be another tool's copy of this Stagehand; it is named on create, never changed.
   *  Otherwise one upload per process and account, named by the archive's SHA-256; a failed one is forgotten so the next
   *  create tries again (a plan with no room answers 403 `insufficient_plan`, which the failure names). */
  const extension = (): Promise<KernelExtensionRef> => {
    if (options.extension) return options.extension();
    let up = uploads.get(account);
    if (!up) {
      up = (async () => {
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
      })();
      uploads.set(account, up);
      up.catch(() => uploads.delete(account));
    }
    return up;
  };

  const lookup = async (id: string, signal?: AbortSignal) => call("GET", `/browsers/${encodeURIComponent(id)}`, { signal });
  const status = async (ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus> => {
    const found = await lookup(ref.id, signal);
    if (found.status === 404) return "gone";
    return found.json?.deleted_at ? "stopped" : "running";
  };
  const forget = (id: string) => { cdpUrls.delete(held(id)); };

  return {
    name: "kernel",
    caps: CAPS,

    async create(spec, signal) {
      // The upload is shared by every create on the account: a cancelled caller stops waiting, the upload goes on for the rest.
      // A create cancelled before it began asks for nothing.
      signal?.throwIfAborted();
      const body = kernelCreateBody(spec, { stealth: options.stealth, headless: options.headless, extension: await untilAborted(extension(), signal) });
      // At most once: a lost answer is found again by its tag (findByTag), never by a second create.
      const created = await call("POST", "/browsers", { body, signal });
      const id = nonEmpty(created.json?.session_id);
      const url = nonEmpty(created.json?.cdp_ws_url);
      if (created.status === 404 || !id || !url) throw new KernelError("POST /browsers", created.status, "no_session");
      cdpUrls.set(held(id), url);
      return { id, tag: spec.tag };
    },

    async findByTag(tag, signal) {
      if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("a session tag is [A-Za-z0-9_.-]");
      // The filter is Kernel's; the match is ours: a lane that ignores it must never hand back someone else's session. Every
      // page must answer: custody reads this as the complete set (it releases exactly these ids), so a failed page throws.
      const out: LeaseRef[] = [];
      const seen = new Set<string>();
      for (let offset = 0, pages = 0; pages < 100; pages += 1) {
        const query = new URLSearchParams({ status: "active", [`tags[agentrun_tag]`]: tag, limit: "100", offset: String(offset) });
        const page = await call("GET", "/browsers", { query, signal });
        // A list is never "not found": a 404 here is a wrong base URL, and an empty answer would orphan the tag's sessions.
        if (page.status === 404) throw new KernelError("GET /browsers", 404);
        if (!Array.isArray(page.json)) throw new KernelError("GET /browsers", page.status, "not_a_list");
        const rows: any[] = page.json;
        for (const row of rows) {
          const id = nonEmpty(row?.session_id);
          if (id && row?.tags?.agentrun_tag === tag && !row?.deleted_at && !seen.has(id)) { seen.add(id); out.push({ id, tag }); }
        }
        // Kernel pages by headers: X-Has-More, and X-Next-Offset as the next page's absolute start.
        if (page.headers.get("x-has-more") !== "true") return out;
        // More pages with no usable next offset would truncate the set custody releases: a failure, never a partial answer.
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
      // The extension rides the create; the driver finds it in the browser.
      return { sdkCdpUrl: url };
    },

    async release(ref, signal) {
      let failure: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if ((await call("DELETE", `/browsers/${encodeURIComponent(ref.id)}`, { signal })).status === 404) return void forget(ref.id);
          failure = undefined;
          break;
        } catch (error) { failure = error; }
      }
      // Released means Kernel says the session is gone, not that the delete was sent.
      for (let poll = 0; ; poll += 1) {
        const now = await status(ref, signal);
        if (now !== "running" && now !== "pending") return void forget(ref.id);
        if (poll >= confirm.polls) throw failure ?? new Error(`Kernel session ${ref.id} still running after its delete`);
        await sleep(confirm.intervalMs);
      }
    },
  };
}

/** `work`'s result unless `signal` fires first; the work itself goes on (another caller may be waiting for it). */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    // The work's outcome is taken before anything else, so a failure after the caller left is handled, never unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}
