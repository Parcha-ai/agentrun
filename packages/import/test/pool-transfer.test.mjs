// A pool worker hands its read back with its indexes' arrays moved, not copied: a copy is made twice (serialized on the
// worker, deserialized on parseHome's thread), and parseHome's thread is the one every read passes through. The worker
// is the pool's own (pool-worker.js), its replies watched from inside it (pool-transfer-watch.mjs, loaded first).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

test("a pool worker's reply moves every array of its indexes, the slots' tags with them", async (t) => {
  const home = await tempHome(t);
  const session = "00000000-0000-4000-8000-0000000000cc";
  // Enough records that the worker's tables carry tags (1024 slots and more: record-index.ts).
  const uuid = (k) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
  const records = [];
  for (let i = 0; i < 1000; i += 1) {
    records.push(claudeUser({ uuid: uuid(2 * i + 1), text: `p${i}`, i: 2 * i, session }));
    records.push(claudeAnswer({ uuid: uuid(2 * i + 2), msg: `m${i}`, req: `r${i}`, usage: anthropicUsage(3, 5), i: 2 * i + 1, session }));
  }
  const file = await writeJsonl(claudeFile(home, session), records);
  const worker = new Worker(new URL("../dist/pool-worker.js", import.meta.url), {
    execArgv: ["--import", new URL("./pool-transfer-watch.mjs", import.meta.url).href],
    workerData: { maxLine: 2 ** 23 },
  });
  t.after(() => worker.terminate());
  const reply = await new Promise((done, fail) => {
    worker.once("message", done);
    worker.once("error", fail);
    worker.postMessage({ id: 0, source: "claude-code", locator: { file } });
  });
  assert.equal(reply.ok, true);
  assert.ok(reply.watched.arrays.includes("mine.uuids.tags") && reply.watched.arrays.includes("mine.others.tags"), `tagged tables (${reply.watched.arrays})`);
  assert.deepEqual(reply.watched.copied, []);
});
