// Red 4: a reader that comes back (a reconnect) resumes from the last commit it had: its snapshot holds the run as of that
// commit, then only later commits follow, each once. Every batch names the commit (seq) it came from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveWorld, RUN, settled, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

/** Starts `stream`, keeping each batch with its commit's seq. */
function bySeq(stream) {
  const batches = [];
  stream.start(async (events, meta) => void batches.push({ seq: meta.seq, events }));
  return batches;
}

test("a reconnect from a commit's seq gets a snapshot as of it and only the commits after it, nothing twice", async (t) => {
  const w = await liveWorld(t);
  const whole = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => whole.stop());
  const all = bySeq(whole);
  await w.run([{ call: "read" }, { call: "effect" }, { say: "done" }]);
  await w.ended("ended");
  await until(() => settled(all.flatMap((batch) => batch.events).map((event) => event.type)), "the whole stream to the run's end");
  const seqs = all.map((batch) => batch.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "batches in commit order");
  assert.equal(new Set(seqs).size, seqs.length, "one batch per commit");
  const middle = seqs[Math.floor(seqs.length / 2)];
  const again = await watchRun(w.server, RUN, { pollMs: 20, fromSeq: middle });
  t.after(() => again.stop());
  const later = bySeq(again);
  const expected = all.filter((batch) => batch.seq > middle);
  await until(() => later.length >= expected.length, "the commits after the reconnect's seq");
  assert.deepEqual(later.map((batch) => batch.seq), expected.map((batch) => batch.seq), "only the commits after it");
  assert.deepEqual(later.map((batch) => batch.events), expected.map((batch) => batch.events), "the same events as the first reader got for them");
  const entries = (again.snapshot.entries ?? []).map((entry) => Number(entry.id));
  const before = all.filter((batch) => batch.seq <= middle).flatMap((batch) => batch.events).flatMap((event) => (event.type === "message_end" && event.entry ? [Number(event.entry.id)] : []));
  for (const id of before) assert.ok(entries.includes(id), `the snapshot holds entry ${id}, appended at or before the reconnect's seq`);
});
