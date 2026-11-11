// Parity ("not changing: what a person sees"): a run's events from the live view (live/stream.ts, read from the one
// store) are the events the old per-run door's GET /events sent for the same run, the same envelopes in the same order.
// The door's stream was recorded (fixtures/door-one-input.json, live-support.mjs) for the script a B run (pi through the
// adapter on the store) plays here. The kernel's own entries (agentrun.end) are not events. The documented difference is
// only the group-commit fix, which this script never triggers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, envelope, liveWorld, recorded, RUN, SCRIPT, settled, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");
/** The door's stream for one input, recorded: the check that outlives the door's code. */
const RECORDED = recorded("door-one-input");

test("a run's live events from the store are the recorded door's for one input: the same envelopes, in the same order", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run(SCRIPT);
  await w.ended("ended");
  await until(() => settled(got.types()), "the live view's run_end and the input's settlement");
  assert.equal(stream.snapshot.type, RECORDED.snapshot);
  assert.deepEqual(got.events().map(envelope), RECORDED.events, "the recorded door's events");
});
