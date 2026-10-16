import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { localSites } from "../dist/index.js";
import { FakeBackend, fakeDriver } from "../dist/testing/index.js";
import { startAgent } from "./coding-agent/rig.mjs";

const START = "https://shop.example.test/";
const PAGE = { url: START, title: "Shop", text: "Raspberry Pi 5 8GB costs $80", html: "<html><body><h1>Shop</h1><p>Raspberry Pi 5 8GB costs $80</p></body></html>" };
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const toolUse = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${randomUUID().slice(0, 8)}` })], { stopReason: "toolUse" });

test("the coding agent's use_website runs a child pi session that has the browser tools and no use_website, answers its report, and releases its browser", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "use-website-agent-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; fs.rmSync(agentDir, { recursive: true, force: true }); });
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const sites = localSites({ shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START } });
  const agent = await startAgent(t, { extension: { provider: backend.provider, driver: fakeDriver(backend), sites } });
  const requestIds = [randomUUID()];
  requestIds.push(requestIds[0]);
  const child = { turns: 0, refused: null };
  agent.core.setResponses(Array.from({ length: 20 }, () => (context) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const last = context.messages.at(-1);
    if (asked.includes(`Start at ${START}`)) {
      child.turns += 1;
      if (child.turns === 1) return toolUse("use_website", { site: "shop", request_id: randomUUID(), instructions: "Start another child." });
      if (child.turns === 2) { child.refused = { isError: last.isError === true, text: textOf(last) }; return toolUse("snapshot", {}); }
      return fauxAssistantMessage("The 8 GB board costs $80.");
    }
    const answered = context.messages.filter((message) => message.role === "toolResult").length;
    return answered < requestIds.length ? toolUse("use_website", { site: "shop", request_id: requestIds[answered], instructions: "Find the price of the 8 GB board." }) : fauxAssistantMessage("done");
  }));
  await agent.session.prompt("What does the shop charge for the 8 GB board? Ask twice.");

  const answers = agent.seen.filter((row) => row.tool === "use_website").map((row) => JSON.parse(row.text));
  assert.deepEqual(answers, [0, 1].map(() => ({ ok: true, site: "shop", request_id: requestIds[0], report: "The 8 GB board costs $80." })));
  assert.equal(child.turns, 3, "one child for the request, asked twice");
  assert.equal(child.refused?.isError, true, `the child's use_website call: ${child.refused?.text}`);
  assert.match(child.refused.text, /use_website/);
  assert.equal(agent.seen.filter((row) => row.tool === "use_website").length, 2, "only the parent's two calls ran");
  assert.deepEqual([backend.tally().creates, backend.tally().releases], [1, 1], "the child's browser is released when it reports");
});

for (const [when, cancel] of [
  ["before its child starts", async (agent, ctx) => { void agent.session.abort(); for (let i = 0; i < 50 && !ctx.signal.aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); }],
  ["while its child is being set up", async (agent) => { setImmediate(() => { void agent.session.abort(); }); }],
]) {
  test(`a use_website call cancelled ${when} never prompts the child`, async (t) => {
    const agentDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "use-website-agent-"));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; fs.rmSync(agentDir, { recursive: true, force: true }); });
    const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
    const local = localSites({ shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START } });
    let agent;
    const sites = { list: (signal) => local.list(signal), async use(input, ctx) { await cancel(agent, ctx); return local.use(input, ctx); } };
    agent = await startAgent(t, { extension: { provider: backend.provider, driver: fakeDriver(backend), sites } });
    let childTurns = 0;
    agent.core.setResponses(Array.from({ length: 10 }, () => (context) => {
      if (textOf(context.messages.find((message) => message.role === "user")).includes(`Start at ${START}`)) { childTurns += 1; return toolUse("snapshot", {}); }
      return context.messages.some((message) => message.role === "toolResult") ? fauxAssistantMessage("done") : toolUse("use_website", { site: "shop", request_id: randomUUID(), instructions: "Buy the 8 GB board." });
    }));
    await agent.session.prompt("Buy the board.").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(childTurns, 0, "the cancelled child never asked its model anything");
    assert.equal(backend.tally().creates, 0, "and never opened a browser");
  });
}

test("a site listing that fails is asked again at the next session start", async (t) => {
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE } });
  const local = localSites({ shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START } });
  let lists = 0;
  const sites = { list: async (signal) => { lists += 1; if (lists === 1) throw new Error("the site catalog is unreachable"); return local.list(signal); }, use: (input, ctx) => local.use(input, ctx) };
  const agent = await startAgent(t, { extension: { provider: backend.provider, driver: fakeDriver(backend), sites } });
  assert.equal(agent.session.getActiveToolNames().includes("use_website"), false);
  await agent.bind();
  assert.equal(lists, 2, "the listing was asked again");
  assert.equal(agent.session.getActiveToolNames().includes("use_website"), true);
});

const NEWS = "https://news.example.test/";
const SITES = { shop: { title: "The shop", description: "Prices of the store's products.", startUrl: START }, news: { title: "The news", description: "Today's headlines.", startUrl: NEWS } };

