// A run paused at its cap says so in words a first-time user reads: the next step, what it needs, the cap, and the cap to
// raise to, to continue, what it spent in cents. No model's name, no "request". Its refusal's row on the timeline is a
// pause (a `phase` row, `paused: true`), never a failure's red row, and its waiting row says only that it waits for a raise.
import assert from "node:assert/strict";
import { test } from "node:test";
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
    const refusal = rows.findLast((row) => row.paused === true);
    // The words, and the refusal's row a pause in its own short words: both pinned at once.
    assert.deepEqual([pending?.said, refusal?.kind, refusal?.summary, rows.some((row) => row.kind === "error")], ["Not sent: the next step needs at least $0.11, and this run's cap is $0.05. Raise the cap to at least $0.11 to continue.", "phase", "Paused at the run's cap", false], JSON.stringify([pending, refusal]));
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
  const refusal = rows.findLast((row) => row.kind === "phase" && row.summary === "Paused at the run's cap");
  assert.deepEqual([refusal?.paused, Object.hasOwn(waiting ?? {}, "paused")], [true, false], JSON.stringify([refusal, waiting]));
});
