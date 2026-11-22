// A commit's time as the learning snapshot keeps it (learn/folder.ts commitTime): a store gives git's %cI, with the offset
// git's version and the committer's zone give it ("+00:00", "+02:00", or "Z"), and the snapshot rebuilt from a store's
// read must say the same time the snapshot a save wrote: UTC in whole seconds, ending "Z".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitChange, commitTime, learningInit, readSnapshot } from "../dist/learn/folder.js";
import { localLearningStore } from "../dist/learn/store-local.js";

test("commitTime keeps every commit time in UTC ending Z, whatever offset git printed: +00:00, +02:00 and Z read as one instant", () => {
  for (const [printed, kept] of [["2026-11-10T05:18:16+00:00", "2026-11-10T05:18:16Z"], ["2026-11-10T07:18:16+02:00", "2026-11-10T05:18:16Z"], ["2026-11-10T05:18:16Z", "2026-11-10T05:18:16Z"]]) {
    assert.equal(commitTime(printed), kept, printed);
  }
  assert.equal(commitTime("not a time"), "not a time", "text that is no time is kept as it is");
});

test("the time a save's snapshot says of its commit is the commit's own time, as the store's log gives it", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-time-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const store = localLearningStore(data, "agent-one");
  await learningInit(store);
  const merged = await commitChange(store, await readSnapshot(store), { by: { run: "run-1", reason: "A correction." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }] });
  const [commit] = await store.log(merged.main, { limit: 1 });
  assert.equal(commit.sha, merged.main);
  assert.match(merged.snapshot.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(merged.snapshot.at, commitTime(commit.at));
});
