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
const revisionsOf = (page) => all(page.app).filter((el) => el.tagName === "ARTICLE");
const runRows = (page) => all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "run");

const AGENTS = [
  { id: "company-researcher", name: `Company researcher ${HOSTILE}`, description: `Writes a brief ${HOSTILE}`, createdAt: "2026-10-21T09:00:00.000Z", current: "c".repeat(64), currentKind: "workflow", runs: 6 },
  { id: "inbox-triage", name: "Inbox triage", createdAt: "2026-10-22T07:00:00.000Z", current: "t".repeat(64), currentKind: "agentic", runs: 1 },
  { id: "new-agent", name: "New agent", createdAt: "2026-10-23T07:00:00.000Z", current: null, currentKind: null, runs: 0 },
];

test("the store page is store.html: page.css, the graph drawer, then page.js; nothing inline, nothing from the network", () => {
  const html = served("store.html");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.deepEqual(scripts.map(([, attrs, body]) => [attrs, body]), [[' src="/graph.js"', ""], [' src="/page.js"', ""]]);
  assert.match(html, /<html lang="en" data-serve="store">[\s\S]*<link rel="stylesheet" href="\/page\.css">[\s\S]*<main id="app">/);
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|https?:|\/\//i);
});

test("no left accent bar on what the store's page draws: its own rules use a tint, a glyph or a full border, never a border down one side", () => {
  // The classes the store's page adds to page.css; the timeline it shares with an agent home's page keeps that page's rules.
  const OWN = ["agents", "agent-tile", "revs", "revision", "rev-head", "rev-id", "rev-note", "rev-body", "diff", "line", "chip.add", "chip.del", "files li", "filters", "filter", "table.store", "rev", "unknown", "graph-box", "note", "ran", "summary", "pill.escalated", "pill.stopped", "pill.agentic", "pill.workflow", "pill.current", "pill.added", "pill.edited", "pill.removed"];
  const rules = [...served("page.css").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const own = rules.filter(({ selector }) => OWN.some((name) => new RegExp(`\\.${name.replace(".", "\\.")}(?![\\w-])`).test(selector)));
  assert.ok(own.length >= 30, `the store page's rules were found (${own.length})`);
  assert.deepEqual(own.filter(({ body }) => /border-left|inset/.test(body)).map(({ selector }) => selector), []);
});

test("the picker: each agent with its current revision's kind and its run count, a link to its page, and markup as text", async () => {
  const page = mount({ "api/store": { agents: AGENTS } }, "#/", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched, ["api/store"]);
  const tiles = all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "agent-tile");
  assert.deepEqual(tiles.map((el) => [el.getAttribute("href"), pills(el)]), [["#/agents/company-researcher", [["pill workflow", "workflow"]]], ["#/agents/inbox-triage", [["pill agentic", "agentic"]]], ["#/agents/new-agent", []]]);
  assert.ok(tiles[0].textContent.includes(`Company researcher ${HOSTILE}`) && tiles[0].textContent.includes(`Writes a brief ${HOSTILE}`) && tiles[0].textContent.includes("6 runs"));
  assert.ok(tiles[1].textContent.includes("1 run") && !tiles[1].textContent.includes("1 runs"), "one is named in the singular");
  assert.ok(tiles[2].textContent.includes("no revision yet"));
  assert.equal(all(page.app).find((el) => el.tagName === "H1").textContent, "3 agents");
  assert.equal(page.document.title, "Agent store");

  const empty = mount({ "api/store": { agents: [] } }, "#/", { serve: STORE });
  await empty.settle();
  assert.match(empty.app.textContent, /No agents in this store yet\./);
  const busy = mount({ "api/store": [500, { error: "this store has an unfinished write from a run that stopped" }] }, "#/", { serve: STORE });
  await busy.settle();
  assert.match(busy.app.textContent, /Could not read the agent store\. 500 this store has an unfinished write from a run that stopped/);
});

