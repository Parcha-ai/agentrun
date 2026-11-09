// GET /v2/runs/{id}/learning/diff on the switch, over the one store (learning-routes.ts runDiffOverStore): a run its
// learning run merged reads its merge against its parent from its agent's learning folder; one whose proposal the grader
// dropped reads its notes as added files against its seed; one that proposed nothing reads no file against the seed its
// launch names; a run that does not learn is 404. A patch that holds a value saved as a secret after the merge is withheld
// ("secret"). The answer is main's shape (the API document's /runs/{run_id}/learning/diff).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { git, LEARN, learner, made, repoOf, sleep, started } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** `text`, an added file, as git's unified diff writes it, hunks only. */
const added = (text) => {
  const lines = text.split("\n").slice(0, -1);
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((one) => `+${one}\n`).join("")}`;
};

/** Agent `id`'s definition replaced with `definition`'s, less its id and version (a new revision its next run runs). */
async function redefined(api, { definition: { id, version: _, ...definition } }) {
  const res = await api("PUT", `/agents/${id}/definition`, { definition });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

/** Run `runId`, completed, once its learning has ended (merged or dropped): its learning as GET /runs/{id}/learning reads it. */
async function learningEnd(api, runId) {
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  for (let i = 0; ; i++) {
    const learning = (await api("GET", `/runs/${runId}/learning`)).body;
    if (["merged", "dropped"].includes(learning?.state)) return learning;
    assert.ok(i < 1200, `the run's learning ends: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

test("a run's learning diff over the store: a merge against its parent, a dropped proposal's notes as added against its seed, nothing proposed against its seed, 404 for a run that does not learn, and a patch holding a value saved as a secret since withheld", { timeout: 240_000 }, async (t) => {
  // A value no file of this repository holds: a note holds it as it merges, and it is saved as a tool key after.
  const value = ["diff", "store", "pass", process.pid, Date.now().toString(36)].join("-");
  const UNITS = note("Check units", "Convert every amount to one unit before comparing", `Amounts came in cents and in dollars; the pass is ${value}.\n`);
  const TABLES = note("Prefers tables", "Answer with a table when comparing");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api, baseUrl, data } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/runs/{run_id}/learning/diff"].get.responses["200"].content["application/json"].schema;
  const meets = (value) => assert.deepEqual(schemaProblems(doc, schema, value), [], JSON.stringify(value));

  // Run 1 merges: its diff is its merge against its parent, as the merge's script wrote it.
  await made(api, learner("differ", { plan: [["check-units.md", UNITS]], once: true }));
  const one = await started(api, "differ");
  const learned1 = await learningEnd(api, one);
  assert.equal(learned1.state, "merged", JSON.stringify(learned1));
  const repo = repoOf(data, "differ");
  const main1 = git(repo, ["rev-parse", "main"]);
  assert.equal(learned1.merged, main1);
  const diff1 = await api("GET", `/runs/${one}/learning/diff`);
  assert.equal(diff1.status, 200, JSON.stringify(diff1.body));
  meets(diff1.body);
  assert.deepEqual([diff1.body.base, diff1.body.head], [git(repo, ["rev-parse", `${main1}^`]), main1]);
  assert.deepEqual(diff1.body.files.map((f) => [f.path, f.status]), [["MEMORY.md", "modified"], ["check-units.md", "added"]]);
  assert.equal(diff1.body.files[1].patch, added(UNITS));

  // Run 2: the grader drops its note, so its diff is its proposal against its seed (run 1's merge).
  await redefined(api, learner("differ", { plan: [["prefers-tables.md", TABLES]], instructions: "Answer the question.\nGrade: drop." }));
  const two = await started(api, "differ");
  const learned2 = await learningEnd(api, two);
  assert.deepEqual([learned2.state, learned2.reason], ["dropped", "grader"], JSON.stringify(learned2));
  const diff2 = await api("GET", `/runs/${two}/learning/diff`);
  meets(diff2.body);
  assert.deepEqual(diff2.body, { base: main1, head: null, files: [{ path: "prefers-tables.md", status: "added", patch: added(TABLES) }] });

  // Run 3 proposes nothing: no file, against the seed its launch names.
  await redefined(api, learner("differ", { instructions: "Answer the question." }));
  const three = await started(api, "differ");
  const learned3 = await learningEnd(api, three);
  assert.deepEqual([learned3.state, learned3.reason], ["dropped", "empty"], JSON.stringify(learned3));
  const diff3 = await api("GET", `/runs/${three}/learning/diff`);
  meets(diff3.body);
  assert.deepEqual(diff3.body, { base: main1, head: null, files: [] });

  // A run of an agent that does not learn: 404.
  await made(api, agent("plain", { instructions: "Answer the question." }));
  const plain = await started(api, "plain");
  await follow(api, plain, ["completed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${plain}/learning/diff`)).status, 404);

  // The value saved as a tool key: run 1's note's patch, which holds it, is withheld as secret, and nothing shows it.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const cut = (await api("GET", `/runs/${one}/learning/diff`)).body;
  meets(cut);
  assert.deepEqual(cut.files.find((f) => f.path === "check-units.md"), { path: "check-units.md", status: "added", withheld: "secret" });
  assert.ok(!JSON.stringify(cut).includes(value), "the value is nowhere in the diff");
});
