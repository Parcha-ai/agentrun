// A workflow run's graph (GET /runs/{id}/graph) shows each call's input, output and error, and each decision's state and
// answers, with no held secret in them: the same rule as its answer (key-refusal.ts redactedOutput, over the values the
// server holds and handed the run), read once per value and held key set, as a console polls the graph while it runs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";
import * as refusal from "../dist/key-refusal.js";

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
// A value no key holds until the second test saves it.
const LATER = ["later", "held", "zyxwvutsrq"].join("-");
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

/** The smoke's faux decision providers (Jev's API), for a judge node. */
const FAUX_DECISIONS = new URL("../scripts/dwf-smoke/faux-decisions.mjs", import.meta.url).pathname;
const STAND_IN = "faux-test-placeholder";

/** A workflow of a map over `items`, each an llm call, then a judge whose state is the question. */
const judged = {
  v: 2, name: "graph-judged",
  schemas: {
    In: { type: "object", required: ["question", "items"], properties: { question: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["valid"], properties: { valid: { type: "boolean", description: "Does `text` read as a question?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: {
    node: "chain",
    steps: [
      { node: "map", label: "each", itemsPath: "items", as: "answers", resultPath: "answer", maxConcurrency: 1, body: { node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "Answer the graph with the held key." }, out: "Llm", as: "answer", deadline_s: 60 } },
      { node: "judge", label: "check", state: { text: "{question}" }, out: "Verdict", as: "verdict" },
    ],
  },
};

/** A judged run that ended: its map's one item is 190 characters, then the held key (cut at 200 for its label), and its
 *  judge saw the key in its state. */
async function judgedRun(t) {
  const calls = join(await scratch(t), "decisions.jsonl");
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY, TYPESAFE_API_KEY: STAND_IN, AGENTRUN_SMOKE_DECISION_CALLS: calls }, [...NAMES, "PARALLEL_API_KEY"]);
  const { api, data } = await serve(t, { fauxJev: FAUX_DECISIONS });
  assert.equal((await api("POST", "/agents", flowAgent("graph-judged", judged, { tools: ["llm"] }))).status, 201);
  const started = await api("POST", "/agents/graph-judged/runs", { input: { question: `Is ${CUT_KEY} a question?`, items: [`${"x".repeat(190)}${CUT_KEY}`] } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  return { api, data, runId: started.body.run_id };
}

/** The run's store held by another connection with no reader allowed, so the graph's read of it is busy. The store is in
 *  WAL mode, where an exclusive transaction still lets readers in: the connection's exclusive locking mode does not. */
function hold(t, data, runId) {
  const store = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { timeout: 0 });
  store.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  store.prepare("SELECT count(*) FROM sqlite_master").get();
  const release = () => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close());
  t.after(release);
  return release;
}

test("a map item's label cut at 200 characters inside a held key, and a decision whose state holds one: the graph shows no part of either", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await judgedRun(t);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.equal(graph.stale, false);
  const item = graph.nodes["/root/steps/0"].items[0];
  assert.ok(item && item.label.startsWith("x".repeat(190)), JSON.stringify(graph.nodes["/root/steps/0"]));
  assert.equal(graph.decisions.length, 1, JSON.stringify(graph.decisions));
  assert.equal(graph.decisions[0].state.text, "Is [redacted] a question?");
  noKey(JSON.stringify(graph), "the graph");
});

test("a graph read while the run's store is busy, from the last whole view: stale, and no part of a held key", { timeout: 60_000 }, async (t) => {
  const { api, data, runId } = await judgedRun(t);
  assert.equal((await api("GET", `/runs/${runId}/graph`)).body.stale, false, "a whole read first, which the server keeps");
  const release = hold(t, data, runId);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  release();
  assert.equal(graph.stale, true, JSON.stringify(Object.keys(graph)));
  assert.equal(graph.decisions.length, 1, "the kept view holds the decision");
  noKey(JSON.stringify(graph), "the stale graph");
});

test("a graph read while the run's store is busy and no whole view was kept: its live view, stale, and no part of a held key", { timeout: 60_000 }, async (t) => {
  const { api, data, runId } = await judgedRun(t);
  const release = hold(t, data, runId);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  release();
  assert.equal(graph.stale, true, JSON.stringify(Object.keys(graph)));
  assert.ok(graph.effects.length >= 1, JSON.stringify(graph.effects));
  noKey(JSON.stringify(graph), "the live-only graph");
});
