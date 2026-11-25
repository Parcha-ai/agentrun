// A run's GenAI trace, exported over OTLP with the official OpenTelemetry Node SDK, on only when the standard endpoint
// variable is set (OTEL_EXPORTER_OTLP_ENDPOINT, or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and OTEL_SDK_DISABLED is not
// true. Off, nothing of OpenTelemetry is imported (every import of it below is a dynamic one, after that check, or a
// type's), no exporter starts and nothing leaves the machine. On, the exporter is given its endpoint, headers and
// timeout from the OTEL_EXPORTER_OTLP_* variables, and the resource OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
// (deployment.environment.name among them) over our service.name=agentrun and service.version. Those variables are the
// runner's own: no run's environment has them (runner/main.ts runEnv), and no run's process is handed them. A run in its
// own process (run-child.ts) traces over its channel (postedTracing): its runner makes its spans and exports them
// (tracePosts), so its harness, tools and computer never see an OTLP header, and it loads no exporter.
//
// What a span says is genai.ts's. Here: the spans' lifecycle, and the rules that keep a trace from costing a run
//  - one trace per run: its id is the run id's hash, so every claim of a run (a resume, a takeover) is in one trace, and
//    the sampler (always parent-based, its root's ratio from OTEL_TRACES_SAMPLER/_ARG) decides once per run, never
//    splitting a run's spans;
//  - an export that fails or throws is one log line (cut by the runner's redactor, which holds each OTLP header value
//    of 8 characters or more, then of each header value at any length: saidOf), and its spans are dropped: never the run's failure. A run's end never waits on an export: the batch processor sends
//    in the background, a run's process never flushes, and only the runner's close flushes once (flushTraces), for at
//    most FLUSH_MS.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Context, Span } from "@opentelemetry/api";
import type { SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { keyBase } from "@parcha/agentrun-computer";
import type { Ended, ModelUsage } from "@parcha/agentrun-kernel";
import { runnerSecrets, secretRedactor } from "../runner/redact.js";
import { keyValues, otlpHeaderCut } from "../secrets.js";
import { agentAttributes, chatAttributes, spanName, toolAttributes, written, type RouteTrace, type TraceEvent, type TracedRun } from "./genai.js";

/** The most the runner's closing flush waits for its spans' export. */
export const FLUSH_MS = 3_000;

/** The most model requests, and apart the most tool calls, one claim's trace holds open at once: one started past it
 *  has no span. A run's process posts its own trace (tracePosts) and runs the agent's code, so one that starts calls and
 *  never ends them can't grow its runner's memory without bound. */
export const OPEN_MAX = 512;

/** The OTLP exporter's settings from `env`, as the spec reads them: the traces endpoint as given, else the endpoint's
 *  /v1/traces; the headers (the traces' over the general ones); the timeout. The headers go to the endpoint, so it takes
 *  the rule of a URL a key goes to (keyBase) over http or https, since OTLP allows both and a collector is often a plain
 *  http one beside the server: one with a user, a password, a query or a fragment throws in those words, and tracing is
 *  off (genAiTracing). */
export function exporterConfig(env: NodeJS.ProcessEnv): { url: string; headers: Record<string, string>; timeoutMillis?: number } {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  // A traces endpoint, once checked, is used as given, as the spec says: a collector may tell /ingest/ from /ingest. The
  // general endpoint's /v1/traces is added to the rule's normalized return, never the raw string: a bare ? or # passes
  // the rule, and would put the path in a query.
  const checked = keyBase(traces || endpoint, traces ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" : "OTEL_EXPORTER_OTLP_ENDPOINT", ["http:", "https:"]);
  const url = traces || `${checked}/v1/traces`;
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT);
  return { url, headers: { ...keyValues(env.OTEL_EXPORTER_OTLP_HEADERS), ...keyValues(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) }, ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMillis: timeout } : {}) };
}

const TRUE = new Set(["1", "true", "yes", "on"]);

/** Whether `env` turns tracing on: an OTLP endpoint is named, and the SDK is not disabled. */
export function otelOn(env: NodeJS.ProcessEnv): boolean {
  if (TRUE.has((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase())) return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());
}

