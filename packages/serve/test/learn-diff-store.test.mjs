// GET /v2/runs/{id}/learning/diff on the switch, over the one store (learning-routes.ts runDiffOverStore): a run whose
// learning merged (its owner's correction appended to corrections.md) reads its merge against its parent from its
// agent's learning folder; one that merged nothing reads no file against the seed its launch names; a run that does not
// learn is 404. A patch that holds a value saved as a secret after the run is withheld ("secret"). The answer is main's
// shape (the API document's /runs/{run_id}/learning/diff).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ended, fedBack, git, LEARN, learner, made, repoOf, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** `text`, an added file, as git's unified diff writes it, hunks only (a one-line hunk's count left out, as git does). */
const added = (text) => {
  const lines = text.split("\n").slice(0, -1);
  return `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n${lines.map((one) => `+${one}\n`).join("")}`;
};

test("a run's learning diff over the store: a merge against its parent, nothing merged against its seed, 404 for a run that does not learn, and a value saved as a secret since withheld from a merge's patch", { timeout: 240_000 }, async (t) => {
  // A value no file of this repository holds, saved as a tool key after the runs: the owner's correction holds it.
  const value = ["diff", "store", "pass", process.pid, Date.now().toString(36)].join("-");
  const label = `Convert every amount to one unit before comparing; the pass is ${value}.`;
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY"]);
  const { api, baseUrl, data } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/runs/{run_id}/learning/diff"].get.responses["200"].content["application/json"].schema;
  const meets = (value) => assert.deepEqual(schemaProblems(doc, schema, value), [], JSON.stringify(value));

  // Run 1 merges its owner's correction: its diff is its merge against its parent, as the merge's script wrote it.
  await made(api, learner("differ"));
  const runOne = (await fedBack(api, "differ", { label })).view.run_id;
  const learned1 = (await api("GET", `/runs/${runOne}/learning`)).body;
  assert.equal(learned1.state, "merged", JSON.stringify(learned1));
  const repo = repoOf(data, "differ");
  const main1 = git(repo, ["rev-parse", "main"]);
  assert.equal(learned1.merged, main1);
  const diff1 = await api("GET", `/runs/${runOne}/learning/diff`);
  assert.equal(diff1.status, 200, JSON.stringify(diff1.body));
  meets(diff1.body);
  assert.deepEqual([diff1.body.base, diff1.body.head], [git(repo, ["rev-parse", `${main1}^`]), main1]);
  assert.deepEqual(diff1.body.files, [{ path: "corrections.md", status: "added", patch: added(`- ${label}\n`) }]);

  // Run 2 merges nothing: no file, against the seed its launch names.
  const two = await started(api, "differ");
  const { view: view2 } = await ended(api, two);
  assert.deepEqual([view2.learning.state, view2.learning.reason], ["dropped", "empty"], JSON.stringify(view2.learning));
  const diff2 = await api("GET", `/runs/${two}/learning/diff`);
  meets(diff2.body);
  assert.deepEqual(diff2.body, { base: main1, head: null, files: [] });

  // A run of an agent that does not learn: 404.
  await made(api, agent("plain", { instructions: "Answer the question." }));
  const plain = await started(api, "plain");
  await follow(api, plain, ["completed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${plain}/learning/diff`)).status, 404);

  // The value saved as a tool key: run 1's correction's patch, which holds it, is withheld as secret, and nothing shows it.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const cut = (await api("GET", `/runs/${runOne}/learning/diff`)).body;
  meets(cut);
  assert.deepEqual(cut.files, [{ path: "corrections.md", status: "added", withheld: "secret" }]);
  assert.ok(!JSON.stringify(cut).includes(value), "the value is nowhere in the diff");
});
