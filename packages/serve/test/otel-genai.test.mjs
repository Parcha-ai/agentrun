// A run's GenAI trace (otel/tracer.ts, otel/genai.ts): through the adapter loop, from the session's model port and its
// events, into the SDK's in-memory exporter. A stand-in harness makes two model requests (one with Anthropic's counts, a
// cache read and a cache write; one with OpenAI's, its cache inside its input) and one tool call between them; its trace
// is the golden file fixtures/otel-genai-golden.json: the tree, every name and every attribute. No OTLP endpoint is ever
// reached: the endpoint below only turns tracing on, and the exporter is in memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { normalizeUsage } from "@parcha/agentrun-import";
import { ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { genAiTracing, otelOn, traceIdOf } = await import("../dist/otel/tracer.js");
const { chatAttributes, routeTrace, toolAttributes, USAGE_ATTRIBUTES } = await import("../dist/otel/genai.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { exporterConfig, FLUSH_MS } = await import("../dist/otel/tracer.js");
const { runEnv } = await import("../dist/runner/main.js");
const { cliRunEnv } = await import("../dist/runner/cli-run-spec.js");
const { otelPair } = await import("../dist/runner/run-child-host.js");
const { encode } = await import("../dist/secrets.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { traceOfRoute } = await import("../dist/runner/adapter-run-spec.js");
after(closeOpenSessions);
const TIMING = { leaseMs: 60_000, renewEveryMs: 10_000, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const ON = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" };
const GOLDEN = new URL("./fixtures/otel-genai-golden.json", import.meta.url);
const SECRET_WORDS = "Write the launch codes";
const SECRET_ARG = "the-argument-text";

// Anthropic's input_tokens leaves the cache out; OpenAI's input_tokens holds it. Each as the session's proxy reads it.
const ANTHROPIC = normalizeUsage("anthropic", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 });
const OPENAI = normalizeUsage("openai", { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 400, reasoning_output_tokens: 250 });
const portUsage = ({ input, output, cacheRead, cacheWrite }, usd, extra = {}) => ({ input, output, cacheRead, cacheWrite, usd, ...extra });

/** A CLI stand-in whose one turn: asks the model (`requests[0]`), calls `write`, asks again (`requests[1]`), ends. Each
 *  request is `{ model, usage, ended }`, through the session's model port as its proxy would; `turnEvents`: a plan
 *  harness's turn, whose requests never reach the host. */
function standIn(requests) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let turn;
      const ask = async ({ model, usage, ended }) => {
        const ticket = await io.models.beforeRequest({ model });
        await io.models.afterRequest(usage, ticket || undefined, ended);
      };
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            io.onEvent({ type: "text", delta: SECRET_WORDS });
            if (requests[0]) await ask(requests[0]);
            const host = spec.tools.find((each) => each.name === "write");
            const call = { callId: "call-1", tool: "write", args: { line: SECRET_ARG } };
            const answer = io.gate ? await io.gate(call) : "allow";
            if (answer !== "allow") throw new Error("not allowed");
            io.onEvent({ type: "tool_start", callId: call.callId, name: "write", args: call.args });
            const result = await host.call(call.args, { callId: call.callId, signal: io.signal });
            io.onEvent({ type: "tool_end", callId: call.callId, name: "write", isError: Boolean(result.isError), result: result.text });
            if (requests[1]) await ask(requests[1]);
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

const TWO_REQUESTS = [
  { model: "anthropic/claude-sonnet-4.5", usage: portUsage(ANTHROPIC, 0.01), ended: { end: "answered", usd: 0.01 } },
  { model: "openai/gpt-5", usage: portUsage(OPENAI, 0.02), ended: { end: "answered", usd: 0.02 } },
];

/** One run of the stand-in, traced into memory: its spans, the run's row, and the trace's log lines. */
async function tracedRun(t, { requests = TWO_REQUESTS, facts, exporter = new InMemorySpanExporter(), env = ON, trace = { provider: "openrouter", serverAddress: "openrouter.ai", model: "anthropic/claude-sonnet-4.5" } } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const lines = [];
  const write = { name: "write", description: "Write a line.", inputSchema: { type: "object" }, replay: "never", call: async (args) => ({ text: `wrote ${args.line}` }) };
  const createLoop = createAdapterLoop(
    () => ({
      adapter: standIn(requests),
      facts,
      session: { key: "root", label: "root", system: [], tools: [write], context: "fresh" },
      input: SECRET_WORDS,
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      record: "loop",
      hooks: quiet,
      gate: () => "allow",
      trace,
    }),
    { tracing: genAiTracing(env, { exporter, log: (line) => lines.push(line) }) },
  );
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended and released", 20_000);
  return { spans: exporter.getFinishedSpans?.() ?? [], row, lines };
}

const KINDS = ["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];
/** A trace as a tree of names, kinds, statuses and attributes: children in start order, no ids or times. */
function treeOf(spans) {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  const parentOf = (span) => span.parentSpanContext?.spanId;
  const node = (span) => ({
    name: span.name,
    kind: KINDS[span.kind],
    ...(span.status.code === 2 ? { status: "ERROR" } : {}),
    attributes: Object.fromEntries(Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b))),
    children: spans
      .filter((child) => parentOf(child) === span.spanContext().spanId)
      .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])
      .map(node),
  });
  return spans.filter((span) => !byId.has(parentOf(span))).map(node);
}