const revision = (id, fields) => ({ id: id.repeat(64), kind: "agentic", current: false, createdAt: "2026-10-21T09:00:00.000Z", parent: null, parentKind: null, diff: null, ...fields });
const REV_A = revision("a", { note: `Prompt A ${HOSTILE}`, body: { instructions: `Line one.\nLine two ${HOSTILE}`, tools: ["web_fetch", "write"], skills: { "brief/SKILL.md": "1".repeat(64) }, model: "luna", thinking: "low" } });
const REV_B = revision("b", {
  current: true, note: "Prompt B", createdAt: "2026-10-22T10:00:00.000Z", parent: REV_A.id, parentKind: "agentic",
  body: { instructions: `Line one, cited.\nLine two ${HOSTILE}\nLine three.`, tools: ["web_fetch", "read"], skills: { "brief/SKILL.md": "2".repeat(64), "cite/SKILL.md": "3".repeat(64) }, model: "luna", thinking: "medium", prompts: { public: { role: "overlay", text: "Start at the filings." } } },
  diff: {
    against: REV_A.id,
    prompt: [{ op: "del", text: "Line one." }, { op: "add", text: "Line one, cited." }, { op: "same", text: `Line two ${HOSTILE}` }, { op: "add", text: "Line three." }],
    tools: { added: ["read"], removed: ["write"] },
    skills: { added: ["cite/SKILL.md"], removed: [], changed: ["brief/SKILL.md"] },
    thinking: { was: "low", now: "medium" },
  },
});
const run = (id, rev, state, fields = {}) => ({ id, agent: "company-researcher", revision: rev.id, kind: rev.kind, state, startedAt: "2026-10-22T11:00:00.000Z", gone: false, ...fields });
const RUNS = [
  run("run-5", REV_B, "running", { startedAt: "2026-10-23T05:00:00.000Z" }),
  run("run-4", REV_B, "escalated", { startedAt: "2026-10-23T04:00:00.000Z", endedAt: "2026-10-23T04:01:00.000Z", costUsd: 0.018, summary: `escalated at No public record ${HOSTILE}` }),
  run("run-3", REV_B, "completed", { startedAt: "2026-10-22T12:00:00.000Z", endedAt: "2026-10-22T12:04:00.000Z", costUsd: 0.312, summary: "Caterpillar builds machinery." }),
  run("run-2", REV_A, "failed", { endedAt: "2026-10-22T11:03:00.000Z", costUsd: 0, summary: "403 on the investor page" }),
  run("run-1", REV_A, "stopped", { startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:01:00.000Z", gone: true, summary: "never shown" }),
];
// The agent as the reader's readAgent reads it: no kind or run count of its own.
const AGENT = { agent: { id: AGENTS[0].id, name: AGENTS[0].name, description: AGENTS[0].description, createdAt: AGENTS[0].createdAt, current: REV_B.id }, revisions: [REV_B, REV_A] };
const agentApi = (extra = {}) => ({ "api/agents/company-researcher": AGENT, "api/runs?agent=company-researcher": RUNS, ...extra });

test("an agent page: its kind the current revision's, its revisions newest first, the current one marked, an agentic one's prompt diffed line by line against its parent with what else changed", async () => {
  const page = mount(agentApi(), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(page.fetched.slice(0, 2), ["api/agents/company-researcher", "api/runs?agent=company-researcher"]);
  assert.equal(page.document.title, `Company researcher ${HOSTILE} · agent store`);
  assert.deepEqual(pills(all(page.app).filter((el) => classOf(el) === "card agent")[0]), [["pill agentic", "agentic"]], "the current revision's kind");
  const [b, a] = revisionsOf(page);
  assert.deepEqual([classOf(b), classOf(a)], ["revision current", "revision"]);
  assert.ok(b.textContent.includes("bbbbbbbbbbbb") && b.textContent.includes("current") && b.textContent.includes("from aaaaaaaaaaaa") && a.textContent.includes(`Prompt A ${HOSTILE}`));
  const lines = all(b).filter((el) => classOf(el).startsWith("line "));
  assert.deepEqual(lines.map((el) => [classOf(el), el.textContent]), [["line del", "−Line one."], ["line add", "+Line one, cited."], ["line same", ` Line two ${HOSTILE}`], ["line add", "+Line three."]], "every line of both, marked");
  assert.ok(b.textContent.includes("+2 −1 lines"));
  const chips = all(b).filter((el) => /^chip( |$)/.test(classOf(el)));
  assert.deepEqual(chips.map((el) => [classOf(el), el.textContent]), [["chip", "web_fetch"], ["chip add", "+read"], ["chip del", "−write"]]);
  assert.ok(b.textContent.includes("thinking low → medium") && b.textContent.includes("model luna"));
  assert.deepEqual(all(b).filter((el) => el.tagName === "LI").map((el) => [classOf(el), el.textContent]), [["changed", "brief/SKILL.mdchanged · sha256 222222222222"], ["add", "cite/SKILL.mdadded · sha256 333333333333"]]);
  assert.ok(b.textContent.includes("1 prompt variant") && b.textContent.includes("public: Start at the filings."), "prompt variants, when there are any");
  assert.ok(all(a).some((el) => el.tagName === "PRE" && el.textContent === REV_A.body.instructions), "a first revision shows its prompt whole");
});

test("a prompt too long to diff line by line: the note says so, then the prompt whole, and what else changed is still shown", async () => {
  const tooLong = { ...REV_B, diff: { ...REV_B.diff, prompt: null } };
  const page = mount(agentApi({ "api/agents/company-researcher": { ...AGENT, revisions: [tooLong, REV_A] } }), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  const [b] = revisionsOf(page);
  assert.deepEqual(all(b).filter((el) => classOf(el) === "note").map((el) => el.textContent), ["The prompt is too long to diff line by line."]);
  assert.ok(all(b).some((el) => el.tagName === "PRE" && el.textContent === REV_B.body.instructions), "the new prompt, whole");
  assert.equal(all(b).filter((el) => classOf(el).startsWith("line ")).length, 0);
  assert.ok(b.textContent.includes("+read") && b.textContent.includes("thinking low → medium"), "the tools and settings that changed");
});

const node = (path, kind, label) => ({ path, kind, label });
const GRAPH_1 = { nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "call", "Pick the MCC"), node("/root/steps/2", "call", "Format the answer")], edges: [] };
const GRAPH_2 = { nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "call", `Is it a marketplace ${HOSTILE}`), node("/root/steps/2", "call", "Pick the MCC"), node("/root/steps/3", "call", "Answer")], edges: [] };
const MCC_1 = revision("1", { kind: "workflow", note: "First cut", body: { tools: ["web.fetch"], skills: {} }, graph: GRAPH_1 });
const MCC_2 = revision("2", { kind: "workflow", current: true, note: "Marketplaces", parent: MCC_1.id, parentKind: "workflow", body: { tools: ["web.fetch"], skills: {} }, graph: GRAPH_2, diff: { against: MCC_1.id, added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: `Format the answer ${HOSTILE}`, kind: "call" }] } });
const mccApi = (revisions = [MCC_2, MCC_1]) => ({ "api/agents/mcc-classifier": { agent: { id: "mcc-classifier", name: "MCC classifier", createdAt: "2026-10-20T08:00:00.000Z", current: MCC_2.id }, revisions }, "api/runs?agent=mcc-classifier": [] });
const SVG = "http://www.w3.org/2000/svg";
const MARKS = ["new", "edited", "done", "working", "failed", "escalated", "not-run", "fired"];
/** What graph.js drew: each node's path and the marks on it (a diff's tag, a run's state, the fired exit), by path. */
const drawnNodes = (node) => all(node).filter((el) => el.getAttribute("data-path") !== null).map((el) => [el.getAttribute("data-path"), classOf(el).split(" ").filter((name) => MARKS.includes(name)).join(" ")]).sort(([a], [b]) => (a < b ? -1 : 1));
/** graph.js's own svg, whose shapes its own test checks; the page's inert check is for what page.js makes. */
const svgParts = (page) => all(page.app).filter((el) => el.namespaceURI === SVG);

