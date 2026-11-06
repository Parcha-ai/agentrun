// Browser minutes in the run's spend: each charge of a session's time is booked as a TOOL_COST in the commit that bills
// it, and under a cap the time is held before it runs (browser-cost.ts). The first tests run pi-browser's own meter
// in this process on node's mock Date, so every bill is exact; the last ones go through the API with the faux browser.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_PRICES, browserPrice, browserSpend, priceEnvOf } from "../dist/browser-cost.js";
import { paidHolds, useSpend } from "../dist/cap.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const START = "https://example.test/start";
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const BROWSERBASE = { usdPerHour: 0.12, minimumS: 60 };
const KEYS = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
/** The operator's Browserbase price, in USD an hour (browser-cost.ts BROWSER_PRICE_ENV). */
const PRICE_ENV = priceEnvOf("browserbase");

/** A pi run in this process whose model calls browser_read `reads` times, thinking `thinkS` between calls, each read
 *  taking `readS`, on a `provider` browser at `price`, under `cap` (none: no cap). `seen()` runs at every moment the
 *  run can spend: inside each call, before each model turn and after the release. */
async function run(t, { provider = "browserbase", price = BROWSERBASE, reads, readS = 3, thinkS = 20, cap, idleS = 180, end = "close", setup = () => {}, pump = false, options = {}, lastTurn = () => {}, after = async () => {}, cutRelease = false, seen = () => {} }) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { FakeBackend, fakeDriver, fixturePage }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  let spent = 0;
  useSpend(cap === undefined ? undefined : { cap, spent: () => spent, add: (usd) => void (spent = spent === null || usd === null ? null : spent + usd) });
  t.after(() => useSpend(undefined));
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
  const spend = browserSpend(provider, price, idleS, async (conversation, context) => { releases.push(conversation.id); await browser.release(conversation, "close", context); await browser.drain(harness, context); });
  const browser = createBrowserExtension({ ...options,
    provider: () => (cutRelease ? cutting : backend.provider), driver: fakeDriver(backend), evidence: { file: async () => null },
    prices: { sessionUsdPerHour: price.usdPerHour, sessionMinimumS: price.minimumS }, onCharge: spend.onCharge,
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); t.mock.timers.tick(readS * 1000); seen("call", spent); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const extension = { ...browser.extension, tools: browser.extension.tools.map(spend.capped) };
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: reads + 1 }, () => (context) => {
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length > 0) t.mock.timers.tick(thinkS * 1000);
    if (results.length >= reads) lastTurn(backend);
    seen("turn", spent);
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
  await after({ browser, harness, backend, ctx });
  seen("released", spent);
  const [record] = await sessions();
  const entries = (await harness.commit((tx) => tx.scanEntries({ conversationId: durable.ROOT_CONVERSATION_ID, order: "ascending" }, 500), ctx)).items;
  const booked = entries.filter((entry) => entry.kind === "agentrun.tool_cost").map((entry) => entry.data);
  const results = entries.map((entry) => JSON.stringify(entry)).filter((text) => text.includes("spend_cap_reached"));
  return { record, booked, spent, releases, results, backend, stretch: spend.stretch };
}

const pico = (usd) => Math.round(usd * 1e12) / 1e12;
const total = (booked) => pico(booked.reduce((sum, row) => sum + row.usd, 0));

test("uncapped: every charge is booked under its call, idle time between calls included, and the release's last; nothing is refused", async (t) => {
  const { record, booked, releases } = await run(t, { reads: 3 });
  // 3 s, then 20 s thought and a 3 s read twice, then the last answer's 20 s and 5 s to the release: 74 s past the minimum.
  assert.deepEqual(booked.map((row) => [row.tool, row.charged_by, row.seconds]), [["browser", "browserbase", 3], ["browser", "browserbase", 23], ["browser", "browserbase", 23], ["browser", "browserbase", 25]]);
  assert.ok(booked.every((row) => typeof row.call === "string"), "the release's charge goes under the session's last call");
  assert.equal(booked[3].call, booked[2].call);
  assert.deepEqual([record.spent.seconds, record.spent.final], [74, true]);
  assert.equal(total(booked), record.spent.usd, "booked is what the session's record bills");
  assert.ok(Math.abs(record.spent.usd - 74 * 0.12 / 3600) < 1e-11, String(record.spent.usd));
  assert.deepEqual(releases, [], "nothing refused");
  assert.equal(paidHolds(), 0, "no hold is left");
});