const chatSpans = (spans) => spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");

test("golden: a run's trace is invoke_agent over its two chat spans and its tool span, every name and attribute as the fixture has it", async (t) => {
  const { spans, row } = await tracedRun(t);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(treeOf(spans), JSON.parse(readFileSync(GOLDEN, "utf8")), `the trace: ${JSON.stringify(treeOf(spans), null, 2)}`);
  // One trace, its id the run's (every claim of the run shares it), and the resource names the service.
  assert.deepEqual([...new Set(spans.map((span) => span.spanContext().traceId))], [traceIdOf("run-1")]);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(spans[0].resource.attributes["service.name"], "agentrun");
  assert.equal(spans[0].resource.attributes["service.version"], version);
});

test("golden: gen_ai.usage.input_tokens is the inclusive input (input + cache read + cache write) on each chat span, never the raw one", async (t) => {
  const { spans } = await tracedRun(t);
  const [anthropic, openai] = chatSpans(spans);
  for (const [span, usage] of [[anthropic, ANTHROPIC], [openai, OPENAI]]) {
    const a = span.attributes;
    assert.equal(a["gen_ai.usage.input_tokens"], usage.input + usage.cacheRead + usage.cacheWrite, span.name);
    assert.equal(a["gen_ai.usage.cache_write.input_tokens"], a["gen_ai.usage.cache_creation.input_tokens"], "the cache write under both names");
  }
  assert.equal(anthropic.attributes["gen_ai.usage.input_tokens"], 2400, "Anthropic's 100 + 2000 + 300");
  assert.equal(openai.attributes["gen_ai.usage.input_tokens"], 1500, "OpenAI's own input_tokens back");
  // Usage is on chat spans only: a backend that sums a trace never counts a request twice.
  for (const span of spans.filter((one) => one.attributes["gen_ai.operation.name"] !== "chat")) {
    assert.deepEqual(Object.keys(span.attributes).filter((key) => key.startsWith("gen_ai.usage.")), [], `${span.name} carries no usage`);
  }
});

test("a request a plan billed has a chat span with no usage attributes at all, and agentrun.billing=plan", async (t) => {
  const plan = [{ model: "gpt-5", usage: { input: 0, output: 0, usd: null, billing: "plan" }, ended: { end: "answered", usd: null } }];
  const { spans, row } = await tracedRun(t, { requests: plan, trace: { provider: "chatgpt", model: "gpt-5" } });
  assert.equal(row.state, "ended");
  const [chat] = chatSpans(spans);
  assert.equal(chat.name, "chat gpt-5");
  assert.equal(chat.attributes["agentrun.billing"], "plan");
  assert.equal(chat.attributes["gen_ai.provider.name"], "openai", "the plan's route is its vendor's API");
  assert.deepEqual(Object.keys(chat.attributes).filter((key) => key.startsWith("gen_ai.usage.")), [], "no usage, never zeros");
});

