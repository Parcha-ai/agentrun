import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

// A release by a session's tag that ends sessions besides the session's own (a create race of the tag left one running,
// which no record bills): the host hears their ids (`onRaceReleased`), once each release answered, and never the
// session's own, which its record bills. A host whose hook throws never fails the release.

const START = "https://example.test/start";

async function run(t, onRaceReleased) {
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  // Each create of a tag also leaves a second session under it, which nobody's answer names.
  const left = [];
  const provider = {
    ...backend.provider,
    async create(spec, signal) {
      const made = await backend.provider.create(spec, signal);
      left.push((await backend.provider.create(spec, signal)).id);
      return made;
    },
  };
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null }, onRaceReleased,
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    if (context.messages.some((m) => m.role === "toolResult")) return faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
    return faux.fauxAssistantMessage([faux.fauxToolCall("browser_read", {})], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(async () => { await harness.close(ctx).catch(() => undefined); await browser.close(); });
  const config = { label: "node-a", run: "run-race", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await browser.release(root, "close", ctx);
  await browser.drain(harness, ctx);
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  return { record, left, backend, rootId: root.id };
}

test("a release by the session's tag that ends a session a create race left: the host hears that one's id, once, and never the session's own", async (t) => {
  const heard = [];
  const { record, left, backend, rootId } = await run(t, (released) => { heard.push(released); });
  assert.equal(record.state, "released");
  assert.equal(left.length, 1);
  assert.equal(backend.sessions.get(left[0]).state, "stopped", "the release by its tag ended it");
  assert.deepEqual(heard, [{ conversationId: rootId, tag: record.tag, ids: [left[0]] }]);
});

test("a host whose onRaceReleased throws never fails the release: the session's record ends released and both sessions end", async (t) => {
  let calls = 0;
  const { record, left, backend } = await run(t, () => { calls += 1; throw new Error("the host could not book it"); });
  assert.equal(calls, 1);
  assert.equal(record.state, "released");
  assert.equal(backend.sessions.get(record.resourceId).state, "stopped");
  assert.equal(backend.sessions.get(left[0]).state, "stopped");
});
