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
const NEWS = "https://news.example.test/";
const SITES = { shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START }, news: { title: "The news", description: "Today's headlines.", startUrl: NEWS } };
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

async function open(storage, backend, responses, sites = localSites({ shop: SITES.shop })) {
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

// Forced race: each call waits here until `n` calls are in flight, or `ms` passes; it answers whether all `n` met.
function rendezvous(n, ms = 2_000) {
  let arrived = 0;
  let open;
  const met = new Promise((resolve) => { open = resolve; });
  return () => {
    arrived += 1;
    if (arrived === n) open(true);
    return Promise.race([met, new Promise((resolve) => setTimeout(resolve, ms, false).unref())]);
  };
}

/** The parent asks every `calls` entry in one turn; a child snapshots once, then reports the site it started at. */
function fanout(calls, { childTurn } = {}) {
  const turns = new Map();
  const respond = async (context, options) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const site = Object.values(SITES).find((entry) => asked.includes(`Start at ${entry.startUrl}`));
    if (site) {
      const turn = (turns.get(site.startUrl) ?? 0) + 1;
      turns.set(site.startUrl, turn);
      await childTurn?.(site.startUrl, turn, options?.signal);
      return context.messages.at(-1).role === "toolResult" ? fauxAssistantMessage([fauxText(`Read ${site.startUrl}`)], { stopReason: "stop" }) : toolUse("snapshot", {});
    }
    return context.messages.some((message) => message.role === "toolResult")
      ? fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })
      : fauxAssistantMessage(calls.map((call, i) => fauxToolCall("use_website", { site: call.site, request_id: call.requestId, instructions: "Read the start page." }, { id: `call-${i}-${randomUUID().slice(0, 8)}` })), { stopReason: "toolUse" });
  };
  return { turns, responses: () => Array.from({ length: 40 }, () => respond) };
}

/** A port that counts how many of its calls overlap; `run` answers one call. */
function overlapping(run, n) {
  const meet = rendezvous(n);
  const port = { overlapped: [], list: async () => Object.entries(SITES).map(([site, entry]) => ({ site, title: entry.title, description: entry.description })) };
  port.use = async (input, ctx) => { port.overlapped.push(await meet()); return run(input, ctx); };
  return port;
}

const backendFor = () => new FakeBackend({ start: START, pages: { [START]: PAGE, [NEWS]: { url: NEWS, title: "News", text: "Headlines", html: "<html><body><h1>News</h1></body></html>" } } });
const settle = async (harness) => { for (let i = 0; i < 200 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25)); };

test("two use_website calls in one turn run at once, and each child is recorded in the children doc with no lost write", async (t) => {
  const calls = [{ site: "shop", requestId: randomUUID() }, { site: "news", requestId: randomUUID() }];
  const backend = backendFor();
  const local = localSites(SITES);
  const port = overlapping((input, ctx) => local.use(input, ctx), 2);
  const { turns, responses } = fanout(calls);
  const { harness, browser } = await open(new MemoryStorage(), backend, responses(), port);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } });
  await (await root.submit({ type: "input", content: "Read both sites." }, ctx)).wait(ctx);

  assert.deepEqual(port.overlapped, [true, true], "both calls were in flight at once");
  assert.deepEqual(await results(root), calls.map(({ site, requestId }) => ({ ok: true, site, request_id: requestId, report: `Read ${SITES[site].startUrl}` })));
  const byRequest = (await harness.snapshot(browser.docs.Children, root.id, ctx)).byRequest;
  assert.deepEqual(Object.keys(byRequest).sort(), calls.map(({ site, requestId }) => `${site}:${requestId}`).sort(), "both children are recorded");
  assert.equal(new Set(Object.values(byRequest)).size, 2, "in two conversations");
  assert.deepEqual([...turns.values()], [2, 2]);
  await settle(harness);
  assert.deepEqual([backend.tally().creates, backend.tally().releases], [2, 2], "each child had its own browser, released");
});

test("two overlapping use_website calls with the same request_id share one child", async (t) => {
  const requestId = randomUUID();
  const calls = [{ site: "shop", requestId }, { site: "shop", requestId }];
  const backend = backendFor();
  // No localSites here: both calls reach the adapter's child runner, so its own request_id record is what dedupes them.
  const port = overlapping(async ({ site, requestId: id, instructions }, ctx) => ({ report: await ctx.runChild({ site, requestId: id, prompt: `Start at ${SITES[site].startUrl}. ${instructions}` }, ctx.signal) }), 2);
  const { turns, responses } = fanout(calls);
  const { harness, browser } = await open(new MemoryStorage(), backend, responses(), port);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } });
  await (await root.submit({ type: "input", content: "Read the shop, twice at once." }, ctx)).wait(ctx);

  assert.deepEqual(port.overlapped, [true, true], "both calls were in flight at once");
  const answers = await results(root);
  assert.deepEqual(answers, [0, 1].map(() => ({ ok: true, site: "shop", request_id: requestId, report: `Read ${START}` })));
  assert.deepEqual(Object.keys((await harness.snapshot(browser.docs.Children, root.id, ctx)).byRequest), [`shop:${requestId}`]);
  assert.deepEqual([...turns.values()], [2], "the child ran once");
  await settle(harness);
  assert.equal(backend.tally().creates, 1);
});

test("after a crash mid-fan-out, each replayed use_website re-awaits its own child, once", async (t) => {
  const calls = [{ site: "shop", requestId: randomUUID() }, { site: "news", requestId: randomUUID() }];
  const dir = scratchSync(t, "use-website-fanout-crash-");
  const backend = backendFor();
  const local = localSites(SITES);
  const meet = rendezvous(2);
  let crash;
  const crashed = new Promise((resolve) => { crash = resolve; });
  const first = fanout(calls, { childTurn: async (_url, turn, signal) => {
    if (turn !== 2) return;
    // Forced race: the process dies once both children are mid-task, or after the rendezvous gives up.
    void meet().then(crash);
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("the process died")), { once: true }));
  } });
  const one = await open(await openNodeJsonlStorage(dir, ctx), backend, first.responses(), local);
  const root = await one.harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(one.browser.docs.Config, id), CONFIG); } });
  root.submit({ type: "input", content: "Read both sites." }, ctx).then((submission) => submission.wait(ctx)).catch(() => undefined);
  await crashed;
  const before = (await one.harness.snapshot(one.browser.docs.Children, root.id, ctx)).byRequest;
  await one.harness.close(ctx);
  await one.browser.close();
  assert.equal(Object.keys(before).length, 2, "both children were running when the process died");

  const second = fanout(calls);
  const relisted = localSites(SITES);
  const two = await open(await openNodeJsonlStorage(dir, ctx), backend, second.responses(), relisted);
  t.after(() => two.harness.close(ctx));
  two.harness.resume();
  const again = await two.harness.root(ctx);
  for (let i = 0; i < 400 && (await results(again)).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await results(again), calls.map(({ site, requestId }) => ({ ok: true, site, request_id: requestId, report: `Read ${SITES[site].startUrl}` })));
  assert.deepEqual((await two.harness.snapshot(two.browser.docs.Children, again.id, ctx)).byRequest, before, "the same two children, no new one");
  assert.deepEqual(Object.fromEntries(second.turns), { [START]: 1, [NEWS]: 1 }, "each child finished its task once, from where it stopped");
});