test("a plan harness (its wire `plan`: its requests never reach the host) has a chat span per turn, with no usage and agentrun.billing=plan", async (t) => {
  const { spans, row } = await tracedRun(t, { requests: [], facts: { wire: "plan" }, trace: { model: "auto" } });
  assert.equal(row.state, "ended");
  const chats = chatSpans(spans);
  assert.equal(chats.length, 1, `one turn, one chat span: ${spans.map((span) => span.name)}`);
  assert.equal(chats[0].name, "chat auto");
  assert.equal(chats[0].attributes["agentrun.billing"], "plan");
  assert.deepEqual(Object.keys(chats[0].attributes).filter((key) => key.startsWith("gen_ai.usage.")), []);
  assert.ok(spans.some((span) => span.name === "execute_tool write"), "its tool call is traced as any harness's");
});

test("an exporter that throws never fails the run: it ends ok, and the failure is one log line", async (t) => {
  const throwing = { export: () => { throw new Error("collector down"); }, shutdown: async () => {}, forceFlush: async () => {} };
  const { row, lines } = await tracedRun(t, { exporter: throwing });
  assert.equal(row.state, "ended", `the run ended ok: ${JSON.stringify(row)}`);
  assert.equal(lines.length, 1, `one line for every span it dropped: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^\[otel\] a trace export failed; its spans were dropped: collector down$/);
});

test("no span carries content, even with OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=true: no message, prompt, argument or result", async (t) => {
  const before = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT;
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = "true";
  t.after(() => (before === undefined ? delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT : (process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = before)));
  const { spans } = await tracedRun(t, { env: { ...ON, OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: "true" } });
  assert.ok(spans.length >= 4, "the run was traced");
  for (const span of spans) {
    for (const [key, value] of Object.entries(span.attributes)) {
      assert.doesNotMatch(key, /message|prompt|instruction|content|argument|result|input\.value|output\.value/i, `${span.name} has no content attribute`);
      assert.ok(![SECRET_WORDS, SECRET_ARG, `wrote ${SECRET_ARG}`].some((text) => String(value).includes(text)), `${span.name}.${key} holds no content`);
    }
    assert.deepEqual(span.events, [], `${span.name} has no events (content's other home)`);
  }
});

test("sampled per run: OTEL_TRACES_SAMPLER=always_off exports no span of the run, and its run is as it was", async (t) => {
  const { spans, row } = await tracedRun(t, { env: { ...ON, OTEL_TRACES_SAMPLER: "parentbased_always_off" } });
  assert.equal(row.state, "ended");
  assert.equal(spans.length, 0, `none: ${spans.map((span) => span.name)}`);
});

test("off unless an OTLP endpoint is named, and OTEL_SDK_DISABLED wins", async () => {
  assert.equal(otelOn({}), false);
  assert.equal(otelOn({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }), false);
  assert.equal(otelOn({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }), true);
  assert.equal(otelOn({ ...ON, OTEL_SDK_DISABLED: "true" }), false);
  assert.equal(await genAiTracing({}), undefined);
});

test("off by default: a whole run with no OTEL_* set loads no @opentelemetry module and starts no exporter", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_")));
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [new URL("./fixtures/otel-off-run.mjs", import.meta.url).pathname], { env: { ...env, AGENTRUN_TELEMETRY: "0" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, `the run: ${child.stdout}\n${child.stderr}`);
  const said = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.equal(said.state, "ended", "the run ended");
  assert.deepEqual(said.loaded, [], "no @opentelemetry module was loaded");
  // The same probe sees them once tracing is on: its silence above is no blind spot.
  assert.ok(said.loadedOn.includes("@opentelemetry/resources"), `on, the SDK's modules load: ${JSON.stringify(said.loadedOn)}`);
});

test("the mapping: an MCP tool is an extension called with tools/call; a request that did not answer has error.type and no usage", () => {
  const run = { runId: "run-1", harness: "pi" };
  const mcp = toolAttributes(run, { name: "mcp__docs__search", callId: "c1", mcp: true });
  assert.equal(mcp["gen_ai.tool.type"], "extension");
  assert.equal(mcp["mcp.method.name"], "tools/call");
  assert.equal(toolAttributes(run, { name: "bash", callId: "c2" })["gen_ai.tool.type"], "function");
  assert.equal(toolAttributes(run, { name: "bash", callId: "c2" })["mcp.method.name"], undefined);
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, usd: 0 };
  const lost = chatAttributes(run, { model: "m" }, usage, { end: "lost", label: "gateway_timeout" });
  assert.equal(lost["error.type"], "gateway_timeout");
  assert.equal(lost["gen_ai.usage.input_tokens"], undefined);
  assert.equal(chatAttributes(run, { model: "m" }, usage, { end: "answered", usd: 0, label: "error" })["error.type"], "provider_error");
  assert.deepEqual(chatAttributes(run, { model: "m" }, usage, { end: "answered", usd: 0, label: "filtered" })["gen_ai.response.finish_reasons"], ["content_filter"]);
  assert.equal(chatAttributes(run, { model: "m" }, { ...usage, cut: true })["error.type"], "cut");
  // The rename table: OpenTelemetry's name for a cache write and Sentry's, both.
  assert.deepEqual(USAGE_ATTRIBUTES.cacheWrite, ["gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens"]);
  assert.deepEqual(routeTrace({ named: "anthropic/claude-opus-4-1", origin: "https://api.anthropic.com/v1", model: "claude-opus-4-1" }), { provider: "anthropic", serverAddress: "api.anthropic.com", model: "claude-opus-4-1" });
  assert.deepEqual(routeTrace({ named: "nameless", origin: "not a url" }), {});
});

