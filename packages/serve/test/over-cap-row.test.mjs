// Two things serve keeps once the kernel's cap holds the money: the over-cap row a served timeline shows after its usage row
// (run-view.ts withOverCap), and the allowance a claude-agent run's native web search is opened with (adapters.ts nativeOptions).
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeOptions } from "../dist/adapters.js";
import { NATIVE_SEARCH_ALLOWANCE_TOKENS } from "../dist/cap.js";
import { builtinHarness } from "../dist/harness-table.js";
import { withOverCap } from "../dist/run-view.js";

const usage = (usd) => ({ id: "1:usage", kind: "usage", summary: "Cost so far", seq: 9, text: null, usage: { usd, requests: 2 } });
const rows = (usd) => [{ id: "1:3", kind: "final_answer", summary: "Done.", seq: 8, text: "Done." }, usage(usd)];

test("claude-agent's own search is opened with the stated allowance, 8 searches of 25,000 tokens, which its proxy adds to a search request's bound; codex's own search, live (its adapter books each search); nothing where web_search does not resolve native", () => {
  assert.equal(NATIVE_SEARCH_ALLOWANCE_TOKENS, 200_000);
  const plane = (web_search) => ({ AGENTRUN_SERVE_TOOL_PLANE: JSON.stringify({ web_search }) });
  const facts = (harness) => builtinHarness(harness).facts;
  assert.deepEqual(nativeOptions(facts("claude-agent"), plane("native")), { webSearch: true, webSearchAllowance: 200_000 });
  assert.deepEqual(nativeOptions(facts("codex"), plane("native")), { webSearch: "live" });
  for (const [harness, env] of [["opencode", plane("native")], ["codex", plane("exa-keyless")], ["claude-agent", plane("parallel")], ["codex", {}]]) assert.deepEqual(nativeOptions(facts(harness), env), {}, `${harness} ${JSON.stringify(env)}`);
});

test("the over-cap row: after the usage row, once its booked cost is past the cap, saying by how much; none at or under it, or with no cap or no known cost", () => {
  const [, , over] = withOverCap(rows(1.25), 1);
  assert.deepEqual([over.id, over.kind, over.summary, over.seq, "usage" in over], ["1:usage:over_cap", "phase", "Spent $1.25, $0.25 over the run's cap of $1", 9, false]);
  for (const [usd, cap] of [[1, 1], [0.5, 1], [null, 1], [2, undefined]]) assert.equal(withOverCap(rows(usd), cap).length, 2, `${usd} under ${cap}`);
});

test("the over-cap row of a run that passed its cap on a cache miss says by how much and the most it could have, in cents: one row, in these words", () => {
  const out = withOverCap(rows(0.5267564), 0.5, 0.19603125);
  assert.equal(out.filter((row) => row.id.endsWith(":over_cap")).length, 1, "one row");
  assert.equal(out[2].summary, "Went $0.03 over its cap on a cache miss (at most $0.20).");
  // No bound (strict, a cold request, or a cap passed some other way): the row says what it said, in cents.
  assert.equal(withOverCap(rows(0.5267564), 0.5, 0)[2].summary, "Spent $0.53, $0.03 over the run's cap of $0.50");
  assert.equal(withOverCap(rows(0.5267564), 0.5)[2].summary, "Spent $0.53, $0.03 over the run's cap of $0.50");
  // Over by more than the bound: not the cache miss's doing, so not in its words.
  assert.equal(withOverCap(rows(0.8), 0.5, 0.1)[2].summary, "Spent $0.80, $0.30 over the run's cap of $0.50");
  // A cap that is no whole number of cents is said in cents, never as a float's tail.
  assert.equal(withOverCap(rows(0.5), 0.38020940000000003)[2].summary, "Spent $0.50, $0.12 over the run's cap of $0.38");
});

