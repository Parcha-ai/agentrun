// A host books each charge of a session's time from `onCharge`, in the commit that writes it on the session's record: one per
// browser call, for what the session ran since its last charge, and one at the release, topped up to the provider's minimum.
// The clock is node's mock Date: each read moves it on by a stated time, so every bill is exact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend, fixturePage } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

/** A run whose model calls browser_read `reads` times, each read taking `readS` seconds, with the host's `prices`. */
async function run(t, { prices, reads, readS }) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const charges = [];
  const browser = createBrowserExtension({
    provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null }, prices,
    onCharge: async (charge, tx, call) => {
      charges.push({ ...charge, call: call?.callId ?? null });
      // Booked in the same commit as the bill.
      await tx.appendEntry(durable.ROOT_CONVERSATION_ID, { kind: "host.charge", data: { tag: charge.tag, usd: charge.usd } });
    },
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); t.mock.timers.tick(readS * 1000); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: reads + 1 }, () => (context) => {
    const done = context.messages.filter((m) => m.role === "toolResult").length;
    // The model thinks for 20 s between calls: idle time the next call's charge bills.
    if (done > 0) t.mock.timers.tick(20_000);
    return done < reads ? faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" }) : faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = durable.createRegistry();
  registry.install(browser.extension);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const policy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "run", run: "run-charges", policy }); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  t.mock.timers.tick(5_000);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  const booked = (await harness.commit((tx) => tx.scanEntries({ conversationId: durable.ROOT_CONVERSATION_ID, order: "ascending" }, 200), ctx)).items.filter((entry) => entry.kind === "host.charge");
  return { charges, record, booked };
}

const sum = (charges, key) => Math.round(charges.reduce((total, charge) => total + charge[key], 0) * 1e12) / 1e12;
/** Each charge's dollars are its own milliseconds at the hourly price, to the picodollar (the meter carries the remainder). */
const priced = (charges, perHour) => charges.every((charge) => Math.abs(charge.usd - charge.seconds * perHour / 3600) < 2e-12);
const shape = (charges) => charges.map(({ seconds, final, state, provider }) => ({ seconds, final, state, provider }));

test("Browserbase's list price: each call bills the time since the last charge, and the release tops a short session up to its minute", async (t) => {
  const { charges, record, booked } = await run(t, { reads: 2, readS: 3 });
  assert.deepEqual(shape(charges), [
    { seconds: 3, final: false, state: "priced", provider: "fake" },
    // The 20 s the model thought, and the 3 s read.
    { seconds: 23, final: false, state: "priced", provider: "fake" },
    // The model's last answer (20 s) and 5 s more before the release: 51 s ran, topped up to the 60 s minimum.
    { seconds: 34, final: true, state: "priced", provider: "fake" },
  ]);
  assert.ok(priced(charges, 0.12), JSON.stringify(charges));
  assert.ok(charges.slice(0, 2).every((charge) => charge.call !== null) && charges[2].call === null, "a call's charge names its call; the release's none");
  assert.equal(new Set(charges.map((charge) => charge.tag)).size, 1);
  assert.deepEqual([record.spent.seconds, record.spent.usd, record.spent.final], [60, 0.002, true], "the record bills one minute, $0.002");
  assert.equal(sum(charges, "usd"), record.spent.usd, "the charges add up to the bill");
  assert.deepEqual(booked.map((entry) => entry.data.usd), charges.map((charge) => charge.usd), "each was booked in the commit that billed it");
});

test("a per-second price with no minimum (Kernel's): the release bills only the time it ran", async (t) => {
  const { charges, record } = await run(t, { prices: { sessionUsdPerHour: 0.06, sessionMinimumS: 0 }, reads: 1, readS: 4 });
  assert.deepEqual(charges.map(({ seconds, final }) => [seconds, final]), [[4, false], [25, true]]);
  assert.ok(priced(charges, 0.06), JSON.stringify(charges));
  assert.deepEqual([record.spent.seconds, sum(charges, "usd")], [29, record.spent.usd]);
});

test("a free provider (local Chrome) and an unpriced one: the time is charged at $0, and the unpriced one says it has no price", async (t) => {
  const free = await run(t, { prices: { sessionUsdPerHour: 0, sessionMinimumS: 0 }, reads: 1, readS: 2 });
  assert.deepEqual(free.charges.map(({ seconds, usd, state }) => [seconds, usd, state]), [[2, 0, "priced"], [25, 0, "priced"]]);
  t.mock.timers.reset();
  const unpriced = await run(t, { prices: { sessionUsdPerHour: null }, reads: 1, readS: 2 });
  assert.deepEqual(unpriced.charges.map(({ seconds, usd, state }) => [seconds, usd, state]), [[2, 0, "unpriced"], [58, 0, "unpriced"]]);
});
