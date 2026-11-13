import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

// A create the provider refuses (401, 403) made nothing, so its record ends released at once. Any other failed create may
// still land at the provider, so its release keeps waiting out the create deadline.

const START = "https://example.test/start";
const DEADLINE_MS = 60_000;

/** An error shaped as the provider SDK's: the HTTP status on the error itself. */
const httpError = (status) => Object.assign(new Error(`${status} from the provider`), { status });

async function run(t, createError) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const calls = { create: 0, findByTag: 0 };
  const provider = {
    ...backend.provider,
    async create() { calls.create += 1; throw createError; },
    async findByTag() { calls.findByTag += 1; throw createError; },
  };
  const changes = [];
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null }, createDeadlineMs: DEADLINE_MS,
    onSession: (row, change) => { changes.push([row.session.tag, change]); },
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const results = [];
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    const answered = context.messages.filter((m) => m.role === "toolResult");
    if (answered.length) { results.push(answered.at(-1)); return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" }); }
    return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const config = { label: "node-a", run: "run-refused", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const releaseTasks = (await harness.commit((tx) => tx.scanTasks({}, 50), ctx)).items.filter((task) => task.kind === "browser.release");
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  const rows = (await harness.snapshot(browser.docs.Inventory, ctx))?.rows ?? {};
  return { browser, harness, calls, changes, results, releaseTasks, record, rows };
}

for (const status of [401, 403]) {
  test(`a create the provider refuses with ${status} ends its record released at once: no delayed release, no lookup by tag, nothing left in the inventory`, async (t) => {
    const { browser, harness, calls, changes, results, releaseTasks, record, rows } = await run(t, httpError(status));
    assert.equal(calls.create, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
    assert.equal(JSON.parse(results[0].content[0].text).code, "auth", "the call fails with the provider's refusal");
    assert.deepEqual(releaseTasks, [], "no release task waits out the create deadline");
    assert.deepEqual([record.state, record.releaseReason, record.resourceId], ["released", "create_failed", null]);
    assert.deepEqual(rows, {}, "the inventory holds no row for it");
    assert.equal(calls.findByTag, 0, "a refusal is not looked up by tag: the same key would be refused again");
    assert.deepEqual(changes, [[record.tag, "released"]], "the host hears the release once, as for any create_failed record");
    const started = Date.now();
    await browser.drain(harness, ctx);
    assert.ok(Date.now() - started < 5_000, "the drain does not wait for the create deadline");
  });
}

test("a create that fails with a 500 keeps the delayed release: its record waits out the create deadline for a session that may still land", async (t) => {
  const before = Date.now();
  const { calls, results, releaseTasks, record, rows } = await run(t, httpError(500));
  assert.equal(results[0].isError, true);
  assert.notEqual(JSON.parse(results[0].content[0].text).code, "auth");
  assert.equal(calls.findByTag, 1, "the lost answer is looked up by tag");
  assert.deepEqual([record.state, record.releaseReason], ["releasing", "create_failed"]);
  assert.equal(releaseTasks.length, 1);
  const { notBefore } = releaseTasks[0].input;
  assert.ok(notBefore >= before + DEADLINE_MS, `the release waits for the create deadline: notBefore ${notBefore}, ran at ${before}`);
  assert.deepEqual(Object.values(rows).map((row) => [row.tag, row.state]), [[record.tag, "releasing"]], "the row stays until the delayed release confirms");
});
