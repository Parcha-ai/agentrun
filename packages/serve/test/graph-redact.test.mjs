// A workflow run's graph (GET /runs/{id}/graph) shows each call's input, output and error, and each decision's state and
// answers, with no held secret in them: the same rule as its answer (key-refusal.ts redactedOutput, over the values the
// server holds and handed the run), read once per value and held key set, as a console polls the graph while it runs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { raw } from "./store-target.mjs";
import { flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";
import * as served from "../dist/graph-served.js";

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
// A value no key holds until the second test saves it.
const LATER = ["later", "held", "zyxwvutsrq"].join("-");
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const pieces = (value) => Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
const noKey = (text, where) => {
  for (const piece of pieces(CUT_KEY)) assert.ok(!text.includes(piece), `${where} holds ${piece}`);
};

/** The work the graph's reads did: servedGraphView's walks (graph-served.ts graphWalks), each a part or a field cut. Only a
 *  graph read moves it. The process's count of redaction passes (key-refusal.ts answerPasses) is every view's: the run
 *  read and its timeline cut the run's words on every read, and the server's run-end notice and run lister cut them as
 *  the run ends, beside any graph read. */
const walks = () => served.graphWalks.part + served.graphWalks.rest;

/** The parts of a graph that differ between two reads of it, as the graph cuts them: its nodes as one, each decision and
 *  each call, and each other field but read_at (the read's own time, never cut). */
function changedParts(before, next) {
  const { nodes: n0, decisions: d0 = [], effects: e0 = [], read_at: _r0, ...rest0 } = before;
  const { nodes: n1, decisions: d1 = [], effects: e1 = [], read_at: _r1, ...rest1 } = next;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const each = (name, xs, ys) => Array.from({ length: Math.max(xs.length, ys.length) }, (_, i) => (same(xs[i], ys[i]) ? [] : [`${name}[${i}]`])).flat();
  return [
    ...(same(n0, n1) ? [] : ["nodes"]),
    ...each("decisions", d0, d1),
    ...each("effects", e0, e1),
    ...[...new Set([...Object.keys(rest0), ...Object.keys(rest1)])].filter((key) => !same(rest0[key], rest1[key])),
  ];
}

/** The run's graph read again until a read finds it as the read before found it, and that read cut nothing: each part and
 *  field is cut once per content and held set. Every read is held to its own work, with no clock: a read cuts at most the
 *  parts that changed since the read before (a part that changes is a new part, cut once), so a graph cut again on a read
 *  that changed nothing fails at that read. A graph that changes on each of five reads in a row fails too. */
async function untilRedactsNothing(api, runId) {
  let before = (await api("GET", `/runs/${runId}/graph`)).body;
  for (let read = 1; read <= 5; read++) {
    const at = walks();
    const next = (await api("GET", `/runs/${runId}/graph`)).body;
    const walked = walks() - at;
    const changed = changedParts(before, next);
    assert.ok(walked <= changed.length, `read ${read} of the graph cut ${walked} parts again, and ${changed.length} changed since the read before (${JSON.stringify(changed)})`);
    if (changed.length === 0) return next;
    before = next;
  }
  assert.fail("the graph changed on each of five reads in a row");
}

/** `api` as a console's run page reads it: each read of a run's graph with a read of the run itself, at once, both
 *  answered before it returns. The run read cuts the run's words on every read, in this process, as the server's own
 *  run-end notice and run lister cut them as a run ends: none of it is the graph's. */
const withRunPage = (api) => async (method, path, body) => {
  const graph = /^\/runs\/([^/]+)\/graph$/.exec(path);
  if (method !== "GET" || !graph) return api(method, path, body);
  const [read] = await Promise.all([api(method, path, body), api("GET", `/runs/${graph[1]}`)]);
  return read;
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
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY, ...extra }, [...NAMES, ...Object.keys(extra), ...cleared]);
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent(id, flow(second), { tools: ["llm"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  return { api, data, runId: started.body.run_id };
}

test("a workflow run's graph shows its llm call's output and a failed call's error with the held key redacted, 0 times whole or in part", { timeout: 60_000 }, async (t) => {
  const { api, data, runId } = await graphed(t, "graph-keyed", true);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.deepEqual(graph.effects.map((e) => [e.tool, e.status]), [["llm", "done"], ["llm", "failed"]], JSON.stringify(graph.effects.map((e) => [e.tool, e.status, e.error])));
  noKey(JSON.stringify(graph), "the graph");
  // Cut at write too: the node log the graph reads keeps no part of the key in the store.
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  t.after(() => db.close());
  const logged = db.prepare("SELECT record FROM pi_entries WHERE run_id = ?").all(runId).map((row) => String(row.record)).filter((record) => record.includes("agentrun.node.effect"));
  assert.equal(logged.length, 4, "each call's start and end are on the node log");
  noKey(logged.join("\n"), "the node log in the store");
  assert.equal(graph.effects[0].output.text, `Graph: [redacted] here, and ${LATER} too.`);
  assert.match(graph.effects[1].error, /\[redacted\]/, graph.effects[1].error);
});

test("a workflow run's graph is redacted once per held key set: a second read reads nothing again, and a key saved after redacts on the next read", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await graphed(t, "graph-again", false, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY"]);
  // A read of the same graph with the same held set redacts nothing again (untilRedactsNothing).
  const second = await untilRedactsNothing(api, runId);
  assert.equal(second.effects[0].output.text, `Graph: [redacted] here, and ${LATER} too.`);
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: LATER } })).status, 204);
  const at = walks();
  const third = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.ok(walks() > at, "a new held set: the next read cuts the graph again");
  assert.equal(third.effects[0].output.text, "Graph: [redacted] here, and [redacted] too.", "saved, it is held");
});

