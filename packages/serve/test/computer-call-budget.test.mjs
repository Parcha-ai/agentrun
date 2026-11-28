// A computer call's time on the channel (computer-channel.ts callBudgetMs): CALL_MS for a call that names no time of its
// own; for exec.run and process.wait, the call's own timeoutMs and CALL_GRACE_MS for its answer to come back, never less
// than CALL_MS and at most CALL_MAX_MS. The server waits that long for the answer and the runner cuts the call at it, so a
// command given 200 s runs 200 s, not 120. No computer, no network.
import assert from "node:assert/strict";
import { test } from "node:test";

const { CALL_MS, CALL_GRACE_MS, CALL_MAX_MS, callBudgetMs } = await import("../dist/computer-channel.js");
const { openapiDocument } = await import("../dist/openapi.js");

test("a call naming no time of its own, or a method that takes none, runs CALL_MS", () => {
  assert.equal(callBudgetMs({ method: "files.read", params: { path: "/a", timeoutMs: 600_000 } }), CALL_MS, "files.read takes no timeoutMs");
  assert.equal(callBudgetMs({ method: "exec.run", params: { argv: ["true"] } }), CALL_MS, "none given");
  for (const odd of ["600000", -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(callBudgetMs({ method: "exec.run", params: { argv: ["true"], timeoutMs: odd } }), CALL_MS, String(odd));
  }
});

test("exec.run and process.wait run their own timeoutMs and the grace, within CALL_MS and CALL_MAX_MS", () => {
  for (const method of ["exec.run", "process.wait"]) {
    assert.equal(callBudgetMs({ method, params: { timeoutMs: 200_000 } }), 200_000 + CALL_GRACE_MS, `${method} 200 s`);
    assert.equal(callBudgetMs({ method, params: { timeoutMs: 1_000 } }), CALL_MS, `${method}: a short one still gets CALL_MS`);
    assert.equal(callBudgetMs({ method, params: { timeoutMs: 0 } }), CALL_MS, `${method}: 0 asks without waiting`);
    assert.equal(callBudgetMs({ method, params: { timeoutMs: 86_400_000 } }), CALL_MAX_MS, `${method}: a day is cut at CALL_MAX_MS`);
  }
  assert.ok(CALL_MAX_MS > CALL_MS && CALL_GRACE_MS > 0 && CALL_GRACE_MS < CALL_MS);
});

test("the API document states the call's time as the channel runs it", () => {
  const doc = openapiDocument(() => undefined);
  const description = doc.paths["/runs/{run_id}/computer/call"].post.description;
  assert.ok(description.includes(`${CALL_MS / 1000} seconds`), description);
  assert.ok(description.includes(`${CALL_MAX_MS / 60_000} minutes`), description);
  assert.match(description, /exec\.run and process\.wait/);
  assert.match(description, /process\.start/);
});