test("capped: what the run spent plus what it holds never passes the cap; the call that would cross it is refused in the cap's words and the session is released", async (t) => {
  const cap = 0.028;
  const moments = [];
  const { record, booked, spent, releases, results, backend, stretch } = await run(t, { reads: 4, cap, seen: (at, spent) => moments.push([at, spent + paidHolds()]) });
  assert.equal(stretch, 270 * 0.12 / 3600, "the next stretch: its 60 s minimum, the 180 s idle window and 30 s for its release");
  // Each moment the run could spend: inside each call, at each model turn and after the release.
  assert.ok(moments.length >= 6, JSON.stringify(moments));
  for (const [at, held] of moments) assert.ok(held <= cap, `${at}: ${held} is over the cap of ${cap}`);
  // Two calls fit: $0.018 held for the first, then the session's $0.009 reserve beside the second's $0.018 and the 20 s it
  // ran since. The third does not, and is refused before it runs.
  const refusal = results.find((text) => text.includes("spend_cap_reached"));
  // One sentence, the call named mid-sentence in lower case: what the run spent and holds of its cap, what the call could
  // cost and why, and the cap that would run it.
  assert.match(refusal, /spend_cap_reached: Not sent: this run has spent \$0 and holds \$0\.01 for steps still running, of its \$0\.028 cap, and the next step, this browser call, could cost up to \$0\.018667 \(browserbase's session time at \$0\.12 an hour: the 20 s its session ran since its last charge, and twice the next stretch of 270 s \(its 60 s minimum, the 180 s idle window and 30 s for its release\)\)\. Raise the cap to at least \$0\.03 to continue\./);
  assert.equal(releases.length, 1, "its session was released");
  assert.deepEqual([backend.tally().creates, backend.tally().releases, backend.liveCount()], [1, 1, 0]);
  // 3 s, 23 s, and at the refusal 20 s more, topped up to the minute.
  assert.deepEqual(booked.map((row) => row.seconds), [3, 23, 34]);
  assert.deepEqual([record.spent.seconds, record.spent.usd], [60, 0.002]);
  assert.equal(total(booked), 0.002);
  assert.ok(Math.abs(spent - 0.002) < 1e-12 && spent <= cap, `the run's process counted ${spent}`);
  assert.equal(paidHolds(), 0, "every hold is let go once the release is booked");
});

test("capped, a session pi-browser releases itself once the run stops calling: its release's charge is booked from the reserve held for it", async (t) => {
  const cap = 0.01;
  const moments = [];
  const { record, booked, releases, stretch } = await run(t, { reads: 1, idleS: 1, end: "idle", cap, seen: (at, spent) => moments.push([at, spent + paidHolds()]) });
  assert.equal(stretch, 91 * 0.12 / 3600, "its 60 s minimum, a 1 s idle window and 30 s for its release");
  for (const [at, held] of moments) assert.ok(held <= cap, `${at}: ${held} is over the cap of ${cap}`);
  assert.deepEqual([record.state, record.spent.final, releases], ["released", true, []], "released by its idle window, not by a refusal");
  // 3 s at the call; the last answer's 20 s and 5 s more, topped up to the minute at the idle release.
  assert.deepEqual(booked.map((row) => row.seconds), [3, 57]);
  assert.equal(total(booked), 0.002);
  assert.equal(paidHolds(), 0);
});

test("capped, a session whose release the provider never confirms ends lost: billed what it ran and its minimum, and its reserve is let go", { timeout: 90_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const cap = 0.03;
  const { record, booked } = await run(t, { reads: 1, cap, pump: true, setup: (backend) => backend.fail("release", RELEASE_ATTEMPTS) });
  assert.equal(record.state, "lost");
  assert.equal(booked.length, 2, JSON.stringify(booked));
  assert.ok(booked[0].seconds === 3 && booked[1].seconds >= 57, "the call's 3 s, then what it ran until custody gave up, at least the rest of its minute");
  assert.deepEqual([record.spent.final, total(booked)], [true, record.spent.usd]);
  assert.equal(paidHolds(), 0, "no stretch is left held for a session custody no longer tracks as open");
});

test("capped, a create whose answer is lost and whose session no lookup finds yet: its delayed release is held until it is billed", async (t) => {
  const cap = 0.1;
  const moments = [];
  const { record, booked } = await run(t, { reads: 1, cap, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); }, seen: (at, spent) => moments.push([at, spent, paidHolds()]) });
  // The call failed with the session left to a release after the create deadline: the next turn still holds it, the
  // deadline and a stretch at Browserbase's price.
  const [, spentThen, heldThen] = moments.filter(([at]) => at === "turn")[1];
  assert.equal(spentThen, 0, "nothing billed yet");
  assert.ok(Math.abs(heldThen - (60 + 270) * 0.12 / 3600) < 1e-9, `held for its delayed release: ${heldThen}`);
  for (const [at, spent, held] of moments) assert.ok(spent + held <= cap, `${at}: ${spent + held}`);
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => row.seconds), [60], "found by its tag and billed its minimum");
  assert.equal(paidHolds(), 0, "let go once billed");
});

