// Red 1, the lead's repro from #1933's read: two commits stored in ONE storage call mixed their steps in pi-durable-disk's
// live adapter (run_end before the answer, a duplicate message_start, a fake 'interrupted' row). The live view reads the
// store commit by commit (journal.commitsAfter), each commit's own writes, so a group commit streams as its commits in
// their own order.
//
// Made deterministic: a real pi run's storage calls are recorded as pi made them, then stored again in a second run's
// journal with every two calls merged into ONE storage call (pi's group commit, each batch its own commit). The second
// run's stream must be the first run's: the same events, in the same order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { collect, liveWorld, RUN, settled, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

/** Passes the run's storage calls through, keeping a copy of each call's batches. */
function recording(calls) {
  return (journal) =>
    new Proxy(journal, {
      get(target, key) {
        if (key === "commit") return async (batches, receive, context) => {
          const result = await target.commit(batches, receive, context);
          calls.push(JSON.parse(JSON.stringify(batches.slice(0, result.stored))));
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
}

test("commits stored together in one storage call stream as their own commits, in order: no run_end before the answer, no message started twice, no interrupted call", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  // The first run, as pi stores it, one storage call at a time; its stream is the reference.
  const first = await liveWorld(t);
  const firstStream = await watchRun(first.server, RUN, { pollMs: 20 });
  t.after(() => firstStream.stop());
  const expected = collect(firstStream);
  const calls = [];
  await first.run(script, { journal: recording(calls) });
  await first.ended("ended");
  await until(() => settled(expected.types()), "the first run's stream to its end");

  // The same commits in a second run's journal, every two storage calls stored as one.
  const second = await liveWorld(t);
  const secondStream = await watchRun(second.server, RUN, { pollMs: 20 });
  t.after(() => secondStream.stop());
  const got = collect(secondStream);
  const claim = await second.server.claim(RUN, "replayer", { leaseMs: 60_000 });
  const journal = second.server.journal(claim);
  let grouped = 0;
  for (let at = 0; at < calls.length; at += 2) {
    const batches = [...calls[at], ...(calls[at + 1] ?? [])];
    if (batches.length > 1) grouped += 1;
    const result = await journal.commit(batches, () => {}, ctx);
    assert.equal(result.stored, batches.length, `storage call ${at / 2}: every batch stored`);
  }
  assert.ok(grouped > 0, "storage calls that each carried more than one commit (the case this checks)");
  await until(() => settled(got.types()), "the grouped run's stream to its end");

  const types = shape(got.events());
  const answer = types.lastIndexOf("message_end:assistant");
  assert.ok(answer >= 0 && answer < types.indexOf("run_end"), `the answer's message_end before run_end: ${JSON.stringify(types)}`);
  assert.equal(types.filter((type) => type === "message_start:assistant").length, types.filter((type) => type === "message_end:assistant").length, `each assistant message started once: ${JSON.stringify(types)}`);
  assert.equal(JSON.stringify(got.events()).includes("interrupted"), false, "no call reads interrupted");
  assert.deepEqual(types, shape(expected.events()), "the same events as the run stored one commit per call");
});
