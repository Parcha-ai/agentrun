// What a run's trace says of the agent that ran, and what the tracer says in the log. A trace names the agent as the
// person named it (gen_ai.agent.name) with its id (gen_ai.agent.id), the harness on agentrun.harness; the tracer says
// once, at the runner's start, that tracing is on and where spans go (no credential of the endpoint), and a collector
// that keeps failing is one line, then at most one a minute with the count of the failures it did not say.
//
// The OpenTelemetry GenAI semantic conventions v0.1.0, pinned:
//   AGENT_SPANS  https://github.com/open-telemetry/semantic-conventions-genai/blob/d0e74ba6c48bcc4ded473b1828a8212f06b23753/docs/gen-ai/gen-ai-agent-spans.md#L213-L272
//                the invoke_agent span is named `invoke_agent {gen_ai.agent.name}`, else `invoke_agent`; the name is the
//                application's, never a framework default, and is not captured when there is none.
//   REGISTRY     https://github.com/open-telemetry/semantic-conventions-genai/blob/d0e74ba6c48bcc4ded473b1828a8212f06b23753/docs/registry/attributes/gen-ai.md#L11-L12
//                gen_ai.agent.id: the agent resource's unique and stable id; gen_ai.agent.name: its human-readable name.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { until } from "./runner-support.mjs";
import { agent, follow, serve, whenFree, withEnv } from "./support.mjs";

const { flushTraces, genAiTracing, tracePosts } = await import("../dist/otel/tracer.js");
const { secretRedactor } = await import("../dist/runner/redact.js");

// An endpoint with a user, a password and a key parameter, all dummies: none of them may reach a log line.
// The user and password are joined apart (USERINFO), so the source holds no URL with a credential in it.
const USER = "walk-user";
const PASS = "dummy-otlp-pass-0000";
const KEY = "dummy-otlp-key-0000";
const USERINFO = [USER, PASS].join(":");
const CREDENTIALED = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://${USERINFO}@collector.invalid:4318/v1/traces?region=us-east-1&api_key=${KEY}`, OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=dummy-header-key-0000" };
const SHOWN = "https://collector.invalid:4318/v1/traces?region=us-east-1&api_key=[redacted]";
// A GitHub token's shape, a dummy: a name of that shape is cut whatever the runner holds.
const TOKEN_SHAPED = `ghp_${"a1B2".repeat(9)}`;

const attributesOf = (span) => Object.fromEntries((span.attributes ?? []).map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue]));
const credentialFree = (line) => ![USER, PASS, KEY, "dummy-header-key-0000"].some((value) => line.includes(value));