test("capped, a session found by its tag stays billed when its release retries: the next attempt's lookup no longer finds the stopped session", { timeout: 60_000 }, async (t) => {
  const { CONFIRM_POLLS } = await import("@parcha/pi-browser/durable");
  const cap = 0.1;
  // The create's answer is lost and its first lookup fails: the session is left to a release after the create deadline.
  // That release finds it by its tag and stops it, but its confirm gets no answer through every poll, so the release is
  // tried again, and the provider's tag lookup no longer lists the stopped session. The clock moves as real time does.
  const { record, booked } = await run(t, { reads: 1, cap, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); backend.fail("status", CONFIRM_POLLS); } });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]], "one charge, its minimum at list price");
  assert.equal(paidHolds(), 0, "its hold let go once billed");
});

test("capped, a session found by its tag whose release stops it and then fails is billed on the next attempt, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { record, booked } = await run(t, { reads: 1, cap: 0.1, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); }, lastTurn: (backend) => backend.lose("release") });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(paidHolds(), 0, "its hold let go once billed");
});

test("capped, a lost session known only by its tag, stopped by a reopen's release that then fails, is billed by the next reconcile, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const { record, booked } = await run(t, { reads: 1, cap: 0.1, pump: 5, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1 + RELEASE_ATTEMPTS); },
    after: async ({ browser, harness, backend, ctx }) => {
      assert.ok(paidHolds() > 0, "the lost session is still held: it may be running");
      backend.lose("release");
      assert.equal((await browser.reconcile(harness, () => true, ctx)).unreachable.length, 1);
      assert.equal((await browser.reconcile(harness, () => true, ctx)).released.length, 1);
    } });
  assert.deepEqual([record.state, record.spent.final], ["lost", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(paidHolds(), 0, "its hold let go once billed");
});

test("capped, a session found by its tag whose release attempt is aborted between its stop and its next checkpoint is billed by the abort handler, and its hold let go", { timeout: 60_000 }, async (t) => {
  const { record, booked } = await run(t, { reads: 1, cap: 0.1, pump: 5, cutRelease: true, options: { createDeadlineMs: 50 }, setup: (backend) => { backend.lose("create"); backend.fail("findByTag", 1); } });
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.deepEqual(booked.map((row) => [row.seconds, row.usd]), [[60, 0.002]]);
  assert.equal(paidHolds(), 0, "its hold let go once billed");
});