test("a workflow revision: its graph given to window.drawWorkflowGraph in an svg in a .graph-box, with graphDiff's marks; a first one has none", async () => {
  const drawn = [];
  const drawWorkflowGraph = (svg, graph, marks) => drawn.push({ svg, graph, marks });
  const page = mount(mccApi(), "#/agents/mcc-classifier", { serve: STORE, window: { drawWorkflowGraph } });
  await page.settle();
  assertInert(page.app, drawn.map((d) => d.svg));
  assert.deepEqual(drawn.map((d) => [d.svg.tagName, d.svg.namespaceURI, classOf(d.svg.parentNode)]), [["svg", SVG, "graph-box"], ["svg", SVG, "graph-box"]]);
  assert.deepEqual(plain([drawn[0].graph, drawn[0].marks]), [GRAPH_2, { diff: { added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: `Format the answer ${HOSTILE}`, kind: "call" }] } }]);
  assert.deepEqual(plain([drawn[1].graph, drawn[1].marks]), [GRAPH_1, {}], "a first revision has no diff");
  const [m2] = revisionsOf(page);
  assert.ok(m2.textContent.includes("Workflow, against 111111111111") && m2.textContent.includes("+2 added") && m2.textContent.includes("1 edited") && m2.textContent.includes("1 removed"));
});

