// A run's GenAI trace (otel/tracer.ts, otel/genai.ts): through the adapter loop, from the session's model port and its
// events, into the SDK's in-memory exporter. A stand-in harness makes two model requests (one with Anthropic's counts, a
// cache read and a cache write; one with OpenAI's, its cache inside its input) and one tool call between them; its trace
// is the golden file fixtures/otel-genai-golden.json: the tree, every name and every attribute. No OTLP endpoint is ever
// reached: the endpoint below only turns tracing on, and the exporter is in memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { normalizeUsage } from "@parcha/agentrun-import";
import { ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";
import { agent, follow, serve, whenFree, withEnv } from "./support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { genAiTracing, OPEN_MAX, otelOn, traceIdOf, tracePosts } = await import("../dist/otel/tracer.js");
const { chatAttributes, routeTrace, toolAttributes, tracedModel, USAGE_ATTRIBUTES, WRITTEN_MAX } = await import("../dist/otel/genai.js");
const { keepText, runnerSecrets, secretRedactor } = await import("../dist/runner/redact.js");
const { hostSecrets, otlpHeaderCut } = await import("../dist/secrets.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { exporterConfig } = await import("../dist/otel/tracer.js");
const { runEnv } = await import("../dist/runner/main.js");
const { cliRunEnv } = await import("../dist/runner/cli-run-spec.js");
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

/** A CLI stand-in whose one turn: asks the model (`requests[0]`), calls `write`, asks again (`requests[1]`), says
 *  `extra` (more events of the turn), ends. Each request is `{ model, usage, ended }`, through the session's model port
 *  as its proxy would. */
function standIn(requests, extra = []) {
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
            for (const event of extra) io.onEvent(event);
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

/** The run's route as its spec's trace names it: its own model, and the route the second request's model is its own on. */
const TRACE = { provider: "openrouter", serverAddress: "openrouter.ai", model: "anthropic/claude-sonnet-4.5", routes: new Map([["second", { model: "openai/gpt-5" }]]) };

/** One run of the stand-in, traced into memory: its spans, the run's row, and the trace's log lines. `redact`: the
 *  runner's redactor; `extra`: more events of its turn (standIn). */
async function tracedRun(t, { requests = TWO_REQUESTS, extra, redact, facts, exporter = new InMemorySpanExporter(), env = ON, trace = TRACE, runCap = { capUsd: () => undefined, modelOf: () => undefined } } = {}) {
  const lines = [];
  // The claim's trace, told when it ends: its end() is the last thing the claim does (adapter-loop.ts traced).
  let traceEnded = false;
  const tracing = genAiTracing(env, { exporter, log: (line) => lines.push(line) }).then((tracer) => tracer && {
    flush: () => tracer.flush(),
    open: (options) => {
      const run = tracer.open(options);
      return { known: (facts) => run.known(facts), request: (model, route) => run.request(model, route), event: (event) => run.event(event), end: (why) => run.end(why).finally(() => { traceEnded = true; }) };
    },
  });
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const write = { name: "write", description: "Write a line.", inputSchema: { type: "object" }, replay: "never", call: async (args) => ({ text: `wrote ${args.line}` }) };
  const createLoop = createAdapterLoop(
    () => ({
      adapter: standIn(requests, extra),
      facts,
      session: { key: "root", label: "root", system: [], tools: [write], context: "fresh" },
      input: SECRET_WORDS,
      runCap,
      record: "loop",
      hooks: quiet,
      gate: () => "allow",
      trace,
    }),
    { tracing },
  );
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING, ...(redact ? { redact } : {}) });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended and released", 20_000);
  // The run's end commits before its trace ends: the loop's last patch lands the run ended and released, and only then
  // does the claim's trace end, its open spans and its invoke_agent span with it. Read the spans once it has.
  if (await tracing) await until(() => traceEnded, "the claim's trace ended", 5_000);
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

test("a name the model wrote reaches no span uncut: a refused tool is execute_tool with error.type=tool_refused, a body's unknown model is the route's, and a held value is on no span", async (t) => {
  const held = `held-${"secret"}-value-0451`;
  const asked = [{ ...TWO_REQUESTS[0], model: `${held}-model` }, TWO_REQUESTS[1]];
  const extra = [
    // A tool the session does not have, which the harness refused itself (claude-agent's tool_refused), by the model's name.
    { type: "tool_start", callId: "refused-1", name: `${held}_tool`, args: {}, refused: true },
    { type: "tool_end", callId: "refused-1", name: `${held}_tool`, isError: true },
    // A tool the harness ran under a name the model wrote (a native tool's): through the runner's redactor, and capped.
    { type: "tool_start", callId: "named-1", name: `run_${held}_${"x".repeat(100)}`, args: {} },
    { type: "tool_end", callId: "named-1", name: "run", isError: false },
  ];
  const { spans, row } = await tracedRun(t, { requests: asked, extra, redact: secretRedactor([held]) });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const holding = spans.filter((span) => [span.name, ...Object.values(span.attributes)].some((value) => String(value).includes(held)));
  assert.deepEqual(holding.map((span) => span.name), [], "no span holds the held value");
  const refused = spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "refused-1");
  assert.equal(refused.name, "execute_tool", "a refused call is never named");
  assert.equal(refused.attributes["gen_ai.tool.name"], undefined);
  assert.equal(refused.attributes["error.type"], "tool_refused", "its end keeps why it failed");
  assert.equal(refused.status.code, 2);
  const named = spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "named-1");
  assert.ok(named.attributes["gen_ai.tool.name"].length <= WRITTEN_MAX, `capped: ${named.attributes["gen_ai.tool.name"]}`);
  const [first] = chatSpans(spans);
  assert.equal(first.name, "chat anthropic/claude-sonnet-4.5", "the model the run does not know is named by its route's");
  assert.equal(first.attributes["gen_ai.request.model"], "anthropic/claude-sonnet-4.5");
});

test("a run's process's posts are data to its runner: a refused call is unnamed, every name it gives is cut and capped, and its run id is the runner's", async () => {
  const held = `held-${"secret"}-value-0451`;
  const exporter = new InMemorySpanExporter();
  const posts = tracePosts(await genAiTracing(ON, { exporter }), "run-own", secretRedactor([held]));
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-other", harness: "pi", model: `${held}-m` }]);
  posts.post("request", [0, `${held}-asked`, undefined]);
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 }]);
  posts.post("event", [{ type: "tool_start", callId: "r1", name: `${held}_tool`, refused: true }]);
  posts.post("event", [{ type: "tool_end", callId: "r1", isError: true }]);
  posts.post("event", [{ type: "tool_start", callId: "n1", name: `${held}_${"z".repeat(100)}` }]);
  posts.post("event", [{ type: "tool_end", callId: "n1", isError: false }]);
  posts.post("end", [undefined]);
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 4, spans.map((span) => span.name).join());
  assert.ok(spans.every((span) => [span.name, ...Object.values(span.attributes)].every((value) => !String(value).includes(held))), "no span holds the held value");
  assert.ok(spans.every((span) => span.attributes["agentrun.run.id"] === "run-own"));
  assert.equal(spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "r1").attributes["error.type"], "tool_refused");
  assert.ok(spans.every((span) => span.name.length <= "execute_tool ".length + WRITTEN_MAX), "every name capped");
});

test("a run's process holds at most OPEN_MAX requests and OPEN_MAX tool calls open in its runner's trace: one started past that has no span", async () => {
  const exporter = new InMemorySpanExporter();
  const posts = tracePosts(await genAiTracing(ON, { exporter }), "run-open", keepText);
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-open", harness: "pi", model: "m" }]);
  // Each started and never ended, OPEN_MAX + 3 times; then one ended, which frees its place for one more.
  for (let i = 0; i < OPEN_MAX + 3; i++) {
    posts.post("request", [i, "m", undefined]);
    posts.post("event", [{ type: "tool_start", callId: `call-${i}`, name: "bash" }]);
  }
  posts.post("request", [0, "m", undefined]);
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 }]);
  posts.post("event", [{ type: "tool_end", callId: "call-0", isError: false }]);
  posts.post("request", [OPEN_MAX + 10, "m", undefined]);
  posts.post("event", [{ type: "tool_start", callId: "call-late", name: "bash" }]);
  posts.post("end", [undefined]);
  const spans = exporter.getFinishedSpans();
  assert.equal(chatSpans(spans).length, OPEN_MAX + 1, "OPEN_MAX open requests, and one more once one ended");
  const tools = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
  assert.equal(tools.length, OPEN_MAX + 1, "OPEN_MAX open calls, and one more once one ended");
  assert.ok(tools.some((span) => span.attributes["gen_ai.tool.call.id"] === "call-late"), "the call after an end has its span");
  assert.equal(tools.some((span) => span.attributes["gen_ai.tool.call.id"] === `call-${OPEN_MAX}`), false, "a call past OPEN_MAX has none");
});

