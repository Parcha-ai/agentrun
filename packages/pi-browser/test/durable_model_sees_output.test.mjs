import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBrowserExtension, createWebExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";

const START = "https://example.test/start";
const PAGE = { url: START, title: "Filing", text: "Menu Home Acme Corp file number 7741234 Footer", html: "<html><body><nav>Menu Home</nav><article><h1>Acme Corp</h1><p>File number <b>7741234</b></p></article></body></html>" };
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 };

/** What the model is shown for each tool result: its text, and whether it carries an image. A pi-durable that reads a result's `output` shows nothing
 *  for a result that carries only `content`, so the test reads the transcript the faux model receives, not the adapter's return value. */
const shown = (message) => ({ text: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(""), images: (message.content ?? []).filter((part) => part.type === "image").length });

test("every durable tool result reaches the model with its text: browser, web, site and failure results", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const evidence = { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) };
  const requestId = randomUUID();
  const listing = [{ site: "shop", title: "The shop", description: "Prices." }];
  const sites = { port: { list: async () => listing, use: async () => ({ report: "The 8 GB board costs $80." }) }, listing };
  const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence, sites });
  const web = createWebExtension({
    providers: {
      name: "fake",
      fetch: async ({ url }) => ({ finalUrl: url, statusCode: 200, contentType: "text/markdown", content: "# Fetched\n\nBody text" }),
      search: async () => ({ results: [{ url: "https://found.example/1", title: "Found" }] }),
    },
    evidence,
  });
  // The result each tool hands to pi-durable, whichever version CI installs: only 1.2 reads `output`, so the transcript the model reads cannot catch its removal on 1.1.
  const returned = [];
  for (const tool of [...browser.tools, ...web.tools]) {
    const execute = tool.execute;
    tool.execute = async (...args) => { const result = await execute.apply(tool, args); returned.push({ tool: tool.name, content: result.content, output: result.output }); return result; };
  }
  const calls = [
    ["snapshot", {}], ["run", { code: "await page.click('a')" }], ["screenshot", {}], ["browser_read", {}],
    ["run", {}],
    ["web_fetch", { url: "https://s.example/a" }], ["web_search", { query: "acme" }],
    ["use_website", { site: "shop", request_id: requestId, instructions: "Find the price." }],
    ["browser_release", {}],
  ];
  let seen = [];
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: calls.length + 1 }, () => (context) => {
    const results = context.messages.filter((message) => message.role === "toolResult");
    seen = results.map((message) => ({ tool: message.toolName, isError: message.isError === true, ...shown(message) }));
    const next = calls[results.length];
    return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${results.length}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  registry.install(web.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), { label: "node-a", run: "run-output", policy: POLICY }); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

  assert.deepEqual(seen.map((r) => r.tool), calls.map(([name]) => name), "the model got one result for each call");
  for (const r of seen) assert.ok(r.text.trim().length > 0, `${r.tool} reached the model with no text`);
  assert.deepEqual(returned.map((r) => r.tool), calls.map(([name]) => name), "every call went through a wrapped tool");
  for (const r of returned) {
    assert.ok(Array.isArray(r.output) && r.output.length > 0, `${r.tool} returned no output for pi-durable 1.2`);
    assert.deepEqual(r.output, r.content, `${r.tool}: output is the text the model is shown`);
  }
  assert.equal(seen[2].images, 1, "the screenshot keeps its image");
  assert.deepEqual(seen.map((r) => r.isError), [false, false, false, false, true, false, false, false, false], "only the run with neither code nor actions is a failure");
  assert.match(seen[4].text, /"code":"refused"/, "a typed failure is its envelope, as the model reads it");
  assert.match(seen[7].text, /The 8 GB board costs \$80\./);
});
