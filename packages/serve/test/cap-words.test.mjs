// A run paused at its cap says so in words a first-time user reads: the next step, what it needs, the cap, and the cap to
// raise to, to continue, what it spent in cents. No model's name, no "request". Its refusal's row on the timeline is a
// pause (`paused: true`), never a failure's red row, and its waiting row says only that it waits for a raise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore, paidCall, useSpend } from "../dist/cap.js";
import { agent, follow, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];

// Under the faux harness claude-agent and codex run one path (harness-app.ts's guard), so codex stands for both.
for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run whose cap can't cover its next step pauses in plain words, and its refusal's row reads as a pause`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { faux: OUTPUT_PRICED, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    const id = `words-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? {} : { harness }))).status, 201);
    const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
    const { rows } = await follow(api, run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${run_id}`)).body;
    const refusal = rows.findLast((row) => row.kind === "error");
    // The words, and the refusal's row marked a pause: both pinned at once.
    assert.deepEqual([pending?.said, refusal?.kind, refusal?.paused], ["Not sent: the next step needs at least $0.11, and this run's cap is $0.05. Raise the cap to at least $0.11 to continue.", "error", true], JSON.stringify([pending, refusal]));
  });
}

// A budget pause's waiting row says only that the run waits for a raise: the sentence is the banner's (pending.said), once.
test("a budget pause's waiting row reads \"Waiting for you to raise the cap\", and the banner keeps the sentence", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("words-waiting"))).status, 201);
  const { run_id } = (await api("POST", "/agents/words-waiting/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  const { rows } = await follow(api, run_id, SETTLED);
  const { pending } = (await api("GET", `/runs/${run_id}`)).body;
  const waiting = rows.findLast((row) => row.kind === "waiting");
  assert.deepEqual([waiting?.summary, waiting?.text, pending?.said?.startsWith("Not sent: ")], ["Waiting for you to raise the cap", "Waiting for you to raise the cap", true], JSON.stringify([waiting, pending]));
  // The marker is the refusal's alone: the waiting row, made from the refusal's row, is no refusal (#1768 review).
  const refusal = rows.findLast((row) => row.kind === "error");
  assert.deepEqual([refusal?.paused, Object.hasOwn(waiting ?? {}, "paused")], [true, false], JSON.stringify([refusal, waiting]));
});

// Output at $100 a million: 3,072 tokens, a request's least, are $0.3072.
const model = { id: "gpt-6-luna", name: "gpt-6-luna", api: "openai-responses", provider: "p", maxTokens: 64000, contextWindow: 400000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } };

test("after spending: what the run has spent of its cap, what the next step needs, and the cap to raise to, to continue", async () => {
  const answer = (await capBefore(0.3, model)).beforeRequest({ spentUsd: 0.25, inFlight: [], inputTokensMax: 0, outputTokensLeast: 3072 });
  assert.equal(answer?.refuse, "spend_cap_reached (out of budget): Not sent: this run has spent $0.25 of its $0.30 cap, and the next step needs at least $0.31. Raise the cap to at least $0.56 to continue.");
});

test("a paid tool's refusal: the next step is the tool, and what it could cost and why", async (t) => {
  t.after(() => useSpend(undefined));
  useSpend({ cap: 0.5, spent: () => 0.21, add: () => {} });
  const paid = await paidCall("monid_run", async () => 0, () => 0, { usd: 1, basis: "the allowance" });
  assert.equal(paid.refused, "spend_cap_reached: Not sent: this run has spent $0.21 of its $0.50 cap, and the next step, monid_run, could cost up to $1 (the allowance). Raise the cap to at least $1.21 to continue.");
});

// A tester's pause: $0.0237416 spent of a $0.05 cap. What the run spent reads in cents ($0.02), as the "at least" figures
// do; the figures beside the words (pending.spent_usd) keep it whole.
test("after spending a fraction of a cent: the spent figure reads in cents, the next step at least $0.05, the raise at least $0.08", async () => {
  const answer = (await capBefore(0.05, model)).beforeRequest({ spentUsd: 0.0237416, inFlight: [], inputTokensMax: 0, outputTokensLeast: 500 });
  assert.equal(answer?.refuse, "spend_cap_reached (out of budget): Not sent: this run has spent $0.02 of its $0.05 cap, and the next step needs at least $0.05. Raise the cap to at least $0.08 to continue.");
});

test("a paid tool's refusal after spending a fraction of a cent: the spent figure reads in cents", async (t) => {
  t.after(() => useSpend(undefined));
  useSpend({ cap: 0.05, spent: () => 0.0237416, add: () => {} });
  const paid = await paidCall("monid_run", async () => 0, () => 0, { usd: 0.05, basis: "the allowance" });
  assert.equal(paid.refused, "spend_cap_reached: Not sent: this run has spent $0.02 of its $0.05 cap, and the next step, monid_run, could cost up to $0.05 (the allowance). Raise the cap to at least $0.08 to continue.");
});
