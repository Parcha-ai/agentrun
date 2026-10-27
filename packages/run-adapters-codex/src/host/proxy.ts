// The session's model proxy, written for AgentRun. Codex's provider is this proxy on the loopback interface; it holds no
// provider key. The proxy:
//  - admits a request only with the session's own key (compared in constant time), on one route (POST /v1/responses),
//    by exact path text: an absolute URL, `..`, `//`, `%` escapes or an unlisted query never match;
//  - parses the body strictly (one JSON value, no duplicate key at any depth, so a check on one `model` cannot pass while
//    the provider reads another), fixes the model to the session's, sets `store: false`, clamps `max_output_tokens`, and
//    refuses provider-hosted tools (web search, file search, code interpreter, computer use, image generation, MCP, a
//    local shell), and drops every tool definition that is not one of the session's own names (Codex's
//    `request_user_input`), in `tools` and in code mode's `additional_tools` alike: the model is offered the host's
//    tools and, for a code-mode model, code mode's `exec` and `wait` that carry them;
//  - asks the runner before every paid request (`beforeRequest`, where a turn cap or the host's budget refuses it), adds
//    the provider key, forwards to the provider's origin and the route's own path (never text from the request), streams
//    the answer back, and reports the response's usage once it completes (`afterRequest`). A request cut off before its
//    usage arrived reports nothing: the runner counts it as a turn whose cost is unknown.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { GatewayHandlerOptions, GatewayRoute } from "./process.js";

export interface ModelUsageReport {
  input: number;
  output: number;
  cacheRead?: number;
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
  route: GatewayHandlerOptions;
  hooks: ModelProxyHooks;
  /** The price of a response, or null when it is unknown. */
  price?: (model: string, usage: { input: number; output: number; cacheRead: number }) => number | null;
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
  /** The session's own tool names: any other tool definition Codex adds is dropped. Unset, none is dropped. */
  tools?: readonly string[];
  /** For tests: the fetch the proxy forwards with. */
  fetch?: typeof fetch;
}

export interface ModelProxy {
  /** The base URL Codex is given (`<url>/v1`). */
  readonly url: string;
  /** The key Codex sends, which the proxy admits. */
  readonly key: string;
  close(): Promise<void>;
}

const UNSAFE_PATH = /[^A-Za-z0-9/_.\-?=&]|\.\.|\/\/|^[^/]|\?.*\?/;
const HOSTED_TOOL = /^(?:web_search|web_search_preview|file_search|code_interpreter|computer|computer_use|computer_use_preview|image_generation|mcp|local_shell|shell)/;
const MAX_BODY = 32 * 1024 * 1024;

export class ProxyRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ProxyRefusal"; }
}

/** Match a request's method and path text against the routes, never parsing the path as a URL. */
export function matchRoute(routes: readonly GatewayRoute[], method: string, path: string): GatewayRoute {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048 || UNSAFE_PATH.test(path)) throw new ProxyRefusal(403, "the path is not one the table can match");
  const at = path.indexOf("?");
  const pathname = at < 0 ? path : path.slice(0, at);
  if (at >= 0) throw new ProxyRefusal(403, "no query is listed");
  const route = routes.find((r) => r.method === method && r.path === pathname);
  if (!route) throw new ProxyRefusal(403, `${method.slice(0, 16)} ${pathname.slice(0, 128)} is not in the table`);
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

/** Code mode's carriers: the tools a code-mode model calls the session's tools through. */
const CODE_MODE: Readonly<Record<string, string>> = Object.freeze({ exec: "custom", wait: "function" });

/** A list of tool definitions with no hosted tool, less any not the session's own (or code mode's carriers). */
function ownTools(tools: unknown, allowed: ReadonlySet<string> | undefined, carriers: boolean): unknown[] {
  if (!Array.isArray(tools)) throw new ProxyRefusal(400, "tools is not a list");
  const out: unknown[] = [];
  for (const tool of tools) {
    const { type: rawType, name: rawName, tools: inner } = (tool ?? {}) as { type?: unknown; name?: unknown; tools?: unknown };
    const type = String(rawType ?? "");
    const name = String(rawName ?? "");
    if (type === "namespace" && carriers) {
      out.push({ ...(tool as object), tools: ownTools(inner, allowed, true) });
      continue;
    }
    if (HOSTED_TOOL.test(type) || (type !== "function" && type !== "custom")) throw new ProxyRefusal(403, `a ${type.slice(0, 40) || "typeless"} tool is not offered to this session's model`);
    if (!allowed || allowed.has(name) || (carriers && CODE_MODE[name] === type)) out.push(tool);
  }
  return out;
}

