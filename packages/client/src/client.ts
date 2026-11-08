// The client: `new AgentRun({ baseUrl, apiKey })`, a method per operation (operations.generated.ts), and the rules every
// client of the server keeps. The key goes only to its own base URL, in the Authorization header, and is checked to be a
// valid header value before any request; no error holds it. A path argument is encoded whole (a file path keeps its
// slashes), and one that would read as another route is refused before anything is sent. Only a GET, or a request that
// carries an Idempotency-Key, is tried again. A secret body's values are cut from the answer to it.
import { AgentRunAuthError, AgentRunError, AgentRunRefused, AgentRunUnreachable, AgentRunUnsupported, AgentRunUsage, type ServerError } from "./errors.js";
import { BAD_HEADER, backoff, LATE, MAX_RETRY_AFTER_MS, pause, segmentOf, wholeMs, type Exchange } from "./http.js";
import { followRun, waitRun, type FollowOptions, type WaitOptions } from "./live.js";
import { OPERATIONS, resources, type Resources, type Run, type TimelinePage } from "./operations.generated.js";
import { scrubberOf, secretsOf } from "./scrub.js";
import type { Operation, RequestOptions } from "./types.js";

export interface ClientOptions {
  /** The server's API, ending /v2 (default: AGENTRUN_BASE_URL): http or https, with no query, fragment, user or password. */
  baseUrl?: string;
  /** The API key (default: AGENTRUN_API_KEY). */
  apiKey?: string;
  /** How long one try of a request may take, in milliseconds (default 60000). */
  timeoutMs?: number;
  /** How many times a GET, or a request with an Idempotency-Key, is tried again after a 429, a 5xx or a dropped connection (default 4). */
  maxRetries?: number;
  /** The fetch to send with (default: the global one). */
  fetch?: typeof fetch;
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const RETRIABLE = new Set([429, 500, 502, 503, 504]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;

/** A failure's code, never its message: a fetch error's message can quote a header. */
const causeOf = (error: unknown): string => {
  const e = error as { name?: string; code?: unknown; cause?: { code?: unknown } } | undefined;
  if (e?.name === "TimeoutError") return "timeout";
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code) ? code : typeof e?.name === "string" && /^\w+$/.test(e.name) ? e.name : "unknown";
};

/** The causes of a connection that was never made: no server took it. Any other failure took a connection and dropped it. */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);
/** The causes of a TLS handshake the client refused (a certificate it does not trust, a name it does not match). */
const UNTRUSTED = /CERT|TLS|SSL|UNABLE_TO_/;

/** Retry-After in milliseconds (seconds or an HTTP date), 0 when there is none. */
const retryAfterOf = (response: Response): number => {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
};

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

/** A base URL as the client takes it; `where` names it in the refusal. The URL itself is never echoed: it may hold a password. */
function baseOf(given: string | undefined, where: string): string {
  if (given === undefined || given === "") throw new AgentRunUsage("No server: pass baseUrl, or set AGENTRUN_BASE_URL, to the API's base (ending /v2).");
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) {
    throw new AgentRunUsage(`${where} must be an http or https URL with no query, fragment, user or password: the API's base, ending /v2.`);
  }
  return given.replace(/\/+$/, "");
}

const positive = (value: number | undefined, name: string, whole = false) => {
  if (value !== undefined && (!Number.isFinite(value) || value < (whole ? 0 : 1) || (whole && !Number.isInteger(value)))) throw new AgentRunUsage(`${name} must be ${whole ? "a whole number, 0 or more" : "a number of milliseconds, 1 or more"}.`);
  return value;
};

type Runs = Resources["runs"] & {
  /** Waits until the run ends (completed, failed or cancelled, every row in) or waits on a person (`input_required`,
   *  `paused`), and resolves to the run. Past `timeoutMs` it throws AgentRunTimeout, and the run goes on. */
  wait(runId: string, options?: WaitOptions): Promise<Run>;
  /** The run's timeline as it changes: each page the server's event stream sends, until the run ends. A dropped
   *  connection resumes with Last-Event-ID, so no change comes twice. */
  follow(runId: string, options?: FollowOptions): AsyncGenerator<TimelinePage, void, undefined>;
};

export interface AgentRun extends Omit<Resources, "runs"> {
  readonly runs: Runs;
}

/** A client for one AgentRun server. The local server's discovery (its data directory, its record of its address) is the
 *  CLI's: this client reads no file, only its options and the environment. */
