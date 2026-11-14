// The wrap-up's least on a warm cache. A request the wrap-up's note takes, and the request the run keeps back to answer
// (tool-budget.ts reserveFor), are priced as admission prices them (RunCap.asked): the input the session's previous
// request left in the cache at the cache's price, the rest fresh. A Codex-shaped conversation (its input bound the body's
// bytes, a growing prompt read from the cache, each request needing 3,072 output tokens at least and costing under a
// cent) under a $0.50 cap is never told to finish while what is left still buys many of its steps, and none of its tool
// calls is refused for the reserve. Its session's previous request is filed under the model as the cap prices it: the
// faux harness names its model `faux` and the cap prices it as `faux-1`, as Codex names `openai/gpt-6.1-sol` for the
// cap's `gpt-6.1-sol` and Claude Code `claude-sonnet-5-5` for `anthropic/claude-sonnet-5.5`.
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

test("a Codex-shaped run under $0.50 (its input its body's bytes, a warm cache, 3,072 output tokens needed at least, steps under a cent): no wrap-up note while what is left buys many steps, and no tool call refused for the reserve", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
  assert.equal((await api("POST", "/agents", agent("codex-warm", { harness: "claude-agent", instructions: "Grow a Codex-shaped context for 30 requests." }))).status, 201);
  const started = await api("POST", "/agents/codex-warm/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Grown, Codex-shaped."], JSON.stringify(run.pending ?? run.error));
  // About $0.27 spent: $0.23 left at the answer. Request k's least uncached is its body's bytes at the cache write's price
  // and 3,072 output tokens ($0.10 + $0.011 k + $0.031): twice it passes what is left by request 8, and with the typical
  // step it passes the line for tools by request 19. Read from the cache request k-1 left, it is under $0.05.
  assert.ok(run.cost.usd > 0.25 && run.cost.usd < 0.3, `spent as scripted: $${run.cost.usd}`);
  const rows = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows.filter((row) => row.kind === "phase" && WORDS.test(row.summary ?? ""));
  assert.deepEqual(rows.map((row) => row.summary), [], "never told to finish");
  const journal = await journalOf(store, runId);
  assert.deepEqual(journal.filter((entry) => entry.kind === "faux.note").map((entry) => entry.data.text), [], "no request carried a note");
  const results = journal.filter((entry) => entry.kind === "faux.result");
  assert.equal(results.length, 30, "every read ran");
  assert.deepEqual(results.filter((entry) => entry.data.refused), [], "no call refused for the reserve");
});
