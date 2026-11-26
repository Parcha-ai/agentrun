// A server whose OTLP endpoint carries a user, a password, a query or a fragment: the rule of a URL a key goes to
// (keyBase) refuses it, so tracing is off for it. The server starts, a run runs to its end, nothing is sent to the
// endpoint, and the runner's start says once that tracing is off and why, with the variable and the endpoint's origin
// alone. Its own file: a process makes its tracing once (genAiTracing), and the serve test in otel-agent-name.test.mjs
// makes it on.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { until } from "./runner-support.mjs";
import { agent, follow, serve, whenFree, withEnv } from "./support.mjs";

const { flushTraces } = await import("../dist/otel/tracer.js");

// Dummies, the user and password joined apart, so the source holds no URL with a credential in it.
const USER = "walk-user";
const PASS = "dummy-otlp-pass-0000";
const KEY = "dummy-otlp-key-0000";
const USERINFO = [USER, PASS].join(":");
const FRAGMENT = "dummy-fragment-0000-1111";

test("a server whose OTLP endpoint holds a user, a password, a query and a fragment starts and runs: tracing is off, nothing reaches the endpoint, and its start says once why, with no part of the endpoint past its origin", { timeout: 120_000 }, async (t) => {
  // A collector on loopback that counts every request it is sent.
  let requests = 0;
  const collector = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
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
  withEnv(t, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://${USERINFO}@127.0.0.1:${port}/v1/traces?api_key=${KEY}#${FRAGMENT}` }, ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_SDK_DISABLED", "OTEL_TRACES_SAMPLER"]);
  // The tracer's lines go to the console's warnings: every one said from the server's start on.
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => {
    said.push(args.join(" "));
    warn(...args);
  };
  t.after(() => (console.warn = warn));
  const server = await serve(t);
  const made = await whenFree(() => server.api("POST", "/agents", agent("agt-refused-1", { name: "billing-helper" })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.id ?? made.body.agent?.id ?? "agt-refused-1";
  const run = await whenFree(() => server.api("POST", `/agents/${agentId}/runs`, { input: { content: "Hello." } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(server.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", "the run runs to its end with tracing off");
  await until(async () => (await server.store.runs.get(run.body.run_id)).runner === null, "the run's claim was released", 20_000);
  await flushTraces();
  assert.equal(requests, 0, "nothing was sent to the endpoint");
  const otel = said.filter((line) => line.startsWith("[otel]"));
  assert.deepEqual(otel, [`[otel] tracing is off: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT takes no user or password, since the key goes to it: http://127.0.0.1:${port}`], "one line: off, and why");
  assert.ok(said.every((line) => ![USER, PASS, KEY, FRAGMENT, "/v1/traces"].some((value) => line.includes(value))), `no line holds a part of the endpoint past its origin: ${JSON.stringify(said)}`);
});
