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

const rev = (id, fields) => ({ id: id.repeat(64), agent: "company-researcher", parent: null, createdAt: "2026-10-21T09:00:00.000Z", kind: "agentic", current: false, runs: 0, ...fields });
const REV_A = rev("a", { note: `Prompt A ${HOSTILE}`, runs: 2 });
const REV_B = rev("b", { parent: REV_A.id, createdAt: "2026-10-22T10:00:00.000Z", note: "Prompt B", current: true, runs: 1 });
const AGENT_PAGE = {
  agent: { ...AGENTS[0], current: REV_B.id, currentKind: "agentic", revisions: 2, runs: 3 },
  revisions: [REV_B, REV_A],
};
const DETAIL_A = { revision: { ...REV_A, body: { instructions: `Line one.\nLine two ${HOSTILE}`, skills: { "brief/SKILL.md": "1".repeat(64) }, tools: ["web_fetch"], model: "luna", thinking: "low" } }, parent: null, diff: null };
const DETAIL_B = {
  revision: { ...REV_B, body: { instructions: `Line one, cited.\nLine two ${HOSTILE}\nLine three.`, skills: { "brief/SKILL.md": "2".repeat(64), "cite/SKILL.md": "3".repeat(64) }, tools: ["web_fetch", "read"], model: "luna", thinking: "medium" } },
  parent: REV_A,
  diff: {
    against: REV_A.id,
    prompt: [{ op: "del", text: "Line one." }, { op: "add", text: "Line one, cited." }, { op: "same", text: `Line two ${HOSTILE}` }, { op: "add", text: "Line three." }],
    tools: { added: ["read"], removed: ["write"] },
    skills: { added: [{ path: "cite/SKILL.md", sha256: "3".repeat(64) }], removed: [], changed: [{ path: "brief/SKILL.md", was: "1".repeat(64), now: "2".repeat(64) }] },
    thinking: { was: "low", now: "medium" },
  },
};
const agentApi = (extra = {}) => ({
  "api/agents/company-researcher": AGENT_PAGE,
  [`api/agents/company-researcher/revisions/${REV_A.id}`]: DETAIL_A,
  [`api/agents/company-researcher/revisions/${REV_B.id}`]: DETAIL_B,
  ...extra,
});

test("an agent page: its revisions newest first with the current one marked; an agentic one's prompt with a line diff against its parent, and what else changed", async () => {
  const page = mount(agentApi(), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched.slice(0, 1), ["api/agents/company-researcher"]);
  assert.deepEqual(page.fetched.filter((p) => p.includes("/revisions/")), [`api/agents/company-researcher/revisions/${REV_B.id}`, `api/agents/company-researcher/revisions/${REV_A.id}`], "each revision, newest first");
  assert.equal(page.document.title, `Company researcher ${HOSTILE} · agent store`);
  const blocks = all(page.app).filter((el) => classOf(el).startsWith("revision"));
  assert.deepEqual(blocks.map(classOf), ["revision current", "revision"], "newest first; the current one is marked");
  assert.ok(blocks[0].textContent.includes("current") && blocks[0].textContent.includes("bbbbbbbbbbbb") && blocks[0].textContent.includes("from aaaaaaaaaaaa"));
  assert.ok(blocks[1].textContent.includes(`Prompt A ${HOSTILE}`) && blocks[1].textContent.includes("2 runs"));
  const lines = all(blocks[0]).filter((el) => classOf(el).startsWith("line "));
  assert.deepEqual(lines.map((el) => [classOf(el), el.textContent]), [["line del", "−Line one."], ["line add", "+Line one, cited."], ["line same", ` Line two ${HOSTILE}`], ["line add", "+Line three."]], "every line of both, marked");
  assert.ok(blocks[0].textContent.includes("+2 −1"), "the diff's size");
  const chips = all(blocks[0]).filter((el) => /^chip( |$)/.test(classOf(el)));
  assert.deepEqual(chips.map((el) => [classOf(el), el.textContent]), [["chip", "web_fetch"], ["chip add", "+read"], ["chip del", "−write"]]);
  assert.ok(blocks[0].textContent.includes("thinking low → medium") && blocks[0].textContent.includes("model luna"));
  const skills = all(blocks[0]).filter((el) => el.tagName === "LI");
  assert.deepEqual(skills.map(classOf), ["changed", "add"], "skills by path: a changed sha and an added file");
  assert.ok(skills[0].textContent.includes("111111111111 → 222222222222"));
  assert.ok(all(blocks[1]).some((el) => el.tagName === "PRE" && el.textContent === DETAIL_A.revision.body.instructions), "a revision with no parent shows its prompt whole");
  const links = all(blocks[0]).filter((el) => el.tagName === "A").map((el) => el.getAttribute("href"));
  assert.ok(links.includes(`#/agents/company-researcher/revisions/${REV_B.id}`) && links.includes(`#/agents/company-researcher/revisions/${REV_A.id}`));
});

test("one revision's own page: the same block, by itself", async () => {
  const page = mount(agentApi(), `#/agents/company-researcher/revisions/${REV_B.id}`, { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched.slice(0, 2), ["api/agents/company-researcher", `api/agents/company-researcher/revisions/${REV_B.id}`]);
  assert.equal(all(page.app).filter((el) => classOf(el).startsWith("revision")).length, 1);
  assert.match(page.app.textContent, /\+Line one, cited\./);
});