test("a charge joins the run's spend and moves its holds only once the commit that books it is in: one that fails leaves neither", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, durable, { createModels }] = await Promise.all([import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-ai/models")]);
  let spent = 0;
  useSpend({ cap: 1, spent: () => spent, add: (usd) => void (spent += usd) });
  t.after(() => useSpend(undefined));
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models: createModels(), registry: durable.createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async () => undefined);
  spend.watch(harness);
  const charge = { conversationId: 1, tag: "ar-run-1", provider: "browserbase", at: new Date(T0).toISOString(), seconds: 3, usd: 0.0001, final: false, state: "priced" };
  await assert.rejects(harness.commit(async (tx) => { await spend.onCharge(charge, tx); throw new Error("the commit fails after the charge"); }, ctx));
  assert.deepEqual([spent, paidHolds()], [0, 0], "nothing booked: no spend counted, no reserve held");
  await harness.commit((tx) => spend.onCharge(charge, tx), ctx);
  assert.deepEqual([spent, paidHolds()], [0.0001, spend.stretch], "booked: its spend counted, and its session's reserve held");
  await harness.commit((tx) => spend.onCharge({ ...charge, seconds: 57, usd: 0.0019, final: true }, tx), ctx);
  assert.deepEqual([Math.round(spent * 1e12) / 1e12, paidHolds()], [0.002, 0]);
});

test("prices by provider: Browserbase, Kernel and local Chrome, each overridden by its own variable; one unknown or unreadable has none", async (t) => {
  assert.deepEqual(BROWSER_PRICES, { browserbase: { usdPerHour: 0.12, minimumS: 60 }, kernel: { usdPerHour: 0.06, minimumS: 0 }, cdp: { usdPerHour: 0, minimumS: 0 } });
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
  // A provider with no price: uncapped, its time is booked as an unknown cost; capped, every call is refused, saying how to price it.
  const unknown = await run(t, { provider: "steel", price: browserPrice("steel", {}), reads: 1 });
  assert.deepEqual(unknown.booked.map((row) => row.usd), [null, null]);
  t.mock.timers.reset();
  const refused = await run(t, { provider: "steel", price: browserPrice("steel", {}), reads: 1, cap: 5 });
  assert.match(refused.results.join("\n"), /spend_cap_reached: This browser call was not sent\. steel's session time has no price here \(AGENTRUN_BROWSER_USD_PER_HOUR_STEEL gives one\), so the run's cap of \$5 cannot be kept/);
  assert.deepEqual([refused.booked, refused.backend.tally().creates], [[], 0]);
});

test("after a reopen, a kept session's down time is held once: its first call fits where its true exposure does; a session already billed is not held", async (t) => {
  // 15 min down at Browserbase's price ($0.03), with $0.02 spent under a $0.10 cap: the kept session holds a stretch and its
  // down time ($0.039), the call two stretches ($0.018); $0.077 fits. Holding the down time on the call too ($0.048) would not.
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 900_000 });
  const cap = 0.1;
  let spent = 0.02;
  useSpend({ cap, spent: () => spent, add: (usd) => void (spent += usd) });
  t.after(() => useSpend(undefined));
  const base = paidHolds();
  const releases = [];
  const spend = browserSpend("browserbase", BROWSERBASE, 180, async (conversation) => void releases.push(conversation.id));
  let listener;
  spend.watch({ subscribeCommits: (fn) => (listener = fn) });
  const docs = { Inventory: "inventory", Sessions: "sessions" };
  const store = (final) => ({ snapshot: async (token) => (token === "inventory" ? { rows: { k: { tag: "ar-kept", conversationId: 1 } } } : { sessions: [{ tag: "ar-kept", spent: { chargedThrough: new Date(T0).toISOString(), ...(final ? { final: true } : {}) } }] }) });
  // A session whose final charge landed before `kept` read it: nothing to hold, and nothing would ever drop the hold.
  await spend.reopened(store(true), docs, undefined);
  assert.equal(paidHolds(), base, "an already billed session is not held");
  await spend.reopened(store(false), docs, undefined);
  assert.ok(Math.abs(paidHolds() - base - 0.039) < 1e-9, `the kept session: a stretch and its down time, ${paidHolds() - base}`);
  const held = [];
  const tool = spend.capped({ name: "snapshot", execute: async () => {
    held.push(spent + paidHolds() - base);
    t.mock.timers.tick(3_000);
    // Its charge at the call's end: the down time and the call's 3 s, booked once its commit is in.
    const entries = [];
    await spend.onCharge({ conversationId: 1, tag: "ar-kept", provider: "browserbase", at: new Date(Date.now()).toISOString(), seconds: 903, usd: 903 * 0.12 / 3600, final: false, state: "priced" }, { appendEntry: async (_, entry) => void entries.push(entry) }, { callId: "c1" });
    listener({ seq: 1, changes: entries.map((value) => ({ type: "entry", value })) });
    held.push(spent + paidHolds() - base);
    return { content: [{ type: "text", text: "seen" }] };
  } });
  const out = await tool.execute({}, { conversationId: 1, callId: "c1", commit: async () => undefined }, undefined);
  assert.ok(!JSON.stringify(out).includes("spend_cap_reached"), JSON.stringify(out));
  assert.deepEqual(releases, [], "the kept session was not released");
  assert.ok(Math.abs(held[0] - 0.077) < 1e-6, `spent and held as the call runs: ${held[0]}`);
  for (const figure of [...held, spent + paidHolds() - base]) assert.ok(figure <= cap, `${figure} is over the cap of ${cap}`);
  assert.ok(Math.abs(paidHolds() - base - 0.009) < 1e-9, "after its charge the session holds one stretch again");
});

