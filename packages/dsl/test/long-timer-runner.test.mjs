// End-to-end proof for the interpreter's call-node deadline site (deadline_s): with no ceiling, a
// deadline past Node's 2^31-1 ms timer limit must still bound the effect at the full time, not fire at
// ~1 ms. A fake clock runs a call whose effect settles only when its deadline aborts it, with
// deadline_s of 3,000,000 s (past the limit, so the timer chains) and 2,000,000 s (the control). The
// effect is cut only after the clock reaches the full deadline, never early. (retry.backoff_s and
// poll.interval_s share sleep(), proven in long-timer.test.mjs.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow } from "../dist/index.js";
import { MAX_TIMER_DELAY_MS as MAX } from "../dist/long-timer.js";

const SCHEMAS = {
  Plan: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
  Submit: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
  Output: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
};
const wf = (deadline_s) => ({
  v: 2, name: "t", schemas: SCHEMAS, output: { schemaId: "Output", path: "final" },
  root: { node: "chain", steps: [
    { node: "extract", label: "plan", instructions: "plan", out: "Plan", as: "plan" },
    { node: "call", label: "status", via: "tool", tool: "jobs.status", args: { request_id: "{plan.request_id}" }, out: "Submit", as: "job", deadline_s },
    { node: "code", label: "assemble", code: "(s) => ({ final: { status: s.job.status } })" },
  ] },
});
// An effect that never settles on its own; it rejects only when the deadline aborts its signal.
const abortableEffect = ({ signal }) => new Promise((_, reject) => {
  const onAbort = () => reject(new Error("aborted"));
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
});

for (const [label, deadline_s] of [["3,000,000 s (past the 2^31-1 ms limit)", 3_000_000], ["2,000,000 s (control)", 2_000_000]]) {
  test(`call deadline of ${label} cuts the effect at the full time, never ~1 ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); // setImmediate stays real so the interrupt can settle
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
    let outcome = "pending";
    const run = runWorkflow(wf(deadline_s), { question: "q" }, {
      runNode: async () => ({ request_id: "req-1" }),
      runEffect: abortableEffect,
    }).then(() => { outcome = "ok"; }, (e) => { outcome = String(e?.message ?? e); });

    await flush();
    assert.equal(outcome, "pending", "does not fire at ~1 ms (nothing ticked yet)");

    let remaining = deadline_s * 1000;
    while (remaining > MAX) { t.mock.timers.tick(MAX); await flush(); remaining -= MAX; }
    t.mock.timers.tick(remaining - 1);
    await flush();
    assert.equal(outcome, "pending", "does not fire one tick before the deadline");

    t.mock.timers.tick(1);
    await flush();
    assert.match(outcome, /exceeded its .* deadline/, "cut at the full deadline");
    await run;
  });
}