test("a workflow revision drawn by graph.js: the added nodes tagged new, the edited one edited, the removed one named, labels as text; one whose parent is agentic says so", async () => {
  const page = mount(mccApi(), "#/agents/mcc-classifier", { serve: STORE });
  await page.settle();
  assertInert(page.app, svgParts(page));
  const [m2, m1] = revisionsOf(page);
  assert.deepEqual(drawnNodes(m2), [["/root", ""], ["/root/steps/0", ""], ["/root/steps/1", "new"], ["/root/steps/2", "edited"], ["/root/steps/3", "new"]]);
  assert.ok(m2.textContent.includes(`Is it a marketplace ${HOSTILE}`) && m2.textContent.includes(`Format the answer ${HOSTILE} (call)`), "a label and the removed node, as text");
  assert.ok(drawnNodes(m1).every(([, marks]) => marks === ""), "a first revision has no tags");
  const afterAgentic = mount(mccApi([{ ...MCC_2, parentKind: "agentic", diff: null }]), "#/agents/mcc-classifier", { serve: STORE });
  await afterAgentic.settle();
  assert.match(afterAgentic.app.textContent, /Its parent 111111111111 is an agentic revision: this revision runs a workflow in place of a prompt\./);
});

test("the runs: one table across the agent's revisions, escalated a state of its own, a missing cost unknown and a gone directory said in words", async () => {
  const page = mount(agentApi(), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  const rows = runRows(page);
  assert.deepEqual(rows.map((el) => el.getAttribute("href")), RUNS.map((r) => `#/runs/${r.id}`));
  assert.deepEqual(rows.map((el) => pills(el)[0]), [["pill live", "running"], ["pill escalated", "escalated"], ["pill ok", "completed"], ["pill error", "failed"], ["pill stopped", "stopped"]], "escalated is never drawn as failed");
  assert.deepEqual(rows.map((el) => all(el).find((c) => classOf(c).startsWith("c cost")).textContent), ["unknown", "$0.018", "$0.312", "$0", "unknown"], "a missing cost is unknown, never $0; a recorded 0 is $0");
  assert.ok(rows[1].textContent.includes("bbbbbbbbbbbb") && rows[1].textContent.includes("agentic") && rows[1].textContent.includes(`escalated at No public record ${HOSTILE}`));
  assert.ok(rows[4].textContent.includes("its directory is gone") && !rows[4].textContent.includes("never shown"));
  const filters = all(page.app).filter((el) => el.tagName === "A" && classOf(el).startsWith("filter"));
  assert.deepEqual(filters.map((el) => [el.getAttribute("href"), classOf(el), el.textContent]), [
    ["#/agents/company-researcher", "filter on", "All revisions"],
    [`#/agents/company-researcher?revision=${REV_B.id}`, "filter", "bbbbbbbbbbbb agentic"],
    [`#/agents/company-researcher?revision=${REV_A.id}`, "filter", "aaaaaaaaaaaa agentic"],
  ]);
});

test("a cost under a cent keeps two significant digits, so a run that cost $0.00014 never reads as free beside one that cost $0.016", async () => {
  const cheap = [run("run-w", REV_B, "completed", { costUsd: 0.00014 }), run("run-m", REV_B, "completed", { costUsd: 0.0011 }), run("run-a", REV_B, "completed", { costUsd: 0.016 }), run("run-b", REV_B, "completed", { costUsd: 1.5 })];
  const page = mount(agentApi({ "api/runs?agent=company-researcher": cheap }), "#/agents/company-researcher", { serve: STORE });
  await page.settle();
  assert.deepEqual(runRows(page).map((el) => all(el).find((c) => classOf(c).startsWith("c cost")).textContent), ["$0.00014", "$0.0011", "$0.016", "$1.50"]);
});

test("the runs filtered by a revision: the filter is in the hash, so a reload keeps it, and the API is asked for that revision's runs", async () => {
  const api = agentApi({ [`api/runs?agent=company-researcher&revision=${REV_A.id}`]: RUNS.slice(3) });
  const page = mount(api, `#/agents/company-researcher?revision=${REV_A.id}`, { serve: STORE });
  await page.settle();
  assert.deepEqual(page.fetched.slice(0, 2), ["api/agents/company-researcher", `api/runs?agent=company-researcher&revision=${REV_A.id}`]);
  assert.equal(runRows(page).length, 2);
  assert.deepEqual(all(page.app).filter((el) => classOf(el) === "filter on").map((el) => [el.getAttribute("href"), el.getAttribute("aria-current")]), [[`#/agents/company-researcher?revision=${REV_A.id}`, "true"]]);
  assert.match(page.app.textContent, /2 runs of aaaaaaaaaaaa/);
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
const AGENTIC_RUN = { run: RUNS[2], agent: `Company researcher ${HOSTILE}`, note: "Prompt B", rows: TIMELINE };

test("an agentic run's page: its state, cost, agent, revision and summary, then the timeline as an agent home's run draws it", async () => {
  const page = mount({ "api/runs/run-3": AGENTIC_RUN }, "#/runs/run-3", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  const head = all(page.app).find((el) => classOf(el) === "card run-head");
  assert.deepEqual(pills(head), [["pill ok", "completed"], ["pill agentic", "agentic"]]);
  assert.ok(head.textContent.includes("Caterpillar builds machinery.") && head.textContent.includes("took 4m 00s") && head.textContent.includes("$0.312") && head.textContent.includes("2 tool calls") && head.textContent.includes("bbbbbbbbbbbb"));
  assert.deepEqual(all(head).filter((el) => el.tagName === "A").map((el) => [el.getAttribute("href"), el.textContent]), [["#/agents/company-researcher", `Company researcher ${HOSTILE}`]]);
  assert.deepEqual(all(page.app).filter((el) => el.tagName === "DETAILS" && classOf(el).startsWith("call")).map(classOf), ["call many ok", "call ok", "call ok"], "the two one-call rounds fold, as a home's page folds them");
  assert.ok(all(page.app).some((el) => el.tagName === "B" && el.textContent === "Done"));
  assert.deepEqual(all(page.document.getElementById("crumbs")).filter((el) => el.tagName === "A").map((el) => el.textContent), ["Agents", `Company researcher ${HOSTILE}`, "Run"]);
  assert.equal(page.timers.size, 0);

  const noCost = mount({ "api/runs/run-1": { ...AGENTIC_RUN, run: { ...RUNS[4], gone: undefined }, gone: true } }, "#/runs/run-1", { serve: STORE });
  await noCost.settle();
  assert.match(noCost.app.textContent, /cost unknown/);
  assert.match(noCost.app.textContent, /This run's directory is gone from the store's runs folder: only its row is left\./);
  assert.equal(all(noCost.app).filter((el) => classOf(el) === "card timeline").length, 0);
});

test("a running run's page is read again every 2 s, says what it spent so far, and keeps itself through a failed refresh", async () => {
  const api = { "api/runs/run-5": { ...AGENTIC_RUN, run: RUNS[0] } };
  const page = mount(api, "#/runs/run-5", { serve: STORE });
  await page.settle();
  assert.ok(page.app.textContent.includes("refreshing every 2 s") && page.app.textContent.includes("$0.200 so far"));
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [2000]);
  api["api/runs/run-5"] = [503, { error: "busy" }];
  await page.tick();
  assert.ok(page.app.textContent.includes("refreshing every 2 s") && !page.app.textContent.includes("Could not read"), "the run stays");
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [2000], "and it tries again");
  api["api/runs/run-5"] = { ...AGENTIC_RUN, run: { ...RUNS[0], state: "completed", costUsd: 0.3 } };
  await page.tick();
  assert.ok(page.app.textContent.includes("$0.300") && page.timers.size === 0, "a finished run is not read again");
  await page.go("#/");
  const first = mount({ "api/runs/run-5": [503, { error: "busy" }] }, "#/runs/run-5", { serve: STORE });
  await first.settle();
  assert.match(first.app.textContent, /Could not read the agent store\. 503 busy/, "a first read that fails says why");
});

const PRIVATE = "/root/steps/1/branches/private/body";
const PUBLIC = "/root/steps/1/branches/public/body";
const BRIEF = {
  nodes: [node("/root", "chain", "chain"), node("/root/steps/0", "call", "Read the site"), node("/root/steps/1", "route", "Jev: public or private"), node(PUBLIC, "call", "Check the filing"), node(PRIVATE, "escalate", `No public record ${HOSTILE}`)],
  edges: [{ from: "/root", to: "/root/steps/0", kind: "next" }, { from: "/root/steps/0", to: "/root/steps/1", kind: "next" }, { from: "/root/steps/1", to: PUBLIC, kind: "route" }, { from: "/root/steps/1", to: PRIVATE, kind: "route" }],
};
const ESCALATED = { "/root": "escalated", "/root/steps/0": "done", "/root/steps/1": "escalated", [PUBLIC]: "not-run", [PRIVATE]: "escalated" };
const REV_C = revision("c", { kind: "workflow" });
const WORKFLOW_RUN = {
  run: run("run-9", REV_C, "escalated", { startedAt: "2026-10-23T05:10:00.000Z", endedAt: "2026-10-23T05:11:00.000Z", costUsd: 0.018, summary: `escalated at No public record ${HOSTILE}` }),
  agent: "Company researcher",
  note: "The cheap one",
  workflow: { graph: BRIEF, status: ESCALATED, outcome: "escalated", escalatedAt: { path: PRIVATE, label: `No public record ${HOSTILE}` } },
};

test("a workflow run's page: the graph with each node's state, the branch it took and the node an escalation stopped at, drawn as escalated, never failed, and no answer", async () => {
  const drawn = [];
  const page = mount({ "api/runs/run-9": WORKFLOW_RUN }, "#/runs/run-9", { serve: STORE, window: { drawWorkflowGraph: (svg, graph, marks) => drawn.push({ svg, graph, marks }) } });
  await page.settle();
  assertInert(page.app, drawn.map((d) => d.svg));
  assert.deepEqual(plain([drawn[0].graph, drawn[0].marks]), [BRIEF, { status: ESCALATED, taken: [PRIVATE], fired: PRIVATE }]);
  const head = all(page.app).find((el) => classOf(el) === "card run-head");
  assert.deepEqual(pills(head), [["pill escalated", "escalated"], ["pill workflow", "workflow"]]);
  assert.ok(head.textContent.includes("$0.018") && !head.textContent.includes("tool call"));
  assert.match(page.app.textContent, /Escalated at No public record/);
  assert.equal(all(page.app).filter((el) => classOf(el) === "row answer").length, 0, "an escalated run has no answer");
  assert.ok(!pills(page.app).some(([cls]) => cls === "pill error"));
});

test("a completed workflow run's page shows its answer as text; an escalated one's graph has each node's state, the fired exit and the containers on its path escalated", async () => {
  const completed = { ...WORKFLOW_RUN, run: { ...WORKFLOW_RUN.run, state: "completed" }, workflow: { graph: BRIEF, status: { "/root": "done", [PUBLIC]: "done", [PRIVATE]: "not-run" }, outcome: "completed", output: { brief: `Filed ${HOSTILE}` } } };
  const page = mount({ "api/runs/run-9": completed }, "#/runs/run-9", { serve: STORE });
  await page.settle();
  assertInert(page.app, svgParts(page));
  assert.deepEqual(all(page.app).filter((el) => classOf(el) === "row answer").map((el) => el.textContent), [`Answer${JSON.stringify({ brief: `Filed ${HOSTILE}` })}`], "anything but a string as compact JSON");
  const text = mount({ "api/runs/run-9": { ...completed, workflow: { ...completed.workflow, output: `Filed ${HOSTILE}` } } }, "#/runs/run-9", { serve: STORE });
  await text.settle();
  assert.ok(all(text.app).some((el) => el.tagName === "PRE" && el.textContent === `Filed ${HOSTILE}`), "a string as written");

  const escalated = mount({ "api/runs/run-9": WORKFLOW_RUN }, "#/runs/run-9", { serve: STORE });
  await escalated.settle();
  assertInert(escalated.app, svgParts(escalated));
  assert.deepEqual(drawnNodes(escalated.app), [["/root", "escalated"], ["/root/steps/0", "done"], ["/root/steps/1", "escalated"], [PUBLIC, "not-run"], [PRIVATE, "escalated fired"]].sort(([a], [b]) => (a < b ? -1 : 1)));
  assert.ok(escalated.app.textContent.includes(`No public record ${HOSTILE}`));
});

test("an escalated run's page brings the exit that fired into view inside its graph's box; a run with none scrolls nothing", async () => {
  const page = mount({ "api/runs/run-9": WORKFLOW_RUN }, "#/runs/run-9", { serve: STORE });
  await page.settle();
  const scrolled = all(page.app).filter((el) => el.scrolledIntoView);
  assert.deepEqual(scrolled.map((el) => [el.getAttribute("data-path"), plain(el.scrolledIntoView)]), [[PRIVATE, { block: "nearest", inline: "center" }]]);
  const completed = mount({ "api/runs/run-9": { ...WORKFLOW_RUN, run: { ...WORKFLOW_RUN.run, state: "completed" }, workflow: { graph: BRIEF, status: { "/root": "done" }, outcome: "completed" } } }, "#/runs/run-9", { serve: STORE });
  await completed.settle();
  assert.equal(all(completed.app).filter((el) => el.scrolledIntoView).length, 0);
});

test("a workflow run its reader refuses shows that one line in place of the graph, with the run's row still shown", async () => {
  const refused = { ...WORKFLOW_RUN, workflow: undefined, refused: "a run in the keyed layout is not read here" };
  const page = mount({ "api/runs/run-9": refused }, "#/runs/run-9", { serve: STORE });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(all(page.app).filter((el) => classOf(el) === "note").map((el) => el.textContent), ["a run in the keyed layout is not read here"]);
  assert.deepEqual(pills(page.app)[0], ["pill escalated", "escalated"]);
  assert.ok(page.app.textContent.includes("$0.018") && page.app.textContent.includes(`escalated at No public record ${HOSTILE}`));
});
