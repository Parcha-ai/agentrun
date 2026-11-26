// Browser minutes in the run's spend, on the run's one ledger (a real kernel RunTools, support.mjs toolLedger): each
// charge of a session's time is recorded as a BROWSER_CHARGED in the commit that bills it and booked on the ledger once
// that commit is in, and under a cap the time is held on the ledger before it runs (browser-cost.ts). The first tests run
// pi-browser's own meter in this process on node's mock Date, so every bill is exact; the last ones go through the API
// with the faux browser.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BROWSER_CHARGED, BROWSER_PRICES, BROWSER_SESSION_OPEN, browserPrice, browserSpend, priceEnvOf } from "../dist/browser-cost.js";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, follow, scratch, serve, toolLedger, withEnv } from "./support.mjs";

const START = "https://example.test/start";
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const BROWSERBASE = { usdPerHour: 0.12, minimumS: 60 };
const KEYS = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
/** The operator's Browserbase price, in USD an hour (browser-cost.ts BROWSER_PRICE_ENV). */
const PRICE_ENV = priceEnvOf("browserbase");

/** A pi run in this process whose model calls browser_read `reads` times, thinking `thinkS` between calls, each read
 *  taking `readS`, on a `provider` browser at `price`, under `cap` (none: no cap), booked on its one ledger `paid`.
 *  `seen(at, spent, held)` runs at every moment the run can spend, with the ledger's figures: inside each call, before
 *  each model turn and after the release (its ledger steps all written). */
async function run(t, { provider = "browserbase", price = BROWSERBASE, reads, readS = 3, thinkS = 20, cap, idleS = 180, end = "close", setup = () => {}, pump = false, options = {}, lastTurn = () => {}, after = async () => {}, cutRelease = false, seen = () => {}, bind = () => {} }) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { FakeBackend, fakeDriver, fixturePage }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const paid = await toolLedger(cap);
  const backend = new FakeBackend({ name: provider, start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  setup(backend);
  // `cutRelease`: the first release stops the session, then the conversation's tasks are aborted before it answers.
  let root;
  let cut = false;
  const cutting = { ...backend.provider, release: async (ref, signal) => {
    await backend.provider.release(ref, signal);
    if (cut) return;
    cut = true;
    void root.abort(ctx, { background: true });
    await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } };
  const releases = [];
  // A refusal's release, waited for here so its charge is billed at the moment of the refusal.
  const spend = browserSpend(provider, price, idleS, async (conversation, context) => { releases.push(conversation.id); await browser.release(conversation, "close", context); await browser.drain(harness, context); }, undefined, { paid });
  const browser = createBrowserExtension({ ...options,
    provider: () => (cutRelease ? cutting : backend.provider), driver: fakeDriver(backend), evidence: { file: async () => null },
    prices: { sessionUsdPerHour: price.usdPerHour, sessionMinimumS: price.minimumS }, onCharge: spend.onCharge,
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); t.mock.timers.tick(readS * 1000); seen("call", paid.spentUsd(), paid.heldUsd()); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const extension = { ...browser.extension, tools: browser.extension.tools.map(spend.capped) };
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: reads + 1 }, () => (context) => {
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length > 0) t.mock.timers.tick(thinkS * 1000);
    if (results.length >= reads) lastTurn(backend);
    seen("turn", paid.spentUsd(), paid.heldUsd());
    const refused = results.some((m) => m.content.some((c) => c.type === "text" && c.text.includes("spend_cap_reached")));
    return results.length < reads && !refused ? faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" }) : faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = durable.createRegistry();
  registry.install(extension);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  spend.watch(harness);
  const policy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: idleS, batchTimeoutMs: 60_000 };
  root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "run", run: "run-cost", policy }); } });
  // `bind`: the run's browser, root and context, for a test's own hooks (onSession) to act on.
  bind({ browser, root, ctx, spend });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  t.mock.timers.tick(5_000);
  // `idle`: the run calls no more, and pi-browser releases the session itself once its idle window passes (in real time).
  const sessions = async () => (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  if (end === "idle") for (let i = 0; i < 200 && (await sessions())[0]?.state !== "released"; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  else await browser.release(root, "close", ctx);
  // `pump`: the mock clock moves on 2 s (or `pump` ms) every 5 ms of real time, for the release task's backoffs to pass.
  const pumping = pump ? setInterval(() => t.mock.timers.tick(pump === true ? 2_000 : pump), 5) : undefined;
  await browser.drain(harness, ctx).finally(() => clearInterval(pumping));
  await after({ browser, harness, backend, ctx, paid, spend });
  await spend.ledgerIdle();
  seen("released", paid.spentUsd(), paid.heldUsd());
  const [record] = await sessions();
  const entries = (await harness.commit((tx) => tx.scanEntries({ conversationId: durable.ROOT_CONVERSATION_ID, order: "ascending" }, 500), ctx)).items;
  const booked = entries.filter((entry) => entry.kind === BROWSER_CHARGED).map((entry) => entry.data);
  const results = entries.map((entry) => JSON.stringify(entry)).filter((text) => text.includes("spend_cap_reached"));
  return { record, booked, spent: paid.spentUsd(), paid, releases, results, backend, stretch: spend.stretch };
}

const pico = (usd) => Math.round(usd * 1e12) / 1e12;
const total = (booked) => pico(booked.reduce((sum, row) => sum + row.usd, 0));

test("uncapped: every charge is booked under its call, idle time between calls included, and the release's last; nothing is refused", async (t) => {
  const { record, booked, releases, paid } = await run(t, { reads: 3 });
  // 3 s, then 20 s thought and a 3 s read twice, then the last answer's 20 s and 5 s to the release: 74 s past the minimum.
  assert.deepEqual(booked.map((row) => [row.tool, row.charged_by, row.seconds]), [["browser", "browserbase", 3], ["browser", "browserbase", 23], ["browser", "browserbase", 23], ["browser", "browserbase", 25]]);
  assert.ok(booked.every((row) => typeof row.call === "string"), "the release's charge goes under the session's last call");
  assert.equal(booked[3].call, booked[2].call);
  assert.deepEqual([record.spent.seconds, record.spent.final], [74, true]);
  assert.equal(total(booked), record.spent.usd, "booked is what the session's record bills");
  assert.ok(Math.abs(record.spent.usd - 74 * 0.12 / 3600) < 1e-11, String(record.spent.usd));
  assert.deepEqual(releases, [], "nothing refused");
  assert.equal(pico(paid.spentUsd()), record.spent.usd, "the run's ledger books each charge once");
  assert.equal(paid.heldUsd(), 0, "no hold is left");
});

test("a cut release's charge that billed past the release's own time: the release books 0 s and the run's record says by how much the cut went past it; every second booked once", async (t) => {
  // The cut's charge (tools.ts releaseCut: BrowserExtensionHandle.charge) lands after the vendor answered the release and
  // before its confirm commits: 7 s past the release's time.
  const bound = {};
  const { record, booked, paid } = await run(t, {
    reads: 1, price: { usdPerHour: 0.12, minimumS: 0 }, bind: (handles) => Object.assign(bound, handles),
    options: { onSession: async (_row, change) => {
      if (change !== "released") return;
      t.mock.timers.tick(7_000);
      await bound.browser.charge(bound.root, bound.ctx);
      await bound.spend.ledgerIdle();
    } },
  });
  // 3 s, the last answer's 20 s and 5 s to the release; then the cut's 7 s past it, and the release's own 0 s.
  assert.deepEqual(booked.map((row) => [row.seconds, row.final, row.overbooked_s ?? null]), [[3, false, null], [25 + 7, false, null], [0, true, 7]], JSON.stringify(booked));
  assert.deepEqual([record.spent.seconds, record.spent.final], [35, true], "the session is billed what was charged, never less than 0 more");
  assert.equal(total(booked), record.spent.usd, "booked is what the session's record bills");
  assert.equal(pico(paid.spentUsd()), record.spent.usd, "the run's ledger books each second once");
  assert.equal(paid.heldUsd(), 0, "no hold is left");
});

test("capped: what the run spent plus what it holds never passes the cap; the call that would cross it is refused in the cap's words and the session is released", async (t) => {
  const cap = 0.028;
  const moments = [];
  const { record, booked, spent, paid, releases, results, backend, stretch } = await run(t, { reads: 4, cap, seen: (at, spent, held) => moments.push([at, spent + held]) });
  assert.equal(stretch, 270 * 0.12 / 3600, "the next stretch: its 60 s minimum, the 180 s idle window and 30 s for its release");
  // Each moment the run could spend: inside each call, at each model turn and after the release.
  assert.ok(moments.length >= 6, JSON.stringify(moments));
  for (const [at, held] of moments) assert.ok(held <= cap, `${at}: ${held} is over the cap of ${cap}`);
  // Two calls fit: $0.018 held for the first, then the session's $0.009 reserve beside the second's $0.018 and the 20 s it
  // ran since. The third does not, and is refused before it runs.
  const refusal = results.find((text) => text.includes("spend_cap_reached"));
  // One sentence, the call named mid-sentence in lower case: what the run spent and holds of its cap, what the call could
  // cost and why, and the cap that would run it.
  assert.match(refusal, /spend_cap_reached: Not sent: this run has spent less than a cent and holds \$0\.01 for steps still running, of its \$0\.028 cap, and the next step, this browser call, could cost up to \$0\.018667 \(browserbase's session time at \$0\.12 an hour: the 20 s its session ran since its last charge, and twice the next stretch of 270 s \(its 60 s minimum, the 180 s idle window and 30 s for its release\)\)\. Raise the cap to at least \$0\.03 to continue\./);
  assert.equal(releases.length, 1, "its session was released");
  assert.deepEqual([backend.tally().creates, backend.tally().releases, backend.liveCount()], [1, 1, 0]);
  // 3 s, 23 s, and at the refusal 20 s more, topped up to the minute.
  assert.deepEqual(booked.map((row) => row.seconds), [3, 23, 34]);
  assert.deepEqual([record.spent.seconds, record.spent.usd], [60, 0.002]);
  assert.equal(total(booked), 0.002);
  assert.ok(Math.abs(spent - 0.002) < 1e-12 && spent <= cap, `the run's ledger booked ${spent}`);
  assert.equal(paid.heldUsd(), 0, "every hold is let go once the release is booked");
});

test("capped, a session pi-browser releases itself once the run stops calling: its release's charge is booked from the reserve held for it", async (t) => {
  const cap = 0.01;
  const moments = [];
  const { record, booked, releases, stretch, paid } = await run(t, { reads: 1, idleS: 1, end: "idle", cap, seen: (at, spent, held) => moments.push([at, spent + held]) });
  assert.equal(stretch, 91 * 0.12 / 3600, "its 60 s minimum, a 1 s idle window and 30 s for its release");
  for (const [at, held] of moments) assert.ok(held <= cap, `${at}: ${held} is over the cap of ${cap}`);
  assert.deepEqual([record.state, record.spent.final, releases], ["released", true, []], "released by its idle window, not by a refusal");
  // 3 s at the call; the last answer's 20 s and 5 s more, topped up to the minute at the idle release.
  assert.deepEqual(booked.map((row) => row.seconds), [3, 57]);
  assert.equal(total(booked), 0.002);
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0);
});

test("capped, a session whose release the provider never confirms ends lost: billed what it ran and its minimum, and its reserve is let go", { timeout: 90_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const cap = 0.03;
  const { record, booked, paid } = await run(t, { reads: 1, cap, pump: true, setup: (backend) => backend.fail("release", RELEASE_ATTEMPTS) });
  assert.equal(record.state, "lost");
  assert.equal(booked.length, 2, JSON.stringify(booked));
  assert.ok(booked[0].seconds === 3 && booked[1].seconds >= 57, "the call's 3 s, then what it ran until custody gave up, at least the rest of its minute");
  assert.deepEqual([record.spent.final, total(booked)], [true, record.spent.usd]);
  assert.equal(pico(paid.spentUsd()), record.spent.usd, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "no stretch is left held for a session custody no longer tracks as open");
});

test("capped, a create whose answer is lost and whose session no lookup finds yet: its delayed release is held until it is billed", async (t) => {
  const cap = 0.1;
  const moments = [];
  const { record, booked, paid } = await run(t, { reads: 1, cap, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); }, seen: (at, spent, held) => moments.push([at, spent, held]) });
  // The call failed with the session left to a release after the create deadline: the next turn still holds it, the
  // deadline and a stretch at Browserbase's price.
  const [, spentThen, heldThen] = moments.filter(([at]) => at === "turn")[1];
  assert.equal(spentThen, 0, "nothing billed yet");
  assert.ok(Math.abs(heldThen - (60 + 270) * 0.12 / 3600) < 1e-9, `held for its delayed release: ${heldThen}`);
  for (const [at, spent, held] of moments) assert.ok(spent + held <= cap, `${at}: ${spent + held}`);
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => row.seconds), [60], "found by its tag and billed its minimum");
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "let go once billed");
});