test("the runner's side of a run's posts keeps at most OPEN_MAX requests open by itself, whatever its tracing does with them", () => {
  // A tracing that opens every request it is asked for and never refuses one: only tracePosts' own bound is left.
  let asked = 0;
  const trace = { known: () => {}, request: () => { asked += 1; return () => {}; }, event: () => {}, end: async () => {} };
  const posts = tracePosts({ open: () => trace, flush: async () => {} }, "run-bound", keepText);
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-bound", harness: "pi", model: "m" }]);
  // OPEN_MAX + 3 started and never ended, then id 0 again, which the bound refuses before the open-id check is reached
  // (the next test pins that check); then one ended frees its place.
  for (let i = 0; i < OPEN_MAX + 3; i++) posts.post("request", [i, "m", undefined]);
  posts.post("request", [0, "m", undefined]);
  assert.equal(asked, OPEN_MAX, "OPEN_MAX requests opened, none past that");
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 }]);
  posts.post("request", [OPEN_MAX + 10, "m", undefined]);
  posts.post("request", [OPEN_MAX + 11, "m", undefined]);
  assert.equal(asked, OPEN_MAX + 1, "one more once one ended, and no more past that");
});

test("the runner's side of a run's posts opens no second request under an id still open, so the first one's end still ends it", () => {
  // Far below OPEN_MAX, so only the open-id check can refuse the repeat.
  const opened = [];
  const trace = { known: () => {}, request: () => { const request = { ends: 0 }; opened.push(request); return () => { request.ends += 1; }; }, event: () => {}, end: async () => {} };
  const posts = tracePosts({ open: () => trace, flush: async () => {} }, "run-repeat", keepText);
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-repeat", harness: "pi", model: "m" }]);
  posts.post("request", [0, "m", undefined]);
  posts.post("request", [1, "m", undefined]);
  posts.post("request", [0, "m", undefined]);
  assert.equal(opened.length, 2, "an id posted again while open opens nothing");
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 }]);
  assert.deepEqual(opened.map((request) => request.ends), [1, 0], "id 0's end ends the request it first opened");
  posts.post("request", [0, "m", undefined]);
  assert.equal(opened.length, 3, "once ended, the id opens a request again");
});

test("the runner keeps a call's id, its parent's and a route's name a run's process posts at 128 characters or fewer, and a long one still pairs a call's start with its end and its children", async () => {
  // The channel takes a message of megabytes: an id the runner keeps per open call, or per claim, is cut to a fixed size,
  // the same one for every post of it, and two long ids that differ only at their end are still two.
  const huge = (tail) => `${"x".repeat(1024 * 1024)}${tail}`;
  const [one, two] = [huge("a"), huge("b")];
  const events = [];
  const asked = [];
  let known;
  const trace = { known: (run) => { known = run; }, request: (_model, route) => { asked.push(route); return () => {}; }, event: (event) => events.push(event), end: async () => {} };
  const posts = tracePosts({ open: () => trace, flush: async () => {} }, "run-ids", keepText);
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-ids", harness: "pi", model: "m", routes: new Map([[one, { model: "long" }], ["tier", { model: "t" }]]) }]);
  posts.post("request", [0, "m", one]);
  posts.post("request", [1, "m", "tier"]);
  posts.post("event", [{ type: "tool_start", callId: one, name: "bash" }]);
  posts.post("event", [{ type: "tool_start", callId: two, name: "bash", parent: one }]);
  posts.post("event", [{ type: "tool_start", callId: "toolu_01", name: "bash", parent: one }]);
  posts.post("event", [{ type: "tool_end", callId: two, isError: false }]);
  posts.post("event", [{ type: "tool_end", callId: one, isError: false }]);
  const ids = events.flatMap((event) => [event.callId, event.parent].filter((id) => id !== undefined));
  assert.ok(ids.every((id) => id.length <= 128), `every call id and parent handed on is 128 characters or fewer (lengths ${ids.map((id) => id.length).join()})`);
  const keys = [...known.routes.keys()];
  assert.ok(keys.every((key) => key.length <= 128) && asked.every((route) => route.length <= 128), "every route name kept is 128 characters or fewer");
  const [start, child, short, childEnd, end] = events;
  assert.equal(end.callId, start.callId, "a long call's end pairs with its start");
  assert.equal(child.parent, start.callId, "a long parent pairs with its call");
  assert.equal(short.parent, start.callId, "every child of a long call names the same parent");
  assert.equal(childEnd.callId, child.callId, "the child's end pairs with its start");
  assert.notEqual(child.callId, start.callId, "two long ids that differ only at their end are two calls");
  assert.equal(short.callId, "toolu_01", "a short id is handed on as given");
  assert.ok(asked[0] !== "tier" && known.routes.get(asked[0])?.model === "long", "a long route name still finds its route");
  assert.equal(asked[1], "tier", "a short route name is as given");
  // A short id posted in the very shape a long one is kept as is never taken for that long one.
  posts.post("event", [{ type: "tool_start", callId: start.callId, name: "bash" }]);
  assert.notEqual(events.at(-1).callId, start.callId, "an id shaped like a kept long one is kept as another");

  // Through the tracer itself: the long call and its child each end by their own end, the child under its parent.
  const exporter = new InMemorySpanExporter();
  const real = tracePosts(await genAiTracing(ON, { exporter }), "run-ids", keepText);
  real.post("open", [Date.now()]);
  real.post("known", [{ runId: "run-ids", harness: "pi", model: "m" }]);
  real.post("event", [{ type: "tool_start", callId: one, name: "bash" }]);
  real.post("event", [{ type: "tool_start", callId: two, name: "bash", parent: one }]);
  real.post("event", [{ type: "tool_end", callId: two, isError: false }]);
  real.post("event", [{ type: "tool_end", callId: one, isError: false }]);
  const tools = exporter.getFinishedSpans().filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
  assert.equal(tools.length, 2, "both calls ended by their own ends, before the claim's");
  assert.equal(tools[0].parentSpanContext?.spanId, tools[1].spanContext().spanId, "the child's span is under its long parent's");
  await real.end("run-error");
});

test("the model rule: a known model as asked; an unknown one by its route's model; with none, through the redactor and capped", () => {
  const known = (model) => model === "claude-sonnet-4.5";
  assert.equal(tracedModel("claude-sonnet-4.5", { known, routed: "other" }), "claude-sonnet-4.5");
  assert.equal(tracedModel("made-up", { known, routed: "claude-sonnet-4.5" }), "claude-sonnet-4.5");
  assert.equal(tracedModel(undefined, { known }), undefined);
  const cut = tracedModel(`a-held-value-xyz-${"y".repeat(100)}`, { known, redact: secretRedactor(["a-held-value-xyz"]) });
  assert.ok(!cut.includes("a-held-value-xyz") && cut.length <= WRITTEN_MAX, cut);
});

