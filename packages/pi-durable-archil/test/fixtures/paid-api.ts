// A fake paid API for crash tests: an HTTP endpoint that counts every request it receives by route and idempotency key,
// so a test can tell how many times an effect was dispatched. It never deduplicates: a re-sent effect shows as a count
// above one for its key. A hold keeps matching requests open (counted, not answered) until it is released, so a test
// can cut an effect in the middle of its dispatch; a held request whose client goes away before the answer is `cut`.
//
// In process:      const api = await startPaidApi();  ...  api.count("charge", key);  await api.close();
// Out of process:  node test/fixtures/paid-api.ts [--port 8787] [--host 127.0.0.1] [--log requests.jsonl]
//                  prints one line {"url": ...} once it listens.
// Effect routes:   POST /<route> with an `Idempotency-Key` header (required) and an optional JSON body; `X-Writer`
//                  names the caller. The answer is {ok, route, key, seq, count}: `count` is this key's dispatches so far.
// Control routes:  GET /_requests[?route=R]  GET /_counts?route=R  POST /_hold {route, key?, n?}  POST /_release {id?}
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type RequestState = "answered" | "held" | "cut";

/** One request as the server saw it. `nth` is 1 for a key's first dispatch on its route, 2 for a repeat, and so on. */
export interface PaidRequest {
  readonly seq: number;
  readonly route: string;
  readonly key: string;
  readonly nth: number;
  readonly writer: string | null;
  readonly body: unknown;
  /** Epoch milliseconds. */
  readonly receivedAt: number;
  state: RequestState;
  answeredAt: number | null;
  cutAt: number | null;
  /** The hold that caught it, if any. */
  holdId: number | null;
}

/** What an effect route answers. */
export interface PaidAnswer {
  readonly ok: true;
  readonly route: string;
  readonly key: string;
  readonly seq: number;
  readonly count: number;
}

export interface HoldRule {
  readonly route: string;
  /** Only this idempotency key. */
  readonly key?: string;
  /** Only requests for which this returns true (in process only). */
  readonly match?: (request: PaidRequest) => boolean;
  /** How many requests the hold catches before it stops matching; default 1. */
  readonly count?: number;
}

export interface Hold {
  readonly id: number;
  /** The requests it caught, in order. */
  readonly caught: readonly PaidRequest[];
  /** Resolves with the first request it catches. */
  readonly first: Promise<PaidRequest>;
  /** Answer every request it holds (a cut one stays cut) and stop matching. */
  release(): void;
}

export interface PaidApi {
  readonly url: string;
  readonly port: number;
  /** Every request so far, in arrival order; optionally one route's. */
  requests(route?: string): PaidRequest[];
  /** Dispatches of `key` on `route`. */
  count(route: string, key: string): number;
  /** Dispatches per key on `route`. */
  counts(route: string): Record<string, number>;
  hold(rule: HoldRule): Hold;
  /** Release every hold. */
  releaseAll(): void;
  /** Resolves with the first request (past or future) that matches, or rejects after `ms`. */
  waitFor(match: (request: PaidRequest) => boolean, ms?: number): Promise<PaidRequest>;
  close(): Promise<void>;
}

export interface PaidApiOptions {
  /** Default 0 (any free port). */
  readonly port?: number;
  /** Default 127.0.0.1. */
  readonly host?: string;
  /** Append every received, answered and cut event to this file, one JSON object per line. */
  readonly log?: string;
}

const KEY_HEADER = "idempotency-key";
const WRITER_HEADER = "x-writer";
const ROUTE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