test("capped, a session found by its tag stays billed when its release retries: the next attempt's lookup no longer finds the stopped session", { timeout: 60_000 }, async (t) => {
  const { CONFIRM_POLLS } = await import("@parcha/pi-browser/durable");
  const cap = 0.1;
  // The create's answer is lost and its first lookup fails: the session is left to a release after the create deadline.
  // That release finds it by its tag and stops it, but its confirm gets no answer through every poll, so the release is
  // tried again, and the provider's tag lookup no longer lists the stopped session. The clock moves as real time does.
  const { record, booked, paid } = await run(t, { reads: 1, cap, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); backend.fail("status", CONFIRM_POLLS); } });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]], "one charge, its minimum at list price");
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "its hold let go once billed");
});

test("capped, a session found by its tag whose release stops it and then fails is billed on the next attempt, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { record, booked, paid } = await run(t, { reads: 1, cap: 0.1, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); }, lastTurn: (backend) => backend.lose("release") });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "its hold let go once billed");
});

test("capped, a lost session known only by its tag, stopped by a reopen's release that then fails, is billed by the next reconcile, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const { record, booked, paid } = await run(t, { reads: 1, cap: 0.1, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1 + RELEASE_ATTEMPTS); },
    after: async ({ browser, harness, backend, ctx, paid, spend }) => {
      await spend.ledgerIdle();
      assert.ok(paid.heldUsd() > 0, "the lost session is still held: it may be running");
      backend.lose("release");
      assert.equal((await browser.reconcile(harness, () => true, ctx)).unreachable.length, 1);
      assert.equal((await browser.reconcile(harness, () => true, ctx)).released.length, 1);
    } });
  assert.deepEqual([record.state, record.spent.final], ["lost", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "its hold let go once billed");
});

test("capped, a session found by its tag whose release attempt is aborted between its stop and its next checkpoint is billed by the abort handler, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { record, booked, paid } = await run(t, { reads: 1, cap: 0.1, pump: 5, cutRelease: true, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); } });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(pico(paid.spentUsd()), 0.002, "booked once on the run's ledger");
  assert.equal(paid.heldUsd(), 0, "its hold let go once billed");
});

test("a charge joins the run's spend and moves its holds only once the commit that books it is in: one that fails leaves neither", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  const paid = await toolLedger(1);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, undefined, { paid });
  spend.watch(harness);
  const charge = { conversationId: 1, tag: "ar-run-1", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 3, usd: 0.0001, final: false, state: "priced" };
  await assert.rejects(harness.commit(async (tx) => { await spend.onCharge(charge, tx); throw new Error("the commit fails after the charge"); }, ctx));
  await spend.ledgerIdle();
  assert.deepEqual([paid.spentUsd(), paid.heldUsd()], [0, 0], "nothing booked: no spend counted, no reserve held");
  await harness.commit((tx) => spend.onCharge(charge, tx), ctx);
  await spend.ledgerIdle();
  assert.deepEqual([paid.spentUsd(), paid.heldUsd()], [0.0001, spend.stretch], "booked: its spend counted, and its session's reserve held");
  await harness.commit((tx) => spend.onCharge({ ...charge, seconds: 57, usd: 0.0019, final: true }, tx), ctx);
  await spend.ledgerIdle();
  assert.deepEqual([pico(paid.spentUsd()), paid.heldUsd()], [0.002, 0]);
});

test("a person's time carried for a session stays held until the session's next charge books it, and goes then", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  const paid = await toolLedger(1);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, undefined, { paid });
  spend.watch(harness);
  spend.carry("ar-run-2", 600);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paid.heldUsd() - 0.02) < 1e-12, "10 minutes at $0.12 an hour, held");
  spend.carry("ar-run-3", 300);
  await harness.commit((tx) => spend.onCharge({ conversationId: 1, tag: "ar-run-2", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 600, usd: 0.02, final: true, state: "priced" }, tx), ctx);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paid.heldUsd() - 0.01) < 1e-12, "booked: that session's carried time goes, another's stays");
  assert.equal(pico(paid.spentUsd()), 0.02);
  await harness.commit((tx) => spend.onCharge({ conversationId: 1, tag: "ar-run-3", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 300, usd: 0.01, final: true, state: "priced" }, tx), ctx);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paid.heldUsd()) < 1e-12, "and the other's goes with its own charge: nothing is left held");
  assert.equal(pico(paid.spentUsd()), 0.03, "each charge booked once");
});

test("a person's minutes are held once: the next browser call's hold leaves out the carried time it would cover, so under a $0.05 cap it fits; a charge books carried time only up to its own through", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const cap = 0.05;
  const paid = await toolLedger(cap);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const releases = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async (conversation) => void releases.push(conversation.id), undefined, { paid });
  spend.watch(harness);
  /** What the run's ledger holds, its steps all written; and that spent and held are within the cap. */
  const held = async () => {
    await spend.ledgerIdle();
    assert.ok(paid.spentUsd() + paid.heldUsd() <= cap + 1e-12, `spent ${paid.spentUsd()} and held ${paid.heldUsd()} pass the cap of ${cap}`);
    return paid.heldUsd();
  };
  const tag = "ar-run-4";
  const charge = (seconds, usd, final = false) => ({ conversationId: 1, tag, provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds, usd, final, state: "priced" });
  // The session's first charge: its $0.009 reserve held from here.
  await harness.commit((tx) => spend.onCharge(charge(0, 0), tx), ctx);
  // Ten minutes the person had, given back: $0.02 carried.
  t.mock.timers.tick(600_000);
  spend.carry(tag, 600);
  assert.ok(Math.abs((await held()) - 0.029) < 1e-9, `the reserve and the carried time: ${paid.heldUsd()}`);
  // Greptile's numbers: the next call needs the ten minutes once ($0.02, carried) and its two stretches ($0.018) beside the
  // reserve: $0.047 under the $0.05 cap.
  let ran = 0;
  const tool = spend.capped({ name: "snapshot", execute: async () => { ran += 1; return { content: [{ type: "text", text: "ran" }] }; } });
  const api = { conversationId: 1, callId: "c1", commit: async (change) => harness.commit(change, ctx) };
  const out = await tool.execute({}, api, ctx);
  assert.deepEqual([ran, releases, out.content[0].text], [1, [], "ran"], "it fits: the minutes are held once");
  // Five more minutes the person had (T0+10 to T0+15 min, $0.01 carried), then a charge computed through T0+12.5 min that
  // lands after: it books the first ten minutes and half of these, and the rest ($0.005) stays held.
  t.mock.timers.tick(300_000);
  spend.carry(tag, 300);
  assert.ok(Math.abs((await held()) - 0.039) < 1e-9, `the reserve and both carried stretches: ${paid.heldUsd()}`);
  await harness.commit((tx) => spend.onCharge({ ...charge(750, 0.025), at: new Date(T0 + 750_000).toISOString() }, tx), ctx);
  // The first ten minutes' stretch goes; the second runs past the charge's through. The browser trims it to the $0.005
  // after it for the next call's figure, but the run's ledger keeps a carried stretch's hold whole ($0.01) until it is
  // dropped: the reserve ($0.009) and that stretch, beside the $0.025 booked, within the cap.
  assert.ok(Math.abs((await held()) - 0.019) < 1e-9, `the reserve, and the carried stretch the charge's through falls in: ${paid.heldUsd()}`);
  assert.equal(pico(paid.spentUsd()), 0.025);
  await harness.commit((tx) => spend.onCharge(charge(150, 0.005, true), tx), ctx);
  assert.ok(Math.abs(await held()) < 1e-9, "the release's charge books the rest: nothing left held");
  assert.equal(pico(paid.spentUsd()), 0.03, "each charge booked once");
});

