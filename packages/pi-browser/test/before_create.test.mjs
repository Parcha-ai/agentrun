import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

// A host's barrier before the vendor's session exists (`beforeCreate`): it runs once the session's record is in the store
// (state `creating`, its tag, in the inventory), and before the provider's create; one that throws sends nothing.

const START = "https://example.test/start";

async function run(t, beforeCreate) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const order = [];
  const provider = { ...backend.provider, async create(spec, signal) { order.push(["create", spec.tag]); return backend.provider.create(spec, signal); } };
  let docs;
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null },
    beforeCreate: (open) => beforeCreate(open, order, docs),
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  docs = browser.docs;
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
  const config = { label: "node-a", run: "run-barrier", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  return { order, results, record, tally: backend.tally() };
}

test("beforeCreate runs once the session's creating record is in the store, and before the provider's create: record, barrier, create", async (t) => {
  const { order, results, record } = await run(t, async (open, order, docs) => {
    // What the store holds as the barrier runs: the record, creating, under the tag the provider will be given.
    // Read inside the commit: a document read in a commit is that commit's, never used once it has settled.
    const seen = await open.commit(async (tx) => {
      const last = (await tx.doc(docs.Sessions, open.conversationId)).sessions.at(-1);
      return last ? { state: last.state, tag: last.tag } : undefined;
    });
    order.push(["barrier", open.tag, seen?.state, seen?.tag]);
  });
  assert.equal(results[0]?.isError, false, JSON.stringify(results[0]));
  assert.deepEqual(order, [["barrier", record.tag, "creating", record.tag], ["create", record.tag]]);
  assert.equal(record.state, "live");
});

test("a beforeCreate that throws creates nothing at the provider: the record ends released, and the call fails", async (t) => {
  const { order, results, record, tally } = await run(t, async (open, order) => {
    order.push(["barrier", open.tag]);
    throw new Error("the store could not be synced");
  });
  assert.deepEqual(order, [["barrier", record.tag]], "no create after a barrier that failed");
  assert.equal(tally.creates, 0);
  assert.equal(results[0]?.isError, true);
  assert.deepEqual([record.state, record.releaseReason, record.resourceId], ["released", "create_failed", null]);
});