test("a run's process posts no held value onto a span: its provider, host, call ids, request ends, turn status and failure are the runner's to clean", async () => {
  const held = `held-${"secret"}-value-0451`;
  const exporter = new InMemorySpanExporter();
  const posts = tracePosts(await genAiTracing(ON, { exporter }), "run-own", secretRedactor([held]));
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-own", harness: "pi", provider: `${held}-provider`, serverAddress: `${held}.example.com`, model: "m", routes: new Map([["tier", { provider: held, serverAddress: held, model: "m2" }]]) }]);
  posts.post("request", [0, "m", undefined]);
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "lost", label: `${held}-label` }]);
  posts.post("request", [1, "m2", "tier"]);
  posts.post("ended", [1, { input: 1, output: 1, usd: 0, billing: held, cut: held }, { end: "nothing", label: "refused", reason: held }]);
  // A call's raw id matches its end; its span shows it cut. A usual id shows as given.
  posts.post("event", [{ type: "tool_start", callId: `${held}-call`, name: "bash" }]);
  posts.post("event", [{ type: "tool_start", callId: "toolu_01usual", name: "bash", parent: `${held}-call` }]);
  posts.post("event", [{ type: "tool_start", callId: `c${"c".repeat(100)}`, name: "bash" }]);
  posts.post("event", [{ type: "tool_end", callId: "toolu_01usual", isError: false }]);
  posts.post("event", [{ type: "tool_end", callId: `${held}-call`, isError: false }]);
  posts.post("event", [{ type: "tool_end", callId: `c${"c".repeat(100)}`, isError: false }]);
  posts.post("end", [`${held}-why`]);
  // A plan harness's turn, whose status is its span's error.type.
  const planned = tracePosts(await genAiTracing(ON, { exporter }), "run-plan", secretRedactor([held]));
  planned.post("open", [Date.now()]);
  planned.post("known", [{ runId: "run-plan", harness: "plan-cli", plan: true, model: "auto" }]);
  planned.post("event", [{ type: "turn_end", status: `${held}-status` }]);
  planned.post("end", [undefined]);
  const spans = exporter.getFinishedSpans();
  const leaks = spans.flatMap((span) => [["name", span.name], ...Object.entries(span.attributes)].filter(([, value]) => String(value).includes(held)).map(([key, value]) => `${key}=${value}`));
  assert.deepEqual(leaks, [], "no exported attribute or name holds the held value");
  const tools = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
  assert.equal(tools.length, 3, tools.map((span) => span.name).join());
  assert.ok(tools.every((span) => span.status.code === 0 && span.attributes["error.type"] === undefined), "each call's end found its start by its raw id");
  assert.ok(tools.some((span) => span.attributes["gen_ai.tool.call.id"] === "toolu_01usual"), "a usual id shows as given");
  assert.ok(tools.every((span) => span.attributes["gen_ai.tool.call.id"].length <= WRITTEN_MAX), "every shown id is capped");
  const usual = tools.find((span) => span.attributes["gen_ai.tool.call.id"] === "toolu_01usual");
  const parent = tools.find((span) => span.spanContext().spanId === usual.parentSpanContext?.spanId);
  assert.ok(parent, "a child call finds its parent by the parent's raw id");
  const [lost, refused] = chatSpans(spans);
  assert.equal(lost.attributes["error.type"], undefined, "an end the runner does not know is read as none");
  assert.equal(refused.attributes["error.type"], "refused", "a known end keeps its label");
  assert.equal(spans.find((span) => span.name === "invoke_agent pi").attributes["error.type"], "run-error", "a failure that is not a code is the runner's");
  assert.equal(spans.find((span) => span.attributes["agentrun.run.id"] === "run-plan" && span.attributes["gen_ai.operation.name"] === "chat").attributes["error.type"], "failed", "a turn status it does not know is failed");
});

test("a body's model is known only by its own id: under a CLI spec's catch-all price (every id priced as the session's model), an invented name is its route's, and a known one is cut too", async (t) => {
  const held = `held-${"secret"}-value-0451`;
  const long = `route-model-${"r".repeat(80)}`;
  // A CLI run's runCap.modelOf (cli-run-spec.ts): with no route named, every id is the session's model.
  const sessionModel = { id: "cap-model", api: "anthropic-messages", price: null, outputCeiling: null };
  const runCap = { capUsd: () => undefined, modelOf: (_id, by) => (by === undefined ? sessionModel : undefined) };
  const asked = [{ ...TWO_REQUESTS[0], model: `${held}-invented` }, { ...TWO_REQUESTS[1], model: long }];
  const { spans, row } = await tracedRun(t, { requests: asked, runCap, redact: secretRedactor([held]), trace: { ...TRACE, model: long } });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const [invented, known] = chatSpans(spans);
  assert.equal(invented.attributes["gen_ai.request.model"], long.slice(0, WRITTEN_MAX), "an invented name is its route's model, whatever the catch-all prices it as");
  assert.equal(known.attributes["gen_ai.request.model"].length, WRITTEN_MAX, `a known name is cut too: ${known.name}`);
  assert.ok(spans.every((span) => !span.name.includes(held)), "no span name holds the held value");
});

test("a runner error line holds no OTLP header value: each one is a held secret, and the tracer's [otel] lines are cut", async (t) => {
  const key = `otlp-${"dummy"}-header-key-7781`;
  const team = `team-${"dummy"}-header-9925`;
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${key}`, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-team=${team}` };
  const values = runnerSecrets(env);
  for (const value of [key, team]) assert.ok(values.includes(value), `${value} is held`);
  assert.equal(secretRedactor(values)(`POST failed: 401 for Bearer ${key} (${team})`).includes(key), false, "a runner line cut of it");
  // The tracer's own line, from an exporter whose error quotes the header it sent.
  const quoting = { export: () => { throw new Error(`401: Authorization: Bearer ${key}`); }, shutdown: async () => {}, forceFlush: async () => {} };
  const { row, lines } = await tracedRun(t, { exporter: quoting, env });
  assert.equal(row.state, "ended");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].includes(key), false, `the tracer's line holds no header value: ${lines[0]}`);
  assert.match(lines[0], /^\[otel\] a trace export failed; its spans were dropped: 401: Authorization: (Bearer )?\[redacted\]$/);
});

test("an OTLP header value of 8 or more is held but a standard one's, under any name; a shorter one is on no held list, and the tracer's cut still takes it", () => {
  const short = `hc${"7"}x1`;
  const long = `honeycomb-${"dummy"}-team-3310`;
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${short},Content-Type=application/json`, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Honeycomb-Team=${long},accept=application/x-protobuf,User-Agent=agentrun-otel,content-encoding=gzip` };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    assert.ok(values.includes(long), `${long} (under X-Honeycomb-Team) is held (${list})`);
    // A held list's every reader is not floored at 8 (a number's equality, a source capture's substring match).
    assert.equal(values.includes(short), false, `${short} (under 8 characters) is on no held list (${list})`);
    for (const value of ["application/json", "application/x-protobuf", "agentrun-otel", "gzip"]) assert.equal(values.includes(value), false, `${value} (a standard header's) is not held (${list})`);
  }
  assert.equal(otlpHeaderCut(env)(`401 for x-honeycomb-team: ${short}`), "401 for x-honeycomb-team: [redacted]", "the tracer's cut takes a short value");
});

test("an OTLP credential is held as an error may quote it: a scheme's credential alone, the SDK's own reading of a value, an endpoint's user, password and key parameter", () => {
  const basic = Buffer.from(`otlp-user:${"dummy"}-pass-5521`).toString("base64");
  const apiKey = `api-${"dummy"}-key-6634`;
  const sentry = `sentry-${"dummy"}-key-2207`;
  // A value with a `;` that ours can't decode: the SDK still sends what comes before the `;` (core parseKeyPairsIntoRecord).
  const property = `team-${"dummy"}-value-7710`;
  const [user, password, query] = [`user-${"dummy"}-4410`, `pass-${"dummy"}-8812`, `query-${"dummy"}-key-9931`];
  // The userinfo is joined apart from the URL, so no line here reads as a URL with a password in it to the source export's
  // credential scan (scripts/export-source.mjs credential_url).
  const userinfo = (name, secret) => [name, secret].join(":");
  const endpoint = `https://${userinfo(user, password)}@collector.invalid/v1/traces?region=us-east-1&api_key=${query}`;
  const env = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic%20${basic},X-Api=Api-Key ${apiKey},x-sentry-auth=sentry sentry_key=${sentry},x-team=${property};%ZZ`,
  };
  const values = runnerSecrets(env);
  for (const [what, value] of [["Basic's credential", basic], ["Api-Key's credential", apiKey], ["the sentry scheme's credential", `sentry_key=${sentry}`], ["the SDK's reading", property], ["the endpoint's user", user], ["its password", password], ["its api_key", query]]) {
    assert.ok(values.includes(value), `${what} is held`);
  }
  assert.equal(values.includes("us-east-1"), false, "a parameter named like no credential is not held");
  const said = otlpHeaderCut(env)(`401 from ${endpoint}: bad credential ${basic}, ${apiKey}, ${property}`);
  assert.equal(said, `401 from https://${userinfo("[redacted]", "[redacted]")}@collector.invalid/v1/traces?region=us-east-1&api_key=[redacted]: bad credential [redacted], [redacted], [redacted]`);
});