test("a person's minutes are held once while they still have the browser: ten minutes into a take-over, the call's hold leaves out what the take-over holds, so under a $0.06 cap it fits; a charge books those minutes off the take-over's hold", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const cap = 0.06;
  const paid = await toolLedger(cap);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const releases = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async (conversation) => void releases.push(conversation.id), undefined, { paid });
  spend.watch(harness);
  /** What the run's ledger holds, its steps all written; and that spent and held are within the cap. */
  const held = async () => {
    await spend.ledgerIdle();
    assert.ok(paid.spentUsd() + paid.heldUsd() <= cap + 1e-12, `spent ${paid.spentUsd()} and held ${paid.heldUsd()} pass the cap of ${cap}`);
    return paid.heldUsd();
  };
  const tag = "ar-run-5";
  const charge = (seconds, usd, final = false) => ({ conversationId: 1, tag, provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds, usd, final, state: "priced" });
  // The session's first charge: its $0.009 reserve held from here. Then the owner takes over: fifteen minutes, $0.03, held up front.
  await harness.commit((tx) => spend.onCharge(charge(0, 0), tx), ctx);
  const take = await spend.personTime("taking over the browser", 900, { pauses: false, tag, from: Date.now() });
  assert.equal(take.refused, undefined);
  t.mock.timers.tick(600_000);
  // Greptile's numbers: ten minutes in, the call needs its two stretches ($0.018) beside the take-over's $0.03 and the
  // reserve's $0.009: $0.057 under the $0.06 cap. The ten minutes are inside the take-over's hold already.
  let ran = 0;
  const tool = spend.capped({ name: "snapshot", execute: async () => { ran += 1; return { content: [{ type: "text", text: "ran" }] }; } });
  const api = { conversationId: 1, callId: "c1", commit: async (change) => harness.commit(change, ctx) };
  const out = await tool.execute({}, api, ctx);
  assert.deepEqual([ran, releases, out.content[0].text], [1, [], "ran"], "it fits: the person's minutes are held once");
  // A charge through T0+10 min books those ten minutes ($0.02): the take-over's hold keeps only the five minutes after it.
  await harness.commit((tx) => spend.onCharge(charge(600, 0.02), tx), ctx);
  // The browser trims the take-over's hold to the five minutes after the charge for the next call's figure, but the run's
  // ledger keeps it whole ($0.03) until it is handed back: the reserve and the take-over, beside the $0.02 booked ($0.059),
  // within the cap.
  assert.ok(Math.abs((await held()) - 0.039) < 1e-9, `the reserve and the take-over's hold: ${paid.heldUsd()}`);
  assert.equal(pico(paid.spentUsd()), 0.02);
  take.drop();
  assert.ok(Math.abs((await held()) - 0.009) < 1e-9, "handed back: the reserve alone");
  await harness.commit((tx) => spend.onCharge(charge(0, 0, true), tx), ctx);
  assert.ok(Math.abs(await held()) < 1e-9, "the release's charge: nothing left held");
  assert.equal(pico(paid.spentUsd()), 0.02, "each charge booked once");
});

test("a person's time the cap refuses pauses the run only when it is the agent's own step: an ask's does, the owner's take-over's does not", async (t) => {
  const paid = await toolLedger(0.01);
  const pauses = [];
  const browser = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, undefined, { paid, pause: async (refusal) => void pauses.push(refusal) });
  const take = await browser.personTime("taking over the browser", 900, { pauses: false });
  assert.match(take.refused ?? "", /^spend_cap_reached: .*taking over the browser/);
  assert.deepEqual(pauses, [], "the owner's refused take-over leaves the run's next request alone");
  const ask = await browser.personTime("handing the browser to you", 900);
  assert.match(ask.refused ?? "", /^spend_cap_reached: .*handing the browser to you/);
  assert.equal(pauses.length, 1, "the agent's refused ask pauses the run at its next request");
  assert.match(pauses[0].refuse, /handing the browser to you/);
  assert.equal(pauses[0].code, "spend_cap_reached");
  await browser.ledgerIdle();
  assert.deepEqual([paid.spentUsd(), paid.heldUsd()], [0, 0], "nothing held for either");
});

test("prices by provider: Browserbase, Kernel and local Chrome, each overridden by its own variable; one unknown or unreadable has none", async (t) => {
  assert.deepEqual(BROWSER_PRICES, { browserbase: { usdPerHour: 0.12, minimumS: 60 }, kernel: { usdPerHour: 0.06, minimumS: 0 }, cdp: { usdPerHour: 0, minimumS: 0 } });
  // A computer provider whose descriptor bills nothing (Local Chrome) is free, by its descriptor, never by a list here.
  assert.deepEqual(browserPrice("local-chrome", {}), { usdPerHour: 0, minimumS: 0 });
  assert.deepEqual(browserPrice("kernel", {}), { usdPerHour: 0.06, minimumS: 0 });
  assert.deepEqual(browserPrice("kernel", { AGENTRUN_BROWSER_USD_PER_HOUR_KERNEL: "0.48" }), { usdPerHour: 0.48, minimumS: 0 });
  assert.deepEqual(browserPrice("browserbase", { AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE: " 0.1 " }), { usdPerHour: 0.1, minimumS: 60 }, "a contract price keeps the minimum");
  assert.deepEqual(browserPrice("cdp", { AGENTRUN_BROWSER_USD_PER_HOUR_CDP: "" }), { usdPerHour: 0, minimumS: 0 }, "blank is unset");
  for (const bad of ["-1", "abc", "1e3", "0x1"]) assert.equal(browserPrice("kernel", { AGENTRUN_BROWSER_USD_PER_HOUR_KERNEL: bad }).usdPerHour, null, bad);
  assert.deepEqual(browserPrice("steel", {}), { usdPerHour: null, minimumS: 0 });
  assert.equal(browserPrice("steel", { AGENTRUN_BROWSER_USD_PER_HOUR_STEEL: "0.05" }).usdPerHour, 0.05);
  // Kernel's per-second price: the release bills only the time it ran.
  const kernel = await run(t, { provider: "kernel", price: browserPrice("kernel", {}), reads: 1, readS: 4 });
  assert.deepEqual(kernel.booked.map((row) => [row.charged_by, row.seconds]), [["kernel", 4], ["kernel", 25]]);
  assert.ok(Math.abs(total(kernel.booked) - 29 * 0.06 / 3600) < 1e-11, String(total(kernel.booked)));
  t.mock.timers.reset();
  // Local Chrome is free: its time books nothing and holds nothing, and a capped run is never refused for it.
  const local = await run(t, { provider: "cdp", price: browserPrice("cdp", {}), reads: 2, cap: 0.001 });
  assert.deepEqual([local.booked, local.releases, local.stretch], [[], [], 0]);
  t.mock.timers.reset();
  // A provider with no price: uncapped, its time is booked as an unknown cost; capped, every call is refused for good on
  // the run's ledger, in the kernel's own words, and no session is created.
  const unknown = await run(t, { provider: "steel", price: browserPrice("steel", {}), reads: 1 });
  assert.deepEqual(unknown.booked.map((row) => row.usd), [null, null]);
  // Uncapped, the run's ledger books its charges at no figure: the run's spend reads unknown, never $0, and nothing is held.
  assert.deepEqual([unknown.paid.spentUsd(), unknown.paid.heldUsd()], [null, 0]);
  t.mock.timers.reset();
  const refused = await run(t, { provider: "steel", price: browserPrice("steel", {}), reads: 1, cap: 5 });
  assert.match(refused.results.join("\n"), /spend_cap_reached: Not sent: the next step, this browser call, has no price here, so the run's cap of \$5 cannot be kept: the run is out of budget\./);
  assert.deepEqual([refused.booked, refused.backend.tally().creates], [[], 0]);
});

test("after a reopen, a kept session's down time is held once: its first call fits where its true exposure does; a session already billed is not held", async (t) => {
  // 15 min down at Browserbase's price ($0.03), with $0.02 spent under a $0.10 cap: the kept session holds a stretch and its
  // down time ($0.039), the call two stretches ($0.018); $0.077 fits. Holding the down time on the call too ($0.048) would not.
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 900_000 });
  const cap = 0.1;
  const paid = await toolLedger(cap);
  await paid.spend(0.02);
  const base = 0;
  const releases = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async (conversation) => void releases.push(conversation.id), undefined, { paid });
  const paidHolds = () => paid.heldUsd();
  const spentNow = () => paid.spentUsd();
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const docs = { Inventory: "inventory", Sessions: "sessions" };
  const store = (final) => ({ snapshot: async (token) => (token === "inventory" ? { rows: { k: { tag: "ar-kept", conversationId: 1 } } } : { sessions: [{ tag: "ar-kept", spent: { chargedThrough: new Date(T0).toISOString(), ...(final ? { final: true } : {}) } }] }) });
  // A session whose final charge landed before `kept` read it: nothing to hold, and nothing would ever drop the hold.
  await spend.reopened(store(true), docs, undefined);
  await spend.ledgerIdle();
  assert.equal(paidHolds(), base, "an already billed session is not held");
  await spend.reopened(store(false), docs, undefined);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base - 0.039) < 1e-9, `the kept session: a stretch and its down time, ${paidHolds() - base}`);
  const held = [];
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    held.push(spentNow() + paidHolds() - base);
    t.mock.timers.tick(3_000);
    // Its charge at the call's end: the down time and the call's 3 s, booked once its commit is in.
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-kept", provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds: 903, usd: 903 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, { callId: "c1" });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    await spend.ledgerIdle();
    held.push(spentNow() + paidHolds() - base);
    return { content: [{ type: "text", text: "seen" }] };
  } });
  const out = await tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined);
  assert.ok(!JSON.stringify(out).includes("spend_cap_reached"), JSON.stringify(out));
  assert.deepEqual(releases, [], "the kept session was not released");
  assert.ok(Math.abs(held[0] - 0.077) < 1e-6, `spent and held as the call runs: ${held[0]}`);
  // Its charge booked the down time and the call's 3 s ($0.0301): the reserve is one stretch again on the run's ledger
  // ($0.009), beside the call's two ($0.018) and the $0.0501 spent, never the down time held beside the charge that booked it.
  assert.ok(Math.abs(held[1] - 0.0771) < 1e-6, `spent and held once the charge is booked: ${held[1]}`);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base - 0.009) < 1e-9, `after its charge the ledger holds the reserve at one stretch: ${paidHolds() - base}`);
  for (const figure of [...held, spentNow() + paidHolds() - base]) assert.ok(figure <= cap, `${figure} is over the cap of ${cap}`);
});

/** Ledger writes that land only when the test lets them, never on a clock: `later()` waits in line until `landUntil(done)`
 *  lets it go. That lets the oldest waiting write land, one at a time, each only once everything the one before it set off
 *  has run (a turn of the event loop between them), until `done` settles. A `done` still pending with no write left
 *  waiting for STALLED_TURNS turns in a row is a hang, and fails as one, by count, never by time. */
const STALLED_TURNS = 50;
function heldWrites() {
  const waiting = [];
  const later = () => new Promise((resolve) => waiting.push(resolve));
  async function landUntil(done) {
    let over = false;
    done.then(() => (over = true), () => (over = true));
    for (let idle = 0; !over; ) {
      await new Promise((resolve) => setImmediate(resolve));
      if (over) break;
      const next = waiting.shift();
      if (next) (next(), (idle = 0));
      else if ((idle += 1) >= STALLED_TURNS) throw new Error(`stalled: nothing left to land and it has not settled after ${STALLED_TURNS} turns`);
    }
    return done;
  }
  return { later, landUntil };
}

