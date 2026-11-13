import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { FakeBackend, fakeDriver, hostRegistered } from "@parcha/pi-browser/testing";
import { AGENT, browsesOnce, counted, failing, FAILS_SESSION, init, open, PAGE, START, until } from "./fixtures/storage-failure.mjs";

// A browser session whose release the store cannot record is still let go of: its driver is closed and the
// provider releases it, and the record is left as it is, so a reopened run's reconcile finds the session gone.

/** Every session the backend created had a release reach it. */
const releasedAll = (backend) => backend.ledger.filter((row) => row.op === "create").every((made) => backend.ledger.some((row) => row.op === "release" && row.id === made.id));

test("when a storage error fails the Session, closing the extension closes the driver and releases the session at the provider", { skip: !FAILS_SESSION && "pi-durable before 1.2 gives no sign that a failed commit poisoned the Session, so close learns of a failed store only from a release commit's own failure" }, async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { drivers, driver } = counted(fakeDriver(backend));
  const { knobs, storage } = failing(new MemoryStorage());
  const { harness, browser } = await open(storage, { provider: backend.provider, driver, responses: browsesOnce() });
  t.after(() => harness.close(ctx).catch(() => undefined));
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  await (await root.submit({ type: "input", content: "Look at the shop." }, ctx)).wait(ctx);
  assert.deepEqual([backend.liveCount(), drivers.opened, drivers.closed], [1, 1, 0], "the conversation holds a live session");

  // Any write fails the Session now; the host gets no further and only closes the extension.
  knobs.failAll = true;
  await assert.rejects(harness.commit(async (tx) => { (await tx.doc(browser.docs.Config, root.id)).label = "node-b"; }, ctx));
  await browser.close();
  assert.equal(drivers.closed, 1, "the driver was closed");
  assert.equal(backend.liveCount(), 0, `the session was released at the provider: ${backend.ledger.map((row) => row.op).join(",")}`);
  assert.equal(releasedAll(backend), true);
});

test("a host release closes the driver before it commits: a release commit still waiting on the store has already closed it", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { drivers, driver } = counted(fakeDriver(backend));
  const { knobs, storage } = failing(new MemoryStorage());
  const { harness, browser } = await open(storage, { provider: backend.provider, driver, responses: browsesOnce() });
  let store = () => {};
  // The held commit is let through before the Harness closes, also when an assertion failed first.
  t.after(async () => { store(); await harness.close(ctx); await browser.close(); });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  await (await root.submit({ type: "input", content: "Look at the shop." }, ctx)).wait(ctx);

  knobs.held = new Promise((resolve) => { store = resolve; });
  const releasing = browser.release(root, "close", ctx);
  assert.equal(await until(() => knobs.waiting), true, "the release commit is waiting on the store");
  assert.equal(drivers.closed, 1, "the driver was closed before the commit settled");
  store();
  await releasing;
  assert.equal(await until(() => backend.liveCount() === 0), true, "the committed release task released the session");
});

test("a session the provider would not release when the store could not record it is released again when the extension closes; the warning is scrubbed", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  backend.echo(true);
  const { drivers, driver } = counted(fakeDriver(backend));
  const { knobs, storage } = failing(new MemoryStorage());
  const { harness, browser } = await open(storage, { provider: backend.provider, driver, responses: browsesOnce(), redact: { values: () => hostRegistered(backend.sentinels) } });
  const warnings = [];
  const onWarning = (warning) => { if (warning.code === "PI_BROWSER_RELEASE") warnings.push(warning.message); };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  await (await root.submit({ type: "input", content: "Look at the shop." }, ctx)).wait(ctx);
  const tag = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].tag;

  knobs.releaseFails = 1;
  backend.fail("release", 1);
  await assert.rejects(browser.release(root, "close", ctx));
  assert.equal(drivers.closed, 1, "the driver was closed");
  assert.equal(backend.liveCount(), 1, "the provider's release failed");
  assert.equal(await until(() => warnings.length === 1), true, "the failed release is a process warning");
  assert.match(warnings[0], new RegExp(`^pi-browser: ${tag}: `));
  const s = backend.sentinels;
  for (const secret of [s.runToken, s.bbApiKey, s.bbConnectUrl, s.kernelCdpUrl]) assert.equal(warnings[0].includes(secret), false, `the warning carries no ${secret.slice(0, 6)}...`);
  await harness.close(ctx).catch(() => undefined);
  await browser.close();
  assert.equal(backend.liveCount(), 0, "closing the extension released it");
  assert.equal(releasedAll(backend), true);
});

