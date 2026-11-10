// A learning run whose seed failed at its start says why at its end, in main's words (learning-words.ts STOPPED), from
// the reason its launch's learning start records (run-launch.ts seedFailed): its agent's learning folder could not be
// read ("the agent's notes could not be read"), or what was read could not be made into its start ("could not be
// copied into the run"). A start that names no reason (an older launch) says the latter, as before.
import assert from "node:assert/strict";
import { test } from "node:test";

const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { said, STOPPED } = await import("../dist/learning-words.js");

/** The end-of-run step's answer for a run launched with `learning`, which fails at its start: what it keeps. */
async function endOf(learning) {
  const end = learningEndOfRun({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, learning }, { store: {}, data: "/nonexistent", env: {} });
  return (await end({ runId: "run-1", agentId: "agent-1", outcome: "completed" })).also[0].row.proposal;
}

test("a learning folder that could not be read at the start: dropped seed_failed, in main's could-not-be-read words", async () => {
  const proposal = await endOf({ given: [], seed: null, section: "", seedFailed: "unreadable" });
  assert.deepEqual(proposal, { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.unreadable) });
  assert.match(proposal.detail, /could not be read/);
});

test("a start that could not be made from the seed it read: dropped seed_failed, in main's not-copied words", async () => {
  const proposal = await endOf({ given: [], seed: null, section: "", seedFailed: "not_copied" });
  assert.deepEqual(proposal, { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.notCopied) });
  assert.match(proposal.detail, /could not be copied/);
});

test("an older launch whose failed start names no reason says not copied, as it did", async () => {
  assert.equal((await endOf({ given: [], seed: null, section: "" })).detail, said.stopped(STOPPED.notCopied));
});
