// A run's live view reads the run's journal through store.journal, which hands out one journal per (run, epoch) and keeps
// it while it is open. A watch keeps it open only while it is watched: once the last watch of a (run, epoch) ends, the
// journal closes and the store keeps it no longer, so a server that watches many runs over its life holds no journal of
// a watch that ended. Two watches of one run share it, and one ending leaves the other reading.
import assert from "node:assert/strict";
import { test } from "node:test";
import { watchRun } from "../dist/live/stream.js";
import { queued, storeOn } from "./store-helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** "open" while `stream` has not ended within `ms`, else how it ended. */
const stillOpen = (stream, ms) => Promise.race([stream.closed.then((end) => end.reason), sleep(ms).then(() => "open")]);

test("a watch that ends keeps no journal: the store's open journals are as before it", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const before = store.openJournals;
  const stream = await watchRun(store, "run-1", { pollMs: 10 });
  stream.start(() => {});
  await sleep(30);
  await stream.stop();
  assert.equal(store.openJournals, before, "the watch's journal is closed and dropped");
});

test("two watches of one run share its journal: the first ending leaves the second reading, and the last one closes it", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const before = store.openJournals;
  const first = await watchRun(store, "run-1", { pollMs: 10 });
  const second = await watchRun(store, "run-1", { pollMs: 10 });
  first.start(() => {});
  second.start(() => {});
  await sleep(30);
  await first.stop();
  assert.equal(await stillOpen(second, 100), "open", "the second still reads after the first ended");
  await second.stop();
  assert.equal(store.openJournals, before, "the last watch closed it");
});