test("a dataset or tenant OTLP header (x-honeycomb-dataset, x-axiom-dataset, x-scope-orgid) is on no held list at any length, and the tracer's cut still takes it", () => {
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-dataset=production,X-Axiom-Dataset=agentrun production", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "X-Scope-OrgID=tenant-production-7" };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    for (const value of ["production", "agentrun production", "tenant-production-7"]) assert.equal(values.includes(value), false, `${value} (a dataset or tenant header's) is not held (${list})`);
  }
  assert.equal(otlpHeaderCut(env)("404 for dataset production (agentrun production), org tenant-production-7"), "404 for dataset [redacted] ([redacted]), org [redacted]", "the tracer's cut takes each");
});

test("an unknown OTLP header's spaced value is held whole, never its tail alone; a credential-named header's, or a known auth scheme's, credential is held without its first word too", () => {
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: "X-Tenant=acme production-cluster" };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    assert.ok(values.includes("acme production-cluster"), `an unknown header's value is held whole (${list})`);
    assert.equal(values.includes("production-cluster"), false, `an unknown header's tail alone is not held (${list})`);
  }
  const [custom, splunk, genie, token] = [`custom-${"dummy"}-cred-5150`, `splunk-${"dummy"}-token-6261`, `genie-${"dummy"}-key-7372`, `token-${"dummy"}-value-8483`];
  const values = runnerSecrets({ OTEL_EXPORTER_OTLP_HEADERS: `X-Vendor-Auth=Custom ${custom},X-Splunk=Splunk ${splunk},X-Ops=GenieKey%20${genie},X-Custom=token ${token}` });
  for (const [what, value] of [["a credential-named header's", custom], ["Splunk's", splunk], ["GenieKey's", genie], ["Token's", token]]) {
    assert.ok(values.includes(value), `${what} credential alone is held`);
  }
});

test("an OTLP endpoint's query parameter is held when a whole word of its name says credential, never for a word that only starts like one", () => {
  const [access, signature, camel] = [`access-${"dummy"}-token-1212`, `sig-${"dummy"}-value-3434`, `camel-${"dummy"}-key-5656`];
  const endpoint = `https://collector.invalid/v1/traces?authority=collector-east-7&keyspace=spans-main&access_token=${access}&X-Amz-Signature=${signature}&apiKey=${camel}`;
  const values = runnerSecrets({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint });
  for (const [what, value] of [["access_token", access], ["X-Amz-Signature", signature], ["apiKey", camel]]) assert.ok(values.includes(value), `${what}'s value is held`);
  for (const [what, value] of [["authority", "collector-east-7"], ["keyspace", "spans-main"]]) assert.equal(values.includes(value), false, `${what}'s value is not held`);
});

test("an OTLP endpoint's query parameter whose name is one lowercase word ending in a credential word is held; authority and keyspace still are not", () => {
  const names = ["accesstoken", "authtoken", "apitoken", "writekey", "accesskey", "clientsecret"];
  const value = (name) => `${name}-${"dummy"}-value-4747`;
  const endpoint = `https://collector.invalid/v1/traces?authority=collector-east-7&keyspace=spans-main&${names.map((name) => `${name}=${value(name)}`).join("&")}`;
  const values = runnerSecrets({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint });
  for (const name of names) assert.ok(values.includes(value(name)), `${name}'s value is held`);
  for (const [what, held] of [["authority", "collector-east-7"], ["keyspace", "spans-main"]]) assert.equal(values.includes(held), false, `${what}'s value is still not held`);
});

test("the tracer's [otel] lines cut an unknown header's tail after any first word, which the held lists still hold only whole", () => {
  const cred = `custom-${"dummy"}-cred-9090`;
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: `X-Custom=Custom ${cred}` };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    assert.ok(values.includes(`Custom ${cred}`), `the value is held whole (${list})`);
    assert.equal(values.includes(cred), false, `its tail alone is not held (${list})`);
  }
  assert.equal(otlpHeaderCut(env)(`401: bad credential ${cred}`), "401: bad credential [redacted]", "an [otel] line quoting the tail alone is cut");
});

// Which of `names`, each an OTLP endpoint's query parameter with a dummy value of its own, have their value on the held list.
const heldParams = (names) => {
  const value = (name) => `${name}-${"dummy"}-value-6060`;
  const values = runnerSecrets({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://collector.invalid/v1/traces?${names.map((name) => `${name}=${value(name)}`).join("&")}` });
  return names.filter((name) => values.includes(value(name)));
};

test("an OTLP endpoint's query parameter named like a credential with a number after it (apiKey2, token2, secret01, token_2) is held", () => {
  const names = ["apiKey2", "token2", "secret01", "token_2", "api_key_2"];
  assert.deepEqual(names.filter((name) => !heldParams(names).includes(name)), [], "every numbered credential name's value is held");
});

test("an OTLP endpoint's query parameter whose name is one lowercase word starting with a credential word (tokenvalue, passwordhash) is held; a plural count (tokens, secrets) and authority, keyspace are not", () => {
  const names = ["tokenvalue", "passwordhash", "secretvalue", "jwtpayload", "passwdhash"];
  assert.deepEqual(names.filter((name) => !heldParams(names).includes(name)), [], "every name starting with a credential word has its value held");
  assert.deepEqual(heldParams(["tokens", "secrets", "authority", "keyspace"]), [], "a plural count, authority and keyspace are not held");
});

test("an OTLP endpoint's query parameter named jwt or session, or ending in passwd, pwd, authorization or sessionid, is held; sessions and sessioncount are not", () => {
  const names = ["jwt", "session", "sessionid", "session_token", "jsessionid", "dbpasswd", "userpwd", "proxyauthorization", "accessjwt"];
  assert.deepEqual(names.filter((name) => !heldParams(names).includes(name)), [], "every jwt, session and passwd/pwd/authorization name's value is held");
  assert.deepEqual(heldParams(["sessions", "sessioncount"]), [], "a count of sessions is not held");
});

test("an OTLP endpoint's query parameter whose lowercase name ends in key is held, whatever comes before it (hmackey, accountkey, storagekey, routingkey); keyspace is not", () => {
  const names = ["apikey", "accesskey", "writekey", "datadogapikey", "hmackey", "accountkey", "storagekey", "sharedkey", "consumerkey", "instrumentationkey", "routingkey", "sortkey"];
  assert.deepEqual(names.filter((name) => !heldParams(names).includes(name)), [], "every name ending in key has its value held");
  assert.deepEqual(heldParams(["keyspace", "keys"]), [], "a name that only starts with key is not held");
});

test("an OTLP header value carrying a credential-named name=value pair or a URL with a credential in it is held and cut of that credential alone; a harmless pair is left whole", () => {
  const [session, dsnKey, user, password] = [`session-${"dummy"}-tok-1301`, `dsn-${"dummy"}-key-2402`, `user-${"dummy"}-3503`, `pass-${"dummy"}-4604`];
  const userinfo = (name, secret) => [name, secret].join(":");
  const env = {
    ...ON,
    OTEL_EXPORTER_OTLP_HEADERS: `Cookie=session=${session}; theme=dark-mode-on,X-Sentry-Dsn=https://${dsnKey}@sentry.invalid/1`,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=https://${userinfo(user, password)}@relay.invalid/v1`,
  };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    assert.deepEqual([["the cookie's session", session], ["the DSN's key", dsnKey], ["the URL's user", user], ["its password", password]].filter(([, value]) => !values.includes(value)).map(([what]) => what), [], `every credential inside a header value is held alone (${list})`);
    for (const value of ["dark-mode-on", "theme=dark-mode-on"]) assert.equal(values.includes(value), false, `${value} (a pair named like no credential) is not held (${list})`);
  }
  assert.equal(
    otlpHeaderCut(env)(`401: session ${session} expired; theme=dark-mode-on; dsn key ${dsnKey}; relay ${user} ${password}`),
    "401: session [redacted] expired; theme=dark-mode-on; dsn key [redacted]; relay [redacted] [redacted]",
    "an [otel] line quoting each credential alone is cut of it, and the harmless pair is left",
  );
});

test("an OTLP header value's URL is read with its whole user and password before the value is split at ; & and spaces: a password with ; & or = in it is held whole with its user, and cut", () => {
  const userinfo = (name, secret) => [name, secret].join(":");
  const user = `relayuser-${"dummy"}-5705`;
  const passwords = [["a ; in the password", `relay;${"dummy"}-pass-6806`], ["an & and an = in the password", `relay&${"dummy"}=pass-7907`]];
  const missed = [];
  for (const [what, password] of passwords) {
    const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=https://${userinfo(user, password)}@relay.invalid/v1` };
    for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
      for (const [part, value] of [["the user", user], ["the password", password]]) if (!values.includes(value)) missed.push(`${what}: ${part} (${list})`);
    }
    const line = `401 from relay: user ${user}, password ${password}`;
    const cut = "401 from relay: user [redacted], password [redacted]";
    if (otlpHeaderCut(env)(line) !== cut) missed.push(`${what}: the [otel] cut shows ${otlpHeaderCut(env)(line)}`);
    if (secretRedactor(runnerSecrets(env))(line) !== cut) missed.push(`${what}: the runner's redactor shows ${secretRedactor(runnerSecrets(env))(line)}`);
  }
  assert.deepEqual(missed, [], "a URL's user and its whole password are held alone and cut, whatever the password holds");
  const session = `session-${"dummy"}-tok-9109`;
  const values = runnerSecrets({ OTEL_EXPORTER_OTLP_HEADERS: `X-Relay=https://relay.invalid;session=${session};contact=ops@team.invalid` });
  assert.equal(values.includes(session), true, "a credential-named pair inside what reads as a URL's user is still held alone");
});

