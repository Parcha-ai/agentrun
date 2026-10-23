// The serve page on an agent store, offline: page.js run with <html data-serve="store"> on the small DOM of
// test/page-dom.mjs over a fake API whose names, prompts, labels and summaries carry markup. Markup arrives as text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { all, assertInert, mount, served } from "./page-dom.mjs";

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const STORE = "store";
const classOf = (el) => el.getAttribute("class") ?? "";
const pills = (node) => all(node).filter((el) => classOf(el).startsWith("pill ")).map((el) => [classOf(el), el.textContent]);

const AGENTS = [
  { id: "company-researcher", name: `Company researcher ${HOSTILE}`, description: `Writes a brief ${HOSTILE}`, createdAt: "2026-10-21T09:00:00.000Z", current: "c".repeat(64), currentKind: "workflow", runs: 6, revisions: 3 },
  { id: "inbox-triage", name: "Inbox triage", createdAt: "2026-10-22T07:00:00.000Z", current: "t".repeat(64), currentKind: "agentic", runs: 1, revisions: 1 },
  { id: "new-agent", name: "New agent", createdAt: "2026-10-23T07:00:00.000Z", current: null, currentKind: null, runs: 0, revisions: 0 },
  { id: "gone-agent", name: "Gone agent", createdAt: "2026-10-19T07:00:00.000Z", current: "g".repeat(64), currentKind: "agentic", runs: 2, revisions: 1, missing: true },
];

test("the store page is store.html: page.css and the graph drawer then page.js, nothing inline, nothing from the network", () => {
  const html = served("store.html");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.deepEqual(scripts.map(([, attrs, body]) => [attrs, body]), [[' src="/graph.js"', ""], [' src="/page.js"', ""]]);
  assert.match(html, /<html lang="en" data-serve="store">/);
  assert.match(html, /<link rel="stylesheet" href="\/page\.css">[\s\S]*<main id="app">[\s\S]*<script src="\/graph\.js"><\/script>\n<script src="\/page\.js"><\/script>\n<\/body>/);
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|https?:|\/\//i);
});

test("the picker: each agent with its current revision's kind and its run count, a link to its page, and markup as text", async () => {
  const page = mount({ "api/store": { agents: AGENTS } }, "#/", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched, ["api/store"]);
  const tiles = all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "agent-tile");
  assert.deepEqual(tiles.map((el) => el.getAttribute("href")), ["#/agents/company-researcher", "#/agents/inbox-triage", "#/agents/new-agent", "#/agents/gone-agent"]);
  assert.ok(tiles[0].textContent.includes(`Company researcher ${HOSTILE}`) && tiles[0].textContent.includes(`Writes a brief ${HOSTILE}`));
  assert.ok(tiles[0].textContent.includes("6 runs") && tiles[0].textContent.includes("3 revisions"));
  assert.ok(tiles[1].textContent.includes("1 run") && !tiles[1].textContent.includes("1 runs") && tiles[1].textContent.includes("1 revision"), "one is named in the singular");
  assert.ok(tiles[2].textContent.includes("no revision yet"));
  assert.deepEqual(pills(page.app), [["pill workflow", "workflow"], ["pill agentic", "agentic"], ["pill agentic", "agentic"], ["pill missing", "missing"]]);
  assert.match(page.app.textContent, /4 agents/);
  assert.equal(page.document.title, "Agent store");
  assert.match(all(page.app).find((el) => el.tagName === "H1").textContent, /4 agents/);
});

test("an empty store says so, and a store that cannot be read says why", async () => {
  const empty = mount({ "api/store": { agents: [] } }, "#/", { serve: STORE });
  await empty.settle();
  assert.match(empty.app.textContent, /No agents in this store yet\./);
  const broken = mount({ "api/store": [500, { error: "the agent store could not be read" }] }, "#/", { serve: STORE });
  await broken.settle();
  assert.match(broken.app.textContent, /Could not read the agent store\. 500 the agent store could not be read/);
});
