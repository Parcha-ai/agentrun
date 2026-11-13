// A tool call whose args fail the tool's schema is refused by pi-durable before the tool runs. That refusal is built by
// pi-durable, not by the adapter's execute wrapper (whose results go through forModel, see durable_model_sees_output), so
// this holds the other path: on every pi-durable the peers accept, the model is still shown why its call was refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const PAGE = { url: START, title: "Start", text: "Hello", html: "<html><body><p>Hello</p></body></html>" };
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };

/** What the model is shown for a tool result: the transcript the faux model receives, not a value the adapter returned. */
const shown = (message) => ({ tool: message.toolName, isError: message.isError === true, text: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("") });

test("a call whose args fail the schema is refused before the tool runs, and the model is shown why", async (t) => {
  const evidence = { file: async () => ({ path: "evidence/browser.md", bodyLine: 1 }) };
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence });
  const ran = [];
  for (const tool of browser.tools) {
    const execute = tool.execute;
    tool.execute = async (...args) => { ran.push(tool.name); return execute.apply(tool, args); };
  }
  // The first call's clip is not an object, so the schema refuses it; the second passes the schema (neither code nor actions)
  // and the tool refuses it, typed.
  const calls = [["screenshot", { clip: "the top" }], ["run", {}]];
  let seen = [];
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: calls.length + 1 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    seen = results.map(shown);
    const next = calls[results.length];
    return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${results.length}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "node-a", run: "run-args", policy: POLICY }); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.deepEqual(seen.map((r) => r.tool), ["screenshot", "run"], "the model got one result for each call");
  assert.deepEqual(ran, ["run"], "the call that failed the schema never reached the tool");
  assert.equal(seen[0].isError, true, "the schema refusal is an error");
  assert.ok(seen[0].text.trim().length > 0, "the schema refusal reached the model with no text");
  assert.match(seen[0].text, /\bclip\b/, "the model is told which argument was wrong");
  assert.equal(seen[1].isError, true);
  assert.match(seen[1].text, /"code":"refused"/, "a call the schema passes is refused by the tool, as its typed envelope");
});