// Last of this process's runs: its first process's reserve stays in this process's holds (a real one would be gone).
/** A run whose first process opened one browser session and ended without letting the run go (the session still live at
 *  the provider, as after a crash): `open()` starts its next process on the same store. */
async function restarted(t) {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { openNodeSqliteStorage }, { createBrowserExtension }, { FakeBackend, fakeDriver, fixturePage }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"), import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const file = join(await scratch(t), "run.sqlite");
  let spent = 0;
  useSpend({ cap: 0.05, spent: () => spent, add: (usd) => void (spent += usd) });
  t.after(() => useSpend(undefined));
  const backend = new FakeBackend({ name: "browserbase", start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  /** One process of the run: its own extension, bookings and harness on the run's one store. */
  const open = async () => {
    const spend = browserSpend("browserbase", BROWSERBASE, 1, async () => undefined);
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
  await first.browser.close();
  await first.harness.close(ctx);
  assert.equal(backend.liveCount(), 1);
  return { ctx, backend, root, open, spent: () => spent };
}

test("capped, a session kept across a restart of the run's process is held from the reopen and released an idle window after it, its charge booked", { timeout: 60_000 }, async (t) => {
  const { ctx, backend, root, open, spent: spentNow } = await restarted(t);
  const second = await open();
  // Its idle window is 1 s from here, so the reopened run's session goes once that passes with no call.
  await second.harness.commit(async (tx) => { (await tx.doc(second.browser.docs.Config, root.id)).policy.idleReleaseS = 1; }, ctx);
  // The first process's holds would be gone with it; here they stay in this one, so the second's are read beside them.
  const base = paidHolds();
  await second.browser.reconcile(second.harness, () => true, ctx);
  await second.spend.reopened(second.harness, second.browser.docs, ctx);
  assert.ok(paidHolds() - base >= second.spend.stretch, `held from the reopen: ${paidHolds() - base}`);
  for (let i = 0; i < 200 && backend.liveCount() > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  await second.browser.drain(second.harness, ctx);
  assert.equal(backend.liveCount(), 0, "released an idle window after the reopen, with no call");
  const [record] = (await second.harness.snapshot(second.browser.docs.Sessions, root.id, ctx)).sessions;
  assert.deepEqual([record.state, record.spent.final], ["released", true]);
  assert.equal(Math.round(spentNow() * 1e12) / 1e12, record.spent.usd, "the process counted the whole bill: its first charge before the restart, the rest at the release");
  assert.equal(paidHolds(), base, "its reserve let go with its release");
  await second.harness.close(ctx);
});

// After the restart test, for the same reason.
test("capped, a reopened run holds every session its custody still tracks, not only those reconcile kept: one it could not reach", { timeout: 60_000 }, async (t) => {
  const { ctx, backend, root, open } = await restarted(t);
  const second = await open();
  const base = paidHolds();
  // The provider does not answer the reopen's status check: the session stays tracked, live and billing, unreached.
  backend.fail("status", 1);
  const report = await second.browser.reconcile(second.harness, () => true, ctx);
  assert.equal(report.unreachable.length, 1, JSON.stringify(report));
  await second.spend.reopened(second.harness, second.browser.docs, ctx);
  assert.ok(paidHolds() - base >= second.spend.stretch, `held from the reopen: ${paidHolds() - base}`);
  await second.browser.release(await second.harness.conversation(root.id, ctx), "close", ctx);
  await second.browser.drain(second.harness, ctx);
  assert.equal(backend.liveCount(), 0);
  assert.equal(paidHolds(), base, "let go once its release is billed");
  await second.harness.close(ctx);
});

/** Every TOOL_COST in a run's store, as written. */
const toolCosts = (data, runId) => {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === "agentrun.tool_cost").map((entry) => entry.data);
  } finally {
    db.close();
  }
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

test("through the API: an uncapped run's browser minutes are its cost, folded into its browser calls' rows on its timeline, and /usage's browser_time meter in seconds and dollars", async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.deepEqual((await api("GET", "/capabilities")).body.features.usage.meters, ["tokens", "tools", "browser_time", "learning"]);
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page 3 times." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  const booked = toolCosts(data, started.body.run_id);
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
});

test("through the API, live: each browser call's row carries its charge as it runs, /usage reads it as browser time, and the release's charge after the answer is an update of the last call's row, never a row of its own", { timeout: 120_000 }, async (t) => {
  // The calls' charges are what their sessions ran, a few milliseconds here: at the list price ($0.12 an hour) two of
  // them can come to less than half a micro-dollar, which the run's cost rounds to $0, and /usage then has no meters to
  // split. At $36 an hour every millisecond is $0.00001, so what the live run has spent is never rounded away.
  withEnv(t, { ...KEYS, [PRICE_ENV]: "36" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER", PRICE_ENV]);
  const gate = join(await scratch(t), "gate");
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-browse-gated.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/browse/runs", { input: { content: `Browse the example page 2 times, then answer once ${gate} exists.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The model waits on the gate with the session open: both calls ran and were charged, the release not yet.
  const view = new Map();
  let after = 0;
  const served = [];
  const read = async () => {
    const { status, body: page } = await api.fresh("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "500" })}`);
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
  const { rows, pages } = await follow(api, runId, ["completed"], { after });
  const updates = pages.flatMap((page) => page.rows).filter((row) => row.id === last.id);
  assert.ok(updates.length >= 1, "the follow saw the last call's row again");
  assert.ok(updates.at(-1).usage.usd > before, JSON.stringify([before, updates.map((row) => row.usage)]));
  assert.ok(!pages.some((page) => page.reset), "no reset: an update of the row it had");
  assert.ok(!pages.flatMap((page) => page.rows).some((row) => /^Tool cost/.test(row.summary ?? "")), "no row of its own");
  const booked = toolCosts(data, runId);
  assert.equal(booked.at(-1).final, true);
  assertFolded([...new Map([...view.values(), ...rows].map((row) => [row.id, row])).values()], booked);
  // One session of well under a minute, topped up to Browserbase's 60 s minimum: $0.60 at $36 an hour.
  assert.equal(pico(booked.reduce((sum, charge) => sum + charge.usd, 0)), 0.6);
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.6, "the run's cost counts each charge once");
});

test("through the API: a capped run whose next browser call would pass its cap is refused before it in the cap's words, its session released and its booked spend within the cap", async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("capped", { tools: ["browser"] }))).status, 201);
  // The first call holds $0.018 (two stretches of 270 s at $0.12 an hour); the second would hold that again beside the
  // session's $0.009 reserve, past $0.02.
  const started = await api("POST", "/agents/capped/runs", { input: { content: "Browse the example page 3 times." }, max_cost_usd: 0.02 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // Refused for room, the run pauses at its cap (paid-pause.test.mjs), in the call's words: no answer echoes them now.
  await follow(api, started.body.run_id, ["input_required", "completed", "failed"]);
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.deepEqual([view.status, view.state, view.pending?.kind], ["input_required", "waiting", "budget"], JSON.stringify(view));
  assert.match(view.pending.said, /^Not sent: this run has spent \$[\d.]+( and holds \$[\d.]+ for steps still running,)? of its \$0\.02 cap, and the next step, this browser call, could cost up to \$0\.018\d* \(.*\)\. Raise the cap to at least \$0\.03 to continue\.$/);
  // Paused, its process lets go of the browser session as it lets go of the run: the release's booking lands then, not
  // at the pause, and the store is that process's until it has. Read until it is in, up to 30 s.
  let booked = [];
  for (const deadline = Date.now() + 30_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    try {
      booked = toolCosts(data, started.body.run_id);
    } catch (error) {
      if (!/database is locked/.test(error.message)) throw error;
    }
    if (pico(booked.reduce((sum, row) => sum + row.usd, 0)) >= 0.002 || Date.now() > deadline) break;
  }
  assert.ok(booked.length >= 1 && booked.every((row) => row.tool === "browser"), JSON.stringify(booked));
  assert.equal(pico(booked.reduce((sum, row) => sum + row.usd, 0)), 0.002, "one session, released at its one-minute minimum");
  assert.ok(view.cost.usd <= 0.02, `the run's cost ${view.cost.usd} is within its cap`);
});

test("through the API: a provider with no price books its time as an unknown cost, counted unpriced on browser_time with its seconds, never as $0 or under tools", async (t) => {
  withEnv(t, { ...KEYS, FAUX_BROWSER_PROVIDER: "steel" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("unpriced", { tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/unpriced/runs", { input: { content: "Browse the example page 2 times." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  const booked = toolCosts(data, started.body.run_id);
  assert.ok(booked.length >= 2 && booked.every((row) => row.usd === null && row.charged_by === "steel"), JSON.stringify(booked));
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.cost.usd, null, "its cost is unknown");
  const lines = (await api("GET", "/usage?group_by=meter")).body.lines;
  const browser = lines.find((line) => line.meter === "browser_time");
  assert.ok(browser, JSON.stringify(lines));
  assert.deepEqual([browser.usd, browser.unpriced_runs, browser.unit], [0, 1, "second"]);
  assert.ok(browser.quantity > 0, "its seconds");
  assert.equal(lines.find((line) => line.meter === "tools"), undefined, "no other tool charged anything");
});

test("through the API: a browser call counts once among the run's paid tool calls, its release's charge included: one call is 1, two are 2", { timeout: 120_000 }, async (t) => {
  withEnv(t, KEYS, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "FAUX_BROWSER_PROVIDER"]);
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname, fauxBrowser: new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("browse", { tools: ["browser"] }))).status, 201);
  for (const [times, said] of [[1, "1 paid tool call"], [2, "2 paid tool calls"]]) {
    const started = await api("POST", "/agents/browse/runs", { input: { content: `Browse the example page ${times} times.` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"]);
    const booked = toolCosts(data, started.body.run_id);
    // Each call's own charge, and the release's under the last call: one charge more than calls, never a call more.
    assert.equal(booked.length, times + 1, JSON.stringify(booked));
    assert.equal(new Set(booked.map((charge) => charge.call)).size, times);
    const usage = rows.find((row) => row.kind === "usage");
    assert.ok(usage.summary.endsWith(` and ${said}`), usage.summary);
    assert.deepEqual(usage.usage, { usd: 0.002, requests: times + 1 }, "the charges still count in full: the session's 60 s minimum");
  }
});
