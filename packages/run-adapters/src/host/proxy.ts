// A session's model proxy, written for AgentRun: the provider a harness is pointed at, on the loopback interface. The
// harness holds only the session's own key; the provider's credential never reaches it. The proxy is provider-neutral,
// and a `ProviderPolicy` says what one provider's API may carry (its routes, how its client sends a key, the body it may
// forward, where a response reports its usage). The core:
//  - admits a request only with the session's key (compared in constant time), on a route the policy lists, by exact
//    path text: an absolute URL, `..`, `//`, `%` escapes or a query never match;
//  - parses the body strictly (one JSON value, no duplicate key at any depth, so a check on one `model` cannot pass while
//    the provider reads another), then has the policy shape it (or refuse it);
//  - asks the runner before every paid request (`beforeRequest`, where a turn cap or the host's budget refuses it) and
//    answers a refusal with a status the client does not retry, adds the provider's credential, forwards to the
//    provider's origin and the route's own path (never text from the request), streams the answer back, and reports the
//    response's usage once it completes (`afterRequest`). A response cut off before its usage arrived reports nothing:
//    the runner counts it as a turn whose cost is unknown.
// Model spend is accounted only there, by the runner: the proxy keeps no ledger of its own.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

/** A route a policy admits: its method, its exact path, and the request headers forwarded with it. */
export interface ProxyRoute {
  readonly method: string;
  readonly path: string;
  readonly headers?: readonly string[];
}

/** Token counts a response reports. */
export interface ProxyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

/** What one provider's API may carry through the proxy. */
export interface ProviderPolicy {
  /** A name for messages. */
  readonly id: string;
  readonly routes: readonly ProxyRoute[];
  /** The key the client sent, from its headers ("" when it sent none). */
  keyOf(headers: IncomingHttpHeaders): string;
  /** The headers that carry the provider's credential. */
  authHeaders(credential: string): Record<string, string>;
  /** The body the provider gets for a request on `route`: throw a `ProxyRefusal` to refuse it. */
  apply(body: unknown, route: ProxyRoute): Record<string, unknown>;
  /** The usage a completed response reports, if it reports one: from its whole text, or, for a long one, its first and
   *  last 64 KiB (a provider may report input tokens as a stream starts and output tokens as it ends). */
  usageOf(text: string): ProxyUsage | undefined;
  /** The status a request the runner refused gets: one the client does not retry. Default 400. */
  readonly refusedStatus?: number;
}

export interface ModelUsageReport extends ProxyUsage {
  usd: number | null;
  estimated?: boolean;
}

export interface ModelProxyHooks {
  /** Before a paid request leaves; a throw refuses it. */
  beforeRequest(request: { model: string }): Promise<void>;
  /** When a request's response has completed, with its usage. */
  afterRequest(usage: ModelUsageReport): Promise<void>;
}

export interface ModelProxyOptions {
  policy: ProviderPolicy;
  hooks: ModelProxyHooks;
  /** The session's model, as the runner names it to `beforeRequest`. The policy fixes the body's model. */
  model: string;
  /** The provider's origin (`https://api.example.com`); a route's path is appended to it. */
  origin: string;
  /** The provider's credential, read for each request. */
  credential: () => string | Promise<string>;
  /** The price of a response, or null when it is unknown. */
  price?: (model: string, usage: ProxyUsage) => number | null;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** For tests: the fetch the proxy forwards with. */
  fetch?: typeof fetch;
}

export interface ModelProxy {
  /** The proxy's origin, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The key the harness sends, which the proxy admits. */
  readonly key: string;
  close(): Promise<void>;
}

const UNSAFE_PATH = /[^A-Za-z0-9/_.\-?=&]|\.\.|\/\/|^[^/]|\?.*\?/;
const MAX_BODY = 32 * 1024 * 1024;
/** How much of a response's start and end the proxy keeps to read its usage from. */
const USAGE_WINDOW = 64 * 1024;

export class ProxyRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ProxyRefusal"; }
}

/** Match a request's method and path text against the routes, never parsing the path as a URL. */
export function matchRoute(routes: readonly ProxyRoute[], method: string, path: string): ProxyRoute {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048 || UNSAFE_PATH.test(path)) throw new ProxyRefusal(403, "the path is not one the table can match");
  if (path.includes("?")) throw new ProxyRefusal(403, "no query is listed");
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new ProxyRefusal(403, `${method.slice(0, 16)} ${path.slice(0, 128)} is not in the table`);
  return route;
}