export class AgentRun {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  #reached = false;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = baseOf(options.baseUrl ?? env("AGENTRUN_BASE_URL"), options.baseUrl !== undefined ? "baseUrl" : "AGENTRUN_BASE_URL");
    const key = options.apiKey ?? env("AGENTRUN_API_KEY");
    if (!key) throw new AgentRunAuthError("no_token", "No API key: pass apiKey, or set AGENTRUN_API_KEY.");
    // Refused before it is sent: fetch would quote a bad header value in its error.
    if (BAD_HEADER.test(key) || /\s/.test(key)) throw new AgentRunAuthError("bad_header", "The API key is not a valid header value (it holds a space, a line break, a control character or a character outside Latin-1).");
    this.#apiKey = key;
    this.timeoutMs = positive(options.timeoutMs, "timeoutMs") ?? 60_000;
    this.maxRetries = positive(options.maxRetries, "maxRetries", true) ?? 4;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const groups = resources((id, args, body, params, opts) => this.#call(id, args, body, params, opts));
    Object.assign(this, groups, {
      runs: { ...groups.runs, wait: (runId: string, opts?: WaitOptions) => waitRun(this.#send, runId, opts), follow: (runId: string, opts?: FollowOptions) => followRun(this.#send, this.baseUrl, runId, opts) },
    });
  }

  /** One generated operation: its arguments checked, then sent, then its answer read. */
  async #call(id: string, args: readonly string[], body: unknown, params: object | undefined, options: (RequestOptions & { contentType?: string; stream?: boolean }) | undefined): Promise<unknown> {
    const op = OPERATIONS[id] as Operation;
    const route = `${op.method} ${op.path}`;
    const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => segmentOf(args[op.pathParams.indexOf(name)], name, op.multiSegment.includes(name)));
    const given = (params ?? {}) as Record<string, unknown>;
    const query = new URLSearchParams();
    for (const name of op.query) if (given[name] !== undefined && given[name] !== null) query.set(name, String(given[name]));
    const headers: Record<string, string> = {};
    for (const name of op.headers) {
      const value = given[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || BAD_HEADER.test(value)) throw new AgentRunUsage(`${name} is not a valid header value.`);
      headers[name] = value;
    }
    let sent: BodyInit | undefined;
    if (op.body && body !== undefined) {
      const raw = typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || (typeof Blob !== "undefined" && body instanceof Blob);
      const other = op.body.types.find((type) => !JSON_TYPE.test(type));
      if (raw && other) {
        const type = options?.contentType ?? (other === "*/*" ? "application/octet-stream" : other);
        if (BAD_HEADER.test(type)) throw new AgentRunUsage("contentType is not a valid header value.");
        headers["content-type"] = type;
        sent = body as BodyInit;
      } else {
        headers["content-type"] = "application/json";
        sent = JSON.stringify(body);
      }
    } else if (op.body?.required) throw new AgentRunUsage(`${route} needs a body.`);
    // A body bound for a secret route, the base URL's own path counted: its values are cut from the answer.
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ""}`;
    const secretOp = op.secret ? op : secretAt(op.method, url);
    if (secretOp && sent !== undefined && typeof sent !== "string") throw new AgentRunUsage(`${route} under ${this.baseUrl} reaches ${secretOp.method} ${secretOp.path}, whose body is a secret: send it as JSON.`);
    const secrets = secretOp && typeof sent === "string" ? secretsOf(sent, secretOp.publicFields) : [];
    const response = await this.#send({
      method: op.method, path: url.slice(this.baseUrl.length), route, headers, body: sent, signal: options?.signal, timeoutMs: options?.timeoutMs,
      retryable: op.method === "GET" || headers["Idempotency-Key"] !== undefined, secret: secretOp !== undefined,
      streamed: op.answer === "bytes" && options?.stream === true,
    });
    const answer = await readAnswer(op, route, response, options?.stream === true, secretOp ? scrubberOf(secrets) : undefined);
    return op.tagged ? { body: answer, etag: response.headers.get("etag") } : answer;
  }

  /** One request to the server with the key: tried again when it may be, its redirects followed only within the base
   *  URL's origin, and any answer but a success thrown as its outcome. Resolves to the success's Response. */
  readonly #send = async (x: Exchange): Promise<Response> => {
    const deadline = x.deadline ?? Infinity;
    for (let tries = 1; ; tries++) {
      const left = deadline - Date.now();
      if (left <= 0) throw LATE;
      const timeout = AbortSignal.timeout(wholeMs(Math.min(x.timeoutMs ?? this.timeoutMs, left)));
      const signal = x.signal ? AbortSignal.any([x.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.#follow(x, signal);
        this.#reached = true;
        if (response.ok && !x.streamed) response = await whole(response);
      } catch (error) {
        if (x.signal?.aborted) throw x.signal.reason;
        if (error instanceof AgentRunError) throw error;
        if (Date.now() >= deadline) throw LATE;
        const cause = causeOf(error);
        // A server never reached is unreachable at once; a dropped connection is tried again, even on the first request,
        // and so is a refused one once the server has answered before (it may be restarting); a timeout is not.
        // A certificate the client refuses stays refused, so it is never tried again.
        const neverReached = !this.#reached && NOT_CONNECTED.has(cause);
        if (!x.retryable || neverReached || UNTRUSTED.test(cause) || cause === "timeout" || tries > this.maxRetries) throw new AgentRunUnreachable(this.baseUrl, cause);
        await pause(Math.min(backoff(tries), deadline - Date.now()), x.signal);
        continue;
      }
      if (x.retryable && RETRIABLE.has(response.status) && tries <= this.maxRetries && retryAfterOf(response) <= MAX_RETRY_AFTER_MS) {
        const floor = retryAfterOf(response);
        await response.body?.cancel().catch(() => undefined);
        await pause(Math.min(backoff(tries, floor), Math.max(1, deadline - Date.now())), x.signal);
        continue;
      }
      if (response.ok) return response;
      throw await refusal(x, response, this.#apiKey);
    }
  };

  /** fetch with the key, following a redirect only for a GET and only within the base URL's origin: the key never goes
   *  to another server. Any other redirect is refused (`code` `redirect`). */
  async #follow(x: Exchange, signal: AbortSignal): Promise<Response> {
    const origin = new URL(this.baseUrl).origin;
    let url = `${this.baseUrl}${x.path}`;
    for (let hops = 0; ; hops++) {
      const response = await this.#fetch(url, { method: x.method, headers: { accept: "application/json, */*", ...x.headers, authorization: `Bearer ${this.#apiKey}` }, body: x.body, signal, redirect: "manual" });
      if (!REDIRECT.has(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      const next = location && URL.canParse(location, url) ? new URL(location, url) : undefined;
      const home = next !== undefined && next.origin === origin && !next.username && !next.password;
      if (!home || x.method !== "GET" || hops >= MAX_HOPS) {
        throw new AgentRunRefused(x.route, response.status, "redirect", undefined, `The server answered ${x.route} with a redirect ${home ? "this client does not follow" : "to another origin"} (${response.status}); not followed, so the API key stays with ${this.baseUrl}.`);
      }
      url = next.href;
    }
  }
}

/** `response` with its body read whole: a body cut midway throws here, inside the exchange's rules. */
async function whole(response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  const empty = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(empty ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The secret operation `method` on `url` reaches, its path normalized as fetch normalizes it: the route at the end of
 *  the path, whatever part of it the base URL holds. */
function secretAt(method: string, url: string): Operation | undefined {
  const pathname = new URL(url).pathname.replace(/\/{2,}/g, "/");
  const route = (op: Operation) => new RegExp(`(?:^|/)${op.path.slice(1).split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}/?$`);
  return Object.values(OPERATIONS).find((op) => op.secret && op.method === method && route(op).test(pathname));
}

/** A refused answer as its outcome. The server's error object is kept with every copy of the key cut from it; after a
 *  secret body, only its code. Its text is never read into a message. A caller's abort while the body is still coming
 *  is thrown as the caller's own reason: cancelled work is never reported as a refusal or a bad key. */
async function refusal(x: Exchange, response: Response, apiKey: string): Promise<AgentRunError> {
  let error: ServerError | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())) as { error?: unknown };
    if (parsed?.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)) error = scrubberOf([apiKey])(parsed.error as ServerError);
  } catch {
    if (x.signal?.aborted) throw x.signal.reason;
    error = undefined;
  }
  const code = typeof error?.code === "string" && /^[a-z0-9_]+$/.test(error.code) ? error.code : undefined;
  if (x.secret) error = code ? { code } : undefined;
  if (response.status === 401 || response.status === 403) return new AgentRunAuthError("refused", `The server refused the API key for ${x.route}: ${response.status}${code ? ` ${code}` : ""}.`, { status: response.status, code, error });
  if (response.status === 501) return new AgentRunUnsupported(x.route, response.status, code, error);
  const wait = retryAfterOf(response);
  return new AgentRunRefused(x.route, response.status, code, error, undefined, wait > 0 ? wait : undefined);
}

