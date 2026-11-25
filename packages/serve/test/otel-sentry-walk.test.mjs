// A run's GenAI trace read the way Sentry reads it. One run through the runner and the adapter loop, with a stand-in
// harness whose one turn asks Anthropic (with a cache read and a cache write), calls a tool, asks OpenAI by a tier route
// and asks once more on a plan; the spans go to the SDK's in-memory exporter, never to a network. Each assertion below is
// a rule of Sentry's ingest (Relay) or its Agents views, named beside it; otel-genai.test.mjs's golden holds every
// attribute, so this file asserts only what Sentry reads.
//
// Sentry's reading, pinned:
//   RELAY_EAP     https://github.com/getsentry/relay/blob/b95381eca6c2d794bf9b13afce6f48bd02c2cfe3/relay-event-normalization/src/eap/ai.rs
//                 is_ai_item (L43): a span with gen_ai.operation.name is an AI span; normalize_model (L60): an absent
//                 gen_ai.response.model is the request's; the cost reads gen_ai.usage.cache_creation.input_tokens (L196).
//   RELAY_SPAN    https://github.com/getsentry/relay/blob/b95381eca6c2d794bf9b13afce6f48bd02c2cfe3/relay-event-normalization/src/normalize/span/ai.rs
//                 raw_input_tokens (L62): input_tokens - cache_read - cache_creation; infer_ai_operation_type (L175):
//                 invoke_agent is an agent, execute_tool a tool.
//   SENTRY_COSTS  https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/product/agents/costs.mdx
//   SENTRY_CONV   https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/product/agents/conversations/index.mdx
//   SENTRY_OTLP   https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/concepts/otlp/direct/traces.mdx
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { normalizeUsage } from "@parcha/agentrun-import";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { exporterConfig, genAiTracing, traceIdOf } = await import("../dist/otel/tracer.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 10_000, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const ON = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" };

// Anthropic's input_tokens leaves the cache out (100 uncached, 2000 read, 300 written); OpenAI's holds it (1500 in, 1200
// of them read). Each as the session's proxy reads it.
const ANTHROPIC = normalizeUsage("anthropic", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 });
const OPENAI = normalizeUsage("openai", { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 400 });
const portUsage = ({ input, output, cacheRead, cacheWrite }, usd) => ({ input, output, cacheRead, cacheWrite, usd });

// The run's own route is Anthropic's; a subagent's tier (`fast`) is OpenAI's; `plan` is a ChatGPT plan's.
const TRACE = {
  provider: "anthropic",
  serverAddress: "api.anthropic.com",
  model: "claude-opus-5-5",
  routes: new Map([
    ["fast", { provider: "openai", serverAddress: "api.openai.com" }],
    ["plan", { provider: "chatgpt", serverAddress: "chatgpt.com" }],
  ]),
};
const REQUESTS = {
  anthropic: { model: "claude-opus-5-5", usage: portUsage(ANTHROPIC, 0.01), ended: { end: "answered", usd: 0.01 } },
  openai: { model: "gpt-6.1-sol", route: "fast", usage: portUsage(OPENAI, 0.02), ended: { end: "answered", usd: 0.02 } },
  plan: { model: "gpt-6.1-terra", route: "plan", usage: { input: 0, output: 0, usd: null, billing: "plan" }, ended: { end: "answered", usd: null } },
};

/** A CLI stand-in whose one turn: asks Anthropic, calls `write`, asks OpenAI by the tier route, asks on the plan, ends.
 *  Each request goes through the session's model port as its proxy would. */
