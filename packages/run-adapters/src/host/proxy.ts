// A session's model proxy, written for AgentRun: the provider a harness is pointed at, on the loopback interface. The
// harness holds only the session's own key; the provider's credential never reaches it. The proxy is provider-neutral,
// and a `ProviderPolicy` says what one provider's API may carry (its routes, how its client sends a key, the body it may
// forward, where a response reports its usage). The core:
//  - admits a request only with the session's key (compared in constant time), on a route the policy lists, by exact
//    path text, with no query or one the route lists exactly: an absolute URL, `..`, `//` or `%` escapes never match. A
//    route may be answered here with a status alone, with no key (a client's connectivity check), or be free (a token
//    count, which the runner never pays);
//  - parses the body strictly (one JSON value, no duplicate key at any depth, so a check on one `model` cannot pass while
//    the provider reads another), then has the policy shape it (or refuse it);
//  - asks the runner before every paid request (`beforeRequest`, where a turn cap or the host's budget refuses it) and
//    answers a refusal with a status the client does not retry, adds the provider's credential, forwards to the
//    provider's origin and the route's own path (never text from the request), streams the answer back, and reports the
//    response's usage once it completes (`afterRequest`). Every paid request forwarded is booked exactly once: a response
//    cut short, or one that says no usage, is booked at an unknown cost.
// Model spend is accounted only there, by the runner: the proxy keeps no ledger of its own.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

/** A route a policy admits: its method, its exact path, and the request headers forwarded with it. */
export interface ProxyRoute {
  readonly method: string;
  readonly path: string;
  /** Exact query strings it admits besides none (`beta=true`); forwarded as the table has them. */
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
  /** Answered here with this status and an empty body, never forwarded (a client's connectivity check). */
  readonly local?: number;
  /** Not a paid request (a token count): forwarded without asking the runner, and no usage is reported. */
  readonly free?: boolean;
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
  /** A listed request header's value as forwarded, or undefined to drop it; a `ProxyRefusal` refuses the request before
   *  the runner is asked (a beta the policy does not know). Default: as sent. */
  header?(name: string, value: string): string | undefined;
  /** The body the provider gets for a request on `route`: throw a `ProxyRefusal` to refuse it. */
  apply(body: unknown, route: ProxyRoute): Record<string, unknown>;
  /** The usage a completed response reports, if it reports one: from its whole text, or, for a long one, its first and
   *  last 64 KiB (a provider may report input tokens as a stream starts and output tokens as it ends). */
  usageOf(text: string): ProxyUsage | undefined;
  /** The model the body `apply` returned asks for, once `apply` checked it is one this session may use (its own, or a
   *  smaller one for a client's background calls). The runner is asked about, and the price taken for, that model.
   *  Absent, or undefined for a body: the session's model. */
  modelOf?(body: Record<string, unknown>): string | undefined;
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
  /** Told each forwarded request's route and the provider's status once it answers: what a route does on this
   *  provider (a free route it may not serve), as a status code only, never a body or a key. */
  onResponse?: (response: { method: string; path: string; free: boolean; status: number }) => void;
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

/** Match a request's method and path text against the routes, never parsing the path as a URL: the route, and the
 *  query it carried, which is one the route lists exactly, or none. */
export function matchRoute(routes: readonly ProxyRoute[], method: string, path: string): { route: ProxyRoute; query: string } {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048 || UNSAFE_PATH.test(path)) throw new ProxyRefusal(403, "the path is not one the table can match");
  const at = path.indexOf("?");
  const pathname = at < 0 ? path : path.slice(0, at);
  const query = at < 0 ? "" : path.slice(at + 1);
  const route = routes.find((r) => r.method === method && r.path === pathname);
  if (!route) throw new ProxyRefusal(403, `${method.slice(0, 16)} ${pathname.slice(0, 128)} is not in the table`);
  if (at >= 0 && !route.query?.includes(query)) throw new ProxyRefusal(403, `the query on ${pathname.slice(0, 128)} is not in the table`);
  return { route, query };
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
        // Defined, never assigned: a "__proto__" key is an own field like any other, and the prototype stays put.
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
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
  /** Set by close(): nothing is admitted or sent after it. */
  let closing = false;

