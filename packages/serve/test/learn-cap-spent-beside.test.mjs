// A run's cap counts what was spent beside it on its behalf ("spend caps never overspend"): its learning runs' grades. A
// capped run that learns ends, and its learning run grades what it kept under what the cap left (its launch's
// max_cost_usd). A follow-up then opens the run again: every gate of the run (the adapter loop's one cap, on pi and on a
// CLI harness alike) reads its own sessions' spend and what its learning runs took beside them (Store.learning.spentBeside:
// a grade under way at its own cap, the most it may take; one that ended at its cost). A follow-up whose first request
// would take the run and its grades past the cap is never sent: the run parks for a raise, as at any spend limit, and
// a raise resumes it. An uncapped run's follow-up is held to nothing, as before.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, sleep, started } from "./learn-support.mjs";
import { follow, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];
/** Room for the first round's grade at its worst case (about $0.02 on the faux model), and for the job and its look-back. */
const CAP = 0.05;
const RAISED = 1;
const REVIEW = "Review: the reference MCC for Acme Diner is 5812 (Eating Places, Restaurants); you answered 5814.";
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const EPS = 1e-9;

/** A server, and agent `id` on `harness` whose grade holds its answer until `gate` exists (and that answers a follow-up on
 *  a faux CLI harness too). */
async function heldGrader(t, harness, id) {
  const dir = await mkdtemp(join(tmpdir(), "cap-beside-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gate = join(dir, "grade");
  const server = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(LEARN) });
  await made(server.api, learner(id, { harness, plan: PLAN, instructions: `Answer the question.\nFollow up.\nGrade once ${gate} exists.` }));
  return { server, gate };
}

/** Run `runId` completed, then its first round's learning run claimed and grading (held), read back. */
async function grading(server, runId) {
  await follow(server.api, runId, ["completed"], { deadlineMs: 90_000 });
  for (let i = 0; ; i++) {
    const learning = await server.store.runs.get(`${runId}-learning`);
    if (learning?.state === "running") return learning;
    assert.ok(i < 1800, `the learning run is grading: ${JSON.stringify(learning)}`);
    await sleep(50);
  }
}

/** Follows the run's learning run `id` until it ended. */
async function learningEnded(server, id) {
  for (let i = 0; ; i++) {
    const run = await server.store.runs.get(id);
    if (["ended", "failed", "stopped"].includes(run?.state)) return run;
    assert.ok(i < 1800, `the learning run ended: ${JSON.stringify(run)}`);
    await sleep(50);
  }
}

for (const harness of ["pi", "codex"]) {
  test(`on ${harness}, a follow-up while the run's grade is under way is held to what the grade leaves: it parks at the cap for a raise, never sent past it`, { timeout: 240_000 }, async (t) => {
    const { server, gate } = await heldGrader(t, harness, `beside-${harness}`);
    const runId = await started(server.api, `beside-${harness}`, "Classify Acme Diner.", { max_cost_usd: CAP });
    await grading(server, runId);
    const job = (await server.api("GET", `/runs/${runId}`)).body;
    const reserved = (await server.store.runs.launch(`${runId}-learning`)).body.max_cost_usd;
    assert.ok(Math.abs(reserved - (CAP - job.cost.usd)) < EPS, `the grade holds what the cap left: ${JSON.stringify({ reserved, cost: job.cost })}`);

    // The follow-up: its first request would take the run past its cap once the grade's hold is counted. Not sent: parked.
    assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: REVIEW })).status, 202);
    await follow(server.api, runId, ["input_required"], { deadlineMs: 90_000 });
    const parked = (await server.api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([parked.status, parked.pending?.kind], ["input_required", "budget"], JSON.stringify(parked));
    // What the cap counted as taken: the run's own spend and the grade's hold beside it, the whole cap; nothing more sent.
    assert.ok(Math.abs(parked.pending.spent_usd - CAP) < 1e-6, `the run's spend and its grade's hold: ${JSON.stringify(parked.pending)}`);
    assert.ok(Math.abs(parked.cost.usd - job.cost.usd) < EPS, `nothing of the follow-up was spent: ${JSON.stringify([job.cost, parked.cost])}`);

    // The grade ends (well under its hold); a raise resumes the run, which answers the follow-up and learns again.
    await writeFile(gate, "");
    const first = await learningEnded(server, `${runId}-learning`);
    assert.equal(first.state, "ended");
    assert.ok(first.costUsd > 0 && first.costUsd <= reserved, JSON.stringify(first));
    const raised = await server.api("PATCH", `/runs/${runId}`, { max_cost_usd: RAISED });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    const { view } = await ended(server.api, runId);
    assert.deepEqual([view.status, view.cost.cap_usd], ["completed", RAISED], JSON.stringify(view));
    const second = await server.store.runs.get(`${runId}-learning-2`);
    const grades = first.costUsd + (second?.costUsd ?? 0);
    assert.ok(view.cost.usd + grades <= RAISED, "the run and its grades together within its cap");
  });
}

test("on pi, a follow-up after an earlier grade that ended is held to what that grade's cost leaves: parked at the cap, the run and its grade within it", { timeout: 240_000 }, async (t) => {
  const server = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(LEARN) });
  await made(server.api, learner("beside-ended", { harness: "pi", plan: PLAN }));
  const runId = await started(server.api, "beside-ended", "Classify Acme Diner.", { max_cost_usd: CAP });
  const { view: job } = await ended(server.api, runId);
  assert.equal(job.learning?.state, "merged", JSON.stringify(job.learning));
  // The earlier grade spent all but a cent's tenth of what the cap left it (the faux grader's own cost is far smaller; a
  // real grade on a long proposal costs that much): its learning run's row, as its end wrote it, says so.
  const graded = CAP - job.cost.usd - 0.0001;
  setCost(server, `${runId}-learning`, graded);
  assert.equal((await server.store.runs.get(`${runId}-learning`)).costUsd, graded);

  assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: REVIEW })).status, 202);
  await follow(server.api, runId, SETTLED, { deadlineMs: 90_000 });
  const parked = (await server.api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([parked.status, parked.pending?.kind], ["input_required", "budget"], JSON.stringify(parked));
  assert.ok(Math.abs(parked.pending.spent_usd - (job.cost.usd + graded)) < 1e-6, `the run's spend and its grade's: ${JSON.stringify(parked.pending)}`);
  assert.ok(parked.cost.usd + graded <= CAP + EPS, `the run and its grade within the cap: ${JSON.stringify(parked.cost)}`);
});

test("on pi, an uncapped run's follow-up while its grade is under way is held to nothing: it answers as before", { timeout: 240_000 }, async (t) => {
  const { server, gate } = await heldGrader(t, "pi", "beside-uncapped");
  const runId = await started(server.api, "beside-uncapped", "Classify Acme Diner.");
  await grading(server, runId);
  assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: REVIEW })).status, 202);
  await follow(server.api, runId, ["completed"], { deadlineMs: 90_000 });
  const view = (await server.api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.pending, view.cost.cap_usd], ["completed", null, null], JSON.stringify(view));
  await writeFile(gate, "");
  assert.equal((await learningEnded(server, `${runId}-learning`)).state, "ended");
});

/** Writes run `id`'s cost on the server's store file, as its end would have. */
function setCost(server, id, usd) {
  const db = new DatabaseSync(join(server.data, "store.sqlite"), { timeout: 15_000 });
  try {
    assert.equal(db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(usd, id).changes, 1);
  } finally {
    db.close();
  }
}
