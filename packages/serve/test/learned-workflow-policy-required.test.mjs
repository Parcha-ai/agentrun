// A learned workflow's call nodes are held to the run's tool policy, which every run must give (#2153): its type makes
// `policy` and `denyFrom` required (test/learned-workflow-policy.types.ts holds that to the typecheck), and a run that
// reaches it with none anyway (a caller past the types) runs nothing, saying why: never a tool on a default of allow.
import assert from "node:assert/strict";
import { test } from "node:test";

const { runLearned } = await import("../dist/learned-workflow.js");

/** One call node: web_fetch on the input's url. */
const FETCH = { v: 2, name: "fetch-one", schemas: { In: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Page: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Page", path: "page" }, root: { node: "call", label: "fetch", via: "tool", tool: "web_fetch", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 } };
const flow = { name: "fetch-one", description: "Fetches a page", workflow: JSON.stringify(FETCH) };
const run = { workflows: [flow], granted: ["web_fetch"], env: {}, work: "/nonexistent", models: { getModel: () => undefined, getModels: () => [] }, modelOf: () => undefined };

test("a learned workflow run with no tool policy runs nothing and says why; never a call node on a default of allow", async () => {
  for (const missing of [{}, { policy: () => "allow" }, { denyFrom: () => "default" }]) {
    const out = await runLearned({ ...run, ...missing }, flow, { url: "http://127.0.0.1:9/" });
    assert.deepEqual(out, { text: "The learned workflow fetch-one was not run: its run gave no tool policy for its call nodes", isError: true }, JSON.stringify(Object.keys(missing)));
  }
});

test("with its policy given, a tool set to deny is refused in the gate's words", async () => {
  const out = await runLearned({ ...run, policy: () => "deny", denyFrom: () => "agent" }, flow, { url: "http://127.0.0.1:9/" });
  assert.equal(out.isError, true);
  assert.match(out.text, /web_fetch, which is set to deny for this agent/);
});
