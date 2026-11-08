// Red 1, the lead's repro from #1933's read: two commits stored in ONE storage call mixed their steps in pi-durable-disk's
// live adapter (run_end before the answer, a duplicate message_start, a fake 'interrupted' row). The live view reads the
// store commit by commit (journal.commitsAfter), each commit's own records, so a group commit streams as its commits in
// their own order: the same events as the door's stream of the same run, which never groups.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, doorStream, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

/** The run's journal behind a slow store: each storage call waits, so pi sends the commits made meanwhile together in
 *  the next one. Counts the calls that carried more than one commit. */
function grouping(counter) {
  return (journal) =>
    new Proxy(journal, {
      get(target, key) {
        if (key === "commit") return async (batches, receive, context) => {
          if (batches.length > 1) counter.grouped += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return target.commit(batches, receive, context);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
}

test("commits stored together in one storage call stream as their own commits, in order: no run_end before the answer, no message started twice, no interrupted call", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  const door = await doorStream(script);
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  const counter = { grouped: 0 };
  await w.run(script, { journal: grouping(counter) });
  await w.ended("ended");
  await until(() => settled(got.types()), "the live view's run_end and the input's settlement");
  assert.ok(counter.grouped > 0, "pi stored commits together in one storage call (the case this checks)");
  const events = got.events();
  const types = shape(events);
  const answer = types.lastIndexOf("message_end:assistant");
  assert.ok(answer >= 0 && answer < types.indexOf("run_end"), `the answer's message_end before run_end: ${JSON.stringify(types)}`);
  assert.equal(types.filter((type) => type === "message_start:assistant").length, types.filter((type) => type === "message_end:assistant").length, `each assistant message started once: ${JSON.stringify(types)}`);
  assert.equal(JSON.stringify(events).includes("interrupted"), false, "no call reads interrupted");
  assert.deepEqual(types, shape(door.events), "the same events as the door's stream of the same run");
});