/** A run's trace, for one claim of it. */
export interface RunTrace {
  /** The run's facts, once its spec is known: its invoke_agent span starts then, at the claim's start. Said again (a
   *  restart's spec), nothing changes. */
  known(run: TracedRun): void;
  /** A model request admitted (`route`: the session's route it came by, where it names one): its chat span starts now,
   *  and the function it returns ends it with how it ended. One the claim's end finds still open ends interrupted. */
  request(model: string | undefined, route?: string): (usage: ModelUsage, ended?: Ended) => void;
  /** An event of the session (genai.ts tracedEvent): a tool call's start and end; on a plan-billed harness, its turns. */
  event(event: TraceEvent): void;
  /** The claim ended (`failed`: why, when it failed): every span still open ends, and is handed to the exporter, which
   *  sends it in the background; this never waits on an export. Never throws. */
  end(failed?: string): Promise<void>;
}

/** The tracing of one process: each claim of a run opens its trace. */
export interface GenAiTracing {
  open(options?: { readonly startedAt?: number }): RunTrace;
  /** Every ended span sent, waited for at most FLUSH_MS: once, as the runner closes. Never throws. */
  flush(): Promise<void>;
}

/** A run's own process's tracing (run-child.ts): each call of its claim's trace posted to its runner (`post`, in order
 *  with the rest of its channel), whose tracing makes the spans and exports them (tracePosts). The process loads no
 *  OpenTelemetry module, holds no OTLP setting and never flushes: its end waits on no collector. */
export function postedTracing(post: (method: string, args: unknown[]) => void): GenAiTracing {
  return {
    flush: async () => {},
    open: ({ startedAt = Date.now() } = {}) => {
      post("open", [startedAt]);
      let requests = 0;
      // An event that is no tool's or turn's end is read only as the first of its turn (a plan turn's start): one post.
      let heard = false;
      return {
        known: (run) => post("known", [run]),
        request: (model, route) => {
          const id = requests++;
          post("request", [id, model, route]);
          return (usage, ended) => post("ended", [id, usage, ended]);
        },
        event: (event) => {
          if (event.type === "other" && heard) return;
          heard = event.type !== "turn_end";
          post("event", [event]);
        },
        end: async (failed) => post("end", [failed]),
      };
    },
  };
}

/** The longest id a run's process posts (a call's, a parent's, a route's name) its runner keeps as given. */
const ID_MAX = 128;
const DIGEST = "sha256:";

/** An id a run's process posts, as its runner keeps it: as given when it is ID_MAX characters or fewer, else its
 *  SHA-256 (DIGEST and 64 hex), so every post of one id is kept as the same string of a fixed size. One given in that
 *  shape is hashed too, so no short id is ever taken for a long one. */
