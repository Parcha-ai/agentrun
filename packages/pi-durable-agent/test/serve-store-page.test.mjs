// The serve page on an agent store, offline: page.js run with <html data-serve="store"> on the small DOM of
// test/page-dom.mjs over a fake API whose names, prompts, labels and summaries carry markup. Markup arrives as text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { all, assertInert, mount, served } from "./page-dom.mjs";

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const STORE = "store";
const classOf = (el) => el.getAttribute("class") ?? "";
/** A value made in the page's realm, as this realm's plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));
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

const wrev = (id, fields) => rev(id, { agent: "mcc-classifier", kind: "workflow", ...fields });
const REV_M1 = wrev("1", { note: "First cut", runs: 2 });
const REV_M2 = wrev("2", { parent: REV_M1.id, createdAt: "2026-10-22T15:00:00.000Z", current: true, note: "Marketplaces", runs: 2 });
const node = (path, kind, label) => ({ path, kind, label });
const GRAPH_1 = { nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "pick", "Pick the MCC"), node("/root/steps/2", "code", "Format the answer")], edges: [{ from: "/root", to: "/root/steps/0", kind: "next" }] };
const GRAPH_2 = { nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "decide", `Jev: a marketplace? ${HOSTILE}`), node("/root/steps/2", "pick", "Pick the MCC"), node("/root/steps/3", "report", "Answer")], edges: [{ from: "/root", to: "/root/steps/0", kind: "next" }] };
const MARKS = { added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: `Format the answer ${HOSTILE}`, kind: "code" }] };
const workflowApi = (m2 = {}) => ({
  "api/agents/mcc-classifier": { agent: { id: "mcc-classifier", name: "MCC classifier", current: REV_M2.id, currentKind: "workflow", revisions: 2, runs: 4 }, revisions: [REV_M2, REV_M1] },
  [`api/agents/mcc-classifier/revisions/${REV_M2.id}`]: { revision: { ...REV_M2, body: { skills: {}, tools: ["web_fetch"] } }, parent: REV_M1, diff: { against: REV_M1.id, marks: MARKS, moved: ["/root/steps/2"] }, graph: GRAPH_2, ...m2 },
  [`api/agents/mcc-classifier/revisions/${REV_M1.id}`]: { revision: { ...REV_M1, body: { skills: {}, tools: ["web_fetch"] } }, parent: null, diff: null, graph: GRAPH_1 },
});

test("a workflow revision: its graph drawn by window.drawWorkflowGraph into an svg of the page's own, with graphDiff's badges as marks.diff", async () => {
  const drawn = [];
  const top = (node) => (node.parentNode ? top(node.parentNode) : node);
  const drawWorkflowGraph = (svg, graph, marks) => drawn.push({ svg, graph, marks, attached: top(svg).tagName === "BODY" });
  const page = mount(workflowApi(), "#/agents/mcc-classifier", { serve: STORE, window: { drawWorkflowGraph } });
  await page.settle();
  assertInert(page.app, drawn.map((d) => d.svg));
  assert.equal(drawn.length, 2, "one graph per workflow revision");
  assert.deepEqual(drawn.map((d) => [d.svg.tagName, d.svg.namespaceURI, d.svg.getAttribute("class")]), [["svg", "http://www.w3.org/2000/svg", "workflow-graph"], ["svg", "http://www.w3.org/2000/svg", "workflow-graph"]]);
  assert.ok(drawn.every((d) => d.attached), "drawn once the svg is in the page");
  assert.deepEqual(plain([drawn[0].graph, drawn[0].marks]), [GRAPH_2, { diff: MARKS }]);
  assert.deepEqual(plain([drawn[1].graph, drawn[1].marks]), [GRAPH_1, {}], "a revision with no parent has no badges");
  const blocks = all(page.app).filter((el) => classOf(el).startsWith("revision"));
  assert.ok(blocks[0].textContent.includes("+2 added") && blocks[0].textContent.includes("1 edited") && blocks[0].textContent.includes("1 removed") && blocks[0].textContent.includes("1 moved"));
  assert.ok(blocks[0].textContent.includes("Workflow, against 111111111111"));
});

test("a workflow revision without the graph drawer: its nodes as a text list with the same badges, the removed ones named", async () => {
  const page = mount(workflowApi(), "#/agents/mcc-classifier", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  const [m2] = all(page.app).filter((el) => classOf(el).startsWith("revision"));
  const items = all(m2).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node"));
  assert.deepEqual(items.map((el) => [classOf(el), el.styles["--depth"]]), [["node", "0"], ["node", "1"], ["node added", "1"], ["node edited", "1"], ["node added", "1"]]);
  assert.ok(items[2].textContent.includes(`Jev: a marketplace? ${HOSTILE}`) && items[2].textContent.includes("decide"));
  assert.deepEqual(pills(items[2]), [["pill added", "added"]]);
  assert.deepEqual(pills(items[3]), [["pill edited", "edited"]]);
  assert.ok(m2.textContent.includes(`Format the answer ${HOSTILE} (code)`), "a removed node is named");
});

test("a workflow revision whose graph cannot be drawn here says what to install, and one whose parent is agentic says so", async () => {
  const page = mount(workflowApi({ graph: null, diff: null, unavailable: "install @parcha/agentrun-dsl to see this workflow's graph" }), "#/agents/mcc-classifier", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  const [m2] = all(page.app).filter((el) => classOf(el).startsWith("revision"));
  assert.ok(m2.textContent.includes("install @parcha/agentrun-dsl to see this workflow's graph"));
  assert.equal(all(m2).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node")).length, 0);

  const agentic = mount(workflowApi({ parent: { ...REV_M1, kind: "agentic" }, diff: null }), "#/agents/mcc-classifier", { serve: STORE });
  await agentic.settle();
  const [first] = all(agentic.app).filter((el) => classOf(el).startsWith("revision"));
  assert.ok(first.textContent.includes("Its parent 111111111111 is an agentic revision"));
});

const runRow = (id, revision, state, fields = {}) => ({ id, agent: "company-researcher", revision: revision.id, kind: revision.kind, state, startedAt: "2026-10-22T11:00:00.000Z", ...fields });
const RUNS = [
  runRow("run-5", REV_B, "running", { startedAt: "2026-10-23T05:00:00.000Z" }),
  runRow("run-4", REV_B, "escalated", { startedAt: "2026-10-23T04:00:00.000Z", endedAt: "2026-10-23T04:01:00.000Z", costUsd: 0.018, summary: `escalated at No public record ${HOSTILE}` }),
  runRow("run-3", REV_B, "completed", { startedAt: "2026-10-22T12:00:00.000Z", endedAt: "2026-10-22T12:04:00.000Z", costUsd: 0.312, summary: "Caterpillar builds machinery." }),
  runRow("run-2", REV_A, "failed", { endedAt: "2026-10-22T11:03:00.000Z", costUsd: 0.221, summary: "403 on the investor page" }),
  runRow("run-1", REV_A, "stopped", { startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:01:00.000Z", costUsd: 0.01 }),
  runRow("run-0", REV_A, "missing", { startedAt: "2026-10-20T10:00:00.000Z", costUsd: 0.02 }),
];

test("the runs: one table across the agent's revisions (revision and kind, state, cost, summary, started), escalated and missing each a state of its own", async () => {
  const page = mount(agentApi({ "api/runs?agent=company-researcher": RUNS }), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched.slice(0, 2), ["api/agents/company-researcher", "api/runs?agent=company-researcher"]);
  const rows = all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "run");
  assert.deepEqual(rows.map((el) => el.getAttribute("href")), RUNS.map((r) => `#/runs/${r.id}`));
  assert.deepEqual(rows.map((el) => pills(el)[0]), [["pill live", "running"], ["pill escalated", "escalated"], ["pill ok", "completed"], ["pill error", "failed"], ["pill stopped", "stopped"], ["pill missing", "missing"]], "escalated is never drawn as failed");
  assert.ok(rows[1].textContent.includes("bbbbbbbbbbbb") && rows[1].textContent.includes("agentic") && rows[1].textContent.includes("$0.018") && rows[1].textContent.includes(`escalated at No public record ${HOSTILE}`));
  assert.ok(rows[1].textContent.includes(new Date("2026-10-23T04:00:00.000Z").getFullYear() + "-"), "when it started");
  const filters = all(page.app).filter((el) => el.tagName === "A" && classOf(el).startsWith("filter"));
  assert.deepEqual(filters.map((el) => [el.getAttribute("href"), classOf(el), el.textContent]), [
    ["#/agents/company-researcher", "filter on", "All revisions"],
    [`#/agents/company-researcher?revision=${REV_B.id}`, "filter", "bbbbbbbbbbbb agentic"],
    [`#/agents/company-researcher?revision=${REV_A.id}`, "filter", "aaaaaaaaaaaa agentic"],
  ]);
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [5000], "a running run: the runs are read again every 5 s");
  await page.tick();
  assert.equal(page.fetched.filter((p) => p === "api/runs?agent=company-researcher").length, 2);
  assert.equal(page.fetched.filter((p) => p === "api/agents/company-researcher").length, 1, "only the runs");
});

test("the runs filtered by a revision: the filter is in the hash, so a reload keeps it, and the API is asked for that revision's runs", async () => {
  const filtered = RUNS.filter((r) => r.revision === REV_A.id);
  const page = mount(agentApi({ [`api/runs?agent=company-researcher&revision=${REV_A.id}`]: filtered }), `#/agents/company-researcher?revision=${REV_A.id}`, { serve: STORE });
  await page.settle();
  assert.deepEqual(page.fetched.slice(0, 2), ["api/agents/company-researcher", `api/runs?agent=company-researcher&revision=${REV_A.id}`]);
  assert.equal(all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "run").length, 3);
  const on = all(page.app).filter((el) => classOf(el) === "filter on");
  assert.deepEqual(on.map((el) => [el.getAttribute("href"), el.getAttribute("aria-current")]), [[`#/agents/company-researcher?revision=${REV_A.id}`, "true"]]);
  assert.match(page.app.textContent, /3 runs of aaaaaaaaaaaa/);
  assert.equal(page.timers.size, 0, "nothing is running, so nothing polls");
  const reloaded = mount(agentApi({ [`api/runs?agent=company-researcher&revision=${REV_A.id}`]: filtered }), `#/agents/company-researcher?revision=${REV_A.id}`, { serve: STORE });
  await reloaded.settle();
  assert.equal(all(reloaded.app).filter((el) => el.tagName === "A" && classOf(el) === "run").length, 3, "the same three after a reload");
  const revisionPage = mount(agentApi({ [`api/runs?agent=company-researcher&revision=${REV_A.id}`]: filtered }), `#/agents/company-researcher/revisions/${REV_A.id}`, { serve: STORE });
  await revisionPage.settle();
  assert.equal(all(revisionPage.app).filter((el) => el.tagName === "A" && classOf(el) === "run").length, 3, "a revision's own page shows its runs");
});

const row = (seq, kind, fields = {}) => ({ id: `1:${seq}`, kind, seq, summary: null, text: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, conversation_id: 1, ...fields });
const TIMELINE = [
  row(0, "user_message", { text: `Research ${HOSTILE}`, summary: "You: Research" }),
  row(1, "tool_use", { tool_name: "web_fetch", tool_use_id: "a", round: 1, summary: `Fetched a.example ${HOSTILE}` }),
  row(2, "tool_result", { tool_name: "web_fetch", tool_use_id: "a", tool_status: "success", tool_result_preview: "ok", tool_result_size_bytes: 2 }),
  row(3, "tool_use", { tool_name: "web_fetch", tool_use_id: "b", round: 2, summary: "Fetched b.example" }),
  row(4, "tool_result", { tool_name: "web_fetch", tool_use_id: "b", tool_status: "success", tool_result_preview: "ok", tool_result_size_bytes: 2 }),
  row(5, "usage", { usage: { usd: 0.2, requests: 2 } }),
  row(6, "final_answer", { text: "**Done**: wrote `brief.md`." }),
];
const AGENTIC_RUN = { run: RUNS[2], agent: { id: "company-researcher", name: `Company researcher ${HOSTILE}` }, revision: REV_B, rows: TIMELINE, stored: true };

test("an agentic run's page: its state, revision, agent and summary, then the timeline exactly as an agent home's run draws it", async () => {
  const page = mount({ "api/runs/run-3": AGENTIC_RUN }, "#/runs/run-3", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched, ["api/runs/run-3"]);
  const head = all(page.app).find((el) => classOf(el) === "card run-head");
  assert.deepEqual(pills(head).slice(0, 2), [["pill ok", "completed"], ["pill agentic", "agentic"]]);
  assert.ok(head.textContent.includes("Caterpillar builds machinery.") && head.textContent.includes("took 4m 00s") && head.textContent.includes(`Company researcher ${HOSTILE}`));
  const hrefs = all(head).filter((el) => el.tagName === "A").map((el) => el.getAttribute("href"));
  assert.deepEqual(hrefs, ["#/agents/company-researcher", `#/agents/company-researcher/revisions/${REV_B.id}`]);
  const calls = all(page.app).filter((el) => el.tagName === "DETAILS" && classOf(el).startsWith("call"));
  assert.deepEqual(calls.map(classOf), ["call many ok", "call ok", "call ok"], "the two one-call web_fetch rounds fold, as an agent home's page folds them");
  assert.ok(page.app.textContent.includes(`Fetched a.example ${HOSTILE} and 1 more`));
  assert.ok(all(page.app).some((el) => el.tagName === "B" && el.textContent === "Done"));
  assert.deepEqual(all(page.document.getElementById("crumbs")).filter((el) => el.tagName === "A").map((el) => el.textContent), ["Agents", `Company researcher ${HOSTILE}`, "bbbbbbbbbbbb", "Run"]);
  assert.equal(page.timers.size, 0);
});

test("a running agentic run's page is read again every 2 s until the reader leaves it, and a run whose directory is gone says so", async () => {
  const live = { ...AGENTIC_RUN, run: RUNS[0], rows: TIMELINE.slice(0, 2) };
  const page = mount({ "api/runs/run-5": live, "api/store": { agents: AGENTS } }, "#/runs/run-5", { serve: STORE });
  await page.settle();
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [2000]);
  assert.ok(page.app.textContent.includes("refreshing every 2 s"));
  await page.tick();
  assert.deepEqual(page.fetched, ["api/runs/run-5", "api/runs/run-5"]);
  await page.go("#/");
  assert.equal(page.timers.size, 0);
  const gone = mount({ "api/runs/run-0": { ...AGENTIC_RUN, run: RUNS[5], rows: [], stored: false } }, "#/runs/run-0", { serve: STORE });
  await gone.settle();
  assert.deepEqual(pills(gone.app)[0], ["pill missing", "missing"]);
  assert.match(gone.app.textContent, /This run's directory is not in the store/);
});

const PRIVATE = "/root/steps/1/branches/private/body";
const BRIEF = { nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "route", "Jev: public or private"), node("/root/steps/1/branches/public/body", "call", "Check the filing"), node(PRIVATE, "escalate", `No public record ${HOSTILE}`), node("/root/steps/2", "code", "Answer")], edges: [] };
const ESCALATED_STATUS = { "/root": "escalated", "/root/steps/0": "done", "/root/steps/1": "escalated", "/root/steps/1/branches/public/body": "not-run", [PRIVATE]: "escalated", "/root/steps/2": "not-run" };
const REV_C = rev("c", { kind: "workflow", parent: REV_B.id, current: true, note: "The cheap one" });
const WORKFLOW_RUN = {
  run: runRow("run-9", REV_C, "escalated", { startedAt: "2026-10-23T05:10:00.000Z", endedAt: "2026-10-23T05:11:00.000Z", costUsd: 0.018, summary: `escalated at No public record ${HOSTILE}` }),
  agent: { id: "company-researcher", name: "Company researcher" },
  revision: REV_C,
  stored: true,
  workflow: { graph: BRIEF, status: ESCALATED_STATUS, outcome: "escalated", escalatedAt: { path: PRIVATE, label: `No public record ${HOSTILE}` } },
};

test("a workflow run's page: the graph with the run's node states as marks.status and the escalation as marks.fired, drawn as escalated, never failed", async () => {
  const drawn = [];
  const page = mount({ "api/runs/run-9": WORKFLOW_RUN }, "#/runs/run-9", { serve: STORE, window: { drawWorkflowGraph: (svg, graph, marks) => drawn.push({ svg, graph, marks }) } });
  await page.settle();
  assertInert(page.app, drawn.map((d) => d.svg));
  assert.equal(drawn.length, 1);
  assert.deepEqual(plain(drawn[0].marks), { status: ESCALATED_STATUS, fired: PRIVATE });
  assert.deepEqual(plain(drawn[0].graph), BRIEF);
  const head = all(page.app).find((el) => classOf(el) === "card run-head");
  assert.deepEqual(pills(head).slice(0, 2), [["pill escalated", "escalated"], ["pill workflow", "workflow"]]);
  assert.ok(head.textContent.includes("$0.018") && head.textContent.includes(`escalated at No public record ${HOSTILE}`) && !head.textContent.includes("tool call"));
  assert.match(page.app.textContent, new RegExp(`Escalated at No public record`));
  assert.ok(!pills(page.app).some(([cls]) => cls === "pill error"), "nothing escalated is drawn as failed");
});

test("a workflow run's page without the drawer: the nodes as text with each one's state, the escalation marked where it stopped", async () => {
  const page = mount({ "api/runs/run-9": WORKFLOW_RUN }, "#/runs/run-9", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  const items = all(page.app).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node"));
  assert.deepEqual(items.map((el) => [classOf(el), pills(el)]), [
    ["node", [["pill escalated", "escalated"]]],
    ["node", [["pill ok", "done"]]],
    ["node", [["pill escalated", "escalated"]]],
    ["node", [["pill idle", "not-run"]]],
    ["node fired", [["pill escalated", "escalated"]]],
    ["node", [["pill idle", "not-run"]]],
  ]);
  assert.ok(items[4].textContent.includes(`No public record ${HOSTILE}`) && items[4].textContent.includes("stopped here"));
  assert.ok(!pills(page.app).some(([cls]) => cls === "pill error"));
  const completed = { ...WORKFLOW_RUN, run: { ...WORKFLOW_RUN.run, state: "completed", summary: "Read the site → Answer" }, workflow: { graph: BRIEF, status: { "/root": "done" }, outcome: "completed" } };
  const done = mount({ "api/runs/run-9": completed }, "#/runs/run-9", { serve: STORE });
  await done.settle();
  assert.equal(all(done.app).filter((el) => classOf(el) === "node fired").length, 0);
  assert.match(done.app.textContent, /The path it took/);
});

test("a workflow run's page when the graph cannot be read here says what to install, with the run's row still shown", async () => {
  const page = mount({ "api/runs/run-9": { ...WORKFLOW_RUN, workflow: null, unavailable: "install @parcha/agentrun-dsl to see this workflow's graph" } }, "#/runs/run-9", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.match(page.app.textContent, /install @parcha\/agentrun-dsl to see this workflow's graph/);
  assert.deepEqual(pills(page.app)[0], ["pill escalated", "escalated"]);
});
