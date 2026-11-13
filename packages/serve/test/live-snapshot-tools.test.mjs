// A live view opened while a tool runs shows that tool: the snapshot lists every call started and not ended, as the door's
// snapshot lists pi.live's running tool slots ({ callId, name, status }). The stream folds a stored start into the
// snapshot and skips that call's held start after, so a snapshot without it hid the running tool until its end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { liveWorld, RUN, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");

test("a live view opened while a tool runs has it running in its snapshot", async (t) => {
  const w = await liveWorld(t);
  await w.run([{ call: "slow" }, { say: "done" }], { live: { tickMs: 100 } });
  await w.tools.slowStarted;
  // The call's intent is stored (pi's execute checkpoint on its tool task): the start is in the journal.
  await until(async () => {
    const row = await w.server.runs.get(RUN);
    const records = await journalRecords(w.server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    return records.tasks.some((task) => task.kind === "pi.tool" && task.state?.checkpoint?.phase === "execute");
  }, "the slow call's intent stored");
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  w.tools.letSlowGo();
  const tools = (stream.snapshot.tools ?? []).map((tool) => ({ name: tool.name, status: tool.status, hasCallId: typeof tool.callId === "string" && tool.callId.length > 0 }));
  assert.deepEqual(tools, [{ name: "slow", status: "running", hasCallId: true }], `the snapshot's tools: ${JSON.stringify(stream.snapshot.tools)}`);
});
