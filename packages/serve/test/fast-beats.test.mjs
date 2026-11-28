// FAST_BEATS (support.mjs), the runner timing of the cases that count its beats, against the runner's own defaults: every
// field a tenth of the default startRunner takes, each default read from the constant it is, so the poll and the backoffs
// between two claims of one run stay scaled together when a default moves.
import assert from "node:assert/strict";
import test from "node:test";
import { END_RETRY_BACKOFF_MS, END_RETRY_CAP_MS, INTERRUPT_BACKOFF_MS, RESUME_BACKOFF_MS, RUNNER_POLL_MS } from "../dist/runner/runner.js";
import { FAST_BEATS, RUNNER_BEAT_DEFAULTS } from "./support.mjs";

test("FAST_BEATS is a tenth of each runner default it names, and those are startRunner's own default constants", () => {
  assert.deepEqual(RUNNER_BEAT_DEFAULTS, {
    pollMs: RUNNER_POLL_MS,
    interruptBackoffMs: INTERRUPT_BACKOFF_MS,
    resumeBackoffMs: RESUME_BACKOFF_MS,
    endRetryBackoffMs: END_RETRY_BACKOFF_MS,
    endRetryCapMs: END_RETRY_CAP_MS,
  });
  assert.deepEqual(Object.keys(FAST_BEATS).sort(), Object.keys(RUNNER_BEAT_DEFAULTS).sort(), "the same fields, none dropped or added");
  for (const [field, ms] of Object.entries(RUNNER_BEAT_DEFAULTS)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `${field}'s default is a positive number of ms, not ${ms}`);
    assert.equal(FAST_BEATS[field], ms / 10, `${field}: a tenth of its default ${ms} ms`);
  }
  assert.ok(Object.isFrozen(FAST_BEATS) && Object.isFrozen(RUNNER_BEAT_DEFAULTS), "a case spreads them, never changes them");
});
