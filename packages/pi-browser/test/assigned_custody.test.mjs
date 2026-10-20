// An assigned session under custody (providers/assigned.ts through durable.ts): browser_relaunch is refused before
// anything is released, the session goes on serving the next call, and a conversation's release lets go of its hold
// without handing the session back, so the next conversation browses it. The host takes it back itself, once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { assignedSessionProvider } from "@parcha/pi-browser/providers/assigned";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const PAGE = { url: START, title: "Account", text: "Signed in as the owner. Invoices: 3", html: "<html><body><h1>Account</h1><p>Invoices: 3</p></body></html>" };
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };
const text = (message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

test("browser_relaunch on an assigned session is refused before anything is released, and the session goes on serving", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const handedBack = [];
  const session = {
    id: made.id,
    attach: () => backend.provider.attach(made),
    status: async () => (handedBack.length ? "stopped" : "running"),
    release: async () => { handedBack.push(Date.now()); },
    failure: () => null,
  };
  const browser = createBrowserExtension({ provider: () => assignedSessionProvider({ name: "host-site", session }), driver: fakeDriver(backend), evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) } });
  const calls = [["snapshot", {}], ["browser_relaunch", {}], ["snapshot", {}]];
  let seen = [];
  let releasedDuringCalls = null;
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: calls.length + 1 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    seen = results.map((message) => ({ tool: message.toolName, isError: message.isError === true, text: text(message) }));
    const next = calls[results.length];
    if (!next) releasedDuringCalls = handedBack.length;
    return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${results.length}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "node-a", run: "run-assigned", policy: POLICY }); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.deepEqual(seen.map((r) => r.tool), calls.map(([name]) => name));
  assert.equal(seen[1].isError, true, "the relaunch is refused");
  assert.match(seen[1].text, /"code":"refused"/);
  assert.match(seen[1].text, /unchanged/);
  assert.equal(seen[2].isError, false, "the next call still browses the assigned session");
  assert.match(seen[2].text, /Invoices: 3/);
  assert.equal(releasedDuringCalls, 0, "nothing was handed back while the task browsed");
});

test("two conversations in turn: the first's plane is released at its end, the second browses the same session, and the host is never asked to take it back", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  let handedBack = 0;
  const session = { id: made.id, attach: () => backend.provider.attach(made), status: async () => "running", release: async () => { handedBack += 1; }, failure: () => null };
  const provider = assignedSessionProvider({ name: "host-site", session });
  const browser = createBrowserExtension({ provider: () => provider, driver: fakeDriver(backend), evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) } });
  const seen = [];
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (!results.length) return fauxAssistantMessage([fauxToolCall("snapshot", {}, { id: "call-0" })], { stopReason: "toolUse" });
    seen.push({ isError: results[0].isError === true, text: text(results[0]) });
    return fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const agent = { model: { provider: "faux", modelId: "faux-1" } };
  const init = (label) => async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label, run: "run-assigned", policy: POLICY }); };
  await browser.reconcile(harness, () => true, ctx);
  const first = await harness.root(ctx, { agent, init: init("node-a") });
  await (await first.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await browser.release(first, "close", ctx);
  for (const end = Date.now() + 4000; Object.values((await harness.snapshot(browser.docs.Inventory, ctx))?.rows ?? {}).some((row) => row.state === "releasing"); ) {
    if (Date.now() > end) throw new Error("the first conversation's release never settled");
    await new Promise((r) => setTimeout(r, 20));
  }
  const second = await harness.createConversation({ ownership: { kind: "ownerless" }, agent, init: init("node-b") }, ctx);
  await (await second.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].isError, false);
  assert.equal(seen[1].isError, false, `the second conversation browses the same session: ${seen[1].text}`);
  assert.match(seen[1].text, /Invoices: 3/);
  assert.equal(handedBack, 0, "letting go of a hold never hands the task's only browser back");
});

test("with the provider made per call (the factory form), a second conversation's browse while the first holds the session is refused: the run still has one browser", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const session = { id: made.id, attach: () => backend.provider.attach(made), status: async () => "running", release: async () => undefined, failure: () => null };
  let providers = 0;
  // A new provider at every call: the durable adapter asks its factory at every create and every later use.
  const browser = createBrowserExtension({ provider: () => { providers += 1; return assignedSessionProvider({ name: "host-site", session }); }, driver: fakeDriver(backend), evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) } });
  const seen = [];
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (!results.length) return fauxAssistantMessage([fauxToolCall("snapshot", {}, { id: "call-0" })], { stopReason: "toolUse" });
    seen.push({ isError: results[0].isError === true, text: text(results[0]) });
    return fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const agent = { model: { provider: "faux", modelId: "faux-1" } };
  const init = (label) => async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label, run: "run-assigned", policy: POLICY }); };
  await browser.reconcile(harness, () => true, ctx);
  const first = await harness.root(ctx, { agent, init: init("node-a") });
  await (await first.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const second = await harness.createConversation({ ownership: { kind: "ownerless" }, agent, init: init("node-b") }, ctx);
  await (await second.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.ok(providers > 1, "the factory made more than one provider");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].isError, false, `the first conversation browses: ${seen[0].text}`);
  assert.equal(seen[1].isError, true, "the second conversation's create is refused while the first holds the session");
  assert.match(seen[1].text, /"code":"refused"/);
  assert.match(seen[1].text, /one browser/);
});
