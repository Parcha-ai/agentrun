// The serve mode, a Durable Object stub's fetch over pi's own API. The instance answers `POST /submit` (pi's
// submit with the caller's `requestId`, which pi deduplicates in the run's store, so a retry that lands on the next
// incarnation finds the same submission), `POST /abort`, `GET /events` (pi's agent events as server-sent events) and
// `GET /status`. It listens before the run opens, so its address can go into run.json's holder, and answers 503 with a
// code while the run opens, parks or is released. `requestRun` is the client: it finds the instance through run.json,
// starts the run through `ensureRunning` (with demand) when it is released or gone, and retries while it starts.
// Open requests keep the instance up (parking waits for none). On loopback a bearer token is optional; on any other
// address it is required, read from a private file, and checked in constant time on every route.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ConversationBusy, watchEvents } from "@earendil-works/pi-durable";
import type { Conversation, ConversationId, EntryId, Harness, SubmissionId, SubmissionRecord, UserInput } from "@earendil-works/pi-durable";
import type { RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import { busyState } from "./park.ts";
import type { DurableRun } from "./run.ts";
import { isLeaseFresh, type RunRecord } from "./status.ts";
import { ensureRunning, LEASE_EXPIRY_MS, readRunStatus, type EnsureOptions, type EnsureResult, type HostDriver } from "./supervise.ts";

/** 503 codes the client answers by asking the supervisor again and retrying. */
export const RETRY_CODES = ["OPENING", "PARKING", "RELEASED"] as const;
export type ServeCode = (typeof RETRY_CODES)[number] | "BAD_REQUEST" | "UNAUTHORIZED" | "NOT_FOUND" | "BUSY" | "FAILED";

const MAX_BODY = 1 << 20;
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;

export interface ServeOptions {
  /** Default 0: any free port (the address is in `url` and in run.json's holder). */
  readonly port?: number;
  /** Default 127.0.0.1. Any address that is not loopback needs `token`. */
  readonly host?: string;
  /** Every request must carry `authorization: Bearer <token>` (see `readServeToken`). Optional on loopback only. */
  readonly token?: string;
  /** How the root conversation is created when absent (pi's `root()` options); a submit without `conversationId` goes there. */
  readonly root?: Parameters<Harness["root"]>[1];
  /** Called each time the last open request ends (parking looks again). */
  readonly onIdle?: () => void;
  readonly context?: Context;
}

export interface RunServer {
  /** `http://<host>:<port>`. */
  readonly url: string;
  /** Open requests: submits waiting for their answer, event streams. */
  readonly active: number;
  /** Serve this run (until then every request is 503 OPENING). */
  attach(run: DurableRun): void;
  /** Refuse new submissions with 503 PARKING; the returned function admits them again. */
  pause(): () => void;
  close(): Promise<void>;
}

export type ServeTokenErrorCode = "SERVE_TOKEN_REQUIRED" | "SERVE_TOKEN_INVALID";

/** A non-loopback address without a token, or a token file that is missing, empty or not private. Exit 2 (usage). */
export class ServeTokenError extends PdaError {
  constructor(code: ServeTokenErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, { cause: options.cause, exitCode: 2 });
  }
}

/** 127.0.0.0/8, ::1 (also as an IPv4-mapped address) and `localhost`; everything else reaches the network. */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  return h.startsWith("::ffff:127.") && isIP(h) === 6;
}

/**
 * The serve token from `path`: a regular file no one but its owner may read or write (0600 or stricter), holding one
 * token without whitespace. Read from a file so it is never in argv or an environment.
 */
export function readServeToken(path: string): string {
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a regular file");
    mode = st.mode & 0o777;
  } catch (cause) {
    throw new ServeTokenError("SERVE_TOKEN_INVALID", `cannot use ${path} as the serve token file: ${(cause as Error).message}`, { cause });
  }
  if (mode & 0o077) throw new ServeTokenError("SERVE_TOKEN_INVALID", `${path} has mode ${mode.toString(8)}; the serve token file must be 0600`);
  const token = readFileSync(path, "utf8").trim();
  if (!token || /\s/.test(token)) throw new ServeTokenError("SERVE_TOKEN_INVALID", `${path} holds no token, or one with whitespace`);
  return token;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