const badAnswer = (route: string, status: number, what: string) => new AgentRunRefused(route, status, "bad_answer", undefined, `The server's answer to ${route} is not ${what}.`);

/** A success's body as the operation answers: JSON parsed (a secret body's values cut from it), text as a string, a
 *  file's bytes as they came, or the Response itself for a download asked to stream. */
async function readAnswer(op: Operation, route: string, response: Response, stream: boolean, scrub: (<T>(value: T) => T) | undefined): Promise<unknown> {
  if (op.answer === "bytes" && !scrub) return stream ? response : new Uint8Array(await response.arrayBuffer());
  if (op.answer === "none") return void (await response.body?.cancel().catch(() => undefined));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 204 || bytes.length === 0) return op.answer.includes("json") ? undefined : op.answer === "text" ? "" : bytes;
  const type = response.headers.get("content-type") ?? "";
  if (scrub || (op.answer.includes("json") && (JSON_TYPE.test(type) || op.answer === "json"))) {
    if (!JSON_TYPE.test(type)) throw badAnswer(route, response.status, "JSON");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw badAnswer(route, response.status, "JSON");
    }
    return scrub ? scrub(value) : value;
  }
  if (op.answer.includes("text") && (/^text\//i.test(type) || !op.answer.includes("bytes"))) return new TextDecoder().decode(bytes);
  return bytes;
}
