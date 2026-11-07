// A workflow's `llm` call is a side request through the run's models (request-start.ts completeSimple): marked and costed
// in the run's store under its own label, "llm", never under the default a compaction's summary takes ("compaction"),
// which the timeline and the cap read as a summary.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_COST, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { flowAgent, follow, letGo, runDir, serve } from "./support.mjs";

/** One call node that asks the run's model, through the `llm` tool, what the input's question says. */
const asking = () => ({
  v: 2, name: "asking",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "said" },
  root: { node: "chain", steps: [{ node: "call", label: "ask", via: "tool", tool: "llm", args: { prompt: "{question}" }, out: "Llm", as: "said", deadline_s: 60 }] },
});

test("a workflow's llm call is marked and costed in the run's store as request \"llm\", not as a compaction's summary", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("asking", asking(), { tools: ["llm"] }))).status, 201);
  const { run_id: runId } = (await api("POST", "/agents/asking/runs", { input: { question: "Say hi." } })).body;
  await follow(api, runId, ["completed", "failed"]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  await letGo(data, runId);
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 5_000 });
  t.after(() => db.close());
  const marks = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record))
    .filter((entry) => entry.kind === REQUEST_STARTED || entry.kind === REQUEST_COST).map((entry) => [entry.kind, entry.data?.request]);
  assert.deepEqual(marks, [[REQUEST_STARTED, "llm"], [REQUEST_COST, "llm"]]);
});
