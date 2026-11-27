// A host that stops waiting on a session's release books the time known so far (BrowserExtensionHandle.charge): each open
// session of the conversation, its release under way included, is billed through now, not final, and its
// `chargedThrough` moves in the same commit. The release's own charge, when it lands, bills only the time after that, so
// the two never bill the same second twice; a release confirmed before that charge bills nothing and says by how much
// the earlier charge went past it (overbookedS). The clock is node's mock Date, so every bill is exact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend, fixturePage } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
/** A per-second price with no minimum (Kernel's), so each bill is its own seconds alone. */
const PER_SECOND = { sessionUsdPerHour: 0.06, sessionMinimumS: 0 };
/** The same price with a one-minute minimum (Browserbase's). */
const MINUTE_MINIMUM = { sessionUsdPerHour: 0.06, sessionMinimumS: 60 };

/** A run whose model reads once (4 s) and stops, holding one session, at `prices`. `release` and `create` wrap the
 *  provider's; `onSession` is the host's session hook, handed the browser and the root; `read` replaces the read (handed
 *  the port); `options` add to the extension's, and `setup` readies the fake backend. `wait: false` returns while the run
 *  is under way, its end in `ran`. */
async function opened(t, { release, create, onSession, read, options = {}, setup = () => {}, wait = true, prices = PER_SECOND } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  setup(backend);
  const provider = {
    ...backend.provider,
    ...(release ? { release: (ref, signal) => release(() => backend.provider.release(ref, signal), signal) } : {}),
    ...(create ? { create: (spec, signal) => create(() => backend.provider.create(spec, signal), signal) } : {}),
  };
  const charges = [];
  const box = {};
  const browser = createBrowserExtension({
    ...options,
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null }, prices,
    onCharge: async (charge) => void charges.push(charge),
    ...(onSession ? { onSession: (row, change) => onSession(row, change, box) } : {}),
    tools: { browser_read: read ?? (async (_args, port) => { const s = await port.session(); await s.driver.page(); t.mock.timers.tick(4_000); return { content: [{ type: "text", text: "read" }] }; }) },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses([
    () => faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" }),
    () => faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" }),
  ]);
  const models = createModels();
  models.setProvider(model.provider);
  const registry = durable.createRegistry();
  registry.install(browser.extension);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const policy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "run", run: "run-cut", policy }); } });
  Object.assign(box, { browser, root, ctx });
  await browser.reconcile(harness, () => true, ctx);
  const ran = (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  if (wait) await ran;
  const records = async () => (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  const record = async () => (await records())[0];
  return { browser, harness, root, ctx, charges, record, records, backend, ran };
}

/** `held`, or the release's abort (the harness closing it), whichever comes first. */
const until = (held, signal) => Promise.race([held, new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))]);

const shape = (charges) => charges.map(({ seconds, final, overbookedS }) => ({ seconds, final, ...(overbookedS === undefined ? {} : { overbookedS }) }));

test("a charge while the session's release is under way bills the time through now; the release's charge then bills only the time after it", { timeout: 15_000 }, async (t) => {
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let asked;
  const reached = new Promise((resolve) => (asked = resolve));
  const { browser, harness, root, ctx, charges, record } = await opened(t, { release: async (go, signal) => { asked(); await until(held, signal); return go(); } });
  t.mock.timers.tick(6_000);
  await browser.release(root, "close", ctx);
  const draining = browser.drain(harness, ctx);
  await reached;
  assert.equal((await record()).state, "releasing", "the release was asked and has not answered");
  t.mock.timers.tick(5_000);

  assert.equal(await browser.charge(root, ctx), 1, "the releasing session was charged");
  assert.deepEqual(shape(charges), [{ seconds: 4, final: false }, { seconds: 11, final: false }], "the time through now (6 s, then 5 s while its release waited), not final");
  assert.equal((await record()).spent.chargedThrough, new Date(T0 + 4_000 + 11_000).toISOString(), "its watermark moved with the charge");

  t.mock.timers.tick(3_000);
  letGo();
  await draining;
  assert.deepEqual(shape(charges).slice(2), [{ seconds: 3, final: true }], "the release billed only the 3 s after the charge");
  const spent = (await record()).spent;
  assert.equal(spent.seconds, 4 + 11 + 3, "every second billed once");
  assert.equal(spent.final, true);
  assert.equal(await browser.charge(root, ctx), 0, "a released session is never charged again");
});