test("the mapping: a request that came by another route (a subagent's tier) names that route's provider and host, never the run's", () => {
  const run = { runId: "run-1", harness: "pi", provider: "anthropic", serverAddress: "api.anthropic.com", routes: new Map([["fast", { provider: "openai", serverAddress: "api.openai.com" }]]) };
  const own = chatAttributes(run, { model: "claude-sonnet-4.5" });
  assert.equal(own["gen_ai.provider.name"], "anthropic");
  assert.equal(own["server.address"], "api.anthropic.com");
  const tier = chatAttributes(run, { model: "gpt-5-mini", route: "fast" });
  assert.equal(tier["gen_ai.provider.name"], "openai");
  assert.equal(tier["server.address"], "api.openai.com");
  // A route the run does not know names no provider at all, never the run's by mistake.
  const unknown = chatAttributes(run, { model: "x", route: "strong" });
  assert.equal(unknown["gen_ai.provider.name"], undefined);
  assert.equal(unknown["server.address"], undefined);
});

test("a translated route's trace names the host its requests go to (OpenRouter's), never the route's own placeholder origin; the faux model's names none", async () => {
  // OpenRouter speaks Chat Completions, which pi's session does not: the runner's route translates it, its proxy on the
  // route's own origin. The trace is the one a run's spec carries (adapter-run-spec.ts), its chat span's server.address.
  const routed = await routeOf("openrouter/openai/gpt-6.1-sol", { OPENROUTER_API_KEY: `not-a-secret-${"openrouter"}` });
  assert.equal(routed.provider.origin, ROUTE_ORIGIN);
  const trace = traceOfRoute(routed);
  assert.deepEqual(trace, { provider: "openrouter", serverAddress: "openrouter.ai", model: "openai/gpt-6.1-sol" });
  const chat = chatAttributes({ runId: "run-1", harness: "pi", ...trace }, { model: "openai/gpt-6.1-sol" });
  assert.equal(chat["server.address"], "openrouter.ai");
  // The faux model's requests go nowhere: no host at all, never its stand-in's or the route's.
  const faux = traceOfRoute(await routeOf(undefined, { AGENTRUN_SERVE_FAUX: new URL("./fixtures/faux-at-once.mjs", import.meta.url).pathname }));
  assert.equal(faux.serverAddress, undefined);
  for (const each of [trace, faux]) assert.doesNotMatch(JSON.stringify(each), /model-route\.invalid|localhost/);
});

/** A trace made directly (no run), into memory: its finished spans once `steps` ran on it and it ended. */
async function directTrace(steps, exporter = new InMemorySpanExporter()) {
  const tracing = await genAiTracing(ON, { exporter });
  const trace = tracing.open({ startedAt: Date.now() });
  await steps(trace);
  await trace.end();
  return exporter.getFinishedSpans();
}

test("a plan harness's turn whose only event is its turn_end (no text, no tool) still has its chat span", async () => {
  const spans = await directTrace((trace) => {
    trace.known({ runId: "run-1", harness: "plan-cli", plan: true, model: "auto" });
    trace.event({ type: "turn_end", status: "completed" });
  });
  const chats = chatSpans(spans);
  assert.equal(chats.length, 1, `one turn, one chat span: ${spans.map((span) => span.name)}`);
  assert.equal(chats[0].attributes["agentrun.billing"], "plan");
  assert.equal(chats[0].status.code, 0, "it ended as its turn did, not interrupted");
});