/** Parse one JSON value, refusing a duplicate key at any depth and nesting past 64 levels. */
export function parseStrict(text: string): unknown {
  let i = 0;
  const fail = (why: string): never => { throw new ProxyRefusal(400, `the body is not strict JSON: ${why}`); };
  const ws = () => { while (i < text.length && /[ \t\n\r]/.test(text[i]!)) i++; };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    if (text[i] !== '"') fail("an unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail("nested too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("an object key");
        const key = str();
        if (seen.has(key)) fail(`the key ${JSON.stringify(key).slice(0, 40)} appears twice`);
        seen.add(key);
        ws();
        if (text[i] !== ":") fail("a colon");
        i++;
        out[key] = value(depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        fail("an object");
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        fail("an array");
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail("a value");
    i += m![0].length;
    return JSON.parse(m![0]);
  };
  const out = value(0);
  ws();
  if (i !== text.length) fail("more than one value");
  return out;
}

/** Whether `given` is `key`, in time that does not depend on where they differ. */
export const sameKey = (given: string, key: string): boolean => {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
};

/** Start a session's model proxy on the loopback interface, admitting `key`. */
export async function startModelProxy(options: ModelProxyOptions, key: string): Promise<ModelProxy> {
  const { policy, hooks, model } = options;
  if (!key) throw new Error("agentrun-adapters: a model proxy needs the session's key");
  const forward = options.fetch ?? fetch;
  const origin = new URL(options.origin).origin;
  const refusedStatus = policy.refusedStatus ?? 400;
  const inflight = new Set<AbortController>();

  const refuse = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_proxy" } }));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required");
    let route: ProxyRoute;
    try { route = matchRoute(policy.routes, req.method ?? "", req.url ?? ""); } catch (error) {
      const e = error as ProxyRefusal;
      return refuse(res, e.status ?? 403, e.message);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return refuse(res, 413, "the body is too large");
      chunks.push(chunk as Buffer);
    }
    let body: Record<string, unknown>;
    try {
      body = policy.apply(parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), route);
    } catch (error) {
      const e = error as ProxyRefusal;
      return refuse(res, e instanceof ProxyRefusal ? e.status : 400, e instanceof ProxyRefusal ? e.message : "the body was refused");
    }
    try {
      await hooks.beforeRequest({ model });
    } catch (error) {
      // Not 429: clients retry that, and the runner already refused this request (a turn cap, the host's budget).
      return refuse(res, refusedStatus, `refused before it was sent: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
    const credential = await options.credential();
    if (!credential) return refuse(res, 500, "the session has no provider credential");
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const name of route.headers ?? []) {
      const value = req.headers[name.toLowerCase()];
      if (typeof value === "string") headers[name] = value;
    }
    Object.assign(headers, policy.authHeaders(credential));
    const controller = new AbortController();
    inflight.add(controller);
    res.on("close", () => controller.abort());
    let head = "";
    let tail = "";
    let length = 0;
    try {
      const upstream = await forward(`${origin}${route.path}`, { method: route.method, headers, body: JSON.stringify(body), signal: controller.signal });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      const decoder = new TextDecoder();
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          // The usage is at the start, the end, or both: keep those, not the whole answer.
          const text = decoder.decode(chunk, { stream: true });
          length += text.length;
          if (head.length < USAGE_WINDOW) head += text.slice(0, USAGE_WINDOW - head.length);
          tail = (tail + text).slice(-USAGE_WINDOW);
        }
      }
      res.end();
      // A provider's error answer was not a paid response: it costs nothing.
      const usage = upstream.ok ? policy.usageOf(length <= USAGE_WINDOW ? tail : `${head}\n${tail}`) : { input: 0, output: 0, cacheRead: 0 };
      if (usage) {
        const usd = upstream.ok ? (options.price?.(model, usage) ?? null) : 0;
        await hooks.afterRequest({ ...usage, usd, ...(usd === null ? { estimated: true } : {}) });
      }
    } catch (error) {
      options.log?.(`model proxy (${policy.id}): the request did not complete`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      if (!res.headersSent) refuse(res, 502, "the provider did not answer");
      else res.destroy();
    } finally {
      inflight.delete(controller);
    }
  };

  const server = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, "the proxy failed"); else res.destroy(); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("agentrun-adapters: the model proxy has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    key,
    close: async () => {
      for (const c of inflight) c.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
