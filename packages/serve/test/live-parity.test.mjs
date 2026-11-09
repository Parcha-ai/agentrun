// Red 0, parity (the page: "not changing: what a person sees"): a run's events from the live view (live/stream.ts,
// read from the one store) are the events the door's GET /events sends for the same run, the same types in the same
// order. The door's stream is pi-durable-disk's watchEvents on the run's Harness (what serve's runs.ts reads today); the
// same faux script, tools and input run once under it and once as a B run (createPiLoop on the store), and the two
// streams' shapes (type, and role for a message event) must be equal. The kernel's own entries (agentrun.end) are not
// events. The documented difference is only the group-commit fix, which this script never triggers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collect, doorStream, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";
import { envelope, SCRIPT } from "./record-door-one-input.mjs";

const { watchRun } = await import("../dist/live/stream.js");
/** The door's stream for one input, recorded (record-door-one-input.mjs): the check that outlives the door's code. */
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/door-one-input.json", import.meta.url), "utf8"));

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

// The head-to-head check against the door's live code, until the cutover deletes it (E).
test("a run's live events from the store are the door's for the same run: the same types, in the same order", async (t) => {
  const script = SCRIPT;
  const door = await doorStream(script);
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run(script);
  await w.ended("ended");
  await until(() => settled(got.types()), "the live view's run_end and the input's settlement");
  assert.equal(stream.snapshot.type, door.snapshot.type, "both begin with a snapshot");
  assert.deepEqual(shape(got.events()), shape(door.events), `the live view's events are the door's:\n${JSON.stringify(shape(got.events()))}\n${JSON.stringify(shape(door.events))}`);
});