function keptId(id: string): string {
  return id.length > ID_MAX || id.startsWith(DIGEST) ? `${DIGEST}${createHash("sha256").update(id).digest("hex")}` : id;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const fields = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const figure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A provider id's shape (`anthropic`, `openrouter`, `claude-login`), and a host's (a DNS name, or a bracketed IPv6
 *  address as URL.hostname writes one). A name the redactor cut holds "[redacted]", which is neither. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;
/** A run failure's code (`run-error`, `sdk_failed`, `ECONNREFUSED`). */
const FAILURE_CODE = /^[a-z][a-z0-9_.-]*$/i;
/** Every label a request's end that did not answer can have (Ended): the only ones its span's error.type takes. */
const END_LABELS: Readonly<Record<Extract<Ended, { end: "nothing" | "lost" }>["label"], true>> = Object.freeze({ status: true, never_left: true, refused: true, error_before: true, error_after: true, gateway_timeout: true, retried: true, cut: true });
const TURN_STATUSES: ReadonlySet<string> = new Set(["completed", "interrupted", "failed"]);

/** A request's end as a post gives it, rebuilt of the fields its span reads alone: its kind, and a label only from the
 *  kernel's own (END_LABELS; an answer's `filtered` or `error`). No reason, no other words. An end of any other shape is
 *  read as none. */
function endedOf(value: unknown): Ended | undefined {
  const given = fields(value);
  if (given.end === "answered") return (given.label === "filtered" || given.label === "error" ? { end: "answered", usd: figure(given.usd) ?? null, label: given.label } : { end: "answered", usd: figure(given.usd) ?? null }) as Ended;
  if (given.end === "stopped") return { end: "stopped", streamedTokens: figure(given.streamedTokens) ?? 0 };
  if ((given.end === "nothing" || given.end === "lost") && typeof given.label === "string" && Object.hasOwn(END_LABELS, given.label)) return { end: given.end, label: given.label } as Ended;
  return undefined;
}

/** A request's usage as a post gives it, rebuilt of the fields its span reads alone: its counts as numbers (anything
 *  else is no count, and its span then has none), a plan's billing, a cut. */
function usageOf(value: unknown): ModelUsage {
  const given = fields(value);
  const count = (key: string) => (figure(given[key]) === undefined ? {} : { [key]: figure(given[key]) });
  return { input: figure(given.input) ?? Number.NaN, output: figure(given.output) ?? Number.NaN, ...count("cacheRead"), ...count("cacheWrite"), usd: figure(given.usd) ?? null, ...(given.billing === "plan" ? { billing: "plan" as const } : {}), ...(given.cut === true ? { cut: true } : {}) };
}

/** The runner's side of a run's process's trace (postedTracing): the claim's one trace, opened from `tracing` for run
 *  `runId` whatever the process names, and each post read as data alone (the process runs the agent's code). No string a
 *  post gives reaches a span as given:
 *  - a name (harness, model) is cut by the runner's redactor (`redact`) and at WRITTEN_MAX (written);
 *  - a provider id and a host are cut the same way, and dropped unless they still have their shape (PROVIDER_ID, HOST);
 *  - a call's id is shown cut (TraceEvent.shownId); its id, and a parent's, only match a call's end and children, and
 *    are kept at ID_MAX (keptId), as a route's name is;
 *  - a route's name a request gives only finds its route; it is on no span; at most OPEN_MAX routes are known;
 *  - a request's end and usage are rebuilt (endedOf, usageOf): error.type comes from the kernel's labels alone;
 *  - a turn's status is one of TurnStatus's, else `failed`; the claim's failure is a code's shape, else `run-error`;
 *  - at most OPEN_MAX requests, and OPEN_MAX calls, are open at once: one started past that, or again under an id still
 *    open, has no span.
 *  `end`: the claim's end, for a process that is gone without ending its trace (after its own end, nothing is left). */
export function tracePosts(tracing: GenAiTracing, runId: string, redact?: (text: string) => string): { post(method: string, args: readonly unknown[]): void; end(failed: string): Promise<void> } {
  let trace: RunTrace | undefined;
  const requests = new Map<number, (usage: ModelUsage, ended?: Ended) => void>();
  const name = (value: unknown): string | undefined => (typeof value === "string" ? written(value, redact) : undefined);
  const shaped = (value: unknown, shape: RegExp): string | undefined => {
    const cut = name(value);
    return cut && shape.test(cut) ? cut : undefined;
  };
  const via = (value: unknown): RouteTrace => {
    const given = fields(value);
    const [provider, serverAddress, model] = [shaped(given.provider, PROVIDER_ID), shaped(given.serverAddress, HOST), name(given.model)];
    return { ...(provider ? { provider } : {}), ...(serverAddress ? { serverAddress } : {}), ...(model ? { model } : {}) };
  };
  return {
    post(method, args) {
      if (method === "open") trace ??= tracing.open(figure(args[0]) === undefined ? {} : { startedAt: figure(args[0])! });
      if (!trace) return;
      if (method === "known") {
        const run = fields(args[0]);
        const routes = run.routes instanceof Map ? new Map([...run.routes].slice(0, OPEN_MAX).flatMap(([key, route]) => (typeof key === "string" ? [[keptId(key), via(route)] as const] : []))) : undefined;
        trace.known({ runId, harness: name(run.harness) ?? "unknown", ...(run.plan === true ? { plan: true } : {}), ...via(run), ...(routes ? { routes } : {}) });
      } else if (method === "request" && typeof args[0] === "number") {
        const route = text(args[2]);
        if (!requests.has(args[0]) && requests.size < OPEN_MAX) requests.set(args[0], trace.request(name(args[1]), route === undefined ? undefined : keptId(route)));
      }
      else if (method === "ended" && typeof args[0] === "number") {
        requests.get(args[0])?.(usageOf(args[1]), endedOf(args[2]));
        requests.delete(args[0]);
      } else if (method === "event") {
        const event = fields(args[0]);
        const given = text(event.callId) ?? "";
        const [callId, shownId] = [keptId(given), written(given, redact)];
        const parentId = text(event.parent);
        const parent = parentId ? { parent: keptId(parentId) } : {};
        if (event.type === "tool_start" && event.refused === true) trace.event({ type: "tool_start", callId, shownId, refused: true, ...parent });
        else if (event.type === "tool_start") trace.event({ type: "tool_start", callId, shownId, ...(name(event.name) ? { name: name(event.name) } : {}), ...(event.mcp === true ? { mcp: true } : {}), ...parent });
        else if (event.type === "tool_end") trace.event({ type: "tool_end", callId, isError: event.isError === true });
        else if (event.type === "turn_end") trace.event({ type: "turn_end", status: typeof event.status === "string" && TURN_STATUSES.has(event.status) ? event.status : "failed" });
        else trace.event({ type: "other" });
      } else if (method === "end") void trace.end(args[0] === undefined || args[0] === null ? undefined : (shaped(args[0], FAILURE_CODE) ?? "run-error"));
    },
    end: async (failed) => trace?.end(failed),
  };
}

/** For tests: the exporter in place of OTLP's (the SDK's InMemorySpanExporter), spans exported as each ends, and the
 *  log lines said. */
export interface TracingTest {
  readonly exporter: SpanExporter;
  readonly log?: (line: string) => void;
}

let shared: Promise<GenAiTracing | undefined> | undefined;

/** This process's tracing, or undefined while `env` leaves it off: then no @opentelemetry module is ever loaded. Made
 *  once per process; a test's (`test`) is its own. */
export function genAiTracing(env: NodeJS.ProcessEnv = process.env, test?: TracingTest): Promise<GenAiTracing | undefined> {
  if (!otelOn(env)) return Promise.resolve(undefined);
  if (test) return made(env, test);
  shared ??= made(env).catch((error: unknown) => {
    saidOf(env)(`[otel] tracing is off: the OpenTelemetry SDK did not start: ${(error as Error)?.message ?? error}`);
    return undefined;
  });
  return shared;
}

/** This process's closing flush (GenAiTracing.flush) of its tracing, when it was made; at once when it never was (off:
 *  nothing of OpenTelemetry is loaded for it). Never throws. */
export async function flushTraces(): Promise<void> {
  const tracing = await shared;
  await tracing?.flush();
}

/** A trace id for `runId`: the same for every claim of the run. */
export const traceIdOf = (runId: string): string => createHash("sha256").update(`agentrun-run:${runId}`).digest("hex").slice(0, 32);

const serveVersion = (): string => (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** The tracing's log (`given`, else the runner's console): each `[otel]` line cut first by the runner's redactor over
 *  `env` (runner/redact.ts runnerSecrets: its OTLP header values among them), since an exporter's error may quote a
 *  header it sent, then of every OTLP header value at any length (secrets.ts otlpHeaderCut): the redactor cuts none
 *  shorter than MIN_SECRET, and a tracing key may be. Every line of this module goes through here. */
function saidOf(env: NodeJS.ProcessEnv, given?: (line: string) => void): (line: string) => void {
  const cut = secretRedactor(runnerSecrets(env));
  const headers = otlpHeaderCut(env);
  const log = given ?? ((line: string) => console.warn(line));
  return (line) => log(headers(cut(line)));
}

async function made(env: NodeJS.ProcessEnv, test?: TracingTest): Promise<GenAiTracing> {
  const [api, sdk, resources] = await Promise.all([import("@opentelemetry/api"), import("@opentelemetry/sdk-trace"), import("@opentelemetry/resources")]);
  const log = saidOf(env, test?.log);
  const exporter = safeExporter(test?.exporter ?? new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter(exporterConfig(env)), log);
  // The next root span's trace id (the run's), taken by the one startSpan that asks for it: startSpan is synchronous.
  const ids = { next: undefined as string | undefined };
  const idGenerator = {
    generateTraceId: () => {
      const id = ids.next ?? randomBytes(16).toString("hex");
      ids.next = undefined;
      return id;
    },
    generateSpanId: () => randomBytes(8).toString("hex"),
  };
  // The operator's resource attributes over ours, read from `env` (a test's, or the runner's).
  const named = env.OTEL_SERVICE_NAME?.trim();
  const resource = resources.defaultResource()
    // The resource's names as the spec writes them: no module is loaded for two strings.
    .merge(resources.resourceFromAttributes({ "service.name": "agentrun", "service.version": serveVersion() }))
    .merge(resources.resourceFromAttributes({ ...keyValues(env.OTEL_RESOURCE_ATTRIBUTES), ...(named ? { "service.name": named } : {}) }));
  const provider: TracerProvider = new sdk.TracerProvider({
    resource,
    idGenerator,
    sampler: new sdk.ParentBasedSampler({ root: rootSampler(env, sdk) }),
    spanProcessors: [test ? new sdk.SimpleSpanProcessor({ exporter }) : new sdk.BatchSpanProcessor({ exporter })],
  });
  const tracer = provider.getTracer("agentrun", serveVersion());
  const flush = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, FLUSH_MS)));
    try {
      await Promise.race([Promise.resolve().then(() => provider.forceFlush()).catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  // A process that ends by running out of work (no close, no exit call) flushes once first.
  if (!test) process.once("beforeExit", () => void flush());
  return {
    flush,
    open: ({ startedAt = Date.now() } = {}) => {
      let run: TracedRun | undefined;
      let root: Span | undefined;
      let rootContext: Context | undefined;
      // Each open tool call's span, and the turn it started in (`turns`, the turns ended so far): a turn that did not
      // complete cuts its own calls, never one an earlier turn left going.
      const tools = new Map<string, { readonly span: Span; readonly turn: number; readonly refused: boolean }>();
      let turns = 0;
      // The chat spans of requests still waiting for their end (RunTrace.request).
      const chats = new Set<Span>();
      let turn: Span | undefined;
      const child = (name: string, kind: number, attributes: Record<string, unknown>, parent?: Context): Span =>
        tracer.startSpan(name, { kind, attributes: attributes as never }, parent ?? rootContext);
      const failed = (span: Span, type: string) => {
        span.setAttribute("error.type", type);
        span.setStatus({ code: api.SpanStatusCode.ERROR });
      };
      // A trace's own failure is never its run's: said once, and the trace goes on without what failed.
      let said = false;
      const guarded =
        <A extends unknown[], R>(fn: (...args: A) => R, fallback: R) =>
        (...args: A): R => {
          try {
            return fn(...args);
          } catch (error) {
            if (!said) log(`[otel] a span of a run's trace was dropped: ${(error as Error)?.message ?? error}`);
            said = true;
            return fallback;
          }
        };
      const trace: RunTrace = {
        known: (given) => {
          if (run) return;
          run = given;
          ids.next = traceIdOf(given.runId);
          try {
            root = tracer.startSpan(spanName.agent(given), { kind: api.SpanKind.INTERNAL, startTime: startedAt, attributes: agentAttributes(given) }, api.ROOT_CONTEXT);
          } finally {
            // Taken by that startSpan, or left by one that threw: never the next run's root's.
            ids.next = undefined;
          }
          rootContext = api.trace.setSpan(api.ROOT_CONTEXT, root);
        },
        request: (model, route) => {
          if (!run || run.plan || chats.size >= OPEN_MAX) return () => {};
          const on = run;
          const asked = { ...(model ? { model } : {}), ...(route === undefined ? {} : { route }) };
          const span = child(spanName.chat(model ?? on.model), api.SpanKind.CLIENT, chatAttributes(on, asked));
          chats.add(span);
          return guarded((usage: ModelUsage, ended?: Ended) => {
            if (!chats.delete(span)) return;
            const attributes = chatAttributes(on, asked, usage, ended);
            span.setAttributes(attributes);
            if (attributes["error.type"] !== undefined) span.setStatus({ code: api.SpanStatusCode.ERROR });
            span.end();
          }, undefined);
        },
        event: (event) => {
          if (!run) return;
          const on = run;
          // A plan-billed harness's turn is its model's: a chat span from its first event to its end, with no usage. A turn
          // that ends with no event before (its drive failed at once) has one too, from its end.
          if (on.plan && !turn) turn = child(spanName.chat(on.model), api.SpanKind.CLIENT, chatAttributes(on, {}));
          if (event.type === "tool_start") {
            if (tools.has(event.callId) || tools.size >= OPEN_MAX) return;
            const parent = event.parent ? tools.get(event.parent)?.span : undefined;
            // A call its harness refused (a tool the session does not have) is never named: the name is the model's words.
            const name = event.refused ? undefined : event.name;
            const span = child(spanName.tool(name), api.SpanKind.INTERNAL, toolAttributes(on, { ...(name ? { name } : {}), callId: event.shownId ?? event.callId, ...(event.mcp ? { mcp: true } : {}) }), parent ? api.trace.setSpan(api.ROOT_CONTEXT, parent) : undefined);
            if (event.refused) failed(span, "tool_refused");
            tools.set(event.callId, { span, turn: turns, refused: event.refused === true });
          } else if (event.type === "tool_end") {
            const call = tools.get(event.callId);
            if (!call) return;
            tools.delete(event.callId);
            if (event.isError && !call.refused) failed(call.span, "tool_error");
            call.span.end();
          } else if (event.type === "turn_end") {
            // A call its own turn ended with no end of its own was cut with the turn. One an earlier turn left going (a
            // call that outlived its turn) ends by its own end, or the claim's.
            if (event.status !== "completed") for (const [id, call] of tools) {
              if (call.turn !== turns) continue;
              failed(call.span, "interrupted");
              call.span.end();
              tools.delete(id);
            }
            turns += 1;
            if (turn) {
              if (event.status !== "completed") failed(turn, event.status);
              turn.end();
              turn = undefined;
            }
          }
        },
        end: async (why) => {
          try {
            for (const { span } of tools.values()) {
              failed(span, "interrupted");
              span.end();
            }
            tools.clear();
            // A request whose end the claim's end did not wait for (a booking still writing, a session closed past its
            // bound, a restart's session that never answered it): its chat span ends with the claim, interrupted.
            for (const span of chats) {
              failed(span, "interrupted");
              span.end();
            }
            chats.clear();
            if (turn) {
              failed(turn, "interrupted");
              turn.end();
              turn = undefined;
            }
            if (!root) return;
            if (why !== undefined) failed(root, why);
            root.end();
            root = undefined;
            // No flush here: the batch processor sends these spans in the background, and the process's close flushes
            // what is left (flushTraces), so no claim's end waits on a collector.
          } catch (error) {
            log(`[otel] a run's trace was not ended, its spans dropped: ${(error as Error)?.message ?? error}`);
          }
        },
      };
      return { known: guarded(trace.known, undefined), request: guarded(trace.request, () => {}), event: guarded(trace.event, undefined), end: trace.end };
    },
  };
}

/** The root span's sampler: OTEL_TRACES_SAMPLER's ratio (traceidratio, with or without parentbased_), off, or on (the
 *  default); every other span follows its root's decision (ParentBasedSampler), so a run is sampled whole or not at all. */
function rootSampler(env: NodeJS.ProcessEnv, sdk: typeof import("@opentelemetry/sdk-trace")) {
  const name = (env.OTEL_TRACES_SAMPLER ?? "").trim().toLowerCase().replace(/^parentbased_/, "");
  if (name === "always_off") return new sdk.AlwaysOffSampler();
  if (name === "traceidratio") {
    const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
    return new sdk.TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1);
  }
  return new sdk.AlwaysOnSampler();
}

/** `exporter` made safe for a run: a throw or a failed export is said once, in one line, and the spans are dropped; the
 *  next line is said only after an export has succeeded again, so a collector that is down is one line, not one a batch. */
function safeExporter(exporter: SpanExporter, log: (line: string) => void): SpanExporter {
  let failing = false;
  return {
    export: (spans, done) => {
      const failedWith = (why: unknown) => {
        if (!failing) log(`[otel] a trace export failed; its spans were dropped: ${(why as Error)?.message ?? why}`);
        failing = true;
        done({ code: 1 });
      };
      try {
        exporter.export(spans, (result) => {
          if (result.code === 0) {
            failing = false;
            done(result);
          } else failedWith(result.error ?? "the exporter said it failed");
        });
      } catch (error) {
        failedWith(error);
      }
    },
    shutdown: () => exporter.shutdown().catch(() => undefined),
    forceFlush: () => (exporter.forceFlush ? exporter.forceFlush().catch(() => undefined) : Promise.resolve()),
  };
}
