// A run's grade runs under what its cap leaves ("spend caps never overspend"). A run that learns ends, and its learning
// run grades what it kept: that learning run's launch carries the run's cap left once the job, its follow-ups and each
// look-back are counted, and its earlier rounds' grades (max_cost_usd, runner/learning-end.ts gradeCapOf), and each
// grader call is judged against it before it leaves at its worst case (its input uncached, its whole output bound). A
// grade that doesn't fit is never sent: the learning is skipped, "Not graded: no room under the cap.", never a failure,
// never past the cap. One that fits is graded and merged as before, and an uncapped run's grade is capped by nothing.
// On the faux model ($1 per million tokens each way) a grade's worst case is about $0.02: a $0.015 cap leaves no room for
// it once the job and its look-back are spent, a $0.05 cap does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];
const NO_ROOM = 0.015;
const ROOM = 0.05;
const REVIEW = "Review: the reference MCC for Acme Diner is 5812 (Eating Places, Restaurants); you answered 5814.";
const near = (a, b) => Math.abs(a - b) < 1e-9;

/** Agent `id` on `harness` run once under `cap` (none: uncapped), followed until its learning ended. */
async function learnedUnder(t, harness, id, cap) {
  const server = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(LEARN) });
  await made(server.api, learner(id, { harness, plan: PLAN }));
  const runId = await started(server.api, id, "Classify Acme Diner.", cap === undefined ? {} : { max_cost_usd: cap });
  const { view } = await ended(server.api, runId);
  const learning = await server.store.runs.get(`${runId}-learning`);
  const launch = learning ? (await server.store.runs.launch(learning.id)).body : undefined;
  return { server, runId, view, learning, launch };
}

for (const harness of ["pi", "codex"]) {
  test(`on ${harness}, a capped run whose grade doesn't fit what its cap left is not graded: skipped, said so, and its spend stays within its cap`, { timeout: 180_000 }, async (t) => {
    const { view, learning, launch } = await learnedUnder(t, harness, `no-room-${harness}`, NO_ROOM);
    assert.equal(view.status, "completed");
    assert.ok(typeof view.cost?.usd === "number" && view.cost.usd > 0, JSON.stringify(view.cost));
    // The learning run's cap: what the run's cap left once its job and its look-back were spent.
    assert.ok(near(launch?.max_cost_usd, NO_ROOM - view.cost.usd), `the grade's cap is the run's left: ${JSON.stringify({ launch, cost: view.cost, learning: view.learning })}`);
    assert.deepEqual([view.learning?.state, view.learning?.reason, view.learning?.detail], ["dropped", "no_budget", "Not graded: no room under the cap."], JSON.stringify(view.learning));
    // Skipped, never failed: its learning run ended, and spent nothing (no grade request was sent).
    assert.deepEqual([learning?.state, learning?.costUsd], ["ended", 0]);
    assert.ok(view.cost.usd + learning.costUsd <= NO_ROOM, "the run and its grade together within the cap");
  });

  test(`on ${harness}, a capped run whose grade fits what its cap left is graded and merged as before, within its cap`, { timeout: 180_000 }, async (t) => {
    const { view, learning, launch } = await learnedUnder(t, harness, `room-${harness}`, ROOM);
    assert.deepEqual([view.learning?.state, view.learning?.reason], ["merged", null], JSON.stringify(view.learning));
    assert.ok(near(launch?.max_cost_usd, ROOM - view.cost.usd), JSON.stringify({ launch, cost: view.cost }));
    assert.equal(learning?.state, "ended");
    assert.ok(learning.costUsd > 0, "the grade was paid for");
    assert.ok(learning.costUsd <= launch.max_cost_usd, "the grade within what the cap left");
    assert.ok(view.cost.usd + learning.costUsd <= ROOM, "the run and its grade together within the cap");
  });
}

test("an uncapped run's grade is capped by nothing: its learning run's launch carries no cap, and it merges as before", { timeout: 180_000 }, async (t) => {
  const { view, learning, launch } = await learnedUnder(t, "pi", "uncapped", undefined);
  assert.equal(view.cost?.cap_usd, null);
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["merged", null], JSON.stringify(view.learning));
  assert.ok(launch && !("max_cost_usd" in launch), JSON.stringify(launch));
  assert.ok(learning.costUsd > 0);
});

test("a later round's grade runs under what the cap leaves once the earlier round's grade is counted too", { timeout: 180_000 }, async (t) => {
  const { server, runId, view, learning } = await learnedUnder(t, "pi", "two-rounds", ROOM);
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  assert.ok(learning.costUsd > 0, "the first round's grade was paid for");
  assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: REVIEW })).status, 202);
  const second = await ended(server.api, runId);
  assert.equal(second.view.learning?.state, "merged", JSON.stringify(second.view.learning));
  const launch = (await server.store.runs.launch(`${runId}-learning-2`)).body;
  // The run's spend now (its job, both look-backs and the follow-up) and the first round's grade, both out of the cap.
  assert.ok(near(launch.max_cost_usd, ROOM - second.view.cost.usd - learning.costUsd), JSON.stringify({ launch, cost: second.view.cost, first: learning.costUsd }));
  const graded = (await server.store.runs.get(`${runId}-learning-2`)).costUsd;
  assert.ok(second.view.cost.usd + learning.costUsd + graded <= ROOM, "the run and both its grades together within the cap");
});
