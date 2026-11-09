// What GET /runs/{id}/graph serves of a workflow run over the store is cut by the run's one cut (run-cut.ts), as the file
// path's servedGraph cut it (graph-served.ts servedPart): a map item's label holding a key this server keeps, or a
// sign-in pointer the run was handed (its hand readable, on a Browserbase plane), is served cut; a run whose hand can't
// be read back is refused (403, in the view's words). From the custody read of 4f28fd3b50 (/tmp/custody-probe).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { WITHHELD_SIGN_IN } from "../dist/run-view.js";
import { saveSignIn } from "../dist/sign-ins-store.js";
import { holdsNone, marked, overStore, pointerOf, server, sha, written } from "./custody-support.mjs";
import { flowAgent, follow } from "./support.mjs";

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

/** A workflow mapping over its input's items, each a model call: each item is a node item whose label is the item. */
const mapped = {
  v: 2, name: "graph-mapped",
  schemas: {
    In: { type: "object", required: ["question", "items"], properties: { question: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "answers" },
  root: { node: "chain", steps: [{ node: "map", label: "each", itemsPath: "items", as: "answers", resultPath: "answer", maxConcurrency: 1, body: { node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "Answer." }, out: "Llm", as: "answer", deadline_s: 60 } }] },
};

/** A run of the mapped workflow over `items`, ended; its id. */
async function mappedRun(s, items) {
  const started = await s.api("POST", "/agents/mapped/runs", { input: { question: "q", items } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(s.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  return started.body.run_id;
}

test("a workflow map item's label holding a key this server keeps is served cut on the graph", { timeout: 120_000 }, async (t) => {
  const s = await server(t, { agentTools: false, env: { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY } });
  assert.equal((await s.api("POST", "/agents", flowAgent("mapped", mapped, { tools: ["llm"] }))).status, 201);
  const runId = await mappedRun(s, [`${"x".repeat(150)}${CUT_KEY}`]);
  const graph = await s.api("GET", `/runs/${runId}/graph`);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.ok(JSON.stringify(graph.body.nodes).includes("[redacted]"), JSON.stringify(graph.body.nodes).slice(0, 600));
  holdsNone({ graph: graph.body }, CUT_KEY);
});

test("a workflow map item's label holding the sign-in pointer its run was handed (readable, on a Browserbase plane) is served cut; withheld, the graph is refused", { timeout: 120_000 }, async (t) => {
  const s = await server(t, { agentTools: false });
  assert.equal((await s.api("POST", "/agents", flowAgent("mapped", mapped, { tools: ["llm"] }))).status, 201);
  const pointer = pointerOf();
  const runId = await mappedRun(s, [`see ${pointer} here`]);
  // The agent's sign-in, and the run marked handed it on a Browserbase plane, as the runner's bind keeps them.
  await overStore(s, (store) => saveSignIn(store, s.seal, { agentId: "mapped", provider: "browserbase", pointer }));
  written(s, "UPDATE run_launch SET body = json_set(body, '$.plane.browser', 'browserbase') WHERE run_id = ?", runId);
  marked(s, runId, [sha(pointer)]);
  const graph = await s.api("GET", `/runs/${runId}/graph`);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  holdsNone({ graph: graph.body }, pointer);
  assert.ok(JSON.stringify(graph.body.nodes).includes("see [redacted] here"), JSON.stringify(graph.body.nodes).slice(0, 600));
  // Handed one this server keeps nothing of: withheld, the graph refused in the view's words.
  marked(s, runId, [sha("a pointer this server never kept")]);
  const refused = await s.api("GET", `/runs/${runId}/graph`);
  assert.deepEqual([refused.status, refused.body.error?.message], [403, WITHHELD_SIGN_IN]);
});

test("the whole graph view is cut, not its parts alone: the workflow and its structure echo a node's words, and a pointer the run was handed and a key this server keeps in them are served cut", { timeout: 120_000 }, async (t) => {
  const s = await server(t, { agentTools: false, env: { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY } });
  const pointer = pointerOf();
  // A node's own words (its label and its escalation's summary) in the workflow, as an agent's author might paste them:
  // the graph serves the workflow and its structure beside the run's parts.
  const flow = structuredClone(mapped);
  flow.root.steps.unshift({ node: "escalate", label: `gate ${pointer}`, when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: `needs a person: ${pointer} ${CUT_KEY}` });
  flow.schemas.In.properties.amount = { type: "number" };
  assert.equal((await s.api("POST", "/agents", flowAgent("mapped", flow, { tools: ["llm"] }))).status, 201);
  const started = await s.api("POST", "/agents/mapped/runs", { input: { question: "q", items: ["one"], amount: 600 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(s.api, runId, ["completed", "failed"], { deadlineMs: 50_000 });
  await overStore(s, (store) => saveSignIn(store, s.seal, { agentId: "mapped", provider: "browserbase", pointer }));
  written(s, "UPDATE run_launch SET body = json_set(body, '$.plane.browser', 'browserbase') WHERE run_id = ?", runId);
  marked(s, runId, [sha(pointer)]);
  const graph = await s.api("GET", `/runs/${runId}/graph`);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  // Where each plant would show uncut: every top-level field of the view.
  const fields = Object.entries(graph.body).filter(([, value]) => JSON.stringify(value).includes(pointer) || JSON.stringify(value).includes(CUT_KEY)).map(([field]) => field);
  assert.deepEqual(fields, [], "fields holding a plant");
  holdsNone({ graph: graph.body }, pointer, CUT_KEY);
  assert.ok(JSON.stringify(graph.body.workflow).includes("needs a person: [redacted] [redacted]"), JSON.stringify(graph.body.workflow).slice(0, 400));
  // The run's own facts pass through as they are.
  assert.equal(graph.body.run.id, runId);
});
