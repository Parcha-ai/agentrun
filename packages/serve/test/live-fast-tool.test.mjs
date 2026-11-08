// The lead's gap in the last-writer design: a tool whose start and end both commit between two of the live view's polls
// is first seen already ended (its task row carries only its last writer's seq), and a submission likewise first seen
// settled. The stream still says what happened, in order: tool_execution_start then tool_execution_end, the input placed
// then settled; the same events as the door's stream of the same run, which sees every commit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, doorStream, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

test("a tool that starts and ends between two polls streams its start then its end, as the door's stream does", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  const door = await doorStream(script);
  const w = await liveWorld(t);
  // One poll a second: the read call starts and ends well inside one of them.
  const stream = await watchRun(w.server, RUN, { pollMs: 1_000 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run(script);
  await w.ended("ended");
  await until(() => settled(got.types()), "the run's end on the stream", 20_000);
  const types = shape(got.events());
  const start = types.indexOf("tool_execution_start");
  // An end carries its result entry, so its shape has the entry's role (tool_execution_end:toolResult).
  const end = types.findIndex((type) => type.startsWith("tool_execution_end"));
  assert.ok(start >= 0 && end > start, `the read's start, then its end: ${JSON.stringify(types)}`);
  assert.deepEqual(types, shape(door.events), "the same events as the door's stream");
});