test("a traced run of a saved agent names it: gen_ai.agent.name is the agent's name, gen_ai.agent.id its id, the harness on agentrun.harness; and the runner's start says once that tracing is on, without the endpoint's credentials", { timeout: 120_000 }, async (t) => {
  // A collector on loopback that takes OTLP/HTTP JSON: every span it was sent.
  const spans = [];
  const collector = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        try {
          for (const rs of JSON.parse(Buffer.concat(chunks).toString("utf8")).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
        } catch {
          // Not JSON: no span of this test.
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    collector.closeAllConnections();
    collector.close();
  });
  const port = collector.address().port;
  withEnv(t, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://${USERINFO}@127.0.0.1:${port}/v1/traces?api_key=${KEY}` }, ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_SDK_DISABLED", "OTEL_TRACES_SAMPLER"]);
  // The tracer's lines go to the console's warnings: every one said from the server's start on.
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => {
    said.push(args.join(" "));
    warn(...args);
  };
  t.after(() => (console.warn = warn));
  const server = await serve(t);
  const made = await whenFree(() => server.api("POST", "/agents", agent("agt-billing-7", { name: "billing-helper" })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.id ?? made.body.agent?.id ?? "agt-billing-7";
  assert.notEqual(agentId, "billing-helper", "the agent's id and its name differ, so each attribute is read apart");
  const run = await whenFree(() => server.api("POST", `/agents/${agentId}/runs`, { input: { content: "Hello." } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(server.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  await until(async () => (await server.store.runs.get(run.body.run_id)).runner === null, "the run's claim was released", 20_000);
  await flushTraces();
  const root = await until(() => spans.find((span) => attributesOf(span)["gen_ai.operation.name"] === "invoke_agent" && attributesOf(span)["agentrun.run.id"] === run.body.run_id), "the collector took the run's invoke_agent span", 20_000);
  const rootAttributes = attributesOf(root);
  assert.equal(rootAttributes["gen_ai.agent.name"], "billing-helper", `the agent's name as the person named it: ${JSON.stringify(rootAttributes)}`);
  assert.equal(rootAttributes["gen_ai.agent.id"], agentId, "the agent's id");
  assert.equal(rootAttributes["agentrun.harness"], "pi", "the harness on its own attribute");
  assert.equal(root.name, "invoke_agent billing-helper", "the span named by the agent (AGENT_SPANS)");
  const ofRun = spans.filter((span) => attributesOf(span)["agentrun.run.id"] === run.body.run_id);
  assert.ok(ofRun.length > 1, `the run's chat and tool spans too: ${ofRun.map((span) => span.name)}`);
  for (const span of ofRun) {
    assert.equal(attributesOf(span)["gen_ai.agent.name"], "billing-helper", `${span.name} names the agent`);
    assert.equal(attributesOf(span)["gen_ai.agent.id"], agentId, `${span.name} carries its id`);
  }
  // The runner's start said once that tracing is on, and where: the endpoint without its user, password or key.
  const on = said.filter((line) => line.startsWith("[otel] tracing is on"));
  assert.equal(on.length, 1, `one line at the start: ${JSON.stringify(said)}`);
  assert.ok(on[0].includes(`127.0.0.1:${port}/v1/traces`), `it says where spans go: ${on[0]}`);
  assert.ok(credentialFree(on[0]), `no credential of the endpoint: ${on[0]}`);
  assert.ok(said.every(credentialFree), `no line holds one: ${JSON.stringify(said)}`);
});

test("tracing on says so once, with the endpoint its spans go to cut of its user, password and key; off (no endpoint, or the SDK disabled) says nothing", async () => {
  const lines = [];
  const tracing = await genAiTracing(CREDENTIALED, { exporter: new InMemorySpanExporter(), log: (line) => lines.push(line) });
  assert.ok(tracing, "on");
  assert.deepEqual(lines, [`[otel] tracing is on: spans export to ${SHOWN}`]);
  const quiet = [];
  assert.equal(await genAiTracing({}, { exporter: new InMemorySpanExporter(), log: (line) => quiet.push(line) }), undefined);
  assert.equal(await genAiTracing({ ...CREDENTIALED, OTEL_SDK_DISABLED: "true" }, { exporter: new InMemorySpanExporter(), log: (line) => quiet.push(line) }), undefined);
  assert.deepEqual(quiet, [], "off: no line at all");
});

test("a collector that keeps failing is one line with the endpoint and the time, then at most one a minute that counts the failures it did not say, never one a span", async () => {
  const lines = [];
  let clock = Date.UTC(2026, 10, 25, 7, 1, 31, 465);
  const failing = { export: (_spans, done) => done({ code: 1, error: new Error("503 Service Unavailable") }), shutdown: async () => {}, forceFlush: async () => {} };
  const tracing = await genAiTracing(CREDENTIALED, { exporter: failing, log: (line) => lines.push(line), now: () => clock });
  // Each run's root span is its own export (the test's processor exports each span as it ends): 25 failures in a second.
  const runOnce = async (n) => {
    const trace = tracing.open({ startedAt: clock });
    trace.known({ runId: `run-${n}`, harness: "pi" });
    await trace.end();
  };
  for (let n = 0; n < 25; n++) {
    await runOnce(n);
    clock += 40;
  }
  const failed = () => lines.filter((line) => !line.startsWith("[otel] tracing is on"));
  assert.deepEqual(failed(), [`[otel] a trace export to ${SHOWN} failed at 2026-11-25T07:01:31.465Z; its spans were dropped: 503 Service Unavailable`], "the first failure, said at once, and none of the 24 after it within the minute");
  // A minute after that line, the next failure is said with the count of those not said, the current one among them.
  clock = Date.UTC(2026, 10, 25, 7, 2, 32, 0);
  await runOnce(25);
  assert.deepEqual(failed().slice(1), [`[otel] 25 more trace exports to ${SHOWN} failed since 2026-11-25T07:01:31.465Z, the last at 2026-11-25T07:02:32.000Z; their spans were dropped: 503 Service Unavailable`]);
  await runOnce(26);
  assert.equal(failed().length, 2, `one more failure inside the next minute is not said: ${JSON.stringify(lines)}`);
  assert.ok(lines.every(credentialFree), `no line holds a credential: ${JSON.stringify(lines)}`);
});

test("a run's process's trace names the agent its runner knows, never one the process posts, and a name of a credential's shape is cut", async () => {
  const exporter = new InMemorySpanExporter();
  const posts = tracePosts(await genAiTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" }, { exporter, log: () => {} }), "run-own", secretRedactor([]), { id: "agt-billing-7", name: "billing-helper" });
  posts.post("open", [Date.now()]);
  posts.post("known", [{ runId: "run-other", harness: "pi", agent: { id: "agt-other", name: "someone-else" } }]);
  posts.post("request", [0, "m", undefined]);
  posts.post("ended", [0, { input: 1, output: 1, usd: 0 }, { end: "answered", usd: 0 }]);
  posts.post("end", [undefined]);
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2, spans.map((span) => span.name).join());
  for (const span of spans) {
    assert.equal(span.attributes["gen_ai.agent.name"], "billing-helper", `${span.name}: the runner's agent`);
    assert.equal(span.attributes["gen_ai.agent.id"], "agt-billing-7");
    assert.equal(span.attributes["agentrun.harness"], "pi");
  }
  assert.equal(spans.find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent").name, "invoke_agent billing-helper");

  // An agent named like a key: cut, on the span's name and its attribute, though the runner holds no value at all.
  const shaped = new InMemorySpanExporter();
  const cut = tracePosts(await genAiTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" }, { exporter: shaped, log: () => {} }), "run-shaped", secretRedactor([]), { id: "agt-shaped", name: TOKEN_SHAPED });
  cut.post("open", [Date.now()]);
  cut.post("known", [{ runId: "run-shaped", harness: "pi" }]);
  cut.post("end", [undefined]);
  const [root] = shaped.getFinishedSpans();
  assert.equal(root.attributes["gen_ai.agent.id"], "agt-shaped");
  assert.equal(root.attributes["gen_ai.agent.name"], "[redacted]");
  assert.ok(![root.name, ...Object.values(root.attributes)].some((value) => String(value).includes(TOKEN_SHAPED)), `the shape is on no span: ${root.name}`);
});

test("a trace with no agent known names none: no gen_ai.agent.name (never the harness), no gen_ai.agent.id, the span `invoke_agent` alone", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = await genAiTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" }, { exporter, log: () => {} });
  const trace = tracing.open({ startedAt: Date.now() });
  trace.known({ runId: "run-1", harness: "pi" });
  await trace.end();
  const [root] = exporter.getFinishedSpans();
  assert.equal(root.name, "invoke_agent");
  assert.equal(root.attributes["gen_ai.agent.name"], undefined, "a framework default is no agent's name (AGENT_SPANS)");
  assert.equal(root.attributes["gen_ai.agent.id"], undefined);
  assert.equal(root.attributes["agentrun.harness"], "pi");
});