test("a claim's end never waits on the collector: with an exporter that never answers, it ends at once; the closing flush is bounded", async (t) => {
  const hanging = { export: () => {}, shutdown: async () => {}, forceFlush: () => new Promise(() => {}) };
  const tracing = await genAiTracing(ON, { exporter: hanging });
  const trace = tracing.open({ startedAt: Date.now() });
  trace.known({ runId: "run-1", harness: "pi", provider: "anthropic" });
  trace.request("claude-sonnet-4.5")({ input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 });
  trace.event({ type: "tool_start", callId: "c1", name: "bash", args: {} });
  trace.event({ type: "tool_end", callId: "c1", name: "bash", isError: false });
  let timer;
  t.after(() => clearTimeout(timer));
  const bound = new Promise((resolve) => (timer = setTimeout(() => resolve("waited"), 250)));
  assert.equal(await Promise.race([trace.end().then(() => "ended"), bound]), "ended", "the claim's end did not wait for the export");
  clearTimeout(timer);
  // The process's closing flush waits for it, but never past FLUSH_MS.
  const flushBound = new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), FLUSH_MS + 1_000)));
  assert.equal(await Promise.race([tracing.flush().then(() => "flushed"), flushBound]), "flushed");
});

test("a run whose root span failed to start leaves its trace id to no later span", async () => {
  let thrown = false;
  const failing = { runId: "run-a", get harness() { if (!thrown) { thrown = true; throw new Error("no name yet"); } return "pi"; } };
  const exporter = new InMemorySpanExporter();
  const tracing = await genAiTracing(ON, { exporter, log: () => {} });
  const a = tracing.open();
  a.known(failing);
  // The next span that starts a trace of its own (here run-a's chat, its root never made) takes a fresh id.
  a.request("m")({ input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 });
  const b = tracing.open();
  b.known({ runId: "run-b", harness: "pi" });
  await b.end();
  await a.end();
  const spans = exporter.getFinishedSpans();
  const ids = spans.map((span) => [span.name, span.spanContext().traceId]);
  assert.ok(!ids.some(([, id]) => id === traceIdOf("run-a")), `run-a's id is on no span: ${JSON.stringify(ids)}`);
  assert.equal(spans.find((span) => span.name === "invoke_agent pi").spanContext().traceId, traceIdOf("run-b"));
});

test("a turn that did not complete cuts its own calls, never one an earlier turn left going", async () => {
  const spans = await directTrace((trace) => {
    trace.known({ runId: "run-1", harness: "pi" });
    trace.event({ type: "tool_start", callId: "outlived", name: "subagent", args: {} });
    trace.event({ type: "turn_end", status: "completed" });
    trace.event({ type: "tool_start", callId: "own", name: "bash", args: {} });
    trace.event({ type: "turn_end", status: "interrupted" });
    trace.event({ type: "tool_end", callId: "outlived", name: "subagent", isError: false });
  });
  const byCall = Object.fromEntries(spans.filter((span) => span.attributes["gen_ai.tool.call.id"]).map((span) => [span.attributes["gen_ai.tool.call.id"], span]));
  assert.equal(byCall.own.attributes["error.type"], "interrupted", "the cut turn's own call");
  assert.equal(byCall.outlived.status.code, 0, "the earlier turn's call ended by its own end, ok");
  assert.equal(byCall.outlived.attributes["error.type"], undefined);
});

