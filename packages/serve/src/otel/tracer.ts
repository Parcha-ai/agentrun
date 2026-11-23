// A run's GenAI trace, exported over OTLP with the official OpenTelemetry Node SDK, on only when the standard endpoint
// variable is set (OTEL_EXPORTER_OTLP_ENDPOINT, or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and OTEL_SDK_DISABLED is not
// true. Off, nothing of OpenTelemetry is imported (every import of it below is a dynamic one, after that check, or a
// type's), no exporter starts and nothing leaves the machine. On, the exporter reads every other OTEL_EXPORTER_OTLP_*
// variable (headers, protocol, timeout) itself, and the resource reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
// (deployment.environment.name among them) over our service.name=agentrun and service.version.
//
// What a span says is genai.ts's. Here: the spans' lifecycle, and the rules that keep a trace from costing a run
//  - one trace per run: its id is the run id's hash, so every claim of a run (a resume, a takeover) is in one trace, and
//    the sampler (always parent-based, its root's ratio from OTEL_TRACES_SAMPLER/_ARG) decides once per run, never
//    splitting a run's spans;
//  - an export that fails or throws is one log line, and its spans are dropped: never the run's failure. A run's end
//    waits for its spans' flush at most FLUSH_MS, so a collector that hangs never holds a run's end longer.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Context, Span } from "@opentelemetry/api";
import type { SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import type { AdapterEvent, Ended, ModelUsage } from "@parcha/agentrun-kernel";
import { agentAttributes, chatAttributes, spanName, toolAttributes, type TracedRun } from "./genai.js";

/** The most a run's end waits for its spans' export. */
export const FLUSH_MS = 3_000;

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
  /** An event of the session: a tool call's start and end; on a plan-billed harness, its turns. */
  event(event: AdapterEvent): void;
  /** The claim ended (`failed`: why, when it failed): every span still open ends, then its spans are flushed, waited for
   *  at most FLUSH_MS. Never throws. */
  end(failed?: string): Promise<void>;
}

/** The tracing of one process: each claim of a run opens its trace. */
export interface GenAiTracing {
  open(options?: { readonly startedAt?: number; readonly mcp?: (tool: string) => boolean }): RunTrace;
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
    console.warn(`[otel] tracing is off: the OpenTelemetry SDK did not start: ${(error as Error)?.message ?? error}`);
    return undefined;
  });
  return shared;
}

/** A trace id for `runId`: the same for every claim of the run. */
export const traceIdOf = (runId: string): string => createHash("sha256").update(`agentrun-run:${runId}`).digest("hex").slice(0, 32);

const serveVersion = (): string => (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

async function made(env: NodeJS.ProcessEnv, test?: TracingTest): Promise<GenAiTracing> {
  const [api, sdk, resources, semconv] = await Promise.all([import("@opentelemetry/api"), import("@opentelemetry/sdk-trace"), import("@opentelemetry/resources"), import("@opentelemetry/semantic-conventions")]);
  const log = test?.log ?? ((line: string) => console.warn(line));
  const exporter = safeExporter(test?.exporter ?? new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter(), log);
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
  const resource = resources.defaultResource()
    .merge(resources.resourceFromAttributes({ [semconv.ATTR_SERVICE_NAME]: "agentrun", [semconv.ATTR_SERVICE_VERSION]: serveVersion() }))
    .merge(resources.detectResources({ detectors: [resources.envDetector] }));
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
    await Promise.race([provider.forceFlush().catch(() => undefined), late]);
    clearTimeout(timer);
  };
  return {
    open: ({ startedAt = Date.now(), mcp = () => false } = {}) => {
      let run: TracedRun | undefined;
      let root: Span | undefined;
      let rootContext: Context | undefined;
      const tools = new Map<string, Span>();
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
          root = tracer.startSpan(spanName.agent(given), { kind: api.SpanKind.INTERNAL, startTime: startedAt, attributes: agentAttributes(given) }, api.ROOT_CONTEXT);
          ids.next = undefined;
          rootContext = api.trace.setSpan(api.ROOT_CONTEXT, root);
        },
        request: (model, route) => {
          if (!run || run.plan) return () => {};
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
            if (tools.has(event.callId)) return;
            const parent = event.parent ? tools.get(event.parent) : undefined;
            tools.set(event.callId, child(spanName.tool(event.name), api.SpanKind.INTERNAL, toolAttributes(on, { name: event.name, callId: event.callId, mcp: mcp(event.name) }), parent ? api.trace.setSpan(api.ROOT_CONTEXT, parent) : undefined));
          } else if (event.type === "tool_end") {
            const span = tools.get(event.callId);
            if (!span) return;
            tools.delete(event.callId);
            if (event.isError) failed(span, "tool_error");
            span.end();
          } else if (event.type === "turn_end") {
            // A call its turn ended with no end of its own was cut with the turn.
            if (event.status !== "completed") for (const [id, span] of tools) {
              failed(span, "interrupted");
              span.end();
              tools.delete(id);
            }
            if (turn) {
              if (event.status !== "completed") failed(turn, event.status);
              turn.end();
              turn = undefined;
            }
          }
        },
        end: async (why) => {
          try {
            for (const span of tools.values()) {
              failed(span, "interrupted");
              span.end();
            }
            tools.clear();
            // A request whose end the claim's end did not wait for (a booking still writing, a session closed past its
            // bound): its chat span ends with the claim, interrupted, before the flush.
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
            await flush();
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