test("a kept session's reserve held again at one stretch is asked only once its old one is given back, on a ledger whose give-backs land late", async (t) => {
  // The reopen above, on a ledger whose settle lands only when the test lets it (a write, landing late): the re-held
  // reserve must not be asked while the old one (a stretch and 15 min down, $0.039) is still held there, or the ledger
  // judges the new stretch beside the old one and the charge that booked it (about $0.116 of a $0.10 cap).
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 900_000 });
  const inner = await toolLedger(0.1);
  await inner.spend(0.02);
  const events = [];
  const { later, landUntil } = heldWrites();
  const paid = {
    admit: (request) => (events.push(["asked", request.id]), inner.admit(request)),
    settle: async (id, usd, options) => {
      await later();
      const out = await inner.settle(id, usd, options);
      events.push(["landed", id, options?.givenBack === true]);
      return out;
    },
  };
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, undefined, { paid });
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const docs = { Inventory: "inventory", Sessions: "sessions" };
  await spend.reopened({ snapshot: async (token) => (token === "inventory" ? { rows: { k: { tag: "ar-kept", conversationId: 1 } } } : { sessions: [{ tag: "ar-kept", spent: { chargedThrough: new Date(T0).toISOString() } }] }) }, docs, undefined);
  await spend.ledgerIdle();
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    t.mock.timers.tick(3_000);
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-kept", provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds: 903, usd: 903 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, { callId: "c1" });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    await spend.ledgerIdle();
    return { content: [{ type: "text", text: "seen" }] };
  } });
  const out = await landUntil(tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined));
  assert.ok(!JSON.stringify(out).includes("spend_cap_reached"), JSON.stringify(out));
  await landUntil(spend.ledgerIdle());
  const reserves = events.filter(([what, id]) => what === "asked" && id.startsWith("browser:this browser session's reserve#")).map(([, id]) => id);
  assert.equal(reserves.length, 2, `the reopen's reserve, then the one held again: ${JSON.stringify(events)}`);
  const givenBack = events.findIndex(([what, id, back]) => what === "landed" && id === reserves[0] && back);
  const askedAgain = events.findIndex(([what, id]) => what === "asked" && id === reserves[1]);
  assert.ok(givenBack >= 0 && givenBack < askedAgain, `the old reserve is given back before the new one is asked: ${JSON.stringify(events)}`);
  assert.ok(Math.abs(inner.heldUsd() - 0.009) < 1e-9, `the ledger holds the reserve at one stretch: ${inner.heldUsd()}`);
});

/** A new session's first charge (3 s at Browserbase, under no call), committed and seen by `spend`'s watch. */
async function firstCharge(spend) {
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const entries = [];
  await spend.onCharge({ conversationId: 1, tag: "ar-new", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 3, usd: 3 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) });
  listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
  await spend.ledgerIdle();
}

test("capped, a new session's reserve the cap refuses is said and pauses the run in the cap's words; it is never held", async (t) => {
  // $0.095 spent of a $0.10 cap: the session's first charge (3 s, owed) is booked, and its reserve, one stretch ($0.009),
  // has no room. Starting a session is a choice, so the reserve is not owed; refused, its next stretch is held nowhere.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const paid = await toolLedger(0.1);
  await paid.spend(0.095);
  const logs = [];
  const paused = [];
  await firstCharge(browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) }));
  const said = logs.filter((line) => line.includes("event=browser_reserve_refused"));
  assert.equal(said.length, 1, JSON.stringify(logs));
  assert.match(said[0], /ar-new/);
  assert.match(said[0], /spend_cap_reached/);
  assert.equal(paused.length, 1, `the run is paused once: ${JSON.stringify(paused)}`);
  assert.equal(paused[0].code, "spend_cap_reached");
  assert.match(paused[0].refuse, /spend_cap_reached/);
  assert.equal(paid.heldUsd(), 0, "no reserve is held");
  assert.ok(Math.abs(paid.spentUsd() - 0.0951) < 1e-9, `the charge is booked: ${paid.spentUsd()}`);
});

test("capped, a new session's reserve the cap refused is asked again at the session's next charge: after a raise its next stretch is held", async (t) => {
  // As above, $0.095 spent of a $0.10 cap refuses the reserve and pauses the run. The owner raises the cap to $1, the run
  // goes on, and the session is charged again (3 s more, not its last): its next stretch ($0.009) is held from then on.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  let cap = 0.1;
  const paid = await toolLedger(() => cap);
  await paid.spend(0.095);
  const logs = [];
  const paused = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) });
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const charge = async (at) => {
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-new", provider: "browserbase", at: new Date(at).toISOString(), seconds: 3, usd: 3 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    await spend.ledgerIdle();
  };
  await charge(T0);
  assert.equal(paused.length, 1, `the refused reserve pauses the run: ${JSON.stringify(paused)}`);
  assert.equal(paid.heldUsd(), 0, "the refused reserve holds nothing");
  cap = 1;
  await charge(T0 + 3_000);
  assert.ok(Math.abs(paid.heldUsd() - 0.009) < 1e-9, `after the raise the session's next stretch is held on the ledger, one stretch: ${paid.heldUsd()}`);
  assert.equal(paused.length, 1, "the reserve held after the raise pauses nothing");
});

test("capped, a refused reserve asked again at a charge that lands while a call runs is asked once the call's hold is given back, and the call returns with it held", async (t) => {
  // As above, but the session's next charge comes under a running call (c1) after the raise: the call holds two
  // stretches, one of them room for this reserve, so the reserve asked again waits for that hold to be given back, never
  // judged beside it, and the call returns only once it is held.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  let cap = 0.1;
  const inner = await toolLedger(() => cap);
  await inner.spend(0.095);
  const events = [];
  const paid = {
    admit: (request) => (events.push(["asked", request.id]), inner.admit(request)),
    settle: async (id, usd, options) => {
      const out = await inner.settle(id, usd, options);
      events.push(["landed", id, options?.givenBack === true]);
      return out;
    },
  };
  const paused = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, () => {}, { paid, pause: async (refusal) => void paused.push(refusal) });
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const charge = async (at, call) => {
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-new", provider: "browserbase", at: new Date(at).toISOString(), seconds: 3, usd: 3 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, call);
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
  };
  await charge(T0);
  await spend.ledgerIdle();
  assert.equal(paused.length, 1, `the refused reserve pauses the run: ${JSON.stringify(paused)}`);
  assert.equal(inner.heldUsd(), 0, "the refused reserve holds nothing");
  cap = 1;
  const reserveAsks = () => events.filter(([what, id]) => what === "asked" && id.startsWith("browser:this browser session's reserve#")).length;
  let during;
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    t.mock.timers.tick(3_000);
    await charge(Date.now(), { callId: "c1" });
    during = reserveAsks();
    return { content: [{ type: "text", text: "seen" }] };
  } });
  const out = await tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined);
  assert.ok(!JSON.stringify(out).includes("spend_cap_reached"), JSON.stringify(out));
  // The moment the call returns is the run's next chance to spend: the session's next stretch is held by then.
  assert.ok(Math.abs(inner.heldUsd() - 0.009) < 1e-9, `once the call returns its session's next stretch is held, one stretch: ${inner.heldUsd()} (${JSON.stringify(events)})`);
  await spend.ledgerIdle();
  assert.equal(during, 1, `while the call runs the reserve is not asked again beside its hold: ${JSON.stringify(events)}`);
  const reserves = events.filter(([what, id]) => what === "asked" && id.startsWith("browser:this browser session's reserve#")).map(([, id]) => id);
  assert.equal(reserves.length, 2, `the refused reserve, then the one asked again: ${JSON.stringify(events)}`);
  const givenBack = events.findIndex(([what, id, back]) => what === "landed" && id.startsWith("c1#") && back);
  const askedAgain = events.findIndex(([what, id]) => what === "asked" && id === reserves[1]);
  assert.ok(givenBack >= 0 && givenBack < askedAgain, `the reserve is asked again once the call's hold is given back: ${JSON.stringify(events)}`);
  assert.ok(Math.abs(inner.heldUsd() - 0.009) < 1e-9, `the ledger holds the reserve at one stretch: ${inner.heldUsd()}`);
  assert.equal(paused.length, 1, "the reserve held after the raise pauses nothing");
});

test("capped with room, a new session's reserve is held, and nothing is said or paused", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const paid = await toolLedger(5);
  const logs = [];
  const paused = [];
  await firstCharge(browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) }));
  assert.deepEqual([logs, paused], [[], []]);
  assert.ok(Math.abs(paid.heldUsd() - 0.009) < 1e-9, `its reserve, one stretch: ${paid.heldUsd()}`);
});

/** A browser call through `spend`'s cap that opens a new session: its first charge (3 s at Browserbase) is committed under
 *  the call, and `inside()` runs once that charge is seen, while the call still holds. The call's result. */
async function callOpening(spend, inside = () => {}) {
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-new", provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds: 3, usd: 3 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, { callId: "c1" });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    await inside();
    return { content: [{ type: "text", text: "seen" }] };
  } });
  return tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined);
}

test("capped, a call that fits with its two stretches opens a new session: its reserve is held in the room the call kept for it, never refused, and nothing pauses", async (t) => {
  // A $0.025 cap: the call holds two stretches ($0.018), one for its own time and one for the reserve of a session it
  // opens. Asked beside the call's whole hold, the reserve ($0.009) would make $0.027 and be refused for room the run has.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const paid = await toolLedger(0.025);
  const logs = [];
  const paused = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) });
  // The call runs on after its session opened, as a call does: until its session's first charge is booked on the ledger.
  let booked;
  const charged = new Promise((resolve) => (booked = resolve));
  const settle = paid.settle.bind(paid);
  paid.settle = async (id, usd, options) => {
    const out = await settle(id, usd, options);
    if (options?.givenBack !== true) booked();
    return out;
  };
  const out = await callOpening(spend, () => charged);
  await spend.ledgerIdle();
  assert.ok(!JSON.stringify(out).includes("spend_cap_reached"), JSON.stringify(out));
  assert.deepEqual([logs, paused], [[], []], "the reserve is not refused, and the run is not paused");
  assert.ok(Math.abs(paid.heldUsd() - 0.009) < 1e-9, `the session's reserve is held, one stretch: ${paid.heldUsd()}`);
  assert.ok(Math.abs(paid.spentUsd() - 0.0001) < 1e-9, `the call's charge is booked: ${paid.spentUsd()}`);
});