test("a release confirmed before a charge that billed past it bills nothing, and says by how much the charge went past it", { timeout: 15_000 }, async (t) => {
  // The release's confirm takes its time (`at`), then tells the host (onSession, "released") before its commit: a charge
  // taken there, 7 s later, bills past the release's time.
  const { browser, harness, root, ctx, charges, record } = await opened(t, {
    onSession: async (_row, change, box) => {
      if (change !== "released") return;
      t.mock.timers.tick(7_000);
      assert.equal(await box.browser.charge(box.root, box.ctx), 1, "the session, its release not yet committed, was charged");
    },
  });
  t.mock.timers.tick(2_000);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  assert.deepEqual(shape(charges), [{ seconds: 4, final: false }, { seconds: 9, final: false }, { seconds: 0, final: true, overbookedS: 7 }], "the release billed nothing, the charge having gone 7 s past it, and said so");
  const spent = (await record()).spent;
  assert.deepEqual([spent.seconds, spent.final], [13, true], "the session's time is what was charged before, never less than 0 more");
});

test("a conversation with no open session is charged nothing", { timeout: 15_000 }, async (t) => {
  const { browser, harness, root, ctx, charges } = await opened(t);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  const before = charges.length;
  assert.equal(await browser.charge(root, ctx), 0);
  assert.equal(charges.length, before);
});

/** The session's charges when its release is asked `a` s after the read and confirmed `b` + `c` s later, with a host's
 *  charge `b` s into the release (`cut`) or none. */
async function billed(t, prices, [a, b, c], cut) {
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let asked;
  const reached = new Promise((resolve) => (asked = resolve));
  const { browser, harness, root, ctx, charges, record } = await opened(t, { prices, release: async (go, signal) => { asked(); await until(held, signal); return go(); } });
  t.mock.timers.tick(a * 1000);
  await browser.release(root, "close", ctx);
  const draining = browser.drain(harness, ctx);
  await reached;
  t.mock.timers.tick(b * 1000);
  if (cut) assert.equal(await browser.charge(root, ctx), 1);
  t.mock.timers.tick(c * 1000);
  letGo();
  await draining;
  return { charges, spent: (await record()).spent, browser, harness, root, ctx };
}

const sum = (charges, field) => Math.round(charges.reduce((total, charge) => total + charge[field], 0) * 1e12) / 1e12;

for (const [label, prices, times, seconds] of [
  ["under the provider's minimum", MINUTE_MINIMUM, [2, 3, 1], 60],
  ["past the provider's minimum", MINUTE_MINIMUM, [30, 20, 10], 64],
  ["with no minimum", PER_SECOND, [6, 5, 3], 18],
]) {
  test(`a cut charge, then the release's final charge, book what one uninterrupted session books, ${label}`, { timeout: 15_000 }, async (t) => {
    const whole = await billed(t, prices, times, false);
    t.mock.timers.reset();
    const split = await billed(t, prices, times, true);
    assert.equal(split.charges.length, whole.charges.length + 1, "one charge more: the cut's");
    assert.deepEqual(split.charges.map((charge) => charge.final), [false, false, true]);
    assert.equal(sum(split.charges, "seconds"), seconds, `the session's seconds, once: ${JSON.stringify(shape(split.charges))}`);
    assert.equal(sum(whole.charges, "seconds"), seconds);
    assert.equal(sum(split.charges, "usd"), sum(whole.charges, "usd"), "the same money as the session uninterrupted");
    assert.deepEqual([split.spent.seconds, split.spent.usd, split.spent.final], [whole.spent.seconds, whole.spent.usd, true], "the same record");
  });
}

