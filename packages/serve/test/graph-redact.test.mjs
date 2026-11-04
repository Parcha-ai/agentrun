// A workflow run's graph (GET /runs/{id}/graph) shows each call's input, output and error, and each decision's state and
// answers, with no held secret in them: the same rule as its answer (key-refusal.ts redactedOutput, over the values the
// server holds and handed the run), read once per value and held key set, as a console polls the graph while it runs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { flowAgent, follow, serve, withEnv } from "./support.mjs";
import * as refusal from "../dist/key-refusal.js";

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
// A value no key holds until the second test saves it.
const LATER = ["later", "held", "0123456789"].join("-");
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const pieces = (value) => Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
const noKey = (text, where) => {
  for (const piece of pieces(CUT_KEY)) assert.ok(!text.includes(piece), `${where} holds ${piece}`);
};

/** A workflow of two llm calls: one answers with the held key, the next fails with its provider echoing it. */
const flow = (second) => ({
  v: 2, name: "graph-keyed",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: second ? "failed" : "answer" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "Answer the graph with the held key." }, out: "Llm", as: "answer", deadline_s: 60 },
      ...(second ? [{ node: "call", label: "failed", via: "tool", tool: "llm", args: { prompt: "Fail the graph call echoing the held key." }, out: "Llm", as: "failed", deadline_s: 60 }] : []),
    ],
  },
});

async function graphed(t, id, second, extra = {}, cleared = []) {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY, ...extra }, [...NAMES, ...Object.keys(extra), ...cleared]);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent(id, flow(second), { tools: ["llm"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  return { api, runId: started.body.run_id };
}

test("a workflow run's graph shows its llm call's output and a failed call's error with the held key redacted, 0 times whole or in part", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await graphed(t, "graph-keyed", true);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.deepEqual(graph.effects.map((e) => [e.tool, e.status]), [["llm", "done"], ["llm", "failed"]], JSON.stringify(graph.effects.map((e) => [e.tool, e.status, e.error])));
  noKey(JSON.stringify(graph), "the graph");
  assert.equal(graph.effects[0].output.text, `Graph: [redacted] here, and ${LATER} too.`);
  assert.match(graph.effects[1].error, /\[redacted\]/, graph.effects[1].error);
});

test("a workflow run's graph is redacted once per held key set: a second read reads nothing again, and a key saved after redacts on the next read", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await graphed(t, "graph-again", false, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY"]);
  await api("GET", `/runs/${runId}/graph`);
  const read = refusal.answerPasses.count;
  const second = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.equal(refusal.answerPasses.count, read, "the second read redacted nothing again");
  assert.equal(second.effects[0].output.text, `Graph: [redacted] here, and ${LATER} too.`);
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: LATER } })).status, 204);
  const third = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.equal(third.effects[0].output.text, "Graph: [redacted] here, and [redacted] too.", "saved, it is held");
});