test("a new session is never held nowhere: its call's two stretches hold it until the call's hold is given back, and the call returns only once its reserve is held", async (t) => {
  // A ledger whose asks and settles each land only when the test lets them (writes, landing late), so nothing here leans
  // on the order of microtasks.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const inner = await toolLedger(1);
  const stretch = 270 * 0.12 / 3600;
  const { later, landUntil } = heldWrites();
  const events = [];
  const paid = {
    admit: async (request) => {
      events.push(["asked", request.id]);
      await later();
      const out = await inner.admit(request);
      events.push(["held", request.id, inner.heldUsd()]);
      return out;
    },
    settle: async (id, usd, options) => {
      await later();
      const out = await inner.settle(id, usd, options);
      events.push(["landed", id, options?.givenBack === true, inner.heldUsd()]);
      return out;
    },
  };
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, undefined, { paid });
  const during = [];
  await landUntil(callOpening(spend, async () => {
    await later();
    during.push(inner.heldUsd());
  }));
  // The moment the call returns is the run's next chance to spend (its next request, its next call).
  const returned = inner.heldUsd();
  assert.ok(during[0] >= stretch - 1e-12, `while the call runs its own hold covers the session: ${during[0]}`);
  assert.ok(returned >= stretch - 1e-12 && Math.abs(returned - 0.009) < 1e-9, `once the call returns its session's reserve is held: ${returned} (${JSON.stringify(events)})`);
  const reserve = events.find(([what, id]) => what === "asked" && id.startsWith("browser:this browser session's reserve#"))?.[1];
  const givenBack = events.findIndex(([what, id, back]) => what === "landed" && id.startsWith("c1#") && back);
  const asked = events.findIndex(([what, id]) => what === "asked" && id === reserve);
  assert.ok(givenBack >= 0 && givenBack < asked, `the reserve is asked once the call's hold is given back, never beside it: ${JSON.stringify(events)}`);
  assert.deepEqual(events.slice(givenBack + 1, asked).filter(([what]) => what === "asked"), [], `no other step is asked between the two: ${JSON.stringify(events)}`);
  await landUntil(spend.ledgerIdle());
});

// ---- a call that opens a session and then throws ----

/** The run's one ledger `inner` as its writes see it: each admit and settle lands only when the test lets it
 *  (heldWrites, `landUntil`), and each is logged in `events` (asked, then held or refused; landed, or lost). `charges`
 *  settles once every charge admitted so far is booked. `losesAt(name)`: the claim is lost at the settle of a step of
 *  that name, so that settle and every admit and settle after it fail, as a lost claim's writes do. */
function lateLedger(inner, losesAt = () => false) {
  const { later, landUntil } = heldWrites();
  const events = [];
  const names = new Map();
  const booked = [];
  const done = new Map();
  let lost = false;
  const paid = {
    admit: async (request) => {
      events.push(["asked", request.id]);
      names.set(request.id, request.name);
      if (!request.hold) booked.push(new Promise((resolve) => done.set(request.id, resolve)));
      await later();
      try {
        if (lost) throw new Error("the claim was lost");
        const out = await inner.admit(request);
        events.push(["held", request.id]);
        return out;
      } catch (error) {
        events.push(["refused", request.id]);
        done.get(request.id)?.();
        throw error;
      }
    },
    settle: async (id, usd, options) => {
      await later();
      try {
        if (lost || losesAt(names.get(id))) {
          lost = true;
          events.push(["lost", id]);
          throw new Error("the claim was lost");
        }
        const out = await inner.settle(id, usd, options);
        events.push(["landed", id, options?.givenBack === true]);
        return out;
      } finally {
        done.get(id)?.();
      }
    },
  };
  return { paid, events, charges: () => Promise.all(booked), landUntil };
}

/** A browser call through `spend`'s cap that opens a new session and then throws `thrown`: its open is recorded (opening,
 *  pi-browser's beforeCreate; its records pushed to `opened`), its first charge (`seconds` at Browserbase) is committed
 *  under the call and seen, and once `ready()` settles the tool throws. The call's result. */
async function callOpeningThenThrowing(spend, thrown, { seconds = 3, ready = () => {}, opened = [] } = {}) {
  let listener;
  spend.watch({ observeCommits: (observer) => ((listener = (publication) => observer.advance(publication)), { detach: () => {} }) });
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    await spend.opening({ conversationId: 1, tag: "ar-new", commit: async (write) => write({ appendEntry: async (_, entry) => void opened.push(entry) }) });
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-new", provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds, usd: seconds * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, { callId: "c1" });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    await ready();
    throw thrown;
  } });
  return tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined);
}

/** The index in `events` of the call's hold given back (or lost with its claim), and of its session's reserve asked. */
const giveBackThenReserve = (events) => {
  const call = events.find(([what, id]) => what === "asked" && id.startsWith("c1#"))?.[1];
  const reserve = events.find(([what, id]) => what === "asked" && id.startsWith("browser:this browser session's reserve#"))?.[1];
  return {
    givenBack: events.findIndex(([what, id, back]) => id === call && ((what === "landed" && back) || what === "lost")),
    asked: events.findIndex(([what, id]) => what === "asked" && id === reserve),
  };
};

test("a call that opens a session and then throws rejects with its own error, once its session's reserve is held in the room the call kept for it; the run's pending drains", async (t) => {
  // A $0.025 cap, as above: the call holds two stretches ($0.018). Its tool opens a session, which is charged 3 s, and then
  // throws. paidStep gives the call's hold back on that path too, and its callback (landed) then asks the reserve.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const inner = await toolLedger(0.025);
  const { paid, events, charges, landUntil } = lateLedger(inner);
  const logs = [];
  const paused = [];
  const opened = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) });
  const thrown = new Error("the page crashed");
  await assert.rejects(landUntil(callOpeningThenThrowing(spend, thrown, { opened, ready: charges })), (error) => error === thrown);
  const returned = inner.heldUsd();
  assert.equal(opened.length, 1, JSON.stringify(opened));
  assert.equal(opened[0].kind, BROWSER_SESSION_OPEN);
  assert.ok(Math.abs(opened[0].data.held_usd - 0.018) < 1e-9, `the session opened under the call's two stretches: ${JSON.stringify(opened[0])}`);
  const { givenBack, asked } = giveBackThenReserve(events);
  assert.ok(givenBack >= 0 && givenBack < asked, `the reserve is asked once the call's hold is given back: ${JSON.stringify(events)}`);
  assert.ok(Math.abs(returned - 0.009) < 1e-9, `once the call rejects its session's reserve is held, one stretch: ${returned} (${JSON.stringify(events)})`);
  await landUntil(spend.ledgerIdle());
  assert.deepEqual([logs, paused], [[], []], "the reserve is not refused, and the run is not paused");
  assert.ok(Math.abs(inner.spentUsd() - 0.0001) < 1e-9, `the call's charge is booked: ${inner.spentUsd()}`);
});

test("a call that opens a session and then throws, its reserve refused by the cap: it rejects with its own error, the refusal is said and pauses the run once; the run's pending drains", async (t) => {
  // $0.005 spent of a $0.025 cap: the call fits with its two stretches ($0.023). Its session runs ten minutes ($0.02,
  // owed) and the tool throws. With the call's hold given back, its reserve ($0.009) has no room: $0.034 of $0.025.
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const inner = await toolLedger(0.025);
  await inner.spend(0.005);
  const { paid, events, charges, landUntil } = lateLedger(inner);
  const logs = [];
  const paused = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) });
  const thrown = new Error("the page crashed");
  await assert.rejects(landUntil(callOpeningThenThrowing(spend, thrown, { seconds: 600, ready: charges })), (error) => error === thrown);
  const { givenBack, asked } = giveBackThenReserve(events);
  assert.ok(givenBack >= 0 && givenBack < asked, `the reserve is asked once the call's hold is given back: ${JSON.stringify(events)}`);
  // Acted on before the call returned: the call waits for its reserves.
  const said = logs.filter((line) => line.includes("event=browser_reserve_refused"));
  assert.equal(said.length, 1, JSON.stringify(logs));
  assert.match(said[0], /ar-new/);
  assert.match(said[0], /spend_cap_reached/);
  assert.equal(paused.length, 1, `the run is paused once: ${JSON.stringify(paused)}`);
  assert.equal(paused[0].code, "spend_cap_reached");
  await landUntil(spend.ledgerIdle());
  assert.equal(inner.heldUsd(), 0, "no reserve is held");
  assert.ok(Math.abs(inner.spentUsd() - 0.025) < 1e-9, `the charge is booked: ${inner.spentUsd()}`);
});

test("a call that opens a session and then throws as its claim is lost (the give-back's settle fails): it rejects with its own error, not the settle's; the reserve's failed ask is said; the run's pending drains", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const inner = await toolLedger(0.025);
  const { paid, events, charges, landUntil } = lateLedger(inner, (name) => name === "this browser call");
  const logs = [];
  const paused = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => logs.push(line), { paid, pause: async (refusal) => void paused.push(refusal) });
  const thrown = new Error("the page crashed");
  await assert.rejects(landUntil(callOpeningThenThrowing(spend, thrown, { ready: charges })), (error) => error === thrown);
  const { givenBack, asked } = giveBackThenReserve(events);
  assert.ok(givenBack >= 0 && events[givenBack][0] === "lost" && givenBack < asked, `the reserve is asked once the call's give-back failed: ${JSON.stringify(events)}`);
  const said = logs.filter((line) => line.includes("event=browser_reserve_refused"));
  assert.equal(said.length, 1, JSON.stringify(logs));
  assert.match(said[0], /ar-new/);
  assert.match(said[0], /the claim was lost/);
  // Not the cap's refusal: nothing a raise would fix, so nothing pauses (the next claim's reopen holds the session).
  assert.deepEqual(paused, []);
  await landUntil(spend.ledgerIdle());
});

// ---- pi 1.5's commit observers detach on a throw (observeCommits) ----

/** pi 1.5's observeCommits as the Session runs it: an `advance` that throws is reported, the observer is detached and
 *  ended `listener_error`, and it hears no later commit (pi-durable types.d.ts, Session.observeCommits). */
function piObserver() {
  const state = { detached: false, observer: undefined };
  // The Session's own end (`closed`), settled by `closeAs` as pi's close settles it.
  let closeAs;
  const closed = new Promise((resolve) => (closeAs = resolve));
  return {
    state,
    closeAs,
    harness: { closed, observeCommits: (observer) => ((state.observer = observer), { detach: () => void (state.detached = true) }) },
    publish(changes) {
      if (state.detached) return;
      try {
        state.observer.advance({ seq: 1, changes }, undefined);
      } catch (error) {
        state.detached = true;
        state.observer.end({ kind: "listener_error", error });
      }
    },
    end: (end) => state.observer.end(end),
  };
}
/** A browser charge's commit, as onCharge books it (BROWSER_CHARGED on the root): a session's last (final) by default, so
 *  it leaves no session open and no reserve held. */
const chargeOf = (tag, usd, final = true) => [{ type: "entry", value: { kind: BROWSER_CHARGED, data: { tool: "browser", charged_by: "browserbase", call: null, usd, seconds: 60, tag, conversation: 1, at: new Date(T0).toISOString(), final } } }];
/** The run's one ledger under `cap`, checked at the test's end to hold nothing. `failing` steps (`hold`: its hold-only
 *  steps, `charge`: a charge's own) have their admit throw, as a ledger whose write fails does, that many times. */