test("an OTLP header value's URL with a percent-encoded password is held as written and decoded, and no piece of the decoded password is cut from other words", () => {
  const userinfo = (name, secret) => [name, secret].join(":");
  const user = `relayuser-${"dummy"}-5705`;
  const written = `pass%40word%3B${"dummy"}-8008`;
  const plain = decodeURIComponent(written);
  const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=https://${userinfo(user, written)}@relay.invalid/v1` };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
    assert.deepEqual([["the user", user], ["the password as written", written], ["the password decoded", plain]].filter(([, value]) => !values.includes(value)).map(([what]) => what), [], `the user and the password both ways are held (${list})`);
  }
  assert.equal(
    otlpHeaderCut(env)(`401 from relay: password ${written} (${plain}); 2 spans passed`),
    "401 from relay: password [redacted] ([redacted]); 2 spans passed",
    "an [otel] line quoting the password either way is cut of it, and no piece of it is cut from other words",
  );
});

test("an OTLP header value's quoted URL ends at its closing quote: its user alone is held and cut, though a later pair holds an @", () => {
  const key = `relay-key-${"123"}`;
  const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=upstream='https://${key}@relay.invalid'&contact=ops@team.invalid` };
  for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) assert.equal(values.includes(key), true, `the quoted URL's user alone is held (${list})`);
  const line = `401 from relay: bad key ${key}; 2 spans passed, contact ops`;
  const cut = "401 from relay: bad key [redacted]; 2 spans passed, contact ops";
  assert.equal(otlpHeaderCut(env)(line), cut, "the [otel] cut takes the quoted URL's user alone and leaves passed, contact and ops");
  assert.equal(secretRedactor(runnerSecrets(env))(line), cut, "the runner's redactor takes the quoted URL's user alone");
});

// Every shape a URL with a user and password takes in an OTLP header value: bare, in single quotes or in double quotes; as
// the header's whole value, or as one name=value pair joined to a later pair holding an @ by &, ;, a comma (written %2C:
// a bare comma splits the variable) or a space; with a path or none; with a password holding one of the characters a
// naive read stops at, percent-encoded where RFC 3986 requires it and raw where a person would paste it.
const URL_QUOTES = [["bare", ""], ["single-quoted", "'"], ["double-quoted", '"']];
const URL_PLACES = [
  ["as the header's value", (url) => url],
  ...[["&", "&"], [";", ";"], ["a comma", "%2C"], ["a space", " "]].map(([what, joint]) => [`as a pair joined by ${what} to a later pair with an @`, (url) => `upstream=${url}${joint}contact=ops@team.invalid`]),
];
const URL_PATHS = [["no path", ""], ["a path", "/v1"]];
// [what, the password as written in a URL in `quote`]; null: a user alone (a DSN's key).
const URL_PASSWORDS = [
  ["no password", () => null],
  ["a raw ;", () => `pa;ss-${"dummy"}-7101`],
  ["a raw &", () => `pa&ss-${"dummy"}-7102`],
  ["a raw =", () => `pa=ss-${"dummy"}-7103`],
  ["an encoded comma", () => `pa%2Css-${"dummy"}-7104`],
  ["a quote, raw in double quotes and encoded elsewhere", (quote) => (quote === '"' ? `pa'ss-${"dummy"}-7105` : `pa%27ss-${"dummy"}-7105`)],
  ["a raw @", () => `pa@ss-${"dummy"}-7106`],
  ["an encoded @", () => `pa%40ss-${"dummy"}-7107`],
  ["a raw %", () => `pa%ss-${"dummy"}-7108`],
  ["an encoded %", () => `pa%25ss-${"dummy"}-7109`],
  ["a raw :", () => `pa:ss-${"dummy"}-7110`],
  ["an encoded /", () => `pa%2Fss-${"dummy"}-7111`],
];

test("an OTLP header value's URL, in every shape and with any hard character in its password, has its user and password held as written and decoded and cut alone, and no ordinary word is cut", () => {
  const userinfo = (name, secret) => [name, secret].join(":");
  const plainOf = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const user = `relayuser-${"dummy"}-5705`;
  const missed = [];
  for (const [quoting, quote] of URL_QUOTES) {
    for (const [place, put] of URL_PLACES) {
      for (const [pathing, path] of URL_PATHS) {
        for (const [what, passwordIn] of URL_PASSWORDS) {
          const password = passwordIn(quote);
          const row = `${quoting} URL ${place}, ${pathing}, ${what}`;
          const url = `${quote}https://${password === null ? user : userinfo(user, password)}@relay.invalid${path}${quote}`;
          const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=${put(url)}` };
          const parts = [["the user", user], ...(password === null ? [] : [["the password as written", password], ["the password decoded", plainOf(password)]])];
          for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
            for (const [part, value] of parts) if (!values.includes(value)) missed.push(`${row}: ${part} (${list})`);
          }
          const line = password === null
            ? `401 from relay: key ${user}; 2 spans passed, contact ops`
            : `401 from relay: user ${user}, password ${password}, decoded ${plainOf(password)}; 2 spans passed, contact ops`;
          const cut = password === null
            ? "401 from relay: key [redacted]; 2 spans passed, contact ops"
            : "401 from relay: user [redacted], password [redacted], decoded [redacted]; 2 spans passed, contact ops";
          const otel = otlpHeaderCut(env)(line);
          if (otel !== cut) missed.push(`${row}: the [otel] cut shows ${otel}`);
          const runner = secretRedactor(runnerSecrets(env))(line);
          if (runner !== cut) missed.push(`${row}: the runner's redactor shows ${runner}`);
        }
      }
    }
  }
  assert.deepEqual(missed.slice(0, 24), [], `every URL shape's user and password are held and cut alone, and passed, contact and ops are left (${missed.length} missed)`);
});

