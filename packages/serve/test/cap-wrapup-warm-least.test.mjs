// The wrap-up's least at the worst case, on a conversation that reads the cache. A request the wrap-up's note takes, and
// the request the run keeps back to answer (tool-budget.ts reserveFor), are priced as admission prices them: every input
// token uncached, at the cache write's price, whatever the session's previous request left in the cache. A Codex-shaped
// conversation (its input bound the body's bytes, a growing prompt read from the cache, each request needing 3,072 output
// tokens at least and costing under a cent) is never told to finish while what is left still buys its next steps at their
// worst, and none of its tool calls is refused for the reserve. Under a cap its worst case does not fit, it pauses at the
// step whose worst case passes what is left, and never books past its cap. The faux harness names its model `faux` and
// the cap prices it as `faux-1`, as Codex names `openai/gpt-6.1-sol` for the cap's `gpt-6.1-sol` and Claude Code
// `claude-sonnet-5-5` for `anthropic/claude-sonnet-5.5`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, follow, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SONNET = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
const WORDS = /^AgentRun: (?:About \$\d+(?:\.\d\d)? left of this run's budget: finish now with your answer|This run's budget is about \$\d+(?:\.\d\d)?, enough for little work: answer as soon as you can)\.$/;
const journalOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries;

async function grownRun(t, capUsd) {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
  assert.equal((await api("POST", "/agents", agent("codex-warm", { harness: "claude-agent", instructions: "Grow a Codex-shaped context for 30 requests." }))).status, 201);
  const started = await api("POST", "/agents/codex-warm/runs", { input: { content: "go" }, max_cost_usd: capUsd });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  const journal = await journalOf(store, runId);
  const told = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows.filter((row) => row.kind === "phase" && WORDS.test(row.summary ?? ""));
  return { run, journal, told };
}

test("a Codex-shaped run under a $1.50 cap (its input its body's bytes, a read cache, 3,072 output tokens needed at least, steps under a cent): no wrap-up note while what is left buys its steps at their worst, and no tool call refused for the reserve", { timeout: 180_000 }, async (t) => {
  const { run, journal, told } = await grownRun(t, 1.5);
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Grown, Codex-shaped."], JSON.stringify(run.pending ?? run.error));
  // About $0.27 spent. Request k's least is its body's bytes at the cache write's price and 3,072 output tokens
  // ($0.10 + $0.011 k + $0.031): the answer's (k = 30) is $0.46. The note comes due when what is left is under twice the
  // next request's least (WRAP_UP_LEAST_FACTOR), so $0.92 at the answer: $1.50 less $0.27 spent leaves $1.23, room.
  assert.ok(run.cost.usd > 0.25 && run.cost.usd < 0.3, `spent as scripted: $${run.cost.usd}`);
  assert.deepEqual(told.map((row) => row.summary), [], "never told to finish");
  assert.deepEqual(journal.filter((entry) => entry.kind === "faux.note").map((entry) => entry.data.text), [], "no request carried a note");
  const results = journal.filter((entry) => entry.kind === "faux.result");
  assert.equal(results.length, 30, "every read ran");
  assert.deepEqual(results.filter((entry) => entry.data.refused), [], "no call refused for the reserve");
});

test("the same run under $0.50: it pauses at the step whose worst case (its whole input uncached and its least output) passes what is left, and never books past its cap", { timeout: 180_000 }, async (t) => {
  const { run } = await grownRun(t, 0.5);
  assert.deepEqual([run.status, run.pending?.kind], ["input_required", "budget"], JSON.stringify(run.pending ?? run.error));
  const { cap_usd, spent_usd, needs_usd } = run.pending;
  assert.equal(cap_usd, 0.5);
  // Parked only for want of room: what is left does not buy the step's worst-case least, which a cache miss could bill.
  assert.ok(spent_usd + needs_usd > cap_usd, `parked with room: spent $${spent_usd} + needs $${needs_usd} within $${cap_usd}`);
  // Request k's least is $0.10 + $0.011 k + $0.031: what it needs is one of those, at a k the spend has reached.
  const k = (needs_usd - 0.1 - 0.03072) / 0.011;
  assert.ok(Math.abs(k - Math.round(k)) < 0.01 && k > 5 && k < 30, `needs $${needs_usd}: request ${k}'s worst-case least`);
  assert.ok(run.cost.usd <= cap_usd, `booked within its cap: $${run.cost.usd}`);
});