class HttpError extends Error {
  readonly status: number;
  readonly code: ServeCode;
  constructor(status: number, code: ServeCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = (code: (typeof RETRY_CODES)[number], message: string) => new HttpError(503, code, message);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...(status === 503 ? { "retry-after": "1" } : {}) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "BAD_REQUEST", `body over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "body is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "BAD_REQUEST", "body is not a JSON object");
  return value as Record<string, unknown>;
}

const optionalId = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(400, "BAD_REQUEST", `${name} must be a non-negative integer`);
  return value as number;
};

/** The text of an answer entry (an assistant message's text blocks). */
async function answerOf(conversation: Conversation, entry: EntryId, context: Context): Promise<{ entry: EntryId; text: string }> {
  const page = await conversation.entries({ minEntryId: entry, maxEntryId: entry }, 1, undefined, context);
  const text = (page.items[0]?.model ?? [])
    .flatMap((m) => (m.role === "assistant" ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : []))
    .join("");
  return { entry, text };
}

/** Start listening; requests are answered once `attach` hands over the open run. */
export async function serveRun(options: ServeOptions = {}): Promise<RunServer> {
  const base = options.context ?? BACKGROUND_CONTEXT;
  const bind = options.host ?? "127.0.0.1";
  if (options.token !== undefined && (!options.token || /\s/.test(options.token))) throw new ServeTokenError("SERVE_TOKEN_INVALID", "the serve token is empty or has whitespace");
  if (options.token === undefined && !isLoopback(bind)) {
    throw new ServeTokenError("SERVE_TOKEN_REQUIRED", `serving on ${bind}, which is not loopback, needs a bearer token (--serve-token-file)`);
  }
  // Both sides are hashed to one length, so the comparison takes the same time whatever the caller sent.
  const expected = options.token === undefined ? undefined : digest(`Bearer ${options.token}`);
  const authorized = (req: IncomingMessage) => expected === undefined || timingSafeEqual(digest(req.headers.authorization ?? ""), expected);
  let run: DurableRun | undefined;
  let closed = false;
  let pauses = 0;
  let active = 0;
  const hold = () => void active++;
  const letGo = () => {
    if (--active === 0) options.onIdle?.();
  };

  const harness = (): Harness => {
    if (!run) throw unavailable("OPENING", "the run is still opening");
    if (closed || run.fenced) throw unavailable("RELEASED", "the run is released or fenced on this instance");
    return run.harness;
  };
  const conversationOf = async (id: number | undefined, context: Context): Promise<Conversation> => {
    const h = harness();
    if (id === undefined) return h.root(context, options.root);
    const conversation = await h.conversation(id as ConversationId, context);
    if (!conversation) throw new HttpError(404, "NOT_FOUND", `no conversation ${id}`);
    return conversation;
  };

  async function submit(body: Record<string, unknown>, context: Context): Promise<unknown> {
    const { requestId, content, whenBusy, wait } = body;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new HttpError(400, "BAD_REQUEST", "requestId must be 1 to 200 printable ASCII characters");
    if (typeof content !== "string" && !Array.isArray(content)) throw new HttpError(400, "BAD_REQUEST", "content must be a string or an array of content blocks");
    if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp" && whenBusy !== "reject") throw new HttpError(400, "BAD_REQUEST", "whenBusy is steer, followUp or reject");
    if (pauses > 0) throw unavailable("PARKING", "the run is parking or draining");
    const conversation = await conversationOf(optionalId(body.conversationId, "conversationId"), context);
    const submission = await conversation.submit({ type: "input", requestId, content: content as UserInput, ...(whenBusy === undefined ? {} : { whenBusy }) }, context);
    let record: SubmissionRecord = await submission.status(context);
    if (wait === true) record = await submission.wait(context);
    const answer = record.type === "input" && record.status === "done" ? await answerOf(conversation, record.answer, context) : undefined;
    return { run: run!.ref.id, generation: run!.generation, submission: record, ...(answer ? { answer } : {}) };
  }

  async function abort(body: Record<string, unknown>, context: Context): Promise<unknown> {
    const submissionId = optionalId(body.submissionId, "submissionId");
    const conversationId = optionalId(body.conversationId, "conversationId");
    if (submissionId !== undefined) {
      const result = await harness().abortSubmission(submissionId as SubmissionId, context, conversationId as ConversationId | undefined);
      if (result === "not_found") throw new HttpError(404, "NOT_FOUND", `no submission ${submissionId}`);
      return { result };
    }
    await (await conversationOf(conversationId, context)).abort(context);
    return { result: "aborted" };
  }

  async function status(context: Context): Promise<unknown> {
    const inspection = await harness().inspect(context);
    return {
      run: run!.ref.id,
      generation: run!.generation,
      status: run!.record.status,
      busy: busyState(inspection, Date.now(), 0),
      scheduling: inspection.scheduling,
      tasks: inspection.tasks.map((t) => ({ id: t.record.id, kind: t.record.kind, state: t.state.kind })),
      submissions: inspection.submissions.length,
    };
  }

  async function events(req: IncomingMessage, res: ServerResponse, url: URL, context: Context): Promise<void> {
    const raw = url.searchParams.get("conversationId");
    const conversation = await conversationOf(raw === null ? undefined : optionalId(Number(raw), "conversationId"), context);
    const stream = await watchEvents(harness(), conversation.id, base);
    const write = (event: string, data: unknown) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    hold();
    write("snapshot", stream.snapshot);
    stream.start(async (batch) => write("events", batch));
    req.once("close", () => void stream.stop());
    void stream.closed.then((end) => {
      write("end", { reason: end.reason });
      res.end();
      letGo();
    });
  }

  const server = createServer((req, res) => {
    if (!authorized(req)) {
      res.setHeader("www-authenticate", "Bearer");
      return send(res, 401, { error: "UNAUTHORIZED", message: "a bearer token is required" });
    }
    const abortOnClose = new AbortController();
    res.once("close", () => abortOnClose.abort());
    const context = withAbortSignal(abortOnClose.signal, base);
    const url = new URL(req.url ?? "/", "http://serve");
    const route = `${req.method} ${url.pathname}`;
    const answer = async () => {
      switch (route) {
        case "POST /submit": {
          const body = await readJson(req);
          hold();
          try {
            return send(res, 200, await submit(body, context));
          } finally {
            letGo();
          }
        }
        case "POST /abort":
          return send(res, 200, await abort(await readJson(req), context));
        case "GET /status":
          return send(res, 200, await status(context));
        case "GET /events":
          return events(req, res, url, context);
        default:
          throw new HttpError(404, "NOT_FOUND", `no route ${route}`);
      }
    };
    answer().catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
      if (error instanceof ConversationBusy) return send(res, 409, { error: "BUSY", message: error.message });
      if (run && (closed || run.fenced)) return send(res, 503, { error: "RELEASED", message: (error as Error).message });
      send(res, 500, { error: "FAILED", message: (error as Error)?.message ?? String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bind, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    get active() {
      return active;
    },
    attach(open) {
      run = open;
      open.harness.subscribeClose(() => void (closed = true));
    },
    pause() {
      pauses++;
      let undone = false;
      return () => {
        if (!undone) (undone = true), pauses--;
      };
    },
    close() {
      closed = true;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

// ---- the client --------------------------------------------------------------------------------------------------------

export type ServeErrorCode = "RUN_TERMINAL" | "NOT_SERVED";

/** The run is done or failed (RUN_TERMINAL), or no instance answered before the deadline (NOT_SERVED). */
export class ServeError extends PdaError {
  readonly ensured: readonly EnsureResult[];
  constructor(code: ServeErrorCode, message: string, ensured: readonly EnsureResult[]) {
    super(code, message);
    this.ensured = ensured;
  }
}

export interface RequestOptions {
  readonly host: HostDriver;
  /** ensureRunning's options; every call here is a demand. */
  readonly ensure: Omit<EnsureOptions, "demand">;
  /** Give up after this long; default 120 s. A submit that waits for its answer needs room for the model. */
  readonly timeoutMs?: number;
  /**
   * How long an instance this call started may take to open before the supervisor is asked again; default 60 s. Until
   * then a second start would only be refused (76): the control API can list the new mount late.
   */
  readonly startTimeoutMs?: number;
  /** The instance's serve token, sent as `authorization: Bearer <token>`. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export type RunResponse = {
  readonly status: number;
  readonly body: JsonValue;
  /** The instance that answered. */
  readonly url: string;
  /** Every ensureRunning result on the way, in order (empty when the instance answered at once). */
  readonly ensured: readonly EnsureResult[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The running holder's serve address while its lease is fresh; otherwise there is no instance to talk to. */
function servedBy(record: RunRecord | null, now: number, leaseMs: number): string | undefined {
  if (record?.status !== "running" || !isLeaseFresh(record, now, leaseMs)) return undefined;
  return typeof record.holder?.serve === "string" ? record.holder.serve : undefined;
}

/**
 * Send one request to run `ref`'s instance, waking it if needed: read run.json (S3) and send the request to the running
 * holder's `serve` address while its lease is fresh. When there is none, it does not answer, it answers 503 with a
 * retry code, or its lease lapses while the request is open (a frozen instance accepts connections and never answers;
 * run.json is read again every third of a lease), ask `ensureRunning` with demand (start a released or lost run) and
 * try again until `timeoutMs`. After a start, its own or one the supervisor reports `starting`, it waits for that
 * instance to write its generation (or `startTimeoutMs`) before asking again, and an instance still opening (503
 * OPENING) is waited for. A submit carries a `requestId`, so
 * resending it to the next incarnation is safe: pi admits it once.
 */
export async function requestRun(
  ref: RunRef,
  request: { readonly method: "GET" | "POST"; readonly path: string; readonly body?: JsonValue },
  options: RequestOptions,
): Promise<RunResponse> {
  const fetchFn = options.fetch ?? fetch;
  const now = options.ensure.now ?? Date.now;
  const leaseMs = options.ensure.leaseExpiryMs ?? LEASE_EXPIRY_MS;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const ensured: EnsureResult[] = [];
  const attempt = async (url: string) => {
    const stop = new AbortController();
    const watch = setInterval(() => {
      readRunStatus(options.ensure.control, ref.id).then(
        (r) => servedBy(r, now(), leaseMs) !== url && stop.abort(),
        () => {},
      );
    }, Math.min(Math.max(1_000, leaseMs / 3), 10_000));
    try {
      return await fetchFn(new URL(request.path, url), {
        method: request.method,
        headers: {
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      }).then(
        async (res) => ({ status: res.status, body: (await res.json().catch(() => null)) as JsonValue }),
        () => undefined,
      );
    } finally {
      clearInterval(watch);
    }
  };
  let pendingStart: { until: number; generation: number } | undefined;
  for (let pause = 100; ; pause = Math.min(pause * 2, 1_000)) {
    const record = await readRunStatus(options.ensure.control, ref.id);
    const url = servedBy(record, now(), leaseMs);
    let opening = false;
    if (url) {
      const r = await attempt(url);
      const code = (r?.body as { error?: unknown } | null)?.error;
      if (r && !(r.status === 503 && (RETRY_CODES as readonly unknown[]).includes(code))) return { ...r, url, ensured };
      opening = code === "OPENING";
    }
    // An instance that is opening, or a start in flight whose instance has not written its generation yet, is left to open.
    const generation = record?.generation ?? 0;
    const awaitingStart = pendingStart !== undefined && Date.now() < pendingStart.until && generation < pendingStart.generation;
    if (!opening && !awaitingStart) {
      const result = await ensureRunning(ref, options.host, { ...options.ensure, demand: true });
      ensured.push(result);
      if (result.action === "terminal") throw new ServeError("RUN_TERMINAL", `run ${ref.id} is ${result.status}`, ensured);
      // A start by this call, or one the supervisor's start grace reports in flight: wait for that generation.
      if (result.action === "started") pendingStart = { until: Date.now() + (options.startTimeoutMs ?? 60_000), generation: generation + 1 };
      if (result.action === "starting") pendingStart = { until: Date.now() + (options.startTimeoutMs ?? 60_000), generation: result.generation };
    }
    if (Date.now() + pause > deadline) throw new ServeError("NOT_SERVED", `run ${ref.id} did not answer in ${options.timeoutMs ?? 120_000} ms`, ensured);
    await sleep(pause);
  }
}