function standIn() {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let turn;
      const ask = async ({ model, route, usage, ended }) => {
        const ticket = await io.models.beforeRequest({ model, ...(route ? { route } : {}) });
        await io.models.afterRequest(usage, ticket || undefined, ended);
      };
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            await ask(REQUESTS.anthropic);
            const host = spec.tools.find((each) => each.name === "write");
            const call = { callId: "call-1", tool: "write", args: { line: "one" } };
            io.onEvent({ type: "tool_start", callId: call.callId, name: "write", args: call.args });
            const result = await host.call(call.args, { callId: call.callId, signal: io.signal });
            io.onEvent({ type: "tool_end", callId: call.callId, name: "write", isError: Boolean(result.isError), result: result.text });
            await ask(REQUESTS.openai);
            await ask(REQUESTS.plan);
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

/** The walk: one run, traced into memory. */
async function walk(t) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const exporter = new InMemorySpanExporter();
  const write = { name: "write", description: "Write a line.", inputSchema: { type: "object" }, replay: "never", call: async (args) => ({ text: `wrote ${args.line}` }) };
  const createLoop = createAdapterLoop(
    () => ({
      adapter: standIn(),
      session: { key: "root", label: "root", system: [], tools: [write], context: "fresh" },
      input: "Write one line.",
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      record: "loop",
      hooks: quiet,
      gate: () => "allow",
      trace: TRACE,
    }),
    { tracing: genAiTracing(ON, { exporter, log: () => {} }) },
  );
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended and released", 20_000);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  return exporter.getFinishedSpans();
}

const op = (span) => span.attributes["gen_ai.operation.name"];
const usageKeys = (span) => Object.keys(span.attributes).filter((key) => key.startsWith("gen_ai.usage."));
const chatByModel = (spans, model) => spans.find((span) => op(span) === "chat" && span.attributes["gen_ai.request.model"] === model);

test("Sentry's walk: one run is one tree of AI spans (invoke_agent over chat and execute_tool), every span in the run's conversation", async (t) => {
  const spans = await walk(t);
  // RELAY_EAP is_ai_item: every span names its operation, so Relay takes each as an AI span; RELAY_SPAN
  // infer_ai_operation_type reads these three names (invoke_agent: agent, execute_tool: tool, chat: an AI client call).
  assert.deepEqual(spans.map(op).sort(), ["chat", "chat", "chat", "execute_tool", "invoke_agent"], `the run's spans: ${spans.map((span) => span.name)}`);
  // One tree per run (Sentry's Traces view): one trace id, the run's; one root, the invoke_agent span; every other span
  // its child.
  assert.deepEqual([...new Set(spans.map((span) => span.spanContext().traceId))], [traceIdOf("run-1")]);
  const roots = spans.filter((span) => !spans.some((other) => other.spanContext().spanId === span.parentSpanContext?.spanId));
  assert.deepEqual(roots.map((span) => span.name), ["invoke_agent stand-in-cli"]);
  const [root] = roots;
  for (const span of spans.filter((one) => one !== root)) assert.equal(span.parentSpanContext?.spanId, root.spanContext().spanId, `${span.name} is under the run's invoke_agent`);
  // SENTRY_CONV: Conversations group spans by gen_ai.conversation.id: the run's, on every span.
  for (const span of spans) assert.equal(span.attributes["gen_ai.conversation.id"], "run-1", span.name);
  // The tool's span names its tool (Sentry's tool spans read gen_ai.tool.name).
  const tool = spans.find((span) => op(span) === "execute_tool");
  assert.equal(tool.name, "execute_tool write");
  assert.equal(tool.attributes["gen_ai.tool.name"], "write");
});

