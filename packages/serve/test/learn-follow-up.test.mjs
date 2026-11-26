// A follow-up to a finished run of an agent that learns: the run opens again, answers it, and its new end is a round of
// its own. What the person said in that round (a reviewer's word on its answer) is their correction: appended to the
// agent's corrections.md as one line, with no model turn, kept beside the first round's learning, which stays as
// it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ended, LEARN, learner, learningAt, made, mergesOf, reflectRows, savesOf, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const REVIEW = "Review: the reference MCC for Acme Diner is 5812 (Eating Places, Restaurants); you answered 5814.";

test("a review sent to a finished run of a learning agent is its correction: a second round appends it to corrections.md, one line, beside the first round's learning", { timeout: 150_000 }, async (t) => {
  const { api, store } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("reviewed"));
  const runId = await started(api, "reviewed", "Classify Acme Diner.");
  const first = await ended(api, runId);
  assert.deepEqual([first.view.learning?.state, first.view.learning?.reason], ["dropped", "empty"], JSON.stringify(first.view.learning));
  const before = (await savesOf(store, "reviewed")).length;

  const sent = await api("POST", `/runs/${runId}/messages`, { content: REVIEW });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const second = await ended(api, runId);
  assert.equal(second.view.status, "completed");
  assert.equal(second.view.learning?.state, "merged", `the second round merged: ${JSON.stringify(second.view.learning)}`);

  // The newest save holds the review as one line of corrections.md, one save more, by the run.
  const at = await learningAt(store, "reviewed");
  assert.equal(at.text("corrections.md"), `- ${REVIEW}\n`);
  assert.equal((await savesOf(store, "reviewed")).length, before + 1, "one save more");
  assert.deepEqual((await mergesOf(store, "reviewed", runId)).map((save) => [save.id, save.by.round]), [[at.view.main, 2]], "saved by the run, its second round");

  // Two kept rounds: the first as it was, the second with its correction, neither with a learning run. The run's
  // learning reads the newest.
  const [one, two] = [await store.learning.proposal(runId, 1), await store.learning.proposal(runId, 2)];
  assert.deepEqual([one?.proposal?.state, one?.proposal?.reason], ["dropped", "empty"], "the first round's drop stands");
  assert.equal(two?.round, 2);
  assert.deepEqual([two.proposal.state, two.proposal.corrections], ["merged", 1], JSON.stringify(two.proposal));
  assert.equal(two.learningRunId, undefined, "no learning run");
  assert.equal(await store.runs.get(`${runId}-learning-2`), undefined, "no learning run exists");
  assert.equal((await store.learning.proposal(runId))?.round, 2, "the run's learning is its newest round");

  // The timeline: no end-of-run turn was asked (a correction takes no model turn); the review is the person's.
  assert.deepEqual(reflectRows(second.rows).filter((row) => row.kind === "user_message"), [], "no end-of-run ask");
  const review = second.rows.find((row) => row.kind === "user_message" && row.text === REVIEW);
  assert.ok(review, "the review is a person's message in the timeline");
  assert.notEqual(review.agent_label, "learning", "and never learning's");
});
