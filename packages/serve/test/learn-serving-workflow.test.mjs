// The workflow that serves, API first (#3087 r2): GET /agents/{id}/learning/promotions says, beside each learned
// workflow's state, the champion's own revision (`champion`): its digest and the learning commit its text is read at
// (the promotion record's), each node with its tier and the checks it runs in code (learn/workflow-nodes.ts
// workflowNodesOf), and the check it was promoted on. Read by the champion's recorded digest and commit, never by paging
// the workflow's history: a champion with 25 newer revisions on main after it (each held, its draft failing its checks)
// still reads whole.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { workflowNodesOf } from "../dist/learn/workflow-nodes.js";
import { git } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve, withEnv } from "./support.mjs";

const flow = (label) => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["content"], properties: { content: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label, tier: "fast", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "decide", label: "verdict", instructions: "Is it sure?" },
    { node: "escalate", label: "unclear", when: { predicate: "field_equals", path: "verdict.kind", value: "unclear" }, kind: "asked", stage: "answer", summary: "unclear" },
  ] },
});
const digestOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

test("workflowNodesOf: every node depth first, a chain's steps in order and the chain left out, each with its tier (fast, or the agent's own model) and its checks in code", () => {
  const until = { predicate: "not", of: { predicate: "field_equals", path: "check.ok", value: true } };
  const doc = { v: 2, name: "answer", root: { node: "chain", steps: [
    { node: "extract", label: "target", tier: "fast", state: { content: "{content}" } },
    { node: "call", label: "fetch", via: "tool", tool: "web_fetch", args: { url: "{target.url}" } },
    { node: "loop", label: "repick", maxIters: 2, until, body: { node: "decide", label: "answer", state: { facts: "{facts}" } } },
    { node: "escalate", label: "unclear", when: { predicate: "field_equals", path: "answer.verdict", value: "unclear" } },
  ] } };
  assert.deepEqual(workflowNodesOf(doc), [
    { path: "0", kind: "extract", label: "target", tier: "fast", checks: [] },
    { path: "1", kind: "call", label: "fetch", tier: null, checks: [] },
    { path: "2", kind: "loop", label: "repick", tier: null, checks: [{ on: "until", predicate: until }] },
    { path: "2.body", kind: "decide", label: "answer", tier: "agent", checks: [] },
    { path: "3", kind: "escalate", label: "unclear", tier: null, checks: [{ on: "when", predicate: { predicate: "field_equals", path: "answer.verdict", value: "unclear" } }] },
  ]);
  assert.deepEqual(workflowNodesOf(null), []);
  assert.deepEqual(workflowNodesOf({ root: "x" }), []);
});

test("the promotions read has the champion's own revision, by its recorded digest and commit: 25 held drafts on main after it, and it still reads whole", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, baseUrl, store } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("source", { learning: true }))).status, 201);
  await seedOf(data, "source");
  const repo = join(agentFolderOf(data, "source"), "learning");
  const path = "workflows/answer/workflow.json";
  const land = (text, message) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
    writeFileSync(join(repo, "workflows/answer/README.md"), "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n");
    git(repo, ["add", "--", "workflows/answer"]);
    git(repo, ["commit", "-q", "-m", message]);
    return git(repo, ["rev-parse", "main"]);
  };
  const champion = JSON.stringify(flow("answer"));
  // Each commit as a run's merge (its Run-Id trailer), as the learning log reads one.
  const commit = land(champion, "learning: run-0: merged\n\nRun-Id: run-0");
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7 };
  const items = [{ workflow: "answer", digest: digestOf(champion), at: new Date(Date.UTC(2026, 10, 17, 6)).toISOString(), decided: "promote", reason: "checked: promoted", check: { ...bar, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit }];
  // 25 newer revisions on main, each held: its draft failed its checks.
  for (let i = 1; i <= 25; i++) {
    const text = JSON.stringify(flow(`answer-${i}`));
    land(text, `learning: run-${i}: merged\n\nRun-Id: run-${i}`);
    items.push({ workflow: "answer", digest: digestOf(text), at: new Date(Date.UTC(2026, 10, 17, 7, i)).toISOString(), decided: "hold", reason: "its draft failed its checks", check: { ...bar, attempt: 2, n: 5, agreed: 0, alone: 0, of: [] } });
  }
  await store.settings.put("learning.promotions.source", { v: 1, items });
  // A page of the workflow's history (20 changes by default) no longer holds the champion.
  const page = (await api("GET", "/agents/source/learning/workflows/answer/revisions")).body;
  assert.ok(!page.revisions.some((one) => one.digest === digestOf(champion)), "the champion is past the history's default page");

  const read = await api("GET", "/agents/source/learning/promotions");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema, read.body), []);
  const [serving] = read.body.serving;
  assert.equal(serving.digest, digestOf(champion), "the champion serves");
  assert.deepEqual(serving.champion, {
    digest: digestOf(champion), commit,
    nodes: [
      { path: "0", kind: "extract", label: "answer", tier: "fast", checks: [] },
      { path: "1", kind: "decide", label: "verdict", tier: "agent", checks: [] },
      { path: "2", kind: "escalate", label: "unclear", tier: null, checks: [{ on: "when", predicate: { predicate: "field_equals", path: "verdict.kind", value: "unclear" } }] },
    ],
    check: items[0].check,
  });
});

test("the promotions read's champion is null while nothing serves", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, store } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("source", { learning: true }))).status, 201);
  await store.settings.put("learning.promotions.source", { v: 1, items: [{ workflow: "answer", digest: "e".repeat(16), at: new Date().toISOString(), decided: "hold", reason: "its draft failed its checks" }] });
  const [serving] = (await api("GET", "/agents/source/learning/promotions")).body.serving;
  assert.deepEqual([serving.digest, serving.champion], [null, null]);
});