  /** The host's log, which must never break a request (a throw from it is dropped). */
  const say = (message: string, detail?: Record<string, unknown>) => {
    try { options.log?.(message, detail); } catch { /* the host's log failed; the request goes on */ }
  };
  const refuse = (res: ServerResponse, status: number, message: string, req?: IncomingMessage) => {
    // Every refusal is reported, so a client that calls something the table does not hold is seen, not silently refused.
    say(`model proxy (${policy.id}): refused`, { status, method: String(req?.method ?? "").slice(0, 16), path: String(req?.url ?? "").slice(0, 200), reason: message.slice(0, 200) });
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_proxy" } }));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    let route: ProxyRoute;
    let query: string;
    try { ({ route, query } = matchRoute(policy.routes, req.method ?? "", req.url ?? "")); } catch (error) {
      // Without the key every request that is not a local route gets the same answer, so the table can't be mapped.
      if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required", req);
      const e = error as ProxyRefusal;
      return refuse(res, e.status ?? 403, e.message, req);
    }
    // A local route forwards nothing and answers only a status, so it needs no key: a client's connectivity check
    // (the Claude Agent CLI's `HEAD /api/hello`) is sent without one.
    if (route.local !== undefined) {
      res.writeHead(route.local, { "content-length": "0" });
      return res.end();
    }
    if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required", req);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return refuse(res, 413, "the body is too large", req);
      chunks.push(chunk as Buffer);
    }
    let body: Record<string, unknown>;
    const headers: Record<string, string> = { "content-type": "application/json" };
    try {
      body = policy.apply(parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), route);
      // The listed headers, as the policy keeps them (or refuses them), before the runner is asked.
      for (const name of route.headers ?? []) {
        const value = req.headers[name.toLowerCase()];
        const kept = typeof value === "string" ? (policy.header ? policy.header(name, value) : value) : undefined;
        if (kept !== undefined) headers[name] = kept;
      }
    } catch (error) {
      const e = error as ProxyRefusal;
      return refuse(res, e instanceof ProxyRefusal ? e.status : 400, e instanceof ProxyRefusal ? e.message : "the body was refused", req);
    }
    // The model this request is for, as the policy read it from the body it checked: the runner is asked about it, and
    // it is priced at its rate.
    let asked = model;
    try {
      const named = policy.modelOf?.(body);
      if (typeof named === "string" && named) asked = named;
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not name the request's model; it is booked as the session's`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    // The provider's credential and its headers come before the runner is asked: a request that could not be sent is
    // refused without being admitted, so it is never booked and spends no turn.
    let credential = "";
    try {
      credential = await options.credential();
    } catch (error) {
      say(`model proxy (${policy.id}): the provider credential could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    if (!credential) return refuse(res, 500, "the session has no provider credential", req);
    try {
      Object.assign(headers, policy.authHeaders(credential));
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not build the provider's credential headers`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      return refuse(res, 500, "the provider's credential headers could not be built", req);
    }
    if (closing) return refuse(res, 503, "the model proxy is closing", req);
    try {
      if (!route.free) await hooks.beforeRequest({ model: asked });
    } catch (error) {
      // Not 429: clients retry that, and the runner already refused this request (a turn cap, the host's budget).
      return refuse(res, refusedStatus, `refused before it was sent: ${String((error as Error)?.message ?? error).slice(0, 300)}`, req);
    }
    if (closing) {
      // Admitted while the proxy was closing, and never sent: released, booked at nothing, so the runner's count agrees.
      refuse(res, 503, "the model proxy is closing", req);
      if (!route.free) {
        try {
          await hooks.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: 0 });
        } catch (error) {
          say(`model proxy (${policy.id}): afterRequest threw; the request was not sent and not booked`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
      return;
    }
    const controller = new AbortController();
    inflight.add(controller);
    res.on("close", () => controller.abort());
    let head = "";
    let tail = "";
    let length = 0;
    /** The provider's answer, once it reached the client whole. */
    let answered: { ok: boolean } | undefined;
    try {
      // From here a paid request may be paid, so every way out below books it exactly once.
      const upstream = await forward(`${origin}${route.path}${query ? `?${query}` : ""}`, { method: route.method, headers, body: JSON.stringify(body), signal: controller.signal });
      // The provider answered (and a paid request was paid): a host callback that throws must not lose the answer or
      // its booking.
      try {
        options.onResponse?.({ method: route.method, path: route.path, free: route.free === true, status: upstream.status });
      } catch (error) {
        say(`model proxy (${policy.id}): onResponse threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      const decoder = new TextDecoder();
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          // A client that reads slowly holds the provider back: nothing more is read until what was written drains.
          if (!res.write(chunk)) {
            // One wait, and nothing left behind: whichever comes first takes both listeners off.
            await new Promise<void>((resolve) => {
              const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
              res.on("drain", done);
              res.on("close", done);
            });
          }
          // The usage is at the start, the end, or both: keep those, not the whole answer.
          const text = decoder.decode(chunk, { stream: true });
          length += text.length;
          if (head.length < USAGE_WINDOW) head += text.slice(0, USAGE_WINDOW - head.length);
          tail = (tail + text).slice(-USAGE_WINDOW);
        }
      }
      res.end();
      answered = { ok: upstream.ok };
    } catch (error) {
      say(`model proxy (${policy.id}): the request did not complete`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      if (!res.headersSent) refuse(res, 502, "the provider did not answer", req);
      else res.destroy();
    } finally {
      inflight.delete(controller);
    }
    // Every paid request the proxy forwarded is booked exactly once, after the client has its answer (or lost it):
    // nothing here can turn an answer into an error the client sees and might pay again for. Its usage and price
    // when the answer is whole and says them; nothing for a provider's error answer; an unknown cost for an answer
    // cut short, one that said no usage, or a usage or a price that could not be read. A booking that fails is
    // reported (the runner stops the node on it).
    if (route.free) return;
    let usage: ProxyUsage | undefined;
    let usd: number | null = null;
    if (!answered) {
      usage = { input: 0, output: 0, cacheRead: 0 };
    } else if (!answered.ok) {
      // A provider's error answer was not a paid response: it costs nothing.
      usage = { input: 0, output: 0, cacheRead: 0 };
      usd = 0;
    } else {
      let unread = false;
      try {
        usage = policy.usageOf(length <= USAGE_WINDOW ? tail : `${head}\n${tail}`);
      } catch (error) {
        say(`model proxy (${policy.id}): the usage could not be read; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
      }
      if (!usage) {
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
      }
      try {
        usd = unread ? null : options.price?.(asked, usage) ?? null;
      } catch (error) {
        say(`model proxy (${policy.id}): the price could not be computed; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usd = null;
      }
    }
    try {
      await hooks.afterRequest({ ...usage, usd, ...(usd === null ? { estimated: true } : {}) });
    } catch (error) {
      say(`model proxy (${policy.id}): afterRequest threw; the request was answered and not booked`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  };

  const server = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, "the proxy failed", req); else res.destroy(); }); });
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
      closing = true;
      for (const c of inflight) c.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