async function ledgerFor(t, cap, failing = {}) {
  const paid = await toolLedger(cap);
  const left = { hold: failing.hold ?? 0, charge: failing.charge ?? 0 };
  const admit = paid.admit.bind(paid);
  paid.admit = (request) => {
    const kind = request.hold ? "hold" : "charge";
    if (left[kind] > 0) {
      left[kind] -= 1;
      throw new Error("the ledger's write failed");
    }
    return admit(request);
  };
  t.after(() => assert.equal(paid.heldUsd(), 0, "the test leaves no hold behind"));
  return paid;
}
const DOCS = { Inventory: "inventory", Sessions: "sessions" };
/** A reopen's harness for a run whose root holds `root` and whose browser inventory is empty. */
const reopenOf = (root) => ({ snapshot: async () => ({ rows: {} }), conversation: async () => ({ entries: async () => ({ items: root, next: undefined }) }) });

test("a browser charge the process fails to book in its observer (pi 1.5 detaches an observer that throws): the observer stays attached, a later charge is still booked, and it is logged once: never silently uncounted", async (t) => {
  // The session's reserve cannot be held as its first charge lands: the throw stays inside this process's observer.
  const paid = await ledgerFor(t, 5, { hold: 1 });
  const lines = [];
  const pi = piObserver();
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => lines.push(line), { paid });
  spend.watch(pi.harness);
  pi.publish(chargeOf("ar-1", 0.01, false));
  pi.publish(chargeOf("ar-2", 0.02));
  await spend.ledgerIdle();
  assert.equal(pi.state.detached, false, "the observer stays attached");
  // On the run's one ledger an observer's throw never makes the run's spend unknown: the charges are booked as they land.
  assert.equal(pico(paid.spentUsd()), 0.03, "both charges booked, the later one included");
  assert.equal(lines.filter((line) => line.includes("browser_spend_uncounted")).length, 1, lines.join("\n"));
});

test("on a capped run, a browser charge whose commit landed and whose booking on the ledger failed is booked by the next claim's reopen, once", async (t) => {
  const paid = await ledgerFor(t, 5, { charge: 1 });
  const lines = [];
  const pi = piObserver();
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => lines.push(line), { paid });
  spend.watch(pi.harness);
  const root = chargeOf("ar-1", 0.01).map((change) => change.value);
  pi.publish(chargeOf("ar-1", 0.01));
  await spend.ledgerIdle();
  assert.equal(paid.spentUsd(), 0, "its booking failed: not on the ledger yet");
  assert.equal(lines.filter((line) => line.includes("browser_spend_unbooked")).length, 1, lines.join("\n"));
  // The next claim's reopen reads the root's charges and books the one the ledger lacks; a second reopen books nothing.
  const next = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, () => {}, { paid });
  await next.reopened(reopenOf(root), DOCS, BACKGROUND_CONTEXT);
  await next.ledgerIdle();
  assert.equal(pico(paid.spentUsd()), 0.01, "booked by the reopen");
  await next.reopened(reopenOf(root), DOCS, BACKGROUND_CONTEXT);
  await next.ledgerIdle();
  assert.equal(pico(paid.spentUsd()), 0.01, "once");
});

/** pi 1.5's end for a Session that closed normally: `failed` with "session closed" (session/session.js closeEnds). */
const SESSION_CLOSED = () => ({ kind: "failed", error: new Error("session closed") });

test("an observer end with a Session that failed, or a listener error, is logged once, never silently uncounted, whatever words pi's end carries; what was booked stays booked", async (t) => {
  const FAILED = { kind: "failed", error: new Error("the disk is gone") };
  for (const [end, closedAs] of [[{ kind: "listener_error", error: new Error("a listener threw") }, undefined], [FAILED, FAILED], [SESSION_CLOSED(), FAILED]]) {
    const paid = await ledgerFor(t, 5);
    const lines = [];
    const pi = piObserver();
    const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => lines.push(line), { paid });
    spend.watch(pi.harness);
    pi.publish(chargeOf("ar-1", 0.01));
    pi.end(end);
    if (closedAs) pi.closeAs(closedAs);
    await new Promise((resolve) => setImmediate(resolve));
    await spend.ledgerIdle();
    const said = `${end.kind} ${end.error?.message ?? ""}, the Session ${closedAs?.kind ?? "open"}`;
    assert.equal(lines.filter((line) => line.includes("browser_spend_uncounted")).length, 1, `${said}: ${lines.join("\n")}`);
    assert.equal(paid.spentUsd(), 0.01, `${said}: the charge booked before it stays booked`);
  }
});

test("an observer end with a Session that closed normally (pi's `closed`) keeps the count, silently, whatever words pi's end carries", async (t) => {
  const paid = await ledgerFor(t, 5);
  const lines = [];
  const pi = piObserver();
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => {}, (line) => lines.push(line), { paid });
  spend.watch(pi.harness);
  pi.publish(chargeOf("ar-1", 0.01));
  pi.end(SESSION_CLOSED());
  pi.closeAs({ kind: "closed" });
  await new Promise((resolve) => setImmediate(resolve));
  await spend.ledgerIdle();
  assert.equal(paid.spentUsd(), 0.01, "the count stands");
  assert.deepEqual(lines, [], "no line");
  assert.equal("closing" in spend, false, "no flag of our own: pi's end decides");
});

test("a real Harness: a charge booked, the Harness closed by the run's own close: the count stands, with no line", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  const paid = await ledgerFor(t, 5);
  const lines = [];
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, (line) => lines.push(line), { paid });
  spend.watch(harness);
  const charge = { conversationId: 1, tag: "ar-run-1", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 3, usd: 0.0001, final: true, state: "priced" };
  await harness.commit((tx) => spend.onCharge(charge, tx), ctx);
  await harness.close(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await spend.ledgerIdle();
  assert.equal(paid.spentUsd(), 0.0001, "the count stands after the close");
  assert.deepEqual(lines, [], "no line");
});

/** A real Harness over memory with one browser charge booked on the run's ledger: `storage` to fail it with. */
async function chargedHarness(t, lines) {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  const paid = await ledgerFor(t, 5);
  const storage = new durable.MemoryStorage();
  const harness = await durable.Harness.open(storage, { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, (line) => lines.push(line), { paid });
  spend.watch(harness);
  const charge = { conversationId: 1, tag: "ar-run-1", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 3, usd: 0.0001, final: true, state: "priced" };
  await harness.commit((tx) => spend.onCharge(charge, tx), ctx);
  await spend.ledgerIdle();
  return { ctx, durable, paid, spend, storage, harness, root };
}

test("a real Harness closed by a path that never says the run's close began (a drain without resume, a fence, pi closing it): its normal close keeps the count, with no line", async (t) => {
  const lines = [];
  const { ctx, paid, harness } = await chargedHarness(t, lines);
  await harness.close(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paid.spentUsd(), 0.0001, "the count stands after a normal close");
  assert.deepEqual(lines, [], "no line: nothing went uncounted");
});

test("a real Harness whose store fails: the Session's failed end is logged once, and what was booked stays booked", async (t) => {
  const lines = [];
  const { ctx, durable, paid, storage, harness, root } = await chargedHarness(t, lines);
  storage.commit = async () => { throw new Error("the disk is gone"); };
  await harness.commit(async (tx) => { (await tx.doc(durable.AgentDoc, root.id)).thinkingLevel = "high"; }, ctx).catch(() => undefined);
  assert.equal((await harness.closed).kind, "failed", "the Session failed");
  await new Promise((resolve) => setImmediate(resolve));
  // The run's one ledger is its own session: the root's store failing leaves the charge it booked as booked, never unknown.
  assert.equal(paid.spentUsd(), 0.0001, "the charge stays booked");
  assert.equal(lines.filter((line) => line.includes("browser_spend_uncounted")).length, 1, lines.join("\n"));
});

/** A run whose first process opened one browser session and ended without letting the run go (the session still live at
 *  the provider, as after a crash): `open()` starts its next process on the same store, booking on the run's one ledger
 *  `paid` (one RunTools here for both: the first process's reserve stays open on it, where a lost claim's would be given
 *  back, so the second's holds are read beside it). */
async function restarted(t) {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { openNodeSqliteStorage }, { createBrowserExtension }, { FakeBackend, fakeDriver, fixturePage }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"), import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const file = join(await scratch(t), "run.sqlite");
  const paid = await toolLedger(0.05);
  const backend = new FakeBackend({ name: "browserbase", start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  let claims = 0;
  /** One process of the run: its own extension, bookings and harness on the run's one store, and its own claim on the
   *  run's one ledger (its steps' ids its own, as each claim's are: every process numbers its holds from 1). */
  const open = async () => {
    const claim = `claim${(claims += 1)}:`;
    const mine = { admit: (request) => paid.admit({ ...request, id: claim + request.id }), settle: (id, usd, options) => paid.settle(claim + id, usd, options) };
    const spend = browserSpend("browserbase", BROWSERBASE, 1, async () => undefined, undefined, { paid: mine });
    const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null }, prices: { sessionUsdPerHour: 0.12, sessionMinimumS: 60 }, onCharge: spend.onCharge });
    const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
    model.setResponses([faux.fauxAssistantMessage([faux.fauxToolCall("snapshot", {})], { stopReason: "toolUse" }), faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" })]);
    const models = createModels();
    models.setProvider(model.provider);
    const registry = durable.createRegistry();
    registry.install({ ...browser.extension, tools: browser.extension.tools.map(spend.capped) });
    const harness = await durable.Harness.open(await openNodeSqliteStorage(file), { models, registry, onReport: () => {} }, ctx);
    spend.watch(harness);
    return { spend, browser, harness };
  };
  const first = await open();
  const policy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 600, batchTimeoutMs: 60_000 };
  const root = await first.harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(first.browser.docs.Config, id), { label: "run", run: "run-kept", policy }); } });
  await first.browser.reconcile(first.harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  // The process ends without letting the run go: the session stays live at the provider, as after a crash.
  await first.spend.ledgerIdle();
  await first.browser.close();
  await first.harness.close(ctx);
  assert.equal(backend.liveCount(), 1);
  return { ctx, backend, root, open, paid };
}

