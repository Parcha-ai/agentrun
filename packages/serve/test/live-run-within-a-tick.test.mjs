// A whole run inside one poll of the live view: its run starts and ends, and its turns, calls and messages land, all
// between two reads of the store. pi.live keeps no history, so read at the end it shows no run at all; the stream still
// says what happened, from the records that keep their order (the input submission and the generation tasks for the
// run, pi.tool tasks for the calls, entries for the messages): run_start before run_end, each once, and the same events
// as the door's stream of the same run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, doorStream, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

test("a run that starts and ends inside one poll streams run_start then run_end, each once, as the door's stream does", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  const door = await doorStream(script);
  const w = await liveWorld(t);
  // The first read is before the run; the next is long after it ended.
  const stream = await watchRun(w.server, RUN, { pollMs: 5_000 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run(script);
  await w.ended("ended");
  await until(() => settled(got.types()), "the run on the stream after the next poll", 20_000);
  const types = got.types();
  assert.equal(types.filter((type) => type === "run_start").length, 1, `one run_start: ${JSON.stringify(types)}`);
  assert.equal(types.filter((type) => type === "run_end").length, 1, `one run_end: ${JSON.stringify(types)}`);
  assert.ok(types.indexOf("run_start") < types.indexOf("run_end"), "run_start first");
  assert.deepEqual(shape(got.events()), shape(door.events), "the same events as the door's stream");
});