for (const [what, calls] of [
  ["two sites", [{ site: "shop", requestId: randomUUID() }, { site: "news", requestId: randomUUID() }]],
  ["one request_id twice", ((requestId) => [{ site: "shop", requestId }, { site: "shop", requestId }])(randomUUID())],
]) {
  test(`the coding agent runs use_website calls in one turn at once: ${what}`, async (t) => {
    const agentDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "use-website-agent-"));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; fs.rmSync(agentDir, { recursive: true, force: true }); });
    const backend = new FakeBackend({ start: START, pages: { [START]: PAGE, [NEWS]: { url: NEWS, title: "News", text: "Headlines", html: "<html><body><h1>News</h1></body></html>" } } });
    const local = localSites(SITES);
    // Forced race: each call waits until both are in flight, or two seconds pass.
    let arrived = 0;
    let open;
    const met = new Promise((resolve) => { open = resolve; });
    const overlapped = [];
    const sites = { list: (signal) => local.list(signal), async use(input, ctx) {
      arrived += 1;
      if (arrived === 2) open(true);
      overlapped.push(await Promise.race([met, new Promise((resolve) => setTimeout(resolve, 2_000, false).unref())]));
      return local.use(input, ctx);
    } };
    const agent = await startAgent(t, { extension: { provider: backend.provider, driver: fakeDriver(backend), sites } });
    const turns = new Map();
    agent.core.setResponses(Array.from({ length: 20 }, () => (context) => {
      const asked = textOf(context.messages.find((message) => message.role === "user"));
      const site = Object.values(SITES).find((entry) => asked.includes(`Start at ${entry.startUrl}`));
      if (site) {
        turns.set(site.startUrl, (turns.get(site.startUrl) ?? 0) + 1);
        return context.messages.at(-1).role === "toolResult" ? fauxAssistantMessage(`Read ${site.startUrl}`) : toolUse("snapshot", {});
      }
      return context.messages.some((message) => message.role === "toolResult")
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage(calls.map((call, i) => fauxToolCall("use_website", { site: call.site, request_id: call.requestId, instructions: "Read the start page." }, { id: `call-${i}-${randomUUID().slice(0, 8)}` })), { stopReason: "toolUse" });
    }));
    await agent.session.prompt("Read them at once.");

    assert.deepEqual(overlapped, [true, true], "both calls were in flight at once");
    const byCall = (a, b) => `${a.site}:${a.request_id}`.localeCompare(`${b.site}:${b.request_id}`);
    const answers = agent.seen.filter((row) => row.tool === "use_website").map((row) => JSON.parse(row.text)).sort(byCall);
    assert.deepEqual(answers, calls.map(({ site, requestId }) => ({ ok: true, site, request_id: requestId, report: `Read ${SITES[site].startUrl}` })).sort(byCall));
    const children = new Set(calls.map(({ site, requestId }) => `${site}:${requestId}`)).size;
    assert.deepEqual([...turns.values()], Array(children).fill(2), "one child per request, each run once");
    assert.deepEqual([backend.tally().creates, backend.tally().releases], [children, children], "each child's browser is released when it reports");
  });
}

test("on one existing browser (--browser-endpoint) the coding agent's children take turns: two calls in one turn never run their children at once", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "use-website-agent-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; fs.rmSync(agentDir, { recursive: true, force: true }); });
  const backend = new FakeBackend({ start: START, pages: { [START]: PAGE, [NEWS]: { url: NEWS, title: "News", text: "Headlines", html: "<html><body><h1>News</h1></body></html>" } } });
  const env = { ...process.env, PI_BROWSER_ENDPOINT: "ws://127.0.0.1:9/devtools/browser/shared" };
  const agent = await startAgent(t, { extension: { provider: backend.provider, driver: fakeDriver(backend), sites: localSites(SITES), env } });
  const calls = [{ site: "shop", requestId: randomUUID() }, { site: "news", requestId: randomUUID() }];
  // Forced race: a child's first turn waits until the other child has started too, or two seconds pass. The timer keeps
  // the process alive, since with the turn queue the wait always runs to it.
  let started = 0;
  let open;
  const both = new Promise((resolve) => { open = resolve; });
  let running = 0, most = 0;
  agent.core.setResponses(Array.from({ length: 20 }, () => async (context) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const site = Object.values(SITES).find((entry) => asked.includes(`Start at ${entry.startUrl}`));
    if (site) {
      if (context.messages.at(-1).role === "toolResult") { running -= 1; return fauxAssistantMessage(`Read ${site.startUrl}`); }
      running += 1;
      most = Math.max(most, running);
      started += 1;
      if (started === 2) open();
      await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      return toolUse("snapshot", {});
    }
    return context.messages.some((message) => message.role === "toolResult")
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage(calls.map((call, i) => fauxToolCall("use_website", { site: call.site, request_id: call.requestId, instructions: "Read the start page." }, { id: `call-${i}-${randomUUID().slice(0, 8)}` })), { stopReason: "toolUse" });
  }));
  await agent.session.prompt("Read them at once.");

  assert.equal(most, 1, "one child at a time on one browser");
  const answers = agent.seen.filter((row) => row.tool === "use_website").map((row) => JSON.parse(row.text)).map(({ site, report }) => `${site}: ${report}`).sort();
  assert.deepEqual(answers, [`news: Read ${NEWS}`, `shop: Read ${START}`]);
});
