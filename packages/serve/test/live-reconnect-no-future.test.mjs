// The doc-history rule (the lead's GO): pi.live, pi.inbox and pi.usage keep no history, so a commit read later would
// carry a later commit's value of them. A reconnect from an old seq must not show anything first written after it: each
// batch it gets, commit N's, says only what commit N (and earlier ones) wrote, the same events a reader that kept up got
// for commit N, never a later commit's run_end, usage or inbox.
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveWorld, RUN, settled, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

function bySeq(stream) {
  const batches = [];
  stream.start(async (events, meta) => void batches.push({ seq: meta.seq, events }));
  return batches;
}

test("a reconnect from an early seq gets each later commit's own events, never a value first written by a later commit", async (t) => {
  const w = await liveWorld(t);
  const live = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => live.stop());
  const kept = bySeq(live);
  await w.run([{ call: "read" }, { call: "effect" }, { say: "done" }]);
  await w.ended("ended");
  await until(() => settled(kept.flatMap((batch) => batch.events).map((event) => event.type)), "the kept-up stream to the run's end");
  // From before the run's first commit: every commit is replayed, after the run is over.
  const replay = await watchRun(w.server, RUN, { pollMs: 20, fromSeq: 0 });
  t.after(() => replay.stop());
  const replayed = bySeq(replay);
  await until(() => replayed.length >= kept.length, "the replay of every commit");
  for (const batch of replayed) {
    const same = kept.find((each) => each.seq === batch.seq);
    assert.deepEqual(batch.events, same?.events ?? [], `commit ${batch.seq} replays as it streamed live, with nothing from a later commit`);
  }
  const runEnd = replayed.findIndex((batch) => batch.events.some((event) => event.type === "run_end"));
  const answer = replayed.findIndex((batch) => batch.events.some((event) => event.type === "message_end" && event.entry?.model?.[0]?.role === "assistant" && JSON.stringify(event.entry.model[0].content).includes("done")));
  assert.ok(answer >= 0 && runEnd >= answer, `run_end never before the answer's commit: answer at batch ${answer}, run_end at ${runEnd}`);
});
