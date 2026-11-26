// A learned workflow's revisions (GET /v2/agents/{id}/learning/workflows/{name}/revisions): the saves of the agent's
// learning that changed its workflow.json, oldest first, each with who made it, when, why and the text it had then; the
// latest `limit` of them; a workflow no save changed is 404; a README-only save (a retire, an approval) is no revision of
// its workflow.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { putLearning } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, answerFlow, serve } from "./support.mjs";

/** `files` saved on agent `id`'s learning in one save, by `by` (a run's merge `{ runId, reason }`, or a person's change
 *  `{ person, file }`); its version id. */
const commit = (store, id, files, by) => putLearning(store, id, files, by);
const README = (name) => `---\nname: ${name}\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n`;
const JSON_OF = (flow) => JSON.stringify(flow);

test("a learned workflow's revisions: oldest first with the text each had, by run and by person, the latest `limit`, 404 for one no save changed", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, store } = await serve(t, { learning: "on" });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning/workflows/{name}/revisions"].get.responses["200"].content["application/json"].schema;
  const id = "invoice-sorter";
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness: "pi", instructions: "Answer the question." }))).status, 201);
  await store.learning.seed(id);
  const path = "workflows/answer/workflow.json";
  const v1 = answerFlow("Answer the question.");
  const v2 = answerFlow("Answer the question, in whole numbers.");
  const v3 = { ...v2, root: { node: "chain", steps: [...v2.root.steps, { node: "extract", label: "check", instructions: "Check it.", out: "Answer", as: "answer" }] } };
  const first = await commit(store, id, { [path]: JSON_OF(v1), "workflows/answer/README.md": README("answer") }, { runId: "run-1", reason: "It does the job again." });
  await commit(store, id, { "corrections.md": "- Answer in whole numbers.\n" }, { runId: "run-2", reason: "Its owner's correction." });
  const second = await commit(store, id, { [path]: JSON_OF(v2) }, { runId: "run-3", reason: "The instruction said whole numbers." });
  await commit(store, id, { "workflows/answer/README.md": `${README("answer")}retired\n` }, { person: "retired", file: "workflows/answer/README.md" });
  const third = await commit(store, id, { [path]: JSON_OF(v3) }, { person: "edited", file: path });

  const read = async (query = "", name = "answer") => api("GET", `/agents/${id}/learning/workflows/${name}/revisions${query}`);
  const all = await read();
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(schemaProblems(doc, schema, all.body), []);
  assert.deepEqual(all.body.revisions.map((r) => [r.commit, r.by, r.text && JSON.parse(r.text)]), [[first, { run: "run-1" }, v1], [second, { run: "run-3" }, v2], [third, { user: true }, v3]], "oldest first; the README save and the corrections save are no revisions");
  assert.deepEqual([all.body.name, all.body.total, all.body.truncated], ["answer", 3, false]);
  // Each revision's digest is its file's (workflow-first.ts workflowDigest): what runs' metrics and promotion records name it by.
  assert.deepEqual(all.body.revisions.map((r) => r.digest), all.body.revisions.map((r) => createHash("sha256").update(r.text).digest("hex").slice(0, 16)));
  assert.equal(new Set(all.body.revisions.map((r) => r.digest)).size, 3);
  assert.match(all.body.revisions[0].reason, /It does the job again\./);
  assert.ok(Date.parse(all.body.revisions[0].at) > 0);

  const last = await read("?limit=2");
  assert.deepEqual(last.body.revisions.map((r) => r.commit), [second, third], "the latest ones, still oldest first");
  assert.equal(last.body.total, 3, "total counts every revision, limit aside");

  for (const query of ["?limit=0", "?limit=51", "?limit=two"]) assert.equal((await read(query)).status, 400, query);
  assert.equal((await read("", "Bad_Name")).status, 400, "a name a workflow cannot have");
  assert.equal((await read("", "never-learned")).status, 404);
  assert.equal((await api("GET", "/agents/nobody/learning/workflows/answer/revisions")).status, 404);
});
