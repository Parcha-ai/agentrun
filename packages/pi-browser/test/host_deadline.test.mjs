import assert from "node:assert/strict";
import test from "node:test";
import { pageDriver } from "../dist/driver/page-driver.js";
import { NO_HYDRATED_SNAPSHOT_ERROR, classifyBrowserError } from "../dist/core/failures.js";
import { CONTEXT_GONE } from "../dist/driver/new-document.js";
import { TREE, fakeStagehand, nameOf, png, unanswered } from "./fixtures/fake-stagehand.mjs";

const DEADLINES = { batchMs: 60_000, snapshotMs: 200, screenshotMs: 200 };

/** The call's own outcome, or a failure naming that it was still waiting after `ms`. */
async function within(call, ms) {
  let timer;
  try {
    return await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}
const dropped = (error) => classifyBrowserError(error, false).code === "browser_unavailable";

test("a screenshot the browser never answers fails at its deadline as a dropped connection, and its late failure is nobody's", async () => {
  const hung = unanswered();
  const driver = pageDriver(fakeStagehand({ screenshot: () => hung.reply }), DEADLINES);
  const started = Date.now();
  await assert.rejects(within(driver.screenshot({ type: "png" }), 3_000), dropped);
  assert.ok(Date.now() - started < 2_000, "it failed at its deadline, not at the test's limit");
  const unhandled = [];
  const seen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", seen);
  try {
    hung.fail(new Error("RPC client closed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { process.off("unhandledRejection", seen); }
  assert.deepEqual(unhandled, []);
});

test("a snapshot the browser never answers fails at its deadline, the call queued behind it runs then, and its late tree never becomes the snapshot actions use", async () => {
  const hung = unanswered();
  let batches = 0;
  const driver = pageDriver(fakeStagehand({ snapshot: () => hung.reply, batches: [{ __stagehandPlaywrightCompat: true, value: "ran" }], onBatch: () => { batches += 1; } }), DEADLINES);
  const snapshot = driver.snapshot();
  const queued = driver.run({ code: "return 'ran';" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(batches, 0, "the run waits behind the pending snapshot");
  await assert.rejects(within(snapshot, 3_000), dropped);
  assert.equal(await within(queued, 3_000), "ran", "the run behind it ran once the snapshot failed");
  hung.answer(TREE);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(within(driver.run({ actions: [{ op: "click", id: "0-1" }] }), 3_000), (error) => error.message === NO_HYDRATED_SNAPSHOT_ERROR);
});

test("a snapshot and a screenshot that answer within their deadlines are the driver's answers", async () => {
  const driver = pageDriver(fakeStagehand(), DEADLINES);
  assert.equal(await driver.snapshot(), TREE.formattedTree);
  assert.equal(nameOf(Buffer.from((await driver.screenshot({ type: "png" })).data, "base64")), "fresh");
});

// The calls this deadline newly wraps: #1007's clipped screenshot and #1073's read on a replaced document.
const scrolled = (x, y) => ({ __stagehandPlaywrightCompat: true, value: { x, y } });

test("a clipped screenshot the browser never answers fails at its deadline as a dropped connection, and the driver's next one answers", async () => {
  const hung = unanswered();
  const asked = [];
  const driver = pageDriver(fakeStagehand({ screenshot: (options) => { asked.push(options); return asked.length === 1 ? hung.reply : Promise.resolve(png("fresh")); }, batches: [scrolled(0, 40), scrolled(0, 40)] }), DEADLINES);
  const clip = { x: 10, y: 20, width: 100, height: 50 };
  const started = Date.now();
  await assert.rejects(within(driver.screenshot({ type: "png", clip }), 3_000), dropped);
  assert.ok(Date.now() - started < 2_000, "it failed at its deadline, not at the test's limit");
  assert.deepEqual(asked[0].clip, { x: 10, y: 60, width: 100, height: 50 }, "the clip was read from the viewport's corner, as before");
  assert.equal(nameOf(Buffer.from((await within(driver.screenshot({ type: "png", clip }), 3_000)).data, "base64")), "fresh", "the driver still answers");
});

test("a snapshot that lands in a replaced document and whose read of the new one never answers fails at its deadline, and the next snapshot answers", async () => {
  const hung = unanswered();
  let reads = 0;
  const gone = () => Object.assign(new Error(CONTEXT_GONE), { cause: { code: -32603, message: CONTEXT_GONE } });
  const driver = pageDriver(fakeStagehand({ snapshot: () => { reads += 1; return reads === 1 ? Promise.reject(gone()) : reads === 2 ? hung.reply : Promise.resolve(TREE); } }), DEADLINES);
  const started = Date.now();
  await assert.rejects(within(driver.snapshot(), 3_000), dropped);
  assert.ok(Date.now() - started < 2_000, "it failed at its deadline, not at the test's limit");
  assert.equal(reads, 2, "the lost document was read once more, on the new one");
  assert.equal(await within(driver.snapshot(), 3_000), TREE.formattedTree, "the driver still answers");
});