/** The body the provider gets: the session's model, no stored response, clamped output, no hosted tool, and only the
 *  session's own tools (`allowed`), with code mode's carriers in its `additional_tools`. */
export function applyPolicy(body: unknown, model: string, maxOutputTokens: number, allowed?: ReadonlySet<string>): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProxyRefusal(400, "the body is not an object");
  const out = { ...(body as Record<string, unknown>) };
  if (out.tools !== undefined) out.tools = ownTools(out.tools, allowed, false);
  if (Array.isArray(out.input)) {
    out.input = out.input.map((item) => {
      const it = item as { type?: unknown; tools?: unknown };
      return it?.type === "additional_tools" ? { ...it, tools: ownTools(it.tools, allowed, true) } : item;
    });
  }
  const asked = typeof out.max_output_tokens === "number" && out.max_output_tokens > 0 ? out.max_output_tokens : maxOutputTokens;
  return { ...out, model, store: false, max_output_tokens: Math.min(asked, maxOutputTokens) };
}

const sameKey = (given: string, key: string): boolean => {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
};

/** The usage a Responses stream (or body) reports when it completes, if it does. */
export function usageOf(text: string): { input: number; output: number; cacheRead: number } | undefined {
  let found: { input: number; output: number; cacheRead: number } | undefined;
  for (const m of text.matchAll(/"usage"\s*:\s*\{[^{}]*?"input_tokens"\s*:\s*(\d+)(?:[^{}]*?"input_tokens_details"\s*:\s*\{[^{}]*?"cached_tokens"\s*:\s*(\d+)[^{}]*\})?[^{}]*?"output_tokens"\s*:\s*(\d+)/g)) {
    found = { input: Number(m[1]), cacheRead: Number(m[2] ?? 0), output: Number(m[3]) };
  }
  return found;
}

/** Start the session's model proxy on the loopback interface. */
export async function startModelProxy(options: ModelProxyOptions, key: string): Promise<ModelProxy> {
  const { route: handler, hooks } = options;
  const model = handler.models.model;
  const maxOutputTokens = options.maxOutputTokens ?? 32_000;
  const allowed = options.tools ? new Set(options.tools) : undefined;
  const forward = options.fetch ?? fetch;
  const origin = new URL(handler.target).origin;
  const inflight = new Set<AbortController>();

  const refuse = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_proxy" } }));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    const auth = String(req.headers.authorization ?? "");
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!sameKey(given, key)) return refuse(res, 401, "this session's key is required");
    let route: GatewayRoute;
    try { route = matchRoute(handler.routes, req.method ?? "", req.url ?? ""); } catch (error) {
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
      body = applyPolicy(parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), model, maxOutputTokens, allowed);
    } catch (error) {
      const e = error as ProxyRefusal;
      return refuse(res, e.status ?? 400, e.message ?? "the body was refused");
    }
    try {
      await hooks.beforeRequest({ model });
    } catch (error) {
      // 400, not 429: Codex retries a 429, and the runner already refused this one (a turn cap, the host's budget).
      return refuse(res, 400, `refused before it was sent: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
    const credential = await handler.credential();
    if (!credential) return refuse(res, 500, "the session has no provider credential");
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${credential}` };
    for (const name of route.headers ?? []) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const controller = new AbortController();
    inflight.add(controller);
    res.on("close", () => controller.abort());
    let seen = "";
    try {
      const upstream = await forward(`${origin}${route.path}`, { method: route.method, headers, body: JSON.stringify(body), signal: controller.signal });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      const decoder = new TextDecoder();
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          // Only the tail matters for the usage, which comes at the end.
          seen = (seen + decoder.decode(chunk, { stream: true })).slice(-64 * 1024);
        }
      }
      res.end();
      const usage = upstream.ok ? usageOf(seen) : { input: 0, output: 0, cacheRead: 0 };
      if (usage) {
        const usd = upstream.ok ? (options.price?.(model, usage) ?? null) : 0;
        handler.ledger?.add(usd ?? 0, { method: route.method, path: route.path, model, ...(usd === null ? { estimated: true } : {}) });
        await hooks.afterRequest({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, usd, ...(usd === null ? { estimated: true } : {}) });
      }
    } catch (error) {
      handler.log?.("model proxy: the request did not complete", { error: String((error as Error)?.message ?? error).slice(0, 200) });
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
  if (!address || typeof address === "string") throw new Error("agentrun-codex: the model proxy has no port");
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