test("capped, a session kept across a restart of the run's process is held from the reopen and released an idle window after it, its charge booked", { timeout: 60_000 }, async (t) => {
  const { ctx, backend, root, open, paid } = await restarted(t);
  const second = await open();
  // Its idle window is 1 s from here, so the reopened run's session goes once that passes with no call.
  await second.harness.commit(async (tx) => { (await tx.doc(second.browser.docs.Config, root.id)).policy.idleReleaseS = 1; }, ctx);
  // The first process's holds would be gone with it; here they stay on the one ledger, so the second's are read beside them.
  const base = paid.heldUsd();
  await second.browser.reconcile(second.harness, () => true, ctx);
  await second.spend.reopened(second.harness, second.browser.docs, ctx);
  await second.spend.ledgerIdle();
  assert.ok(paid.heldUsd() - base >= second.spend.stretch, `held from the reopen: ${paid.heldUsd() - base}`);
  for (let i = 0; i < 200 && backend.liveCount() > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  await second.browser.drain(second.harness, ctx);
  assert.equal(backend.liveCount(), 0, "released an idle window after the reopen, with no call");
  const [record] = (await second.harness.snapshot(second.browser.docs.Sessions, root.id, ctx)).sessions;
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  await second.spend.ledgerIdle();
  assert.equal(pico(paid.spentUsd()), record.spent.usd, "the ledger booked the whole bill once: its first charge before the restart (the reopen books it nothing more), the rest at the release");
  assert.ok(Math.abs(paid.heldUsd() - base) < 1e-12, `its reserve let go with its release: ${paid.heldUsd() - base}`);
  await second.harness.close(ctx);
});

// After the restart test, for the same reason.
test("capped, a reopened run holds every session its custody still tracks, not only those reconcile kept: one it could not reach", { timeout: 60_000 }, async (t) => {
  const { ctx, backend, root, open, paid } = await restarted(t);
  const second = await open();
  const base = paid.heldUsd();
  // The provider does not answer the reopen's status check: the session stays tracked, live and billing, unreached.
  backend.fail("status", 1);
  const report = await second.browser.reconcile(second.harness, () => true, ctx);
  assert.equal(report.unreachable.length, 1, JSON.stringify(report));
  await second.spend.reopened(second.harness, second.browser.docs, ctx);
  await second.spend.ledgerIdle();
  assert.ok(paid.heldUsd() - base >= second.spend.stretch, `held from the reopen: ${paid.heldUsd() - base}`);
  await second.browser.release(await second.harness.conversation(root.id, ctx), "close", ctx);
  await second.browser.drain(second.harness, ctx);
  assert.equal(backend.liveCount(), 0);
  await second.spend.ledgerIdle();
  assert.ok(Math.abs(paid.heldUsd() - base) < 1e-12, `let go once its release is billed: ${paid.heldUsd() - base}`);
  await second.harness.close(ctx);
});

/** Every browser charge a run's journal holds, as written: on the runner, each on the root as BROWSER_CHARGED (its money
 *  the run's ledger step), read from the one store the server and the runner share (serve's own handle on it). */
const toolCosts = async (store, runId) => {
  const { entries } = await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT);
  return entries.filter((entry) => entry.kind === BROWSER_CHARGED && entry.data?.tool === "browser").map((entry) => entry.data);
};

/** The browser charges `booked` summed by the call each names, against the rows: each call's tool_use row carries what
 *  its charges came to as `usage`, and no other row carries any. */
function assertFolded(rows, booked) {
  assert.deepEqual(rows.filter((row) => /^Tool cost/.test(row.summary ?? "")).map((row) => row.summary), [], "no row of its own");
  const byCall = new Map();
  for (const charge of booked) byCall.set(charge.call, pico((byCall.get(charge.call) ?? 0) + charge.usd));
  const carrying = rows.filter((row) => row.kind !== "usage" && row.usage);
  assert.ok(carrying.every((row) => row.kind === "tool_use" && row.tool_name === "snapshot"), JSON.stringify(carrying));
  assert.deepEqual(new Map(carrying.map((row) => [row.tool_use_id, row.usage.usd])), byCall, "each browser call's row carries its own charges");
  for (const row of carrying) assert.equal(row.usage.requests, 0);
}

test("through the API: an uncapped run's browser minutes are its cost, folded into its browser calls' rows on its timeline, and /usage's browser_time meter in seconds and dollars", { timeout: 120_000 }, async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.deepEqual((await api("GET", "/capabilities")).body.features.usage.meters, ["tokens", "tools", "browser_time", "learning"]);
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page 3 times." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: Infinity });
  const booked = await toolCosts(store, started.body.run_id);
  assert.ok(booked.length >= 4, JSON.stringify(booked));
  assertFolded(rows, booked);
  // The release's charge is booked under the session's last call: it lands on the last browser call's row.
  const calls = rows.filter((row) => row.kind === "tool_use");
  assert.equal(booked.at(-1).final, true);
  assert.equal(booked.at(-1).call, calls.at(-1).tool_use_id);
  assert.ok(calls.at(-1).usage.usd > booked.find((charge) => charge.call === calls.at(-1).tool_use_id && !charge.final).usd, "its own charge and the release's");
  // Served the same way after the run, from its store.
  assertFolded((await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows, booked);
  // A session of well under a minute: its calls' charges and the release's top it up to the 60 s minimum, $0.002, booked before the run ended.
  assert.equal(Math.round(booked.reduce((sum, row) => sum + row.seconds, 0) * 1000) / 1000, 60);
  assert.equal(pico(booked.reduce((sum, row) => sum + row.usd, 0)), 0.002);
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.cost.usd, 0.002, "the faux model is free: the run's cost is its browser time");
  const usage = (await api("GET", "/usage?group_by=meter")).body;
  assert.deepEqual(usage.lines.map(({ meter, usd, quantity, unit }) => ({ meter, usd, quantity, unit })), [{ meter: "tokens", usd: 0, quantity: undefined, unit: undefined }, { meter: "browser_time", usd: 0.002, quantity: 60, unit: "second" }]);
  assert.equal(usage.total_usd, 0.002);
  // The run's own lines (GET /runs/{id}/usage): its browser time by provider, in raw seconds and dollars.
  const own = (await api("GET", `/runs/${started.body.run_id}/usage`)).body;
  assert.deepEqual(own.lines.filter((line) => line.meter === "browser_time"), [{ meter: "browser_time", model: null, provider: "browserbase", charged_by: null, quantity: 60, unit: "second", basis: "estimate", attempt: 1, billable: true, usd: 0.002 }]);
  assert.deepEqual(own.total, { usd: 0.002 });
  // And its one session: the provider's id for it, when this server opened and let it go, the seconds charged for it (the
  // line's), and no provider record, since this provider keeps none (not_offered), never one of zeros.
  assert.equal(own.browser_sessions.length, 1, JSON.stringify(own.browser_sessions));
  const [session] = own.browser_sessions;
  assert.equal(session.provider, "browserbase");
  assert.equal(typeof session.provider_session_id, "string");
  assert.ok(Date.parse(session.ended_at) >= Date.parse(session.started_at), JSON.stringify(session));
  assert.equal(session.release_reason, "close");
  assert.equal(session.charged_seconds, 60);
  assert.deepEqual([session.provider_record, session.provider_record_status], [null, "not_offered"]);
});

test("through the API, live: each browser call's row carries its charge as it runs, /usage reads it as browser time, and the release's charge after the answer is an update of the last call's row, never a row of its own", { timeout: 120_000 }, async (t) => {
  // The calls' charges are what their sessions ran, a few milliseconds here: at the list price ($0.12 an hour) two of
  // them can come to less than half a micro-dollar, which the run's cost rounds to $0, and /usage then has no meters to
  // split. At $36 an hour every millisecond is $0.00001, so what the live run has spent is never rounded away.
  withEnv(t, { ...KEYS, [PRICE_ENV]: "36" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER", PRICE_ENV]);
  const gate = join(await scratch(t), "gate");
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-browse-gated.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: `Browse the example page 2 times, then answer once ${gate} exists.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The model waits on the gate with the session open: both calls ran and were charged, the release not yet.
  const view = new Map();
  let after = 0;
  const served = [];
  const read = async () => {
    const { status, body: page } = await api("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "500" })}`);
    assert.equal(status, 200, JSON.stringify(page));
    if (page.reset) view.clear();
    for (const row of page.rows) (view.set(row.id, row), served.push(row));
    after = page.next_after;
    return page;
  };
  const calls = () => [...view.values()].filter((row) => row.kind === "tool_use");
  for (const deadline = Date.now() + 60_000; !(calls().length === 2 && calls().every((row) => row.usage)); ) {
    assert.ok(Date.now() < deadline, JSON.stringify([...view.values()].map((row) => [row.kind, row.summary, row.usage])));
    await read();
  }
  const last = calls().at(-1);
  const before = last.usage.usd;
  // The run's process holds its store while it runs: the rows are what can be read of it now.
  assert.ok(calls().every((row) => row.usage.usd > 0 && row.usage.requests === 0), JSON.stringify(calls()));
  assert.deepEqual([...view.values()].filter((row) => /^Tool cost/.test(row.summary ?? "")), [], "no row of its own");
  // /usage reads a live run from its rows: the folded charges are its browser time, never another tool's.
  const lines = (await api("GET", "/usage?group_by=meter")).body.lines;
  assert.equal(lines.find((line) => line.meter === "browser_time")?.usd, Math.round(calls().reduce((sum, row) => sum + row.usage.usd, 0) * 1e6) / 1e6, JSON.stringify(lines));
  assert.equal(lines.find((line) => line.meter === "tools"), undefined, JSON.stringify(lines));
  // The answer, then the run is let go and its session released: that charge changes the last call's row, by its id.
  await writeFile(gate, "");
  const { rows, pages } = await follow(api, runId, ["completed"], { after, deadlineMs: Infinity });
  const updates = pages.flatMap((page) => page.rows).filter((row) => row.id === last.id);
  assert.ok(updates.length >= 1, "the follow saw the last call's row again");
  assert.ok(updates.at(-1).usage.usd > before, JSON.stringify([before, updates.map((row) => row.usage)]));
  assert.ok(!pages.some((page) => page.reset), "no reset: an update of the row it had");
  assert.ok(!pages.flatMap((page) => page.rows).some((row) => /^Tool cost/.test(row.summary ?? "")), "no row of its own");
  const booked = await toolCosts(store, runId);
  assert.equal(booked.at(-1).final, true);
  assertFolded([...new Map([...view.values(), ...rows].map((row) => [row.id, row])).values()], booked);
  // One session of well under a minute, topped up to Browserbase's 60 s minimum: $0.60 at $36 an hour.
  assert.equal(pico(booked.reduce((sum, charge) => sum + charge.usd, 0)), 0.6);
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.6, "the run's cost counts each charge once");
});

