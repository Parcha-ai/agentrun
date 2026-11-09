// A call that never ran (the gate denied it before its intent) streams its end with NO start, exactly as the door's
// stream says it: the live view infers nothing from a commit's writes, so a task that never ran gets no
// tool_execution_start (a stub that synthesizes one for a task first seen ended fails here). Checked head to head
// against the door's stream of the same run with the same gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, doorStream, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

test("a denied call streams its end with no start, as the door's stream of the same run says it", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  const door = await doorStream(script, { deny: true });
  const doorTypes = shape(door.events);
  assert.equal(doorTypes.includes("tool_execution_start"), false, `the door says no start for a call that never ran: ${JSON.stringify(doorTypes)}`);
  assert.ok(doorTypes.some((type) => type.startsWith("tool_execution_end")), "and says its end");
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run(script, { deny: true });
  await w.ended("ended");
  await until(() => settled(got.types()), "the run on the stream");
  assert.deepEqual(shape(got.events()), doorTypes, "the same events as the door's: the denied call's end, no start");
});