test("a session the store could not record as created is released by its conversation's release", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { knobs, storage } = failing(new MemoryStorage());
  // The provider makes the session; the commit that records it live is refused, and every one after it.
  const provider = { ...backend.provider, create: async (...args) => { const made = await backend.provider.create(...args); knobs.failAll = true; return made; } };
  const { drivers, driver } = counted(fakeDriver(backend));
  const { harness, browser } = await open(storage, { provider, driver, responses: browsesOnce() });
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  // Not awaited: a failed commit poisons the Session, and on pi-durable 1.1 the wait then never settles.
  root.submit({ type: "input", content: "Look at the shop." }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  assert.equal(await until(() => knobs.refused > 0, 10_000), true, "the commit that records the session was refused");
  assert.deepEqual([backend.tally().creates, backend.liveCount(), drivers.opened], [1, 1, 0], "the provider made the session; no driver attached");

  await assert.rejects(browser.release(root, "close", ctx));
  assert.equal(backend.liveCount(), 0, "the conversation's release released it at the provider");
  assert.equal(releasedAll(backend), true);
});

/** A provider whose create makes the session and loses its answer, after which the store refuses every commit: the session
 *  is found again by its tag, and the commit that records it is the first one refused. */
function lostCreateStoreFails(backend, knobs) {
  backend.lose("create");
  return { ...backend.provider, create: async (...args) => { knobs.failAll = true; return backend.provider.create(...args); } };
}

test("a session whose create answer was lost is found again by its tag; when the store cannot record it, its conversation's release still releases it at the provider", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { knobs, storage } = failing(new MemoryStorage());
  const { drivers, driver } = counted(fakeDriver(backend));
  const { harness, browser } = await open(storage, { provider: lostCreateStoreFails(backend, knobs), driver, responses: browsesOnce() });
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  // Not awaited: a failed commit poisons the Session, and on pi-durable 1.1 the wait then never settles.
  root.submit({ type: "input", content: "Look at the shop." }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  assert.equal(await until(() => knobs.refused > 0, 10_000), true, "the commit that records the session found by its tag was refused");
  assert.deepEqual([backend.tally().creates, backend.tally().findByTag, backend.liveCount(), drivers.opened], [1, 1, 1, 0], "the provider made the session, its answer was lost, its tag found it; no driver attached");

  await assert.rejects(browser.release(root, "close", ctx));
  assert.equal(backend.liveCount(), 0, `the conversation's release released it at the provider: ${backend.ledger.map((row) => row.op).join(",")}`);
  assert.equal(releasedAll(backend), true);
});

test("a session whose create answer was lost and which the store cannot record is released when the extension closes after the storage error failed the Session", { skip: !FAILS_SESSION && "pi-durable before 1.2 gives no sign that a failed commit poisoned the Session, so close learns of a failed store only from a release commit's own failure" }, async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { knobs, storage } = failing(new MemoryStorage());
  const { drivers, driver } = counted(fakeDriver(backend));
  const { harness, browser } = await open(storage, { provider: lostCreateStoreFails(backend, knobs), driver, responses: browsesOnce() });
  t.after(() => harness.close(ctx).catch(() => undefined));
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  root.submit({ type: "input", content: "Look at the shop." }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  assert.equal(await until(() => knobs.refused > 0, 10_000), true, "the commit that records the session found by its tag was refused");
  assert.deepEqual([backend.tally().creates, backend.liveCount(), drivers.opened], [1, 1, 0]);

  await browser.close();
  assert.equal(backend.liveCount(), 0, `closing the extension released it at the provider: ${backend.ledger.map((row) => row.op).join(",")}`);
  assert.equal(releasedAll(backend), true);
});

test("closing the extension over a healthy store releases nothing: its sessions stay for the next run", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { drivers, driver } = counted(fakeDriver(backend));
  const { harness, browser } = await open(new MemoryStorage(), { provider: backend.provider, driver, responses: browsesOnce() });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  await (await root.submit({ type: "input", content: "Look at the shop." }, ctx)).wait(ctx);
  await harness.close(ctx);
  await browser.close();
  assert.equal(drivers.closed, 1, "the driver was closed");
  assert.equal(backend.liveCount(), 1, "the session is kept for a resume");
  assert.equal(backend.tally().releases, 0);
});
