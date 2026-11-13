// A provider of one fixed session (caps.fixedSession, a host's own session it hands the run) under custody: browser_relaunch
// is refused before anything is released, and the session goes on serving the next call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const PAGE = { url: START, title: "Account", text: "Signed in as the owner. Invoices: 3", html: "<html><body><h1>Account</h1><p>Invoices: 3</p></body></html>" };
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };
const text = (message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

test("browser_relaunch on a fixed session is refused before anything is released, and the session goes on serving", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE }, caps: { fixedSession: true } });
  const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) } });
  const calls = [["snapshot", {}], ["browser_relaunch", {}], ["snapshot", {}]];
  let seen = [];
  let releasedDuringCalls = null;
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: calls.length + 1 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    seen = results.map((message) => ({ tool: message.toolName, isError: message.isError === true, text: text(message) }));
    const next = calls[results.length];
    if (!next) releasedDuringCalls = backend.tally().releases;
    return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${results.length}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "node-a", run: "run-fixed", policy: POLICY }); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.deepEqual(seen.map((r) => r.tool), calls.map(([name]) => name));
  assert.equal(seen[1].isError, true, "the relaunch is refused");
  assert.match(seen[1].text, /"code":"refused"/);
  assert.match(seen[1].text, /unchanged/);
  assert.equal(seen[2].isError, false, "the next call still browses the same session");
  assert.match(seen[2].text, /Invoices: 3/);
  assert.equal(releasedDuringCalls, 0, "nothing was released while the task browsed");
  assert.equal(backend.tally().creates, 1, "and nothing else was launched");
});