test("a quoted URL's short password, under the held lists' floor, is still cut from the [otel] line at any length, though a later pair holds an @", () => {
  const userinfo = (name, secret) => [name, secret].join(":");
  const [user, password] = [`ab${"12"}`, `cd${"34"}`];
  const missed = [];
  for (const [quoting, quote] of URL_QUOTES.filter(([, quote]) => quote)) {
    for (const [place, put] of URL_PLACES) {
      const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=${put(`${quote}https://${userinfo(user, password)}@relay.invalid${quote}`)}` };
      const otel = otlpHeaderCut(env)(`401 from relay: user ${user}, password ${password}; 2 spans passed, contact ops`);
      if (otel !== "401 from relay: user [redacted], password [redacted]; 2 spans passed, contact ops") missed.push(`${quoting} URL ${place}: the [otel] cut shows ${otel}`);
    }
  }
  assert.deepEqual(missed, [], "a quoted URL's user and password are read inside its quotes, so the [otel] cut takes them at any length");
});

// Where a credential sits inside an OTLP header value, past what a URL's own reading covers. Each row: [what, the header
// (an OTEL_EXPORTER_OTLP_TRACES_HEADERS part), the credentials held and cut alone, what is on no held list]. Each row's
// [otel] line also carries ordinary words, none of which may be cut.
const innerUserinfo = (name, secret) => [name, secret].join(":");
const innerToken = (n) => `tok-${"dummy"}-${n}`;
const SENTRY_KEY = `sentry-${"dummy"}-key-8181`;
const INNER_ROWS = [
  ["a credential pair after a ; in an unquoted URL's query", `Cookie=upstream=https://relay.invalid/v1?region=us;session=${innerToken(1201)}`, [innerToken(1201)], ["us"]],
  ["a credential pair after an & in an unquoted URL's query", `Cookie=upstream=https://relay.invalid/v1?region=us&session=${innerToken(1202)}`, [innerToken(1202)], ["us"]],
  ["an access_token in an unquoted URL's fragment", `X-Upstream=upstream=https://relay.invalid/v1#access_token=${innerToken(1203)}`, [innerToken(1203)], []],
  ["a credential pair after a ; in an unquoted URL's fragment", `X-Upstream=upstream=https://relay.invalid/v1#x;session=${innerToken(1204)}`, [innerToken(1204)], []],
  ["a URL nested in another URL's query", `X-Upstream=https://relay.invalid/go?next=https://${innerUserinfo(`u2-${"dummy"}-user`, `p2-${"dummy"}-pass`)}@inner.invalid/`, [`u2-${"dummy"}-user`, `p2-${"dummy"}-pass`], []],
  ["a URL nested in another URL's path", `X-Upstream=https://relay.invalid/go/https://${innerUserinfo(`u3-${"dummy"}-user`, `p3-${"dummy"}-pass`)}@inner.invalid/x`, [`u3-${"dummy"}-user`, `p3-${"dummy"}-pass`], []],
  ["an unquoted URL with a raw ' in its password", `X-Upstream=https://${innerUserinfo(`user-${"dummy"}`, `pa'ss-${"dummy"}-99`)}@host.invalid/`, [`user-${"dummy"}`, `pa'ss-${"dummy"}-99`], []],
  ["sentry's key between commas written %2C", `X-Sentry-Auth=Sentry sentry_version=7%2C sentry_key=${SENTRY_KEY}%2C sentry_client=x`, [SENTRY_KEY], []],
  ["sentry's key between raw commas", `X-Sentry-Auth=Sentry sentry_version=7, sentry_key=${SENTRY_KEY}, sentry_client=x`, [SENTRY_KEY], [`${SENTRY_KEY},`]],
  ["a scheme-relative URL's user", `X-Upstream=//key-${"dummy"}-1234@host.invalid`, [`key-${"dummy"}-1234`], []],
  ["a JSON-escaped URL's user and password", `X-Upstream=https:\\/\\/${innerUserinfo(`u-${"dummy"}-12`, `p-${"dummy"}-34`)}@host.invalid`, [`u-${"dummy"}-12`, `p-${"dummy"}-34`], []],
  ["a single-quoted credential pair's value", `X-Upstream=token='${innerToken(5678)}'`, [innerToken(5678)], []],
  ["a bare URL with no path, then an & pair holding an @", "X-Upstream=https://relay.invalid&contact=ops@team.invalid", [], ["relay.invalid"]],
  ["the same URL as a pair's value", "X-Upstream=upstream=https://relay.invalid&contact=ops@team.invalid", [], ["relay.invalid"]],
];

test("an OTLP header value's credential pair is read anywhere in the value, a URL's query and fragment too, and every URL in it is read, one nested in another, one with a raw ' in its password, scheme-relative or JSON-escaped; a hostname and ordinary words are left", () => {
  const words = "2 spans passed, contact ops, region us v1 relay";
  const missed = [];
  for (const [what, header, held, unheld] of INNER_ROWS) {
    const env = { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: header };
    for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
      for (const value of held) if (!values.includes(value)) missed.push(`${what}: ${value} not held (${list})`);
      for (const value of unheld) if (values.includes(value)) missed.push(`${what}: ${value} held (${list})`);
    }
    const shown = unheld.filter((value) => !held.some((credential) => value.includes(credential)));
    const line = `401 from relay: ${held.map((value) => `got ${value}`).join(", ")}; ${words} ${shown.join(" ")}`;
    const cut = `401 from relay: ${held.map(() => "got [redacted]").join(", ")}; ${words} ${shown.join(" ")}`;
    const otel = otlpHeaderCut(env)(line);
    if (otel !== cut) missed.push(`${what}: the [otel] cut shows ${otel}`);
    const runner = secretRedactor(runnerSecrets(env))(line);
    if (runner !== cut) missed.push(`${what}: the runner's redactor shows ${runner}`);
  }
  assert.deepEqual(missed, [], "each row's credentials are on both held lists and each is cut alone to [redacted] by the [otel] cut and the runner's redactor; its unheld values (a hostname, a key with the raw comma after it) are on neither list, and the ordinary words are left");
});

// A credential with a raw ; in it, as an OTLP endpoint's query parameter or inside a header value. A query or a pair list
// read split at & alone keeps the whole value, a %2C in it too; read split at & and %2C, it keeps the value of a pair in
// a list joined by %2C; read split at ; too, it keeps each pair after a ;. Every reading is held. A value whose part
// before its first ; is empty is held after it; a value of only ; is not held.
// Each row: [what, the env, the credentials held and cut alone, what is on no held list, a line quoting the variable and
// its cut].
const SEMI_PREFIX = `prefix-${"dummy"}`;
const SEMI_WHOLE = `${SEMI_PREFIX};suffix-${"dummy"}`;
const SEMI_COMMA = `${SEMI_PREFIX}%2Cmid-${"dummy"};suffix-${"dummy"}`;
const SEMI_ROWS = [
  [
    "an endpoint's credential parameter with a ; in its value",
    { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://collector.invalid/v1/traces?api_key=${SEMI_WHOLE}` },
    [SEMI_WHOLE, SEMI_PREFIX],
    [],
    [`POST https://collector.invalid/v1/traces?api_key=${SEMI_WHOLE} failed`, "POST https://collector.invalid/v1/traces?api_key=[redacted] failed"],
  ],
  [
    "an endpoint's credential pair after a ; in its query",
    { OTEL_EXPORTER_OTLP_ENDPOINT: `https://collector.invalid?region=us-east-1;session=${innerToken(1301)}` },
    [innerToken(1301)],
    ["us-east-1", `us-east-1;session=${innerToken(1301)}`],
    [`POST https://collector.invalid?region=us-east-1;session=${innerToken(1301)} failed`, "POST https://collector.invalid?region=us-east-1;session=[redacted] failed"],
  ],
  [
    "a credential-named header's value with a ;",
    { ...ON, OTEL_EXPORTER_OTLP_HEADERS: `api-key=${SEMI_WHOLE}` },
    [SEMI_WHOLE, SEMI_PREFIX],
    [],
    [`401 for api-key: ${SEMI_WHOLE}`, "401 for api-key: [redacted]"],
  ],
  [
    "a header value's URL's credential parameter with a ; in its value",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=https://relay.invalid/v1?api_key=${SEMI_WHOLE}` },
    [SEMI_WHOLE, SEMI_PREFIX],
    [],
    [`401 from relay: api_key=${SEMI_WHOLE} refused`, "401 from relay: api_key=[redacted] refused"],
  ],
  [
    "a header value's credential pair with a ; in its value, before an & pair",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=api_key=${SEMI_WHOLE}&region=us-east-1` },
    [SEMI_WHOLE, SEMI_PREFIX],
    ["us-east-1"],
    [`401 for X-Relay: api_key=${SEMI_WHOLE}&region=us-east-1; region us-east-1`, "401 for X-Relay: [redacted]; region us-east-1"],
  ],
  [
    "a header value's credential pair with a ; in its value, before a %2C pair",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=api_key=${SEMI_WHOLE}%2Cregion=us-east-1` },
    [SEMI_WHOLE, SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: key ${SEMI_WHOLE} refused`, "401 from relay: key [redacted] refused"],
  ],
  [
    "a header value's credential pair with a ; in its value, after a %2C pair",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=region=us-east-1%2Capi_key=${SEMI_WHOLE}` },
    [SEMI_WHOLE, SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: key ${SEMI_WHOLE} refused`, "401 from relay: key [redacted] refused"],
  ],
  [
    "a header value's credential pair with a ; and a %2C in its value",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=api_key=${SEMI_COMMA}&region=us-east-1` },
    [SEMI_COMMA, decodeURIComponent(SEMI_COMMA), SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: key ${decodeURIComponent(SEMI_COMMA)} refused`, "401 from relay: key [redacted] refused"],
  ],
  [
    "a header value's credential pair with a ; and a %2C in its value, before an & written %26",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=api_key=${SEMI_COMMA}%26region=us-east-1` },
    [decodeURIComponent(SEMI_COMMA), SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: key ${decodeURIComponent(SEMI_COMMA)} refused`, "401 from relay: key [redacted] refused"],
  ],
  [
    "a header value's credential pair whose value starts with a ;",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=token=;${SEMI_WHOLE}&region=us-east-1` },
    [`;${SEMI_WHOLE}`, SEMI_WHOLE, SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: token ${SEMI_WHOLE} refused`, "401 from relay: token [redacted] refused"],
  ],
  [
    "a header value's credential pair whose value starts with a ;, after a %2C pair",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=region=us-east-1%2Ctoken=;${SEMI_WHOLE}` },
    [`;${SEMI_WHOLE}`, SEMI_WHOLE, SEMI_PREFIX],
    ["us-east-1"],
    [`401 from relay: token ${SEMI_WHOLE} refused`, "401 from relay: token [redacted] refused"],
  ],
  [
    "a header value's credential pair whose value starts with a ; written %3B, in a value that can't be decoded",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Relay=token=%3B${SEMI_WHOLE}&note=100%` },
    [`;${SEMI_WHOLE}`, SEMI_WHOLE, SEMI_PREFIX],
    [],
    [`401 from relay: token ${SEMI_WHOLE} refused`, "401 from relay: token [redacted] refused"],
  ],
  [
    "a header value's credential pair left empty before a ;",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: "X-Relay=token=; theme=dark" },
    [],
    [";", "dark"],
    ["parse error at ; near theme", "parse error at ; near theme"],
  ],
  [
    "a header value's credential pair holding a lone quote",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: "X-Relay=token=' theme=dark" },
    [],
    ["'", "dark"],
    ["parse error at ' near theme", "parse error at ' near theme"],
  ],
  [
    "a header value's credential pair holding a lone quote written %27",
    { ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: "X-Relay=token=%27 theme=dark" },
    [],
    ["'", "%27", "dark"],
    ["parse error at ' near theme", "parse error at ' near theme"],
  ],
];

test("an OTLP endpoint's or header value's credential with a raw ; in it is held whole and as each pair after a ;, and a line quoting it is cut to [redacted] with no piece after the ; left", () => {
  const words = "2 spans passed, contact ops, region us-east-1";
  const missed = [];
  for (const [what, env, held, unheld, [said, saidCut]] of SEMI_ROWS) {
    for (const [list, values] of [["runnerSecrets", runnerSecrets(env)], ["hostSecrets", hostSecrets(env)]]) {
      for (const value of held) if (!values.includes(value)) missed.push(`${what}: ${value} not held (${list})`);
      for (const value of unheld) if (values.includes(value)) missed.push(`${what}: ${value} held (${list})`);
    }
    const line = `401 from collector: ${held.map((value) => `got ${value}`).join(", ")}; ${words}`;
    const cut = `401 from collector: ${held.map(() => "got [redacted]").join(", ")}; ${words}`;
    for (const [redactor, redact] of [["the [otel] cut", otlpHeaderCut(env)], ["the runner's redactor", secretRedactor(runnerSecrets(env))]]) {
      for (const [text, want] of [[line, cut], [said, saidCut]]) {
        const shown = redact(text);
        if (shown !== want) missed.push(`${what}: ${redactor} shows ${shown}`);
      }
    }
  }
  assert.deepEqual(missed, [], "every credential with a ; is held whole and by its pairs, and cut with nothing after the ; left; region and the ordinary words are not");
});

// Held OTLP values that overlap or touch in a line: each row [what, the OTEL_EXPORTER_OTLP_HEADERS value, the line, its
// cut]. Every redactor cuts the union of every held value's places, so no character of any held value is left.
const OVERLAP_KEY = `${SEMI_PREFIX};suffix-${"dummy"}`;
const OVERLAP_ROWS = [
  [
    "the X-Relay pair quoted alone (the SDK's reading `api_key=<key>` starts first, the key with its ; ends later)",
    `X-Relay=api_key=${OVERLAP_KEY}&region=us-east-1`,
    `401 from relay: api_key=${OVERLAP_KEY} refused, region us-east-1`,
    "401 from relay: [redacted] refused, region us-east-1",
  ],
  [
    "two values overlapping, the longer starting first",
    `X-One=alpha-${"dummy"}-long-value-shared,X-Two=shared-tail-${"dummy"}`,
    `401: got alpha-${"dummy"}-long-value-shared-tail-${"dummy"} back`,
    "401: got [redacted] back",
  ],
  [
    "two values overlapping, the longer starting later",
    `X-One=head-${"dummy"}-shared,X-Two=shared-long-${"dummy"}-tail-value`,
    `401: got head-${"dummy"}-shared-long-${"dummy"}-tail-value back`,
    "401: got [redacted] back",
  ],
  [
    "two values touching",
    `X-One=touch-one-${"dummy"},X-Two=touch-two-${"dummy"}`,
    `401: got touch-one-${"dummy"}touch-two-${"dummy"} back`,
    "401: got [redacted] back",
  ],
];

test("OTLP values that overlap or touch in a line are cut as one by every redactor, so no character of any held value is left, whichever starts first or is longer", () => {
  const missed = [];
  for (const [what, headers, line, cut] of OVERLAP_ROWS) {
    const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: headers };
    for (const [redactor, redact] of [["the [otel] cut", otlpHeaderCut(env)], ["the runner's redactor", secretRedactor(runnerSecrets(env))], ["the host's held list's redactor", secretRedactor(hostSecrets(env))]]) {
      const shown = redact(line);
      if (shown !== cut) missed.push(`${what}: ${redactor} shows ${shown}`);
    }
  }
  assert.deepEqual(missed, [], "every overlapping or touching held value is cut as one [redacted]");
});

test("after a header value's first URL query, a later URL's query is read while 4,096 characters of them in all fit: one that fits has its + read as a space, and a longer one's key is still held as written by the pair read", () => {
  // A key of `length` characters with a + in it; the second URL's query is `api_key=` and the key.
  const key = (length) => `dummy+key-${"x".repeat(length - 10)}`;
  const envOf = (query) => ({ ...ON, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=https://a.invalid/?region=us-east-1 https://b.invalid/?api_key=${key(query - 8)}` });
  const fits = runnerSecrets(envOf(4096));
  assert.equal(fits.includes(key(4088).replace("+", " ")), true, "a later query of 4,096 characters is read, its + as a space");
  const over = runnerSecrets(envOf(4097));
  assert.equal(over.includes(key(4089)), true, "a later query over 4,096 characters still has its key held as written (the pair read)");
  assert.equal(over.includes(key(4089).replace("+", " ")), false, "a later query over 4,096 characters is not read as a query");
});

test("an OTLP header value of 16 KB holding 8,000 @, 4,000 URL starts, or 1,000 URLs each in the last's query, starts the tracer and cuts an [otel] line in well under a second, and still holds its URL's user as RFC 3986 reads it (before the last @)", () => {
  const user = `${"a@".repeat(7999)}a`;
  const header = `X-Upstream=https://${user}@relay.invalid`;
  // In a child bounded by its own timeout, so a reading that grows with the @ count fails here by time, never hangs the file.
  const script = [
    "const dist = process.env.TRACER_DIST;",
    "const { genAiTracing } = await import(`${dist}otel/tracer.js`);",
    "const { runnerSecrets, secretRedactor } = await import(`${dist}runner/redact.js`);",
    "const { otlpHeaderCut } = await import(`${dist}secrets.js`);",
    "const exporter = { export: (spans, done) => done({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} };",
    "const on = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otlp.invalid:4318' };",
    "await genAiTracing(on, { exporter, log: () => {} });",
    "const env = { ...on, OTEL_EXPORTER_OTLP_TRACES_HEADERS: process.env.TRACER_HEADER };",
    "const line = `401 from relay: user ${process.env.TRACER_USER}; 2 spans passed`;",
    "const started = performance.now();",
    "await genAiTracing(env, { exporter, log: () => {} });",
    "const otel = otlpHeaderCut(env)(line);",
    "const runner = secretRedactor(runnerSecrets(env))(line);",
    "const ms = performance.now() - started;",
    "const held = runnerSecrets(env).includes(process.env.TRACER_USER);",
    "const nested = { ...on, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=${'a://'.repeat(4000)}` };",
    "const nestedStarted = performance.now();",
    "await genAiTracing(nested, { exporter, log: () => {} });",
    "otlpHeaderCut(nested)(line);",
    "const nestedMs = performance.now() - nestedStarted;",
    "const queried = { ...on, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `X-Upstream=${'a://h?token=a;b&'.repeat(1000)}` };",
    "const queriedStarted = performance.now();",
    "await genAiTracing(queried, { exporter, log: () => {} });",
    "otlpHeaderCut(queried)(line);",
    "const queriedMs = performance.now() - queriedStarted;",
    // The [otel] cut, which finds every place each value starts, over lines quoting each 16 KB value twice.
    "const cutStarted = performance.now();",
    "const cuts = [[env, process.env.TRACER_HEADER.slice('X-Upstream='.length)], [queried, queried.OTEL_EXPORTER_OTLP_TRACES_HEADERS.slice('X-Upstream='.length)]].map(([of, value]) => otlpHeaderCut(of)(`401 from relay: ${value} ${value}; 2 spans passed`));",
    "const cutMs = performance.now() - cutStarted;",
    "console.log(JSON.stringify({ ms, held, otel, runner, nestedMs, queriedMs, cutMs, cuts }));",
    "process.exit(0);",
  ].join("\n");
  const env = { ...process.env, AGENTRUN_TELEMETRY: "0", TRACER_DIST: new URL("../dist/", import.meta.url).href, TRACER_HEADER: header, TRACER_USER: user };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--max-old-space-size=1024", "--input-type=module", "-e", script], { encoding: "utf8", env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.error?.code ?? child.signal ?? child.status, 0, `the tracer started within 20 s and the child ended on its own (stderr: ${(child.stderr ?? "").slice(-300)})`);
  const { ms, held, otel, runner, nestedMs, queriedMs, cutMs, cuts } = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.ok(cutMs < 1000, `the [otel] cut of two lines each quoting a 16 KB value twice took ${Math.round(cutMs)} ms, under 1 s`);
  // The nested queries' value holds `token=a`, so the cut, which has no floor, takes every `a` of the line too.
  assert.deepEqual(cuts.map((cut) => !cut.includes("a@a") && !cut.includes("://") && cut.includes("[redacted] [redacted]") || cut.slice(0, 200)), [true, true], "each quoted value is cut, none of it left");
  assert.ok(ms < 1000, `the tracer started and cut a line in ${Math.round(ms)} ms, under 1 s`);
  assert.ok(nestedMs < 1000, `a 16 KB value of 4,000 URL starts, each inside the last, started the tracer in ${Math.round(nestedMs)} ms, under 1 s`);
  assert.ok(queriedMs < 1000, `a 16 KB value of 1,000 URLs with a query, each inside the last's query, started the tracer in ${Math.round(queriedMs)} ms, under 1 s`);
  assert.equal(held, true, "the URL's user before the last @ is held");
  assert.equal(otel, "401 from relay: user [redacted]; 2 spans passed", "the [otel] cut takes the user");
  assert.equal(runner.includes("a@a"), false, `the runner's redactor shows no piece of the user (it shows ${runner.slice(0, 80)})`);
});

test("a short OTLP header value is cut from the tracer's own error text, at any length; a standard header's value is left as it is", async (t) => {
  const short = `hc${"7"}x1`;
  const env = { ...ON, OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${short},Content-Type=application/json`, OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-team=${short}` };
  // An exporter whose error quotes every header it sent, as a collector's 401 may.
  const quoting = { export: () => { throw new Error(`401 for x-honeycomb-team: ${short} (x-team=${short}), Content-Type: application/json`); }, shutdown: async () => {}, forceFlush: async () => {} };
  const { row, lines } = await tracedRun(t, { exporter: quoting, env });
  assert.equal(row.state, "ended");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].includes(short), false, `the tracer's line holds no header value: ${lines[0]}`);
  assert.equal(lines[0], "[otel] a trace export failed; its spans were dropped: 401 for x-honeycomb-team: [redacted] (x-team=[redacted]), Content-Type: application/json");
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

/** An exporter that never answers: each span it was handed (the export's answer never given), and each flush asked of
 *  it (never resolved). */
function hangingExporter() {
  const exporter = { exported: [], flushes: 0, export: (spans) => void exporter.exported.push(...spans), shutdown: async () => {}, forceFlush: () => ((exporter.flushes += 1), new Promise(() => {})) };
  return exporter;
}

test("a claim's end never waits on the collector: with an exporter that never answers, it has ended by the next turn of the event loop, and asked no flush", async () => {
  const hanging = hangingExporter();
  const tracing = await genAiTracing(ON, { exporter: hanging });
  const trace = tracing.open({ startedAt: Date.now() });
  trace.known({ runId: "run-1", harness: "pi", provider: "anthropic" });
  trace.request("claude-sonnet-4.5")({ input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 });
  trace.event({ type: "tool_start", callId: "c1", name: "bash", args: {} });
  trace.event({ type: "tool_end", callId: "c1", name: "bash", isError: false });
  let ended = false;
  void trace.end().then(() => (ended = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, true, "the claim's end did not wait for the export");
  assert.ok(hanging.exported.some((span) => span.name === "invoke_agent pi"), "its spans were handed to the exporter, unanswered");
  assert.equal(hanging.flushes, 0, "no flush was asked");
});

test("under the runner subcommand (each run a process of its own), a run's release waits on no collector: its process sends nothing, its runner's exporter takes its spans, and no flush comes before the release", { timeout: 120_000 }, async (t) => {
  // A collector that takes a request and never answers: what a run's process would wait on if it sent its own spans.
  // Only a POST is an export: a GET or HEAD is a prober finding the port, never a span.
  const asked = [];
  const collector = createServer((req) => void asked.push(`${req.method} ${req.url}`));
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    collector.closeAllConnections();
    collector.close();
  });
  withEnv(t, { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}` });
  const hanging = hangingExporter();
  // The runner's tracing, its flush a spy that never answers: a release that waited on it would never come.
  let flushed = 0;
  const tracing = genAiTracing(ON, { exporter: hanging, log: () => {} }).then((made) => ({ open: made.open, flush: () => ((flushed += 1), new Promise(() => {})) }));
  const server = await serve(t, { childRuns: { tracing } });
  const made = await whenFree(() => server.api("POST", "/agents", agent("traced")));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await whenFree(() => server.api("POST", "/agents/traced/runs", { input: { content: "Hello." } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(server.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  await until(async () => (await server.store.runs.get(run.body.run_id)).runner === null, "the run's claim was released", 20_000);
  assert.deepEqual(asked.filter((request) => request.startsWith("POST ")), [], `the run's process sent no span to the collector itself (all it was asked: ${JSON.stringify(asked)})`);
  assert.ok(hanging.exported.some((span) => span.name.startsWith("invoke_agent ")), `the runner's exporter took the run's spans: ${hanging.exported.map((span) => span.name)}`);
  assert.equal(flushed, 0, "no flush of the runner's tracing before the run's release");
  assert.equal(hanging.flushes, 0, "no flush of the exporter before the run's release");
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

test("no OTEL_* setting reaches a run: the run environment and a CLI's have none, and the runner's exporter is configured from its own", () => {
  const server = { PATH: "/usr/bin:/bin", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318/", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20dummy-otlp-key,x-team=jobs", OTEL_SERVICE_NAME: "agentrun-prod" };
  const runs = runEnv(server);
  assert.deepEqual(Object.getOwnPropertyNames(runs).filter((name) => name.startsWith("OTEL_")), [], "the run environment has no OTEL_* at all");
  assert.equal(runs.OTEL_EXPORTER_OTLP_HEADERS, undefined, "not even by name");
  const cli = cliRunEnv(runs, "/data");
  assert.deepEqual(Object.getOwnPropertyNames(cli).filter((name) => name.startsWith("OTEL_")), [], "a CLI harness's environment has none");
  assert.deepEqual(exporterConfig(server), { url: "http://collector.invalid:4318/v1/traces", headers: { Authorization: "Bearer dummy-otlp-key", "x-team": "jobs" } });
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
      adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin(script), price: () => 0, extensions: [defineExtension({ name: "native-browse", tools: [browse] })], tools: [ask] }),
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
