import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { localSites } from "@parcha/pi-browser";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { scratchSync } from "./fixtures/scratch.mjs";

const START = "https://shop.example.test/";
const PAGE = { url: START, title: "Shop", text: "Raspberry Pi 5 8GB costs $80", html: "<html><body><h1>Shop</h1><p>Raspberry Pi 5 8GB costs $80</p></body></html>" };
const CONFIG = { label: "node-a", run: "run-sites", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const toolUse = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${randomUUID().slice(0, 8)}` })], { stopReason: "toolUse" });

function script(requestIds, { childTurn } = {}) {
  const seen = { child: 0, parent: 0 };
  const respond = async (context, options) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const last = context.messages.at(-1);
    if (asked.includes(`Start at ${START}`)) {
      seen.child += 1;
      await childTurn?.(seen.child, options?.signal);
      return last.role === "toolResult" ? fauxAssistantMessage([fauxText("The 8 GB board costs $80.")], { stopReason: "stop" }) : toolUse("snapshot", {});
    }
    seen.parent += 1;
    const answered = context.messages.filter((message) => message.role === "toolResult").length;
    return answered < requestIds.length
      ? toolUse("use_website", { site: "shop", request_id: requestIds[answered], instructions: "Find the price of the 8 GB board." })
      : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  };
  return { seen, responses: () => Array.from({ length: 40 }, () => respond) };
}

async function open(storage, backend, responses) {
  const sites = localSites({ shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START } });
  const browser = createBrowserExtension({
    provider: () => backend.provider, driver: fakeDriver(backend),
    evidence: { file: async (label, record) => ({ path: `evidence/${label}/${record.tool}.md`, bodyLine: 1 }) },
    sites: { port: sites, listing: await sites.list(new AbortController().signal) },
  });
  const model = fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(responses);
  const models = createModels();
  models.setProvider(model.provider);
  const registry = createRegistry();
  registry.install(browser.extension);
  const harness = await Harness.open(storage, { models, registry }, ctx);
  await browser.reconcile(harness, () => true, ctx);
  return { harness, browser };
}

async function results(root) {
  return [...(await root.entries({}, 200, undefined, ctx)).items].reverse().filter((entry) => entry.kind === "pi.tool-result").map((entry) => entry.model[0]).filter((message) => message.toolName === "use_website").map((message) => JSON.parse(textOf(message)));
}

test("use_website runs the site's task in a child conversation that has the browser tools and no use_website, answers its report, and releases its browser", async (t) => {
  const requestId = randomUUID();
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { seen, responses } = script([requestId]);
  const { harness, browser } = await open(new MemoryStorage(), backend, responses());
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } });
  await (await root.submit({ type: "input", content: "What does the shop charge for the 8 GB board?" }, ctx)).wait(ctx);

  assert.deepEqual(await results(root), [{ ok: true, site: "shop", request_id: requestId, report: "The 8 GB board costs $80." }]);
  assert.deepEqual(seen, { child: 2, parent: 2 });
  const children = await harness.snapshot(browser.docs.Children, root.id, ctx);
  const childId = children.byRequest[`shop:${requestId}`];
  assert.ok(Number.isInteger(childId) && childId !== root.id);
  const childTools = (await (await harness.conversation(childId, ctx)).agent(ctx)).tools.map((tool) => tool.name);
  assert.ok(childTools.includes("snapshot") && childTools.includes("run"), childTools.join());
  assert.equal(childTools.includes("use_website"), false, "a child cannot start children of its own");
  assert.ok((await root.agent(ctx)).tools.some((tool) => tool.name === "use_website"));
  for (let i = 0; i < 200 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  const childSessions = await harness.snapshot(browser.docs.Sessions, childId, ctx);
  assert.deepEqual(childSessions.sessions.map((session) => session.state), ["released"], "the child's browser is released when its report is in");
  assert.deepEqual([backend.tally().creates, backend.tally().releases], [1, 1]);
});

test("a second use_website call with the same request_id answers the first report and starts no second child", async (t) => {
  const requestId = randomUUID();
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const { seen, responses } = script([requestId, requestId]);
  const { harness, browser } = await open(new MemoryStorage(), backend, responses());
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } });
  await (await root.submit({ type: "input", content: "Price, twice." }, ctx)).wait(ctx);
  const answers = await results(root);
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[1], answers[0]);
  assert.equal(seen.child, 2, "the child ran once");
  assert.deepEqual(Object.keys((await harness.snapshot(browser.docs.Children, root.id, ctx)).byRequest), [`shop:${requestId}`]);
  assert.equal(backend.tally().creates, 1);
});

test("after a crash mid-child, the replayed use_website re-awaits the same child conversation instead of starting another", async (t) => {
  const requestId = randomUUID();
  const dir = scratchSync(t, "use-website-crash-");
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  let crash;
  const crashed = new Promise((resolve) => { crash = resolve; });
  const first = script([requestId], { childTurn: async (turn, signal) => {
    if (turn !== 2) return;
    crash();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("the process died")), { once: true }));
  } });
  const one = await open(await openNodeJsonlStorage(dir, ctx), backend, first.responses());
  const root = await one.harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(one.browser.docs.Config, id), CONFIG); } });
  root.submit({ type: "input", content: "What does the shop charge?" }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  await crashed;
  const childBefore = (await one.harness.snapshot(one.browser.docs.Children, root.id, ctx)).byRequest[`shop:${requestId}`];
  await one.harness.close(ctx);
  await one.browser.close();

  const second = script([requestId]);
  const two = await open(await openNodeJsonlStorage(dir, ctx), backend, second.responses());
  t.after(() => two.harness.close(ctx));
  two.harness.resume();
  const again = await two.harness.root(ctx);
  for (let i = 0; i < 400 && (await results(again)).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await results(again), [{ ok: true, site: "shop", request_id: requestId, report: "The 8 GB board costs $80." }]);
  assert.deepEqual((await two.harness.snapshot(two.browser.docs.Children, again.id, ctx)).byRequest, { [`shop:${requestId}`]: childBefore }, "the same child, no second one");
});