type Pending = { request: PaidRequest; respond: () => void };
type HoldState = { hold: Hold; rule: HoldRule; caught: PaidRequest[]; pending: Pending[]; released: boolean; resolveFirst: (r: PaidRequest) => void };

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export async function startPaidApi(options: PaidApiOptions = {}): Promise<PaidApi> {
  const all: PaidRequest[] = [];
  const holds: HoldState[] = [];
  const waiters = new Set<{ match: (r: PaidRequest) => boolean; resolve: (r: PaidRequest) => void }>();
  let nextHold = 1;
  const log = (event: string, request: PaidRequest) => {
    if (options.log) appendFileSync(options.log, `${JSON.stringify({ event, at: Date.now(), ...request })}\n`);
  };
  const count = (route: string, key: string) => all.filter((r) => r.route === route && r.key === key).length;

  function hold(rule: HoldRule): Hold {
    let resolveFirst!: (r: PaidRequest) => void;
    const first = new Promise<PaidRequest>((resolve) => (resolveFirst = resolve));
    const state: HoldState = {
      rule,
      caught: [],
      pending: [],
      released: false,
      resolveFirst,
      hold: {
        id: nextHold++,
        get caught() {
          return state.caught;
        },
        first,
        release() {
          state.released = true;
          for (const p of state.pending.splice(0)) p.respond();
        },
      },
    };
    holds.push(state);
    return state.hold;
  }

  function catcher(request: PaidRequest): HoldState | undefined {
    return holds.find(
      (h) =>
        !h.released &&
        h.caught.length < (h.rule.count ?? 1) &&
        h.rule.route === request.route &&
        (h.rule.key === undefined || h.rule.key === request.key) &&
        (h.rule.match === undefined || h.rule.match(request)),
    );
  }

  async function effect(route: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = req.headers[KEY_HEADER];
    const body = await readBody(req);
    if (typeof key !== "string" || key === "") return sendJson(res, 400, { ok: false, error: "an Idempotency-Key header is required" });
    const writer = req.headers[WRITER_HEADER];
    const request: PaidRequest = {
      seq: all.length + 1,
      route,
      key,
      nth: count(route, key) + 1,
      writer: typeof writer === "string" ? writer : null,
      body,
      receivedAt: Date.now(),
      state: "held",
      answeredAt: null,
      cutAt: null,
      holdId: null,
    };
    all.push(request);
    log("received", request);
    const respond = () => {
      if (request.state !== "held" || res.destroyed) return;
      request.state = "answered";
      request.answeredAt = Date.now();
      sendJson(res, 200, { ok: true, route, key, seq: request.seq, count: count(route, key) } satisfies PaidAnswer);
      log("answered", request);
    };
    // The client went away before the answer: the effect reached the server, and its caller never learned the outcome.
    res.once("close", () => {
      if (request.state !== "held") return;
      request.state = "cut";
      request.cutAt = Date.now();
      log("cut", request);
    });
    const h = catcher(request);
    for (const w of [...waiters]) if (w.match(request)) (waiters.delete(w), w.resolve(request));
    if (!h) return respond();
    request.holdId = h.hold.id;
    h.caught.push(request);
    h.pending.push({ request, respond });
    if (h.caught.length === 1) h.resolveFirst(request);
  }

  async function control(path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = url.searchParams.get("route") ?? undefined;
    if (req.method === "GET" && path === "/_requests") return sendJson(res, 200, all.filter((r) => route === undefined || r.route === route));
    if (req.method === "GET" && path === "/_counts") return sendJson(res, 200, api.counts(route ?? ""));
    if (req.method === "POST" && path === "/_hold") {
      const body = (await readBody(req)) as { route?: unknown; key?: unknown; n?: unknown } | null;
      if (typeof body?.route !== "string") return sendJson(res, 400, { ok: false, error: "route is required" });
      const h = hold({ route: body.route, ...(typeof body.key === "string" ? { key: body.key } : {}), ...(typeof body.n === "number" ? { count: body.n } : {}) });
      return sendJson(res, 200, { ok: true, id: h.id });
    }
    if (req.method === "POST" && path === "/_release") {
      const body = (await readBody(req)) as { id?: unknown } | null;
      for (const h of holds) if (typeof body?.id !== "number" || h.hold.id === body.id) h.hold.release();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { ok: false, error: `no control route ${req.method} ${path}` });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://paid.invalid");
    const handle = url.pathname.startsWith("/_")
      ? control(url.pathname, url, req, res)
      : req.method === "POST" && ROUTE.test(url.pathname)
        ? effect(ROUTE.exec(url.pathname)![1]!, req, res)
        : Promise.resolve(sendJson(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` }));
    handle.catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) });
    });
  });
  // A held request may stay open for as long as a test freezes its client.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const api: PaidApi = {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    port: address.port,
    requests: (route) => all.filter((r) => route === undefined || r.route === route),
    count,
    counts(route) {
      const out: Record<string, number> = {};
      for (const r of all) if (r.route === route) out[r.key] = (out[r.key] ?? 0) + 1;
      return out;
    },
    hold,
    releaseAll() {
      for (const h of holds) h.hold.release();
    },
    waitFor(match, ms = 60_000) {
      const seen = all.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: (r: PaidRequest) => (clearTimeout(timer), resolve(r)) };
        const timer = setTimeout(() => (waiters.delete(waiter), reject(new Error(`no matching request in ${ms} ms`))), ms);
        waiters.add(waiter);
      });
    },
    async close() {
      api.releaseAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}

/**
 * Dispatch one effect: POST `body` to `<url>/<route>` with `key` as its Idempotency-Key. Resolves with the answer;
 * rejects on a transport error or a non-200 answer. Meant for the tool that performs the effect.
 */
export async function dispatch(url: string, route: string, key: string, body: unknown = null, options: { writer?: string; signal?: AbortSignal } = {}): Promise<PaidAnswer> {
  const res = await fetch(`${url}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, ...(options.writer ? { "x-writer": options.writer } : {}) },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const answer = (await res.json()) as PaidAnswer | { ok: false; error: string };
  if (res.status !== 200 || !answer.ok) throw new Error(`${route} ${key}: HTTP ${res.status} ${JSON.stringify(answer)}`);
  return answer;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  const { values } = parseArgs({ options: { port: { type: "string" }, host: { type: "string" }, log: { type: "string" } } });
  const api = await startPaidApi({ port: values.port ? Number(values.port) : 0, ...(values.host ? { host: values.host } : {}), ...(values.log ? { log: values.log } : {}) });
  process.stdout.write(`${JSON.stringify({ url: api.url })}\n`);
  const stop = () => void api.close().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
