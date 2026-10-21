import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { localSites } from "@parcha/pi-browser";
import { FakeBackend, fakeDriver, hostRegistered } from "@parcha/pi-browser/testing";
import { browserbaseProvider } from "../dist/providers/browserbase.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";
import { scratchSync } from "./fixtures/scratch.mjs";
import { AGENT, browsesOnce, counted, failing, FAILS_SESSION, init, open, PAGE, START, stubDriver, textOf, toolUse, until } from "./fixtures/storage-failure.mjs";

// A browser session whose release the store cannot record is still let go of: its driver is closed and the
// provider releases it, and the record is left as it is, so a reopened run's reconcile finds the session gone.

/** The root asks one use_website request; the child snapshots once and reports. */
function oneChild(requestId) {
  const respond = async (context) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const answered = context.messages.at(-1).role === "toolResult";
    if (asked.includes(`Start at ${START}`)) return answered ? fauxAssistantMessage([fauxText(`Read ${START}`)], { stopReason: "stop" }) : toolUse("snapshot", {});
    return answered ? fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }) : toolUse("use_website", { site: "shop", request_id: requestId, instructions: "Read the start page." });
  };
  return Array.from({ length: 20 }, () => respond);
}
const SHOP = { shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START } };

/** Every session the backend created had a release reach it. */
const releasedAll = (backend) => backend.ledger.filter((row) => row.op === "create").every((made) => backend.ledger.some((row) => row.op === "release" && row.id === made.id));

async function childWhoseStoreFails(t, storage) {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { drivers, driver } = counted(fakeDriver(backend));
  const sites = localSites(SHOP);
  const { harness, browser } = await open(storage, { provider: backend.provider, driver, responses: oneChild(randomUUID()), sites: { port: sites, listing: await sites.list(new AbortController().signal) } });
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const root = await harness.root(ctx, { agent: AGENT, init: init(browser) });
  // Not awaited: a failed commit poisons the Session, and on pi-durable 1.1 the root's wait then never settles.
  root.submit({ type: "input", content: "Read the shop." }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  return { backend, drivers };
}

test("a use_website child whose release the store cannot record still closes its driver and releases its session at the provider", async (t) => {
  const { knobs, storage } = failing(new MemoryStorage());
  knobs.releaseFails = 1;
  const { backend, drivers } = await childWhoseStoreFails(t, storage);
  assert.equal(await until(() => knobs.refused === 1, 10_000), true, "the child's release commit was refused");
  assert.equal(await until(() => drivers.closed === drivers.opened), true, `the child's driver was closed: ${JSON.stringify(drivers)}`);
  assert.equal(drivers.opened, 1);
  assert.equal(await until(() => backend.liveCount() === 0), true, `the child's session was released at the provider: ${backend.ledger.map((row) => row.op).join(",")}`);
  assert.equal(releasedAll(backend), true);
});

test("a use_website child whose report read throws a storage error still closes its driver and releases its session at the provider (#1113)", async (t) => {
  // From pi-durable 1.2 this error fails the Session, so the child's release commit fails too; before 1.2 only the read fails.
  class ReportReadFails extends MemoryStorage {
    fails = 1;
    async scanEntries(query, limit, cursor, context) {
      if (query.order === "descending" && limit > 1 && this.fails > 0) { this.fails -= 1; throw new Error("the report read failed"); }
      return super.scanEntries(query, limit, cursor, context);
    }
  }
  const storage = new ReportReadFails();
  const { backend, drivers } = await childWhoseStoreFails(t, storage);
  assert.equal(await until(() => storage.fails === 0, 10_000), true, "the report read threw");
  assert.equal(await until(() => drivers.closed === drivers.opened), true, `the child's driver was closed: ${JSON.stringify(drivers)}`);
  assert.equal(drivers.opened, 1);
  assert.equal(await until(() => backend.liveCount() === 0), true, `the child's session was released at the provider: ${backend.ledger.map((row) => row.op).join(",")}`);
  assert.equal(releasedAll(backend), true);
});

test("a host release the store cannot record still closes the driver and releases the Browserbase session; the record is left as it is, and the next run's reconcile finds the session gone", async (t) => {
  const dir = scratchSync(t, "release-storage-fails-");
  const fake = fakeBrowserbase();
  const sockets = [];
  const env = { BROWSERBASE_API_KEY: `not-a-secret-storage-${process.pid}`, BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: "wss://proxy.example/ws" };
  const provider = browserbaseProvider({ env, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => { const s = { open: true, close() { this.open = false; } }; sockets.push(s); return s; } });
  const { drivers, driver } = counted(stubDriver);
  const { knobs, storage } = failing(await openNodeJsonlStorage(dir, ctx));
  const one = await open(storage, { provider, driver, responses: browsesOnce() });
  const root = await one.harness.root(ctx, { agent: AGENT, init: init(one.browser) });
  await (await root.submit({ type: "input", content: "Look at the shop." }, ctx)).wait(ctx);
  assert.equal(fake.only("sessions.create").length, 1, "the snapshot opened a Browserbase session");
  const id = [...fake.sessions.keys()][0];

  knobs.releaseFails = 1;
  await assert.rejects(one.browser.release(root, "close", ctx), "the release that could not be recorded is not reported as done");
  assert.equal(knobs.refused, 1, "the release commit was refused");
  assert.deepEqual([drivers.opened, drivers.closed], [1, 1], "the driver was closed");
  assert.deepEqual(fake.only("sessions.update").map((call) => [call.id, call.body.status]), [[id, "REQUEST_RELEASE"]], "Browserbase was asked to release the session");
  assert.equal(fake.sessions.get(id).releaseRequested, true);
  assert.deepEqual(sockets.map((s) => s.open), [false], "the session's download socket was closed");
  await one.harness.close(ctx).catch(() => undefined);
  await one.browser.close();
  assert.equal(fake.only("sessions.update").length, 1, "closing the extension released nothing twice");

  // The next run on the same storage: the record still says live, and the provider says the session is gone.
  const two = await open(await openNodeJsonlStorage(dir, ctx), { provider, driver, responses: browsesOnce() });
  t.after(async () => { await two.harness.close(ctx); await two.browser.close(); });
  const tag = (await two.harness.snapshot(two.browser.docs.Sessions, root.id, ctx)).sessions[0].tag;
  assert.deepEqual(two.report, { released: [], kept: [], lost: [tag], unreachable: [] }, "the record was left live, and the next run's reconcile took the lost path");
  assert.equal((await two.harness.snapshot(two.browser.docs.Sessions, root.id, ctx)).sessions[0].state, "released");
});

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
