// A workflow's `llm` call is paid once and its tokens count once. It completes on the run's marked models, so its cost
// and its tokens are a REQUEST_COST entry the run's usage row and its metrics sum (request-start.ts): its cost, the cost
// its end stores, its graph's total and /v2/stats count it there, and nowhere a second time.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { REQUEST_COST, REQUEST_STARTED, runMetricsOf } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";
import { flowAgent, follow, serve, storeRun } from "./support.mjs";

const FAUX_PRICED = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;

/** A workflow of one `llm` call: the question's answer, in one completion. */
const llmFlow = {
  v: 2, name: "ask-once",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "answer" },
  root: { node: "chain", steps: [{ node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "{question}" }, out: "Llm", as: "answer", deadline_s: 120 }] },
};

test("demo: a priced faux workflow run's $17 llm call is $17 in its stored cost_usd, /v2/stats and its usage row, and its tokens count once", async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_PRICED });
  assert.equal((await api("POST", "/agents", flowAgent("asker", llmFlow, { tools: ["llm"] }))).status, 201);
  const { body } = await api("POST", "/agents/asker/runs", { input: { question: "What is six times seven?" } });
  const { rows } = await follow(api, body.run_id, ["completed"]);
  // The call's own price and count, as the run logged its answer: the priced faux model, $1 a token.
  const logged = (await readFile(join(data, "runs", body.run_id, "nodes.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.t === "effect.end" && line.tool === "llm");
  const { usage, cost_usd: paid } = logged.output;
  assert.equal(paid, 17, JSON.stringify(logged.output));
  assert.equal(rows.findLast((r) => r.kind === "usage").usage.usd, 17, "its usage row");
  assert.equal((await api("GET", `/runs/${body.run_id}`)).body.cost.usd, 17, "its cost");
  assert.equal(storeRun(data, body.run_id).costUsd, 17, "the cost its end stored");
  assert.equal((await api("GET", `/runs/${body.run_id}/graph`)).body.totals.cost_usd, 17, "its graph's total");
  const totals = (await api("GET", "/stats")).body.analytics.totals;
  assert.equal(totals.cost_usd, 17, "/v2/stats");
  // Its tokens, once: the llm answer counts its cached prompt within input_tokens; pi's count keeps it apart.
  const reader = openStoreReader(data);
  const m = reader.runMetrics(body.run_id);
  reader.close();
  assert.deepEqual([m.input + m.cacheRead + m.cacheWrite, m.output, m.requests, m.unmetered], [usage.input_tokens, usage.output_tokens, 1, 0]);
  assert.deepEqual([totals.tokens, totals.requests, totals.unmetered], [usage.input_tokens + usage.output_tokens, 1, 0]);
  // The cap reads the mark's usd as before: the call once.
  assert.equal(spentIn(join(data, "runs", body.run_id, "store", "run.sqlite")), 17);
});

test("a completion's cost mark carries its tokens as pi counts them, the cache apart, and none when pi counted none: summed once, a cached token never twice", async () => {
  const marks = [];
  const run = { harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } };
  const answers = [
    { role: "assistant", content: [{ type: "text", text: "Summary." }], stopReason: "stop", usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 30, totalTokens: 1080, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 } } },
    { role: "assistant", content: [{ type: "text", text: "Unmeasured." }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } } },
  ];
  const { models, open } = await markRequests({ completeSimple: async () => answers.shift() });
  open(run);
  const model = { api: "faux", provider: "faux", id: "m" };
  await models.completeSimple(model, { messages: [] }, {});
  await models.completeSimple(model, { messages: [] }, {});
  assert.deepEqual(marks, [
    { kind: REQUEST_STARTED, data: { request: "compaction" } },
    { kind: REQUEST_COST, data: { request: "compaction", usd: 0.0042, usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 30 } } },
    { kind: REQUEST_STARTED, data: { request: "compaction" } },
    { kind: REQUEST_COST, data: { request: "compaction", usd: 0.001 } },
  ]);
  const m = runMetricsOf(marks);
  assert.deepEqual([m.input, m.cacheRead, m.cacheWrite, m.output, m.requests, m.unmetered], [200, 800, 30, 50, 2, 1], "1030 tokens in, each once; the zeros are no count");
});