test("Sentry's walk: each paid chat span prices as Sentry prices it (model, inclusive input, cache read, cache_creation, output)", async (t) => {
  const spans = await walk(t);
  const cases = [
    { model: "claude-opus-5-5", provider: "anthropic", raw: 100, cacheRead: 2000, cacheWrite: 300, output: 50 },
    { model: "gpt-6.1-sol", provider: "openai", raw: 300, cacheRead: 1200, cacheWrite: 0, output: 400 },
  ];
  for (const want of cases) {
    const chat = chatByModel(spans, want.model);
    assert.ok(chat, `a chat span for ${want.model}: ${spans.map((span) => span.name)}`);
    const a = chat.attributes;
    assert.equal(chat.name, `chat ${want.model}`);
    assert.equal(a["gen_ai.provider.name"], want.provider, "each request names its own route's provider");
    // SENTRY_COSTS, RELAY_EAP normalize_model: the price is looked up by the response model, and an absent one is the
    // request's. Whichever Sentry ends up with names the model asked.
    assert.equal(a["gen_ai.response.model"] ?? a["gen_ai.request.model"], want.model, "the model Sentry prices by");
    // RELAY_EAP L196: the cost reads Sentry's name for a cache write. OpenTelemetry's name is beside it, the same count.
    assert.equal(a["gen_ai.usage.cache_creation.input_tokens"], want.cacheWrite, "cache_creation, the name Sentry's cost reads");
    assert.equal(a["gen_ai.usage.cache_write.input_tokens"], want.cacheWrite, "cache_write, OpenTelemetry's name");
    assert.equal(a["gen_ai.usage.cache_read.input_tokens"], want.cacheRead);
    assert.equal(a["gen_ai.usage.output_tokens"], want.output);
    // RELAY_SPAN raw_input_tokens: Sentry takes both cache counts out of gen_ai.usage.input_tokens to price the uncached
    // part, so input_tokens holds them: what is left is each provider's own uncached input, never below zero.
    const raw = a["gen_ai.usage.input_tokens"] - a["gen_ai.usage.cache_read.input_tokens"] - a["gen_ai.usage.cache_creation.input_tokens"];
    assert.equal(raw, want.raw, `the uncached input Sentry prices for ${want.model}`);
  }
});

test("Sentry's walk: usage is on chat spans only, so a trace's sum counts each request once; a plan's request has none", async (t) => {
  const spans = await walk(t);
  // Sentry's dashboards sum gen_ai.usage.* over spans: on invoke_agent or execute_tool it would count a request twice.
  for (const span of spans.filter((one) => op(one) !== "chat")) assert.deepEqual(usageKeys(span), [], `${span.name} carries no usage`);
  const input = spans.reduce((sum, span) => sum + (span.attributes["gen_ai.usage.input_tokens"] ?? 0), 0);
  assert.equal(input, 2400 + 1500, "the trace's input sum is the two paid requests', once each");
  // SENTRY_COSTS: no tokens, no cost. A plan's request is not billed by the token: no counts at all (never zeros, which
  // would read as a free request), and it says whose bill it is.
  const plan = chatByModel(spans, "gpt-6.1-terra");
  assert.ok(plan, `the plan's chat span: ${spans.map((span) => span.name)}`);
  assert.deepEqual(usageKeys(plan), []);
  assert.equal(plan.attributes["agentrun.billing"], "plan");
  assert.equal(plan.attributes["gen_ai.provider.name"], "openai", "a ChatGPT plan's route is OpenAI's");
});

test("the docs' Sentry settings: the combined OTLP endpoint gets /v1/traces, the traces one is taken as given, and the auth header reads as Sentry wants it", () => {
  // SENTRY_OTLP: the header is `x-sentry-auth: sentry sentry_key=<public key>`. Placeholders only.
  const header = { "x-sentry-auth": "sentry sentry_key=not-a-key" };
  const combined = exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://o0.ingest.sentry.invalid/api/0/integration/otlp", OTEL_EXPORTER_OTLP_HEADERS: "x-sentry-auth=sentry sentry_key=not-a-key" });
  assert.deepEqual(combined, { url: "https://o0.ingest.sentry.invalid/api/0/integration/otlp/v1/traces", headers: header });
  // Percent-encoded, as the OTLP exporter spec writes a header value: the same header.
  assert.deepEqual(exporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://o0.ingest.sentry.invalid/api/0/integration/otlp/", OTEL_EXPORTER_OTLP_HEADERS: "x-sentry-auth=sentry%20sentry_key=not-a-key" }).headers, header);
  // Sentry's own page names the traces variables: the URL as given.
  const traces = exporterConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://o0.ingest.sentry.invalid/api/0/integration/otlp/v1/traces", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-sentry-auth=sentry sentry_key=not-a-key" });
  assert.deepEqual(traces, { url: "https://o0.ingest.sentry.invalid/api/0/integration/otlp/v1/traces", headers: header });
});