test("a session billed final is never billed again: its record's next final adds nothing, and a charge after it charges nothing", { timeout: 15_000 }, async (t) => {
  const { charges, spent, browser, harness, root, ctx } = await billed(t, MINUTE_MINIMUM, [2, 3, 1], true);
  const before = charges.length;
  t.mock.timers.tick(30_000);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  assert.equal(await browser.charge(root, ctx), 0, "the charge finds no session to bill");
  assert.equal(charges.length, before, "no charge after the final one");
  const again = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].spent;
  assert.deepEqual([again.seconds, again.usd, again.final], [spent.seconds, spent.usd, true]);
});

/** What each of `sessions` was charged, in order. */
const chargedEach = (charges, sessions) => sessions.map((session) => charges.filter((charge) => charge.tag === session.tag).map(({ seconds, final }) => ({ seconds, final })));

test("a session whose create is still under way is charged nothing, and its own charges then bill the whole session once", { timeout: 15_000 }, async (t) => {
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let asked;
  const reached = new Promise((resolve) => (asked = resolve));
  const { browser, harness, root, ctx, charges, record, ran } = await opened(t, { wait: false, create: async (go, signal) => { asked(); await until(held, signal); return go(); } });
  await reached;
  assert.deepEqual([(await record()).state, (await record()).resourceId], ["creating", null], "its create was asked and has not answered");
  t.mock.timers.tick(3_000);
  assert.equal(await browser.charge(root, ctx), 0, "no session to charge yet");
  assert.deepEqual(charges, [], "and no charge");

  letGo();
  await ran;
  t.mock.timers.tick(2_000);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  assert.deepEqual(shape(charges), [{ seconds: 7, final: false }, { seconds: 2, final: true }], "the read's charge from the create's start (3 s, then the 4 s read), then the release's 2 s");
  assert.equal((await record()).spent.seconds, 9, "every second once");
});

test("a session whose create's answer was lost, its release by tag under way with no session id on its record, is charged nothing; the release bills the session it found, once", { timeout: 15_000 }, async (t) => {
  // The create lands at the provider and its answer is lost, and the lookup by its tag fails: the record is left
  // releasing with no id, to a release after the create deadline. That release finds the session by its tag, and its
  // stop waits on the provider.
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let asked;
  const reached = new Promise((resolve) => (asked = resolve));
  const { browser, harness, root, ctx, charges, record, backend } = await opened(t, {
    options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); },
    release: async (go, signal) => { asked(); await until(held, signal); return go(); },
  });
  t.mock.timers.tick(1_000);
  await reached;
  assert.deepEqual([(await record()).state, (await record()).releaseReason, (await record()).resourceId], ["releasing", "create_failed", null]);
  t.mock.timers.tick(3_000);
  assert.equal(await browser.charge(root, ctx), 0, "a record with no session id is not charged");
  assert.deepEqual(charges, [], "and no charge");

  letGo();
  await browser.drain(harness, ctx);
  assert.equal(backend.liveCount(), 0);
  assert.deepEqual(shape(charges), [{ seconds: 4, final: true }], "the release bills the session it found, all of it, once");
  assert.equal(typeof (await record()).resourceId, "string", "the id its lookup found is recorded");
});

