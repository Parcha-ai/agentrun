// A learning run whose cap was raised mid-run looks back under the raised cap (beta.33 re-test, run 01a1cb57: a $0.001
// cap raised to $1 completed, then read "Skipped: no budget left in this run to look back" with $0.994 left). The
// end-of-run step's budget check reads the cap the run is held to now, its newest raise's (adapter-loop.ts capNow, the
// one each request is admitted under), never its launch's. Through the server: the run pauses at its first request,
// the owner raises the cap, the job completes having spent past the cap it started with, and its learning is kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, started } from "./learn-support.mjs";
import { follow, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FILE = "check-units.md";
const NOTE = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
/** A cap no request fits: the run pauses at its first. */
const CAP = 0.0001;
const RAISED = 1;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];

for (const harness of ["pi", "codex"]) {
  test(`on ${harness}, a run whose cap is raised mid-run, then spends past the cap it started with, looks back under the raised cap and keeps its learning`, { timeout: 180_000 }, async (t) => {
    const { api } = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(LEARN) });
    const id = `raised-${harness}`;
    await made(api, learner(id, { harness, plan: [[FILE, NOTE]] }));
    const runId = await started(api, id, "Go.", { max_cost_usd: CAP });
    await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
    const paused = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([paused.status, paused.pending?.kind], ["input_required", "budget"], JSON.stringify(paused));
    const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: RAISED });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    const { view } = await ended(api, runId);
    assert.deepEqual([view.status, view.cost?.cap_usd], ["completed", RAISED], JSON.stringify(view.cost));
    assert.ok(view.cost.usd > CAP, `the job spent past the cap it started with: ${JSON.stringify(view.cost)}`);
    assert.deepEqual([view.learning?.state, view.learning?.reason], ["merged", null], `it looked back under the raised cap, never "no budget left": ${JSON.stringify(view.learning)}`);
  });
}
