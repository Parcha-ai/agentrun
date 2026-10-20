// On the cdp provider: a host release the store cannot record still closes the driver, kills the Chrome by its
// pid and removes its profile and its private TMPDIR, like any release; the record is left live, and the next run's
// reconcile finds the browser gone. The fake Chrome runs wherever Node does; the real one needs a Chrome.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, isRunning, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { processesNaming, scratch, scratchSync } from "./fixtures/scratch.mjs";
import { AGENT, browsesOnce, counted, failing, init, open, stubDriver, until } from "./fixtures/storage-failure.mjs";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-chrome.mjs");
const LOOPBACK_ONLY = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const pidOf = (id) => Number(/^local:(\d+):/.exec(id)[1]);

async function releaseUnrecorded(t, { executablePath, args, driver }) {
  const profiles = await scratch(t, "release-cdp-");
  const dir = scratchSync(t, "release-cdp-store-");
  const provider = cdpProvider({ chrome: { executablePath, profileRoot: profiles, args } });
  const { drivers, driver: counting } = counted(driver);
  const { knobs, storage } = failing(await openNodeJsonlStorage(dir, ctx));
  const one = await open(storage, { provider, driver: counting, responses: browsesOnce() });
  const root = await one.harness.root(ctx, { agent: AGENT, init: init(one.browser) });
  await (await root.submit({ type: "input", content: "Look at the page." }, ctx)).wait(ctx);
  const { tag, resourceId, state } = (await one.harness.snapshot(one.browser.docs.Sessions, root.id, ctx)).sessions[0];
  const pid = pidOf(resourceId);
  t.after(() => { if (isRunning(pid)) process.kill(-pid, "SIGKILL"); }, { timeout: 30_000 });
  const profile = path.join(profiles, tag);
  // A host TMPDIR too long to leave room for a private one is given to Chrome as it is: then there is none to remove.
  const marker = path.join(profile, ".pib-tmpdir");
  const tmp = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  if (tmp === null) t.diagnostic("this host's TMPDIR leaves no room for a private one, so the Chrome was given the host's");
  assert.deepEqual([state, isRunning(pid), tmp === null || existsSync(tmp), drivers.opened], ["live", true, true, 1], "the conversation holds a live Chrome");

  knobs.releaseFails = 1;
  await assert.rejects(one.browser.release(root, "close", ctx), "the release that could not be recorded is not reported as done");
  assert.equal(knobs.refused, 1, "the release commit was refused");
  assert.equal(drivers.closed, 1, "the driver was closed");
  assert.equal(isRunning(pid), false, "the Chrome is gone");
  assert.equal(existsSync(profile), false, "its profile was removed");
  if (tmp !== null) assert.equal(existsSync(tmp), false, "its private TMPDIR was removed");
  await one.harness.close(ctx).catch(() => undefined);
  await one.browser.close();

  const two = await open(await openNodeJsonlStorage(dir, ctx), { provider, driver: counting, responses: browsesOnce() });
  t.after(async () => { await two.harness.close(ctx); await two.browser.close(); }, { timeout: 30_000 });
  assert.deepEqual(two.report, { released: [], kept: [], lost: [tag], unreachable: [] }, "the record was left live, and the next run's reconcile took the lost path");
  assert.equal((await two.harness.snapshot(two.browser.docs.Sessions, root.id, ctx)).sessions[0].state, "released");
}

test("a host release the store cannot record still kills the cdp provider's Chrome and removes its profile and private TMPDIR (fake Chrome)", async (t) => {
  await releaseUnrecorded(t, { executablePath: FAKE, args: [], driver: stubDriver });
});

test("a host release the store cannot record still closes Stagehand and kills a real Chrome, its profile and private TMPDIR removed", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  await releaseUnrecorded(t, { executablePath: CHROME, args: [LOOPBACK_ONLY], driver: stagehandDriver() });
});

/** A driver whose close takes as long as a Stagehand close can. */
const slowClosing = (driver, ms = 500) => async (...args) => {
  const d = await driver(...args);
  return { ...d, close: async () => { await new Promise((resolve) => setTimeout(resolve, ms)); await d.close(); } };
};

/** The crash-and-resume example's shutdown: release, close the extension, close the Harness, and no drain. The release
 *  task must start while the driver is still closing, or the Harness closes before it runs and the Chrome stays up. */
async function releaseWithoutDrain(t, { executablePath, args, driver }) {
  const profiles = await scratch(t, "release-cdp-");
  const dir = scratchSync(t, "release-cdp-store-");
  const provider = cdpProvider({ chrome: { executablePath, profileRoot: profiles, args } });
  const { harness, browser } = await open(await openNodeJsonlStorage(dir, ctx), { provider, driver, responses: browsesOnce() });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  await (await root.submit({ type: "input", content: "Look at the page." }, ctx)).wait(ctx);
  const pid = pidOf((await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].resourceId);
  t.after(() => { if (isRunning(pid)) process.kill(-pid, "SIGKILL"); }, { timeout: 30_000 });
  assert.equal(isRunning(pid), true, "the conversation holds a live Chrome");

  await browser.release(root, "close", ctx);
  await browser.close();
  await harness.close(ctx);
  assert.equal(isRunning(pid), false, "the Chrome is gone once the Harness has closed");
  assert.equal(await until(() => processesNaming(profiles).length === 0, 2_000), true, "no process of the Chrome is left");
}

test("a host that releases, closes the extension and closes the Harness with no drain leaves no Chrome (fake Chrome, a driver as slow to close as Stagehand)", async (t) => {
  await releaseWithoutDrain(t, { executablePath: FAKE, args: [], driver: slowClosing(stubDriver) });
});

test("a host that releases, closes the extension and closes the Harness with no drain leaves no real Chrome (Stagehand)", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  await releaseWithoutDrain(t, { executablePath: CHROME, args: [LOOPBACK_ONLY], driver: stagehandDriver() });
});
