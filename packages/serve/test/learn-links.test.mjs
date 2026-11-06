// Every path the end of a run takes into its agent's learning folder goes through agentFolder (learning.ts): the
// end-of-run turn's seed, read again; the check of what the turn wrote against that seed; the grade's read of main; and
// the merge. With a link planted at disk/agents/<key>/learning (agentFolderOf), to a folder that works, each refuses: the run's
// learning is dropped with that step's reason, and nothing is read or written through the link.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, repoOf, savedOf, settled, sleep, started } from "./learn-support.mjs";
import { runDir, scratch, serve, withEnv } from "./support.mjs";

const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];

/** Agent `id`'s folder moved to `aside`, and a link to it planted where it was: followed, the link finds a folder that works. */
function plant(data, id, aside) {
  renameSync(repoOf(data, id), aside);
  symlinkSync(aside, repoOf(data, id));
  assert.ok(lstatSync(repoOf(data, id)).isSymbolicLink());
}

/** Every file under `dir`, `.git` included, with a digest of its bytes: what a write through the link would change. */
function tree(dir, at = "") {
  return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((entry) => {
    const path = join(at, entry.name);
    if (entry.isDirectory()) return tree(dir, path);
    return [`${path} ${createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")}`];
  }).sort();
}

async function until(what, check) {
  for (let i = 0; !(await check()); i++) {
    assert.ok(i < 1200, what);
    await sleep(50);
  }
}

const callsIn = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

test("a link planted at the agent's learning folder after the run started: the end-of-run turn's seed is refused (reflect_failed), and the turn's check is refused (propose_failed); nothing is read or written through it", { timeout: 150_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const dir = await scratch(t);

  // The seed read again before the turn: planted while the job holds, after the run was seeded through the real folder.
  const answer = join(dir, "answer");
  await made(api, learner("seeder", { instructions: `Answer once ${answer} exists.`, plan: PLAN }));
  const seeder = await started(api, "seeder");
  await until("the run is seeded", () => existsSync(join(runDir(data, seeder), "learning.json")));
  const seederAside = join(dir, "seeder-learning");
  plant(data, "seeder", seederAside);
  const seederBefore = tree(seederAside);
  writeFileSync(answer, "");
  const one = await ended(api, seeder);
  assert.equal(one.view.result.final_answer, "Job answer.", "the job's answer stands");
  settled(one.view, one.rows, "dropped", "reflect_failed");
  assert.deepEqual(tree(seederAside), seederBefore, "nothing written through the link");

  // The check of what the turn answered: planted while the turn holds, once its seed was read through the real folder.
  const reflect = join(dir, "reflect");
  await made(api, learner("proposer", { instructions: `Reflect once ${reflect} exists.`, plan: PLAN }));
  const proposer = await started(api, "proposer");
  await until("the turn is asked", async () => (await api("GET", `/runs/${proposer}/timeline`)).body.rows?.some((row) => row.agent_label === "learning" && row.kind === "user_message"));
  const proposerAside = join(dir, "proposer-learning");
  plant(data, "proposer", proposerAside);
  const proposerBefore = tree(proposerAside);
  writeFileSync(reflect, "");
  const two = await ended(api, proposer);
  settled(two.view, two.rows, "dropped", "propose_failed");
  assert.equal(existsSync(join(runDir(data, proposer), "learning-proposal.json")), false, "nothing was proposed");
  assert.deepEqual(tree(proposerAside), proposerBefore, "nothing written through the link");
});

test("a link planted at the agent's learning folder while a run's proposal waits for its grade: the grade's read of main is refused, the grader never asked, and the merge of a kept verdict is refused, both grade_failed; main never moves", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, AGENTRUN_TEST_FAUX_GRADE_HOLD: "1" }, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  // Two runs proposed, each held at its grader, and the server closed under them: both stay proposed.
  const first = await serve(t, { learning: "on", faux: LEARN });
  const { data } = first;
  const runs = {};
  for (const id of ["reader", "merger"]) {
    await made(first.api, learner(id, { plan: PLAN }));
    runs[id] = await started(first.api, id);
    await until(`${id}'s grader is asked`, async () => (await first.api("GET", `/runs/${runs[id]}`)).body.learning?.state === "proposed" && callsIn(calls).length === Object.keys(runs).length);
  }
  await first.close();
  delete process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD;
  // The merger's verdict was kept before the server went: its next start merges on it, without reading main to grade.
  const file = join(runDir(data, runs.merger), "serve.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(meta.learning.state, "proposed");
  writeFileSync(file, JSON.stringify({ ...meta, learning: { ...meta.learning, verdict: { merge: true, reason: "Each note is general and new.", items: [{ file: "check-units.md", keep: true, why: "It holds as a general rule." }] }, cost_usd: { grade: 0.001 }, tokens: { grade: { input: 1, cache_read: 0, cache_write: 0, output: 1 } } } }));
  const before = {};
  for (const id of ["reader", "merger"]) {
    plant(data, id, join(dir, `${id}-learning`));
    before[id] = tree(join(dir, `${id}-learning`));
  }

  const second = await serve(t, { learning: "on", faux: LEARN, data });
  for (const id of ["reader", "merger"]) {
    const { view, rows } = await ended(second.api, runs[id]);
    settled(view, rows, "dropped", "grade_failed");
    await savedOf(data, runs[id]);
    assert.deepEqual(tree(join(dir, `${id}-learning`)), before[id], `${id}: nothing written through the link`);
    assert.equal(git(join(dir, `${id}-learning`), ["rev-list", "--count", "main"]), "1", `${id}: main did not move`);
  }
  assert.equal(callsIn(calls).length, 2, "the grader was not asked again: main was never read through the link");
});