test("through the API: a capped run whose next browser call would pass its cap is refused before it in the cap's words, its session released and its booked spend within the cap", { timeout: 120_000 }, async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("capped", { tools: ["browser"] }))).status, 201);
  // The first call holds $0.018 (two stretches of 270 s at $0.12 an hour); the second would hold that again beside the
  // session's $0.009 reserve, past $0.02.
  const started = await api("POST", "/agents/capped/runs", { input: { content: "Browse the example page 3 times." }, max_cost_usd: 0.02 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // Refused for room, the run pauses at its cap (paid-pause.test.mjs), in the call's words: no answer echoes them now.
  await follow(api, started.body.run_id, ["input_required", "completed", "failed"], { deadlineMs: Infinity });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.deepEqual([view.status, view.state, view.pending?.kind], ["input_required", "waiting", "budget"], JSON.stringify(view));
  assert.match(view.pending.said, /^Not sent: this run has spent (?:\$[\d.]+|less than a cent)( and holds \$[\d.]+ for steps still running,)? of its \$0\.02 cap, and the next step, this browser call, could cost up to \$0\.018\d* \(.*\)\. Raise the cap to at least \$0\.03 to continue\.$/);
  // Paused, its process lets go of the browser session as it lets go of the run: the release's booking lands then, not
  // at the pause, and the store is that process's until it has. Read until it is in, up to 30 s.
  let booked = [];
  for (const deadline = Date.now() + 30_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    try {
      booked = await toolCosts(store, started.body.run_id);
    } catch (error) {
      if (!/database is locked/.test(error.message)) throw error;
    }
    if (pico(booked.reduce((sum, row) => sum + row.usd, 0)) >= 0.002 || Date.now() > deadline) break;
  }
  assert.ok(booked.length >= 1 && booked.every((row) => row.tool === "browser"), JSON.stringify(booked));
  assert.equal(pico(booked.reduce((sum, row) => sum + row.usd, 0)), 0.002, "one session, released at its one-minute minimum");
  assert.ok(view.cost.usd <= 0.02, `the run's cost ${view.cost.usd} is within its cap`);
});

test("through the API: a provider with no price books its time as an unknown cost, counted unpriced on browser_time with its seconds, never as $0 or under tools", { timeout: 120_000 }, async (t) => {
  withEnv(t, { ...KEYS, FAUX_BROWSER_PROVIDER: "steel" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("unpriced", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/unpriced/runs", { input: { content: "Browse the example page 2 times." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: Infinity });
  const booked = await toolCosts(store, started.body.run_id);
  assert.ok(booked.length >= 2 && booked.every((row) => row.usd === null && row.charged_by === "steel"), JSON.stringify(booked));
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.cost.usd, null, "its cost is unknown");
  const lines = (await api("GET", "/usage?group_by=meter")).body.lines;
  const browser = lines.find((line) => line.meter === "browser_time");
  assert.ok(browser, JSON.stringify(lines));
  assert.deepEqual([browser.usd, browser.unpriced_runs, browser.unit], [0, 1, "second"]);
  assert.ok(browser.quantity > 0, "its seconds");
  assert.equal(lines.find((line) => line.meter === "tools"), undefined, "no other tool charged anything");
  // The run's own lines: its seconds on steel, its dollars unknown, never $0; the total unknown with it.
  const own = (await api("GET", `/runs/${started.body.run_id}/usage`)).body;
  const steel = own.lines.find((line) => line.meter === "browser_time");
  assert.deepEqual([steel.provider, steel.usd, steel.basis, steel.unit], ["steel", null, "unpriced", "second"], JSON.stringify(own.lines));
  assert.ok(steel.quantity > 0, "its seconds");
  assert.equal(own.total.usd, null);
});

test("through the API: a browser call counts once among the run's paid tool calls, its release's charge included: one call is 1, two are 2", { timeout: 120_000 }, async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  for (const [times, said] of [[1, "1 paid tool call"], [2, "2 paid tool calls"]]) {
    const started = await api("POST", "/agents/browse/runs", { input: { content: `Browse the example page ${times} times.` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: Infinity });
    const booked = await toolCosts(store, started.body.run_id);
    // Each call's own charge, and the release's under the last call: one charge more than calls, never a call more.
    assert.equal(booked.length, times + 1, JSON.stringify(booked));
    assert.equal(new Set(booked.map((charge) => charge.call)).size, times);
    const usage = rows.find((row) => row.kind === "usage");
    assert.ok(usage.summary.endsWith(` and ${said}`), usage.summary);
    assert.deepEqual(usage.usage, { usd: 0.002, requests: times + 1 }, "the charges still count in full: the session's 60 s minimum");
  }
});

test("a run that mixes browser and monid charges, as serve books them, reads from its rows as booked: $0.0448 in all, $0.0018 browser time, $0.003 monid's, each charge once", async () => {
  const [{ timelineOf, TOOL_COST }, { costOf, knownToolCostOf, toolCostOf }] = await Promise.all([import("../dist/timeline/index.js"), import("../dist/run-view.js")]);
  let id = 1;
  const at = (s) => Date.UTC(2026, 10, 5, 12, 0, s);
  // Each model request costs $0.01; four of them.
  const answer = (content, s) => ({ kind: "pi.assistant", id: id++, conversationId: 1, model: [{ role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", usage: { input: 10, output: 5, cost: { total: 0.01 } }, timestamp: at(s) }] });
  const callOf = (callId, name, args = {}) => ({ type: "toolCall", id: callId, name, arguments: args });
  const resultOf = (callId, name, text, s) => ({ kind: "pi.tool-result", id: id++, conversationId: 1, model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: at(s) }] });
  // browser-cost.ts's Booked, and a monid endpoint's settle (paid-calls.ts paidStep): the TOOL_COSTs serve writes on the root.
  const browser = (usd, call, final = false) => ({ kind: TOOL_COST, id: id++, conversationId: 1, data: { tool: "browser", charged_by: "browserbase", call, usd, seconds: final ? 48 : 3, tag: "run-1-s1", conversation: 1, at: new Date(at(0)).toISOString(), final } });
  const monid = (usd, call) => ({ kind: TOOL_COST, id: id++, conversationId: 1, data: { tool: "monid:faux/company", charged_by: "monid", call, usd } });
  const rows = timelineOf([
    answer([callOf("b1", "snapshot")], 1), browser(0.0001, "b1"), resultOf("b1", "snapshot", "[1-1] page", 2),
    answer([callOf("m1", "monid__faux__company", { body: { name: "Acme" } })], 3), monid(0.003, "m1"), resultOf("m1", "monid__faux__company", "{\"ok\":true}", 4),
    answer([callOf("b2", "browser_read", { what: "markdown" })], 5), browser(0.0001, "b2"), resultOf("b2", "browser_read", "url: https://example.test/\n---\nbody", 6),
    answer([{ type: "text", text: "Done." }], 7), browser(0.0016, "b2", true),
  ], { settled: true });
  assert.equal(costOf(rows), 0.0448, "$0.04 of requests and $0.0048 of charges");
  assert.equal(rows.at(-1).summary, "Cost so far: $0.0448 over 4 model requests and 3 paid tool calls", "b1, monid and b2: three calls, the release under b2 adding a charge, never a call");
  assert.equal(pico(toolCostOf(rows)), 0.0048);
  assert.equal(pico(toolCostOf(rows, "browser")), 0.0018, "the browser's rows: /usage's browser_time");
  assert.equal(pico(toolCostOf(rows, "browser", true)), 0.003, "every other tool's: /usage's tools");
  assert.deepEqual([pico(knownToolCostOf(rows, "browser")), pico(knownToolCostOf(rows, "browser", true))], [0.0018, 0.003]);
  assert.deepEqual(rows.filter((row) => /^Tool cost/.test(row.summary ?? "")).map((row) => [row.summary, row.usage.usd]), [["Tool cost: monid charged $0.0030 for monid:faux/company", 0.003]], "monid's own row; no browser Tool cost row");
  assert.deepEqual(rows.filter((row) => row.kind === "tool_use" && row.usage).map((row) => [row.tool_name, row.usage.usd]), [["snapshot", 0.0001], ["browser_read", 0.0017]]);
});

test("a kept session's non-final charge books a person's carried minutes off the session, not twice off the live call's hold", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const paid = await toolLedger(1);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined, undefined, { paid });
  spend.watch(harness);
  const base = 0;
  /** What the run's ledger holds, its steps all written. */
  const paidHolds = () => paid.heldUsd();
  const S = spend.stretch;
  const r = 0.12 / 3600;
  const microUsd = (usd) => Math.ceil(Math.round(usd * 1e12) / 1e6) / 1e6;
  const tag = "ar-run-booked-a";
  const charge = (seconds, usd, final, at) => ({ conversationId: 1, tag, provider: "browserbase", at: new Date(at).toISOString(), seconds, usd, final, state: "priced" });
  // The session's first charge at T0: its reserve held, its last charge now T0.
  await harness.commit((tx) => spend.onCharge(charge(0, 0, false, T0), tx), ctx);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base - S) < 1e-12, "the reserve alone");
  // A person had the session for its first minute (T0..T0+60 s), given back: $0.002 carried.
  t.mock.timers.tick(60_000);
  spend.carry(tag, 60);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base - (S + 60 * r)) < 1e-12, "the reserve and the carried minute");
  // At T0+100 s the agent's browser call holds ranS - carried + two stretches = 40 s + 2 stretches.
  t.mock.timers.tick(40_000);
  let seen;
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    // A non-final charge computed through T0+120 s bills the whole 120 s (r*120), of which the carried minute (r*60) is a
    // person's. The call's hold left that carried minute out, so the charge must take only r*60 off the call's hold, not
    // the whole r*120 (which would cut what the call still holds a second time).
    t.mock.timers.tick(20_000);
    await harness.commit((tx) => spend.onCharge(charge(120, 120 * r, false, T0 + 120_000), tx, { callId: "c1" }), ctx);
    await spend.ledgerIdle();
    seen = paidHolds() - base;
    return { content: [{ type: "text", text: "ran" }] };
  } });
  const api = { conversationId: 1, callId: "c1", commit: async (change) => harness.commit(change, ctx) };
  await tool.execute({}, api, ctx);
  // The call still runs. The run's ledger never trims a call's hold-only step while it runs (the browser's take() is its
  // own figure): the call holds all it was admitted at, 40 s and two stretches, beside the session's one-stretch reserve,
  // and the carried minute is booked and dropped. So nothing comes off the call's hold twice (the bug took the whole
  // r*120 off it, leaving 2S - 80 s); the charge itself is booked once, r*120.
  const expected = microUsd(40 * r + 2 * S) + S;
  assert.ok(Math.abs(seen - expected) < 1e-9, `the call's whole hold beside the reserve (${expected}), never 2S - 80 s (${microUsd(40 * r + 2 * S) - 120 * r + S}): ${seen}`);
  assert.ok(Math.abs(paid.spentUsd() - 120 * r) < 1e-12, `the charge booked once: ${paid.spentUsd()}`);
  // The call returns, its hold let go; the release books the rest.
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base - S) < 1e-12, "the reserve alone once the call returns, the carried minute booked");
  await harness.commit((tx) => spend.onCharge(charge(0, 0, true, T0 + 120_000), tx, { callId: "c1" }), ctx);
  await spend.ledgerIdle();
  assert.ok(Math.abs(paidHolds() - base) < 1e-12, "nothing left held");
  assert.ok(Math.abs(paid.spentUsd() - 120 * r) < 1e-12, "each charge booked once");
});