test("a held session (a person has it) is charged through now, not final; its release bills only the rest", { timeout: 15_000 }, async (t) => {
  const { browser, harness, root, ctx, charges, record } = await opened(t, {
    read: async (_args, port) => { const s = await port.session(); await s.driver.page(); t.mock.timers.tick(4_000); await port.hold("handoff-1"); return { content: [{ type: "text", text: "held" }] }; },
  });
  assert.equal((await record()).state, "held");
  t.mock.timers.tick(5_000);
  assert.equal(await browser.charge(root, ctx), 1, "the held session was charged");
  const cut = shape(charges);
  assert.deepEqual([sum(charges, "seconds"), cut.at(-1).final], [9, false], `its 9 s through now, not final: ${JSON.stringify(cut)}`);
  t.mock.timers.tick(2_000);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  assert.deepEqual(shape(charges).slice(cut.length), [{ seconds: 2, final: true }], "the release billed only the 2 s after the charge");
  assert.equal((await record()).spent.seconds, 11);
});

test("a lost session (custody gave up releasing it) is billed in full when it is lost, and a charge after it charges nothing", { timeout: 60_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const { browser, harness, root, ctx, charges, record } = await opened(t, { setup: (backend) => backend.fail("release", RELEASE_ATTEMPTS) });
  t.mock.timers.tick(2_000);
  await browser.release(root, "close", ctx);
  // The mock clock moves as real time does while the release task backs off.
  const pumping = setInterval(() => t.mock.timers.tick(5), 5);
  await browser.drain(harness, ctx).finally(() => clearInterval(pumping));
  assert.deepEqual([(await record()).state, (await record()).spent.final], ["lost", true]);
  const before = charges.length;
  t.mock.timers.tick(3_000);
  assert.equal(await browser.charge(root, ctx), 0, "a lost session is not charged");
  assert.equal(charges.length, before, "and no charge");
});

test("a charge at the instant the session was last charged charges nothing, so no $0 charge is booked under it", { timeout: 15_000 }, async (t) => {
  const { browser, root, ctx, charges, record } = await opened(t);
  assert.deepEqual(shape(charges), [{ seconds: 4, final: false }], "the read charged the session through now");
  assert.equal(await browser.charge(root, ctx), 0, "nothing ran since");
  assert.equal(charges.length, 1, "no $0 charge");
  t.mock.timers.tick(2_000);
  assert.equal(await browser.charge(root, ctx), 1);
  assert.equal(await browser.charge(root, ctx), 0, "a second charge at the same instant charges nothing");
  assert.deepEqual(shape(charges), [{ seconds: 4, final: false }, { seconds: 2, final: false }]);
  assert.equal((await record()).spent.seconds, 6);
});

test("two open sessions of one conversation, one releasing and one live, are both charged through now, and each one's release bills only its own rest", { timeout: 15_000 }, async (t) => {
  // The read reads 4 s, relaunches (the first session's release is asked, and waits on the provider) and reads 2 s more
  // on the new session.
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let asked;
  const reached = new Promise((resolve) => (asked = resolve));
  const { browser, harness, root, ctx, charges, records } = await opened(t, {
    release: async (go, signal) => { asked(); await until(held, signal); return go(); },
    read: async (_args, port) => {
      const s = await port.session();
      await s.driver.page();
      t.mock.timers.tick(4_000);
      const again = await port.relaunch({});
      await again.driver.page();
      t.mock.timers.tick(2_000);
      return { content: [{ type: "text", text: "read" }] };
    },
  });
  await reached;
  assert.deepEqual((await records()).map((one) => one.state), ["releasing", "live"]);
  t.mock.timers.tick(5_000);
  assert.equal(await browser.charge(root, ctx), 2, "both sessions were charged");
  t.mock.timers.tick(3_000);
  letGo();
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  const [first, second] = chargedEach(charges, await records());
  assert.deepEqual(first, [{ seconds: 11, final: false }, { seconds: 3, final: true }], "the first: its 11 s to the charge, then its release's 3 s");
  assert.deepEqual(second, [{ seconds: 2, final: false }, { seconds: 5, final: false }, { seconds: 3, final: true }], "the second: the read's 2 s, 5 s to the charge, then its release's 3 s");
  assert.deepEqual((await records()).map((one) => [one.state, one.spent.seconds]), [["released", 14], ["released", 10]], "each session's time, once");
});