test("no OTEL_* setting reaches a run: the run environment and a CLI's have none, and a run's process gets them on its pipe alone", () => {
  const server = { PATH: "/usr/bin:/bin", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318/", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20dummy-otlp-key,x-team=jobs", OTEL_SERVICE_NAME: "agentrun-prod" };
  const runs = runEnv(server);
  assert.deepEqual(Object.getOwnPropertyNames(runs).filter((name) => name.startsWith("OTEL_")), [], "the run environment has no OTEL_* at all");
  assert.equal(runs.OTEL_EXPORTER_OTLP_HEADERS, undefined, "not even by name");
  const cli = cliRunEnv(runs, "/data");
  assert.deepEqual(Object.getOwnPropertyNames(cli).filter((name) => name.startsWith("OTEL_")), [], "a CLI harness's environment has none");
  // A run's own process: on its pipe, read back as that process reads it, and the exporter configured from it.
  const pipe = encode(otelPair(server));
  const tracerUrl = JSON.stringify(new URL("../dist/otel/tracer.js", import.meta.url).href);
  const read = `const { otelEnv, exporterConfig } = await import(${tracerUrl}); process.stdout.write(JSON.stringify({ env: Object.keys(process.env).filter((n) => n.startsWith('OTEL_')), config: exporterConfig(otelEnv()) }));`;
  const child = spawnSync(process.execPath, ["--import", new URL("../dist/secrets.js", import.meta.url).pathname, "--input-type=module", "-e", read], {
    input: pipe, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, AGENTRUN_SECRETS_FD: "0", AGENTRUN_SECRETS_LEN: String(pipe.length), AGENTRUN_TELEMETRY: "0" },
  });
  assert.equal(child.status, 0, child.stderr);
  const said = JSON.parse(child.stdout);
  assert.deepEqual(said.env, [], "the run's process has no OTEL_* in its environment");
  assert.deepEqual(said.config, { url: "http://collector.invalid:4318/v1/traces", headers: { Authorization: "Bearer dummy-otlp-key", "x-team": "jobs" } });
  assert.deepEqual(exporterConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/traces", OTEL_EXPORTER_OTLP_TIMEOUT: "500" }), { url: "http://c/traces", headers: {}, timeoutMillis: 500 });
});

test("pi: a native extension's tool and a session's native tool each have one execute_tool span, as a host tool has, none twice", { timeout: 90_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const exporter = new InMemorySpanExporter();
  const parameters = { type: "object", properties: {} };
  const browse = defineTool({ name: "browse", description: "Browses.", parameters, replay: "safe", execute: async () => ({ output: [{ type: "text", text: SECRET_ARG }] }) });
  const ask = defineTool({ name: "ask_person", description: "Asks.", parameters, replay: "safe", execute: async () => ({ output: [{ type: "text", text: "no one" }], isError: true }) });
  const write = { name: "write", description: "Write a line.", inputSchema: parameters, replay: "never", call: async () => ({ text: "wrote" }) };
  const script = [{ calls: [{ call: "browse" }, { call: "ask_person" }, { call: "write" }] }, { say: "done" }];
  const createLoop = createAdapterLoop(
    (_claim, run) => ({
      adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin(script), price: () => 0, extensions: [defineExtension({ name: "native-browse", tools: [browse] })], tools: [ask] }),
      session: { key: "root", label: "root", system: ["Follow the script."], tools: [write], context: "fresh" },
      input: "Follow the script.",
      hooks: quiet,
      gate: () => "allow",
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
    }),
    { tracing: genAiTracing(ON, { exporter }) },
  );
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended and released", 60_000);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const spans = exporter.getFinishedSpans();
  const tools = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool").map((span) => span.name).sort();
  assert.deepEqual(tools, ["execute_tool ask_person", "execute_tool browse", "execute_tool write"], `one span per call: ${spans.map((span) => span.name)}`);
  const asked = spans.find((span) => span.name === "execute_tool ask_person");
  assert.equal(asked.status.code, 2, "a native tool's error result fails its span");
  assert.equal(asked.attributes["error.type"], "tool_error");
  assert.ok(spans.every((span) => Object.values(span.attributes).every((value) => !String(value).includes(SECRET_ARG))), "no result text on any span");
});

test("a request still open when the claim ends has its chat span ended interrupted, exported with the rest", async () => {
  const spans = await directTrace((trace) => {
    trace.known({ runId: "run-1", harness: "pi", provider: "anthropic" });
    trace.request("claude-sonnet-4.5");
  });
  const [chat] = chatSpans(spans);
  assert.ok(chat, `the open request's span was exported: ${spans.map((span) => span.name)}`);
  assert.equal(chat.status.code, 2);
  assert.equal(chat.attributes["error.type"], "interrupted");
  assert.deepEqual(Object.keys(chat.attributes).filter((key) => key.startsWith("gen_ai.usage.")), [], "no usage on a request that never answered");
});