test("a graph read again as a console's run page reads it, with the run beside it, redacts nothing again: the run read's cuts are not the graph's", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await graphed(t, "graph-beside", false, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY"]);
  const again = await untilRedactsNothing(withRunPage(api), runId);
  assert.equal(again.effects[0].output.text, `Graph: [redacted] here, and ${LATER} too.`);
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
async function judgedRun(t, item = CUT_KEY) {
  const calls = join(await scratch(t), "decisions.jsonl");
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY, TYPESAFE_API_KEY: STAND_IN, AGENTRUN_SMOKE_DECISION_CALLS: calls, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, [...NAMES, "PARALLEL_API_KEY"]);
  const { api, data } = await serve(t, { fauxJev: FAUX_DECISIONS });
  assert.equal((await api("POST", "/agents", flowAgent("graph-judged", judged, { tools: ["llm"] }))).status, 201);
  const started = await api("POST", "/agents/graph-judged/runs", { input: { question: `Is ${CUT_KEY} a question?`, items: [`${"x".repeat(190)}${item}`] } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  return { api, data, runId: started.body.run_id };
}

/** The one store held by another connection, as a runner mid-commit holds it: the write lock taken (BEGIN IMMEDIATE) and a
 *  read open on the run's journal inside it. The graph reads the store in its own connection (WAL), so a held writer never
 *  makes it wait or serve a stale view. The hold waits its turn for the write lock, for up to 15 s: the runner's release
 *  still commits just after the run reads as ended (runner.ts, after its flush). Through raw(), so the wait is on a worker:
 *  the server and its runner run in this process, and a transaction of theirs takes its COMMIT from this thread. */
async function hold(t, data, runId) {
  const store = await raw(join(data, "store.sqlite"), { timeout: 15_000 });
  let released;
  const release = () => (released ??= (async () => {
    try {
      await store.exec("ROLLBACK").catch(() => {});
    } finally {
      await store.close();
    }
  })());
  t.after(release);
  await store.exec("BEGIN IMMEDIATE");
  await store.get("SELECT count(*) FROM pi_entries WHERE run_id = ?", runId);
  return release;
}

test("a map item's label cut at 200 characters inside a held key, and a decision whose state holds one: the graph shows no part of either", { timeout: 60_000 }, async (t) => {
  const { api, runId } = await judgedRun(t);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.equal(graph.stale, undefined, "no stale view: the store is read lock-free");
  const item = graph.nodes["/root/steps/0"].items[0];
  assert.ok(item && item.label.startsWith("x".repeat(190)), JSON.stringify(graph.nodes["/root/steps/0"]));
  assert.equal(graph.decisions.length, 1, JSON.stringify(graph.decisions));
  assert.equal(graph.decisions[0].state.text, "Is [redacted] a question?");
  noKey(JSON.stringify(graph), "the graph");
  // The label and the decision's state are read once per held key set, as every part is.
  // A read that finds them as the read before did cuts none of them again (untilRedactsNothing).
  assert.deepEqual((await untilRedactsNothing(api, runId)).nodes, graph.nodes);
});

test("a graph read while another connection holds the run's store: read whole and lock-free, never stale, and no part of a held key", { timeout: 60_000 }, async (t) => {
  const { api, data, runId } = await judgedRun(t);
  const whole = (await api("GET", `/runs/${runId}/graph`)).body;
  const release = await hold(t, data, runId);
  const held = await api("GET", `/runs/${runId}/graph`);
  await release();
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.deepEqual(Object.keys(held.body).sort(), Object.keys(whole).sort(), "the same view: no stale field, no live view in its place");
  assert.deepEqual([held.body.nodes, held.body.decisions, held.body.effects], [whole.nodes, whole.decisions, whole.effects]);
  noKey(JSON.stringify(held.body), "the graph read while held");
});

test("a call's error and a decision's state, each long enough to be cut, with the held key across the cut: the graph shows no part of it", { timeout: 60_000 }, async (t) => {
  const calls = join(await scratch(t), "decisions.jsonl");
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY, TYPESAFE_API_KEY: STAND_IN, AGENTRUN_SMOKE_DECISION_CALLS: calls }, [...NAMES, "PARALLEL_API_KEY"]);
  const { api } = await serve(t, { fauxJev: FAUX_DECISIONS });
  // A judge's state past 64 KB is kept cut (state_truncated); the key repeats, so a copy sits across that cut too.
  const flow = {
    ...judged, name: "graph-cut",
    schemas: { ...judged.schemas, In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } },
    root: { node: "chain", steps: [
      { node: "judge", label: "check", state: { text: "{question}" }, out: "Verdict", as: "verdict" },
      { node: "call", label: "failed", via: "tool", tool: "llm", args: { prompt: "Fail the graph call at length." }, out: "Llm", as: "failed", deadline_s: 60 },
    ] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("graph-cut", flow, { tools: ["llm"] }))).status, 201);
  const started = await api("POST", "/agents/graph-cut/runs", { input: { question: `${CUT_KEY} `.repeat(2000) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  const graph = (await api("GET", `/runs/${started.body.run_id}/graph`)).body;
  assert.equal(graph.decisions[0]?.state_truncated, true, JSON.stringify(graph.decisions.map((d) => [d.state_truncated, typeof d.state])));
  assert.ok(graph.effects.some((e) => e.status === "failed" && e.error), JSON.stringify(graph.effects.map((e) => [e.status, e.error?.length])));
  noKey(JSON.stringify(graph), "the graph");
  // The error and the stored-cut state are read once per held key set, as every part is.
  await untilRedactsNothing(api, started.body.run_id);
});

test("a key saved after a graph read: the next read, while another connection holds the run's store, shows no part of it, a label's cut inside it included", { timeout: 60_000 }, async (t) => {
  // Not held when the run ran, nor when the graph was first read; no 8 characters of it are in CUT_KEY or LATER.
  const saved = ["later", "saved", "qponmlkjih"].join("-");
  const { api, data, runId } = await judgedRun(t, saved);
  const first = (await api("GET", `/runs/${runId}/graph`)).body;
  assert.ok(JSON.stringify(first.nodes).includes(saved.slice(0, 10)), "not held yet: the label shows it, cut at 200");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: saved } })).status, 204);
  const release = await hold(t, data, runId);
  const graph = (await api("GET", `/runs/${runId}/graph`)).body;
  await release();
  assert.equal(graph.stale, undefined, "read whole, lock-free");
  const shown = JSON.stringify(graph);
  for (let i = 0; i + 8 <= saved.length; i++) assert.ok(!shown.includes(saved.slice(i, i + 8)), `the graph holds ${saved.slice(i, i + 8)}: ${JSON.stringify(graph.nodes)}`);
});
