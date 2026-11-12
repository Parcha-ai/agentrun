// A follow-up to a finished run of an agent that learns: the run opens again, answers it, and at its new end looks back
// once more, a round of its own. The new end-of-run turn is asked of the model (never answered from the first round's
// submission), sees the follow-up (a reviewer's word on its answer included), and keeps its own proposal, graded and
// merged by a learning run of its own, beside the first round's, which stays as it was. What the follow-up's own turn and
// the new look-back cost is kept with the round, apart from the job's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, reflectRows, repoOf, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const PLAN = [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]];
const REVIEW = "Review: the reference MCC for Acme Diner is 5812 (Eating Places, Restaurants); you answered 5814.";

test("a review sent to a finished run of a learning agent asks its end-of-run turn again with the review in it: a second round, graded and merged by its own learning run, beside the first", { timeout: 150_000 }, async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("reviewed", { plan: PLAN }));
  const runId = await started(api, "reviewed", "Classify Acme Diner.");
  const first = await ended(api, runId);
  assert.equal(first.view.learning?.state, "merged", JSON.stringify(first.view.learning));
  const repo = repoOf(data, "reviewed");
  const before = Number(git(repo, ["rev-list", "--count", "main"]));

  const sent = await api("POST", `/runs/${runId}/messages`, { content: REVIEW });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const second = await ended(api, runId);
  assert.equal(second.view.status, "completed");
  assert.equal(second.view.learning?.state, "merged", `the second round merged: ${JSON.stringify(second.view.learning)}`);

  // Main holds both rounds: the first's note, then the review's, one merge more.
  const files = git(repo, ["ls-tree", "--name-only", "main"]).split("\n");
  assert.ok(files.includes("check-units.md") && files.includes("reviewed.md"), files.join(", "));
  assert.match(git(repo, ["show", "main:reviewed.md"]), /the reference MCC for Acme Diner is 5812/);
  assert.equal(Number(git(repo, ["rev-list", "--count", "main"])), before + 1, "one merge more");

  // Two kept rounds: the first as it was, the second with the review in what the person said, each with its own learning
  // run. The run's learning reads the newest.
  const [one, two] = [await store.learning.proposal(runId, 1), await store.learning.proposal(runId, 2)];
  assert.equal(one?.round, 1);
  assert.equal(two?.round, 2);
  assert.deepEqual(one.turn.asked, ["Classify Acme Diner."]);
  assert.deepEqual(two.turn.asked, ["Classify Acme Diner.", REVIEW], "the second round heard the review, and no end-of-run prompt");
  assert.match(two.turn.answer, /```note reviewed\.md/);
  assert.equal(one.learningRunId, `${runId}-learning`);
  assert.equal(two.learningRunId, `${runId}-learning-2`);
  assert.equal((await store.learning.proposal(runId))?.round, 2, "the run's learning is its newest round");
  assert.equal((await store.runs.get(`${runId}-learning`))?.state, "ended", "the first round's learning run stands");
  assert.equal((await store.runs.get(`${runId}-learning-2`))?.state, "ended");

  // What each part cost: the job's, the first look-back, then the follow-up's own turn and the second look-back, apart.
  const [p1, p2] = [one.proposal, two.proposal];
  assert.ok(p1.job_cost_usd > 0 && p1.look_back_usd > 0, JSON.stringify(p1));
  assert.equal(p1.follow_up_usd, undefined, "the first round follows no message");
  assert.ok(p2.follow_up_usd > 0, `the review's own turn is the round's: ${JSON.stringify(p2)}`);
  assert.ok(p2.look_back_usd > 0, JSON.stringify(p2));
  assert.ok(Math.abs(p2.job_cost_usd - (p1.job_cost_usd + p1.look_back_usd + p2.follow_up_usd)) < 1e-9, "spend before the second look-back = the job, the first look-back and the follow-up");

  // The timeline: each round's turn is learning's, the review and its answer are not.
  const turnRows = reflectRows(second.rows);
  const asks = turnRows.filter((row) => row.kind === "user_message");
  assert.equal(asks.length, 2, `two end-of-run asks, each labelled: ${JSON.stringify(turnRows.map((row) => [row.kind, row.summary]))}`);
  const review = second.rows.find((row) => row.kind === "user_message" && row.text === REVIEW);
  assert.ok(review, "the review is a person's message in the timeline");
  assert.notEqual(review.agent_label, "learning", "and never learning's");
});

test("a follow-up to a run whose first look-back kept nothing still looks back: its round merges what the review taught", { timeout: 150_000 }, async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("blank"));
  const runId = await started(api, "blank", "Classify Acme Diner.");
  const first = await ended(api, runId);
  assert.deepEqual([first.view.learning?.state, first.view.learning?.reason], ["dropped", "empty"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: REVIEW })).status, 202);
  const second = await ended(api, runId);
  assert.equal(second.view.learning?.state, "merged", JSON.stringify(second.view.learning));
  assert.deepEqual(git(repoOf(data, "blank"), ["ls-tree", "--name-only", "main"]).split("\n"), ["MEMORY.md", "reviewed.md"]);
  assert.equal((await store.learning.proposal(runId, 1))?.proposal.reason, "empty", "the first round's drop stands");
});
