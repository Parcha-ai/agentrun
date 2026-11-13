// A learned workflow's revisions (GET /v2/agents/{id}/learning/workflows/{name}/revisions): the commits on main that changed
// its workflow.json, oldest first, each with who made it, when, why and the text it had then; the latest `limit` of them;
// a workflow no commit changed is 404; a README-only commit (a retire, an approval) is no revision of its workflow.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, answerFlow, serve } from "./support.mjs";

/** `files` committed on agent `id`'s main as one commit, its message `message`; then the snapshot rebuilt. */
async function commit(data, id, files, message) {
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", message]);
  await resnap(data, id);
  return git(repo, ["rev-parse", "main"]);
}
const README = (name) => `---\nname: ${name}\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n`;
const JSON_OF = (flow) => JSON.stringify(flow);

test("a learned workflow's revisions: oldest first with the text each had, by run and by person, the latest `limit`, 404 for one no commit changed", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, data } = await serve(t, { learning: "on" });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning/workflows/{name}/revisions"].get.responses["200"].content["application/json"].schema;
  const id = "invoice-sorter";
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness: "pi", instructions: "Answer the question." }))).status, 201);
  await seedOf(data, id);
  const path = "workflows/answer/workflow.json";
  const v1 = answerFlow("Answer the question.");
  const v2 = answerFlow("Answer the question, in whole numbers.");
  const v3 = { ...v2, root: { node: "chain", steps: [...v2.root.steps, { node: "extract", label: "check", instructions: "Check it.", out: "Answer", as: "answer" }] } };
  const first = await commit(data, id, { [path]: JSON_OF(v1), "workflows/answer/README.md": README("answer") }, "learning: run-1: merged\n\nIt does the job again.\n\nRun-Id: run-1");
  await commit(data, id, { "other.md": "---\nname: Other\ndescription: another note\ntype: reference\n---\nx\n" }, "learning: run-2: merged\n\nRun-Id: run-2");
  const second = await commit(data, id, { [path]: JSON_OF(v2) }, "learning: run-3: merged\n\nThe instruction said whole numbers.\n\nRun-Id: run-3");
  await commit(data, id, { "workflows/answer/README.md": `${README("answer")}retired\n` }, "learning: retired by a person: workflows/answer/README.md\n\nChanged-By: user");
  const third = await commit(data, id, { [path]: JSON_OF(v3) }, "learning: edited by a person: workflows/answer/workflow.json\n\nChanged-By: user");

  const read = async (query = "", name = "answer") => api("GET", `/agents/${id}/learning/workflows/${name}/revisions${query}`);
  const all = await read();
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(schemaProblems(doc, schema, all.body), []);
  assert.deepEqual(all.body.revisions.map((r) => [r.commit, r.by, r.text && JSON.parse(r.text)]), [[first, { run: "run-1" }, v1], [second, { run: "run-3" }, v2], [third, { user: true }, v3]], "oldest first; the README commit and the other note's commit are no revisions");
  assert.deepEqual([all.body.name, all.body.total, all.body.truncated], ["answer", 3, false]);
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
