// serve.js on the store's page, offline: graph.js, serve.js and page.js run on pi-durable-agent's small test DOM over a
// stub of the /v2 routes the page calls (every run, an agent's definition, a new agent or revision, the current revision,
// a new run, a run's timeline and its messages), in the shapes agentrun-serve answers, and of the store's /api. Names and
// texts carry markup, which arrives as text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { all, assertInert, mount } from "../../pi-durable-agent/test/page-dom.mjs";

const SERVE_JS = readFileSync(new URL("../src/page/serve.js", import.meta.url), "utf8");
const HOSTILE = '<img src=x onerror="alert(1)">';
const classOf = (el) => el.getAttribute("class") ?? "";
const plain = (value) => JSON.parse(JSON.stringify(value));
const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const AGENTS = [
  { id: "calc", name: `Calc ${HOSTILE}`, createdAt: "2026-10-21T09:00:00.000Z", current: REV_B, currentKind: "agentic", runs: 2 },
  { id: "brief", name: "Brief", createdAt: "2026-10-22T09:00:00.000Z", current: "c".repeat(64), currentKind: "workflow", runs: 1 },
];
/** A run as GET /v2/runs lists it. */
const summary = (run_id, agent_id, revision, kind, status, state, created_at, ended_at, usd) => ({ run_id, agent_id, agent_version: 1, revision, kind, sha: null, status, state, title: `Input of ${run_id}`, created_at, ended_at, cost: { usd, basis: "estimate", charge_state: null, cap_usd: null } });
const RUNS = [
  summary("run-3", "brief", "c".repeat(64), "workflow", "input_required", "waiting", "2026-10-23T05:00:00.000Z", null, null),
  summary("run-2", "calc", REV_B, "agentic", "completed", "idle", "2026-10-23T04:00:00.000Z", "2026-10-23T04:01:00.000Z", 0.312),
  summary("run-1", "calc", REV_A, "agentic", "failed", "idle", "2026-10-22T04:00:00.000Z", "2026-10-22T04:01:00.000Z", 0.00014),
];
const revision = (id, current, note) => ({ id, kind: "agentic", current, createdAt: "2026-10-22T10:00:00.000Z", note, parent: null, parentKind: null, diff: null, body: { instructions: "Answer.", tools: ["read"], skills: {} } });
const AGENT_PAGE = { agent: { id: "calc", name: `Calc ${HOSTILE}`, createdAt: "2026-10-21T09:00:00.000Z", current: REV_B }, revisions: [revision(REV_B, true, "Cites"), revision(REV_A, false, `First ${HOSTILE}`)] };
/** A run as GET /v2/runs/{id} answers it while it works. */
const LIVE = { ...summary("run-9", "calc", REV_B, "agentic", "working", "working", "2026-10-23T06:00:00.000Z", null, 0.01), updated_at: "2026-10-23T06:00:01.000Z", result: null, error: null, poll_after_ms: 1000 };
const CAPABILITIES = { backend: "local", contract: "agentrun.v2/0", features: { agents: { create: true, list: true, update: true, revisions: true }, thinking: ["low", "medium", "high", "xhigh", "max"] }, tools: ["read", "write", "edit", "ask_person"].map((name) => ({ name, summary: "", nodes: name !== "ask_person", available: true })) };
/** An agent as GET /v2/agents/{id} answers it: the current revision's definition, numbered, and the revision as its ETag. */
const agentView = (id, revision, definition) => ({ agent_id: id, definition: { id, version: 2, ...definition, skills: [] }, kind: definition.workflow ? "workflow" : "agentic", revision, revisions: 2, source: null, skills: [], sign_ins: [], runs: { count: 0, live: 0 }, region: "local", home_etag: `"${revision}"`, created_at: "2026-10-21T09:00:00.000Z", updated_at: "2026-10-22T10:00:00.000Z" });

/** A stub of the routes: `answers` maps "METHOD path" (or a path for a GET) to a body, [status, body] or a function of
 *  the parsed body; every call is kept in `calls`. A timeline long poll waits for `push`, and an abort ends it. */
function stub(answers) {
  const calls = [];
  const queued = [];
  const waiting = [];
  const fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, path, body, headers: init.headers, signal: init.signal });
    let answer = answers[`${method} ${path}`] ?? (method === "GET" ? answers[path] : undefined);
    if (answer === undefined && /\/timeline\?wait_ms=[1-9]/.test(path)) {
      answer = await new Promise((resolve, reject) => {
        if (queued.length) return resolve(queued.shift());
        waiting.push(resolve);
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (typeof answer === "function") answer = await answer(body);
    const [status, data] = answer === undefined ? [404, { error: { code: "not_found", message: `no route ${path}` } }] : Array.isArray(answer) && typeof answer[0] === "number" ? answer : [200, answer];
    return { ok: status < 300, status, text: async () => JSON.stringify(data) };
  };
  const push = (page) => (waiting.length ? waiting.shift()(page) : queued.push(page));
  return { fetch, calls, push, answer: (more) => Object.assign(answers, more), writes: () => calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, plain(c.body)]) };
}

function open(hash, answers) {
  const api = stub(answers);
  const page = mount({}, hash, { serve: "store", fetch: api.fetch, scripts: [["serve.js", SERVE_JS]] });
  return { page, api };
}
const find = (page, tag, name) => all(page.app).find((el) => el.tagName === tag && el.name === name);
const buttonNamed = (page, text) => all(page.app).find((el) => el.tagName === "BUTTON" && el.textContent === text);
const problemText = (page) => all(page.app).filter((el) => classOf(el) === "problem").map((el) => el.textContent);
const pillsOf = (page, cardClass) => all(all(page.app).find((el) => classOf(el) === cardClass)).filter((el) => classOf(el).startsWith("pill ")).map((el) => [classOf(el), el.textContent]);

test("every run: newest first across the agents, with its agent, revision, kind, state, cost and start; a row opens the run, and markup is text", async () => {
  const { page, api } = open("#/runs", { "v2/runs?limit=100": { runs: RUNS, next_cursor: null }, "api/store": { agents: AGENTS } });
  await page.settle();
  assertInert(page.app);
  assert.deepEqual(api.calls.map((c) => c.path), ["v2/runs?limit=100", "api/store"]);
  const rows = all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "run");
  assert.deepEqual(rows.map((el) => el.getAttribute("href")), ["#/runs/run-3", "#/runs/run-2", "#/runs/run-1"]);
  const cells = (row) => all(row).filter((el) => /^c /.test(classOf(el))).map((el) => [classOf(el), el.textContent]);
  const [waiting, done, failed] = rows.map(cells);
  assert.deepEqual(waiting.slice(1), [["c state", "input required"], ["c agent", "Brief"], ["c rev", "cccccccccccc workflow"], ["c cost unknown", "unknown"], ["c id", "run-3"]]);
  assert.deepEqual(done.slice(1), [["c state", "completed"], ["c agent", `Calc ${HOSTILE}`], ["c rev", "bbbbbbbbbbbb agentic"], ["c cost", "$0.312"], ["c id", "run-2"]]);
  assert.match(done[0][1], /^2026-10-2\d \d\d:\d\d/);
  assert.deepEqual(all(rows[2]).filter((el) => classOf(el).startsWith("pill ")).map(classOf), ["pill error"]);
  assert.deepEqual(failed.slice(1, 2).concat(failed.slice(4, 5)), [["c state", "failed"], ["c cost", "$0.00014"]], "a run under a tenth of a cent is not free");
  assert.equal(all(page.app).find((el) => el.tagName === "H1").textContent, "3 runs");
  assert.equal(page.document.title, "All runs · AgentRun Server");
  assert.deepEqual(all(page.document.getElementById("crumbs")).filter((el) => el.tagName === "A").map((el) => el.textContent), ["Agents", "All runs"]);
  const filters = all(page.app).filter((el) => el.tagName === "A" && classOf(el).startsWith("filter"));
  assert.deepEqual(filters.map((el) => [el.textContent, el.getAttribute("href"), classOf(el)]).slice(0, 4), [["All agents", "#/runs", "filter on"], [`Calc ${HOSTILE}`, "#/runs?agent=calc", "filter"], ["Brief", "#/runs?agent=brief", "filter"], ["Any state", "#/runs", "filter on"]]);
  assert.deepEqual(filters.slice(4).map((el) => el.textContent), ["queued", "working", "input required", "completed", "failed", "cancelled"]);
});

test("every run, filtered by agent and state in the hash, so a reload keeps them; a next page comes with Show more", async () => {
  const { page, api } = open("#/runs?agent=calc&status=failed", {
    "v2/runs?limit=100&agent=calc&status=failed": { runs: [RUNS[2]], next_cursor: "Mg" },
    "v2/runs?limit=100&agent=calc&status=failed&cursor=Mg": { runs: [{ ...RUNS[2], run_id: "run-0" }], next_cursor: null },
    "api/store": { agents: AGENTS },
  });
  await page.settle();
  assert.equal(api.calls[0].path, "v2/runs?limit=100&agent=calc&status=failed");
  const on = all(page.app).filter((el) => classOf(el) === "filter on").map((el) => [el.textContent, el.getAttribute("href")]);
  assert.deepEqual(on, [[`Calc ${HOSTILE}`, "#/runs?agent=calc&status=failed"], ["failed", "#/runs?agent=calc&status=failed"]]);
  assert.equal(all(page.app).find((el) => el.tagName === "H1").textContent, "1 run so far");
  buttonNamed(page, "Show more").click();
  await page.settle();
  assert.equal(api.calls.at(-1).path, "v2/runs?limit=100&agent=calc&status=failed&cursor=Mg");
  assert.deepEqual(all(page.app).filter((el) => el.tagName === "A" && classOf(el) === "run").map((el) => el.getAttribute("href")), ["#/runs/run-1", "#/runs/run-0"]);
  assert.equal(all(page.app).find((el) => el.tagName === "H1").textContent, "2 runs");
  assert.equal(buttonNamed(page, "Show more"), undefined, "no more pages");
  const none = open("#/runs?status=cancelled", { "v2/runs?limit=100&status=cancelled": { runs: [], next_cursor: null }, "api/store": { agents: AGENTS } });
  await none.page.settle();
  assert.match(none.page.app.textContent, /No run matches\./);
});

test("a new agent: name, description, a prompt, a model and the tools capabilities offer, sent to POST /v2/agents as JSON; then its page", async () => {
  const { page, api } = open("#/new", { "v2/capabilities": CAPABILITIES, "POST v2/agents": [201, agentView("researcher", REV_A, { name: "Researcher", instructions: "Research one company.", tools: ["read"] })] });
  await page.settle();
  assert.deepEqual(all(page.app).filter((el) => el.tagName === "INPUT" && el.getAttribute("type") === "checkbox").map((el) => [el.value, el.checked]), [["read", false], ["write", false], ["edit", false], ["ask_person", false]]);
  find(page, "INPUT", "name").value = "  Researcher ";
  find(page, "INPUT", "description").value = "Writes briefs.";
  find(page, "TEXTAREA", "instructions").value = "Research one company.";
  find(page, "INPUT", "model").value = " openai/gpt-5 ";
  const thinking = find(page, "SELECT", "thinking");
  assert.deepEqual(all(thinking).map((el) => [el.value, el.textContent]), [["", "the run's effort"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]], "the levels capabilities offer, never off");
  thinking.value = "high";
  const boxes = all(page.app).filter((el) => el.getAttribute("type") === "checkbox");
  boxes[0].checked = true;
  boxes[3].checked = true;
  find(page, "INPUT", "name").value = " ";
  buttonNamed(page, "Create agent").click();
  await page.settle();
  assert.deepEqual(problemText(page), ["The agent needs a name."]);
  assert.deepEqual(api.writes(), [], "nothing is sent");
  find(page, "INPUT", "name").value = "  Researcher ";
  buttonNamed(page, "Create agent").click();
  await page.settle();
  assert.deepEqual(api.writes(), [["POST", "v2/agents", { definition: { name: "Researcher", tools: ["read", "ask_person"], description: "Writes briefs.", instructions: "Research one company.", model: "openai/gpt-5", thinking: "high" } }]]);
  const sent = api.calls.at(-1);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(page.window.location.hash, "#/agents/researcher");
});

test("a new workflow agent: the workflow's JSON in place of a prompt and a model; JSON that does not parse, and the server's refusal with its fields, are said", async () => {
  const { page, api } = open("#/new", {
    "v2/capabilities": CAPABILITIES,
    "POST v2/agents": (body) => (body.definition.workflow.steps ? [201, { agent_id: "flow" }] : [422, { error: { code: "input_invalid", message: "the workflow does not check", fields: [{ field: "definition.workflow.steps", reason: "missing", message: `steps is required ${HOSTILE}` }] } }]),
  });
  await page.settle();
  const [prompt, workflow] = ["Prompt", "Workflow"].map((text) => buttonNamed(page, text));
  assert.deepEqual([prompt.getAttribute("aria-pressed"), workflow.getAttribute("aria-pressed")], ["true", "false"]);
  const fields = all(page.app).filter((el) => classOf(el) === "field");
  const hidden = () => fields.filter((el) => el.hidden).map((el) => el.childNodes[0].textContent);
  assert.deepEqual(hidden(), ["Workflow"]);
  workflow.click();
  assert.deepEqual(hidden(), ["Prompt", "Model", "Thinking"], "a workflow revision keeps no model or thinking level");
  assert.equal(workflow.getAttribute("aria-pressed"), "true");
  find(page, "INPUT", "name").value = "Flow";
  find(page, "TEXTAREA", "workflow").value = "{ not json";
  buttonNamed(page, "Create agent").click();
  await page.settle();
  assert.match(problemText(page)[0], /^The workflow is not JSON: /);
  assert.deepEqual(api.writes(), []);
  find(page, "TEXTAREA", "workflow").value = '{"name":"flow"}';
  buttonNamed(page, "Create agent").click();
  await page.settle();
  assert.deepEqual(problemText(page), [`422 the workflow does not checkdefinition.workflow.steps: steps is required ${HOSTILE}`]);
  assert.equal(buttonNamed(page, "Create agent").disabled, false, "the button is back for another try");
  find(page, "TEXTAREA", "workflow").value = '{"name":"flow","steps":[]}';
  buttonNamed(page, "Create agent").click();
  await page.settle();
  assert.deepEqual(api.writes().at(-1), ["POST", "v2/agents", { definition: { name: "Flow", tools: [], workflow: { name: "flow", steps: [] } } }]);
  assert.equal(page.window.location.hash, "#/agents/flow");
});

test("edit: the form is the current definition, a tool the server does not bind still checked; saving PUTs it to .../definition with a note, never the name or description the store keeps", async () => {
  const definition = { name: `Calc ${HOSTILE}`, description: "Adds.", instructions: "Answer.", model: "openai/gpt-5", thinking: "low", tools: ["read", "web_fetch"] };
  let stale = false;
  const { page, api } = open("#/agents/calc/edit", {
    "v2/capabilities": CAPABILITIES,
    "v2/agents/calc": agentView("calc", REV_B, definition),
    "PUT v2/agents/calc/definition": () => (stale ? [412, { error: { code: "precondition_failed", message: `If-Match is "${REV_B}", and the agent's current revision is "${REV_A}"` } }] : agentView("calc", REV_A, definition)),
  });
  await page.settle();
  assert.equal(find(page, "INPUT", "name"), undefined);
  assert.equal(find(page, "INPUT", "description"), undefined);
  assert.equal(all(page.app).find((el) => el.tagName === "H1").textContent, `Calc ${HOSTILE}`);
  assert.match(all(page.app).find((el) => classOf(el) === "lede").textContent, /^Adds\. Saving commits a new revision/);
  assert.equal(find(page, "TEXTAREA", "instructions").value, "Answer.");
  assert.equal(find(page, "INPUT", "model").value, "openai/gpt-5");
  assert.equal(find(page, "SELECT", "thinking").value, "low", "an edit keeps the revision's thinking level");
  const boxes = all(page.app).filter((el) => el.getAttribute("type") === "checkbox");
  assert.deepEqual(boxes.map((el) => [el.value, el.checked]), [["read", true], ["write", false], ["edit", false], ["ask_person", false], ["web_fetch", true]]);
  assert.equal(classOf(boxes[4].parentNode), "unbound");
  assert.deepEqual(all(page.document.getElementById("crumbs")).filter((el) => el.tagName === "A").map((el) => [el.textContent, el.getAttribute("href")]), [["Agents", "#/"], [`Calc ${HOSTILE}`, "#/agents/calc"], ["Edit", "#/agents/calc/edit"]]);
  find(page, "TEXTAREA", "instructions").value = "Answer, and show the sum.";
  find(page, "INPUT", "note").value = "Shows its work";
  boxes[4].checked = false;
  buttonNamed(page, "Commit revision").click();
  await page.settle();
  assert.deepEqual(api.writes(), [["PUT", "v2/agents/calc/definition", { definition: { tools: ["read"], instructions: "Answer, and show the sum.", model: "openai/gpt-5", thinking: "low" }, note: "Shows its work" }]], "no id, version or skills: the server numbers the revision and carries the skill files over");
  assert.equal(api.calls.at(-1).headers["if-match"], `"${REV_B}"`, "the edit commits onto the revision the form read");
  assert.equal(page.window.location.hash, "#/agents/calc");
  stale = true;
  buttonNamed(page, "Commit revision").click();
  await page.settle();
  assert.deepEqual(problemText(page), ["The agent has a newer revision than the one this form started from: open Edit again to start from it."]);

  const flow = open("#/agents/brief/edit", { "v2/capabilities": { ...CAPABILITIES, tools: undefined }, "v2/agents/brief": agentView("brief", "c".repeat(64), { name: "Brief", workflow: { name: "brief", steps: [] }, tools: [] }) });
  await flow.page.settle();
  assert.equal(buttonNamed(flow.page, "Workflow").getAttribute("aria-pressed"), "true");
  assert.equal(find(flow.page, "TEXTAREA", "workflow").value, JSON.stringify({ name: "brief", steps: [] }, null, 2));
  assert.match(flow.page.app.textContent, /This server binds no tools\./, "capabilities without a tools list offers none");
});

test("an agent's page: Edit, a run form on its revisions, and Make current on each revision that is not; it posts {revision} and the page is read again", async () => {
  const answers = { "api/agents/calc": AGENT_PAGE, "api/runs?agent=calc": [], "POST v2/agents/calc/current": { agent_id: "calc" } };
  const { page, api } = open("#/agents/calc", answers);
  await page.settle();
  const card = all(page.app).find((el) => classOf(el) === "card agent");
  assert.deepEqual(all(card).filter((el) => el.tagName === "A" && classOf(el) === "btn quiet").map((el) => [el.textContent, el.getAttribute("href")]), [["Edit: commit a new revision", "#/agents/calc/edit"]]);
  const options = all(card).filter((el) => el.tagName === "OPTION").map((el) => [el.value, el.textContent, Boolean(el.selected)]);
  assert.deepEqual(options, [[REV_B, "bbbbbbbbbbbb · agentic · current · Cites", true], [REV_A, `aaaaaaaaaaaa · agentic · First ${HOSTILE}`, false]]);
  const heads = all(page.app).filter((el) => classOf(el) === "rev-head");
  assert.deepEqual(heads.map((head) => all(head).filter((el) => el.tagName === "BUTTON").map((el) => el.textContent)), [[], ["Make current"]]);
  const before = api.calls.length;
  all(heads[1]).find((el) => el.tagName === "BUTTON").click();
  await page.settle();
  assert.deepEqual(api.writes(), [["POST", "v2/agents/calc/current", { revision: REV_A }]]);
  assert.deepEqual(api.calls.slice(before + 1).map((c) => c.path), ["api/agents/calc", "api/runs?agent=calc", "api/runs?agent=calc"], "the page is read again, its comparison of revisions too");
});

test("start a run: its input, on the revision the form shows picked (the current one unless another is), always named, POSTed to the agent's runs, a workflow's as a JSON object; then the run's page", async () => {
  const answers = { "api/agents/calc": AGENT_PAGE, "api/runs?agent=calc": [], "POST v2/agents/calc/runs": [202, { ...LIVE, status: "queued" }] };
  const { page, api } = open("#/agents/calc", answers);
  await page.settle();
  buttonNamed(page, "Start run").click();
  await page.settle();
  assert.deepEqual(problemText(page), ["Write the run's input first."]);
  find(page, "TEXTAREA", "input").value = "What is six times seven?";
  buttonNamed(page, "Start run").click();
  await page.settle();
  assert.deepEqual(api.writes(), [["POST", "v2/agents/calc/runs", { input: { content: "What is six times seven?" }, revision: REV_B }]], "the current revision is named too, so one committed in another tab does not change what runs");
  assert.equal(page.window.location.hash, "#/runs/run-9");
  find(page, "SELECT", "revision").value = REV_A;
  buttonNamed(page, "Start run").click();
  await page.settle();
  assert.deepEqual(api.writes().at(-1), ["POST", "v2/agents/calc/runs", { input: { content: "What is six times seven?" }, revision: REV_A }]);

  const flow = { agent: { ...AGENT_PAGE.agent, id: "brief" }, revisions: [{ ...revision("c".repeat(64), true, "A workflow"), kind: "workflow", graph: { nodes: [], edges: [] } }] };
  const wf = open("#/agents/brief", { "api/agents/brief": flow, "api/runs?agent=brief": [], "POST v2/agents/brief/runs": [202, { ...LIVE, run_id: "run-w", agent_id: "brief", kind: "workflow", status: "queued" }] });
  await wf.page.settle();
  find(wf.page, "TEXTAREA", "input").value = "Caterpillar";
  buttonNamed(wf.page, "Start run").click();
  await wf.page.settle();
  assert.match(problemText(wf.page)[0], /^A workflow's input is a JSON object its input schema takes/);
  find(wf.page, "TEXTAREA", "input").value = "[1]";
  buttonNamed(wf.page, "Start run").click();
  await wf.page.settle();
  assert.deepEqual(wf.api.writes(), [], "nothing is sent for input that is not an object");
  find(wf.page, "TEXTAREA", "input").value = '{"name": "Caterpillar", "website": "caterpillar.com"}';
  buttonNamed(wf.page, "Start run").click();
  await wf.page.settle();
  assert.deepEqual(wf.api.writes(), [["POST", "v2/agents/brief/runs", { input: { name: "Caterpillar", website: "caterpillar.com" }, revision: "c".repeat(64) }]]);
  assert.equal(wf.page.window.location.hash, "#/runs/run-w");
});

const row = (seq, kind, fields = {}) => ({ id: `r${seq}`, seq, kind, summary: fields.summary ?? kind, conversation_id: "c", ...fields });
const page = (fields) => ({ status: "working", state: "working", reset: false, rows: [], drop: [], next_after: 10, unchanged: false, has_more: false, final: false, cost: { usd: 0.01 }, ...fields });

test("a live run follows /v2's timeline with a long poll, an answer box while it waits on ask_person, and the store's page once it is final", async () => {
  const stored = { run: { id: "run-9", agent: "calc", revision: REV_B, kind: "agentic", state: "completed", startedAt: LIVE.created_at, endedAt: "2026-10-23T06:01:00.000Z", costUsd: 0.03, summary: "Asked, then answered." }, agent: "Calc", note: "Cites", rows: [row(0, "user_message", { text: "Pick a region" }), row(5, "final_answer", { text: "Using eu." })] };
  const { page: shown, api } = open("#/runs/run-9", {
    "v2/runs/run-9": LIVE,
    "v2/runs/run-9/timeline": page({ reset: true, rows: [row(0, "user_message", { text: `Pick a region ${HOSTILE}` })] }),
    "api/store": { agents: AGENTS },
    "POST v2/runs/run-9/messages": [202, { run_id: "run-9", mode: "answer" }],
    "api/runs/run-9": stored,
  });
  await shown.settle();
  assert.deepEqual(api.calls.map((c) => c.path), ["v2/runs/run-9", "v2/runs/run-9/timeline", "api/store", "v2/runs/run-9/timeline?wait_ms=25000&after=10"]);
  const head = all(shown.app).find((el) => classOf(el) === "card run-head");
  assert.ok(head.textContent.includes("working") && head.textContent.includes("$0.010 so far") && head.textContent.includes("live") && head.textContent.includes("bbbbbbbbbbbb"));
  assert.deepEqual(all(head).filter((el) => el.tagName === "A").map((el) => [el.getAttribute("href"), el.textContent]), [["#/agents/calc", `Calc ${HOSTILE}`]]);
  assert.ok(shown.app.textContent.includes(`Pick a region ${HOSTILE}`));
  assert.equal(all(shown.app).filter((el) => classOf(el).includes("answer-box")).length, 0, "no answer box while it works");

  const ask = [row(1, "tool_use", { tool_name: "ask_person", tool_use_id: "t1", summary: "Asked you: Which region?" }), row(2, "tool_result", { tool_name: "ask_person", tool_use_id: "t1", tool_status: "success" }), row(3, "waiting", { summary: "Waiting for you: Which region?", text: `Which region? ${HOSTILE}` })];
  api.push(page({ status: "input_required", state: "waiting", rows: ask, next_after: 20 }));
  await shown.settle();
  const box = all(shown.app).find((el) => classOf(el) === "card answer-box");
  assert.equal(all(box).find((el) => classOf(el) === "question").textContent, `Which region? ${HOSTILE}`);
  assert.equal(api.calls.at(-1).path, "v2/runs/run-9/timeline?wait_ms=25000&after=20");
  find(shown, "TEXTAREA", "answer").value = "eu";
  api.push(page({ status: "input_required", state: "waiting", rows: [row(6, "usage", { usage: { usd: 0.02 } })], next_after: 21, cost: { usd: 0.02 } }));
  await shown.settle();
  assert.ok(shown.app.textContent.includes("$0.020 so far"), "the page was drawn again");
  assert.equal(find(shown, "TEXTAREA", "answer").value, "eu", "and kept what is typed");
  buttonNamed(shown, "Send answer").click();
  await shown.settle();
  assert.deepEqual(api.writes(), [["POST", "v2/runs/run-9/messages", { content: "eu" }]]);
  assert.equal(find(shown, "TEXTAREA", "answer").value, "");

  api.push(page({ status: "working", rows: [row(4, "user_message", { text: "eu" })], drop: ["r3"], next_after: 30 }));
  await shown.settle();
  assert.equal(all(shown.app).filter((el) => classOf(el) === "card answer-box").length, 0, "the box goes once it is answered");
  assert.ok(!shown.app.textContent.includes("Waiting for you"), "a dropped row is gone");
  api.push(page({ status: "completed", state: "idle", rows: [row(5, "final_answer", { text: "Using eu." })], next_after: 40, final: true }));
  await shown.settle();
  assert.deepEqual(api.calls.slice(-2).map((c) => c.path), ["api/runs/run-9", "api/agents/calc"], "a final run is the store's own page, which reads whether its revision learns");
  assert.ok(all(shown.app).find((el) => classOf(el) === "card run-head").textContent.includes("Asked, then answered."));
});

test("a live run's view drops the run's own start and end rows, as its stored view has none: a waiting run shows its question, not \"Run finished\"", async () => {
  const quiet = [
    row(0, "phase", { id: "c1:run:start", summary: "Run started" }),
    row(1, "user_message", { text: "Pick a region" }),
    row(2, "tool_use", { tool_name: "ask_person", tool_use_id: "t1", summary: "Asked you: Which region?" }),
    row(3, "tool_result", { tool_name: "ask_person", tool_use_id: "t1", tool_status: "success" }),
    row(4, "phase", { id: "c1:run:end", summary: "Run finished" }),
    row(5, "waiting", { summary: "Waiting for you: Which region?", text: "Which region?" }),
    row(6, "phase", { id: "c1:run:end~2", summary: "Run finished" }),
    row(7, "phase", { summary: "Retrying in 5 s: overloaded" }),
  ];
  const { page: shown } = open("#/runs/run-9", { "v2/runs/run-9": { ...LIVE, status: "input_required", state: "waiting" }, "v2/runs/run-9/timeline": page({ reset: true, status: "input_required", state: "waiting", rows: quiet }), "api/store": { agents: AGENTS } });
  await shown.settle();
  const timeline = all(shown.app).find((el) => classOf(el) === "card timeline");
  assert.ok(!timeline.textContent.includes("Run started") && !timeline.textContent.includes("Run finished"));
  assert.ok(timeline.textContent.includes("Waiting for you: Which region?") && timeline.textContent.includes("Retrying in 5 s: overloaded"), "every other phase row stays");
  assert.equal(all(shown.app).find((el) => classOf(el) === "question").textContent, "Which region?");
});

test("a run that ended escalated is drawn escalated, never failed: /v2 says failed with error.code escalated, in All runs and in the live header", async () => {
  const escalated = { error: { code: "escalated", message: "Escalated at No public record" } };
  const list = open("#/runs", { "v2/runs?limit=100": { runs: [{ ...RUNS[1], run_id: "run-e", status: "failed", ...escalated }, RUNS[2]], next_cursor: null }, "api/store": { agents: AGENTS } });
  await list.page.settle();
  const statePills = all(list.page.app).filter((el) => classOf(el) === "c state").map((cell) => all(cell).filter((el) => classOf(el).startsWith("pill ")).map((el) => [classOf(el), el.textContent])[0]);
  assert.deepEqual(statePills, [["pill escalated", "escalated"], ["pill error", "failed"]], "a plain failure stays failed");

  const ended = open("#/runs/run-9", { "v2/runs/run-9": { ...LIVE, status: "failed", state: "idle", ...escalated }, "v2/runs/run-9/timeline": page({ reset: true, status: "failed", state: "idle" }), "api/store": { agents: AGENTS } });
  await ended.page.settle();
  assert.deepEqual(pillsOf(ended.page, "card run-head")[0], ["pill escalated", "escalated"]);

  const live = open("#/runs/run-9", { "v2/runs/run-9": LIVE, "v2/runs/run-9/timeline": page({ reset: true }), "api/store": { agents: AGENTS } });
  await live.page.settle();
  assert.deepEqual(pillsOf(live.page, "card run-head")[0], ["pill live", "working"]);
  live.api.calls.length = 0;
  const answers = { "v2/runs/run-9": { ...LIVE, status: "failed", state: "idle", ...escalated } };
  live.api.answer(answers);
  live.api.push(page({ status: "failed", state: "idle", next_after: 20 }));
  await live.page.settle();
  assert.ok(live.api.calls.some((c) => c.path === "v2/runs/run-9"), "a run that turns failed is read again for its error");
  assert.deepEqual(pillsOf(live.page, "card run-head")[0], ["pill escalated", "escalated"]);
});

test("leaving a live run aborts its long poll; a run this server never ran, or a final one, is the store's own run page", async () => {
  const stored = { run: { id: "old", agent: "calc", revision: REV_A, kind: "agentic", state: "completed", startedAt: LIVE.created_at, endedAt: LIVE.created_at }, agent: "Calc", rows: [] };
  const { page: shown, api } = open("#/runs/run-9", { "v2/runs/run-9": LIVE, "v2/runs/run-9/timeline": page({ reset: true }), "api/store": { agents: AGENTS }, "api/runs/old": stored, "v2/runs/old": [404, { error: { code: "not_found", message: "no run old" } }] });
  await shown.settle();
  const poll = api.calls.at(-1);
  assert.match(poll.path, /wait_ms=25000/);
  await shown.go("#/runs/old");
  assert.equal(poll.signal.aborted, true);
  assert.ok(api.calls.some((c) => c.path === "api/runs/old"), "a run /v2 does not know is read from the store");
  assert.equal(shown.timers.size, 0, "nothing polls after the abort");

  const final = open("#/runs/run-9", { "v2/runs/run-9": { ...LIVE, status: "completed" }, "v2/runs/run-9/timeline": page({ final: true, status: "completed" }), "api/store": { agents: AGENTS }, "api/runs/run-9": { ...stored, run: { ...stored.run, id: "run-9" } } });
  await final.page.settle();
  assert.deepEqual(final.api.calls.map((c) => c.path), ["v2/runs/run-9", "v2/runs/run-9/timeline", "api/store", "api/runs/run-9", "api/agents/calc"]);
});

/** Revisions and runs shaped like the MCC classifier's A, B and C: two prompts and a workflow, eight runs each. */
const MCC = (() => {
  const rev = (letter, kind, note, current, createdAt, tools = ["read"]) => ({ ...revision(letter.repeat(64), current, note), kind, createdAt, body: { tools, skills: {}, ...(kind === "agentic" ? { instructions: "Pick the MCC." } : {}) }, ...(kind === "workflow" ? { graph: { nodes: [], edges: [] } } : {}) });
  const revisions = [
    rev("d", "agentic", "Prompt D: not run yet", false, "2026-10-23T16:53:00.000Z"),
    rev("c", "workflow", "The cheap one: read the home page, one fast model step", true, "2026-10-23T16:52:00.000Z"),
    rev("b", "agentic", "Prompt B: a rubric", false, "2026-10-23T16:51:00.000Z"),
    rev("a", "agentic", "Prompt A: the plain instructions", false, "2026-10-23T16:50:00.000Z"),
  ];
  const runs = [];
  const add = (letter, costs, seconds, states) =>
    costs.forEach((cost, i) => {
      const startedAt = new Date(Date.UTC(2026, 9, 23, 17, letter.charCodeAt(0) - 96, i * 2)).toISOString();
      runs.push({ id: `${letter}${i}`, agent: "mcc", revision: letter.repeat(64), kind: letter === "c" ? "workflow" : "agentic", state: states[i] ?? "completed", startedAt, endedAt: new Date(Date.parse(startedAt) + seconds[i] * 1000).toISOString(), costUsd: cost, gone: false });
    });
  add("a", Array(8).fill(0.107 / 8), [60, 61, 59, 60, 62, 58, 60, 60], { 3: "failed" });
  add("b", Array(8).fill(0.182 / 8), [90, 91, 89, 90, 92, 88, 90, 90], {});
  add("c", Array(8).fill(0.0011 / 8), [2, 3, 2, 2, 1, 2, 2, 2], { 5: "escalated" });
  return { agent: { id: "mcc", name: "MCC classifier", createdAt: "2026-10-23T16:50:00.000Z", current: "c".repeat(64) }, revisions, runs: runs.reverse() };
})();

test("compare revisions: one row per revision, newest first, with its runs, completed, failed or escalated, total cost, cost per completed run and median time; the cheapest per completed run is marked, and a row filters the runs", async () => {
  const answers = { "api/agents/mcc": { agent: MCC.agent, revisions: MCC.revisions }, "api/runs?agent=mcc": MCC.runs, [`api/runs?agent=mcc&revision=${"b".repeat(64)}`]: MCC.runs.filter((r) => r.revision === "b".repeat(64)) };
  const { page: shown, api } = open("#/agents/mcc", answers);
  await shown.settle();
  const sections = all(shown.app).filter((el) => el.tagName === "SECTION").map(classOf);
  assert.deepEqual(sections, ["card agent", "card compare", "card runs", "card revs"]);
  const card = all(shown.app).find((el) => classOf(el) === "card compare");
  assertInert(card);
  const rows = all(card).filter((el) => el.tagName === "A" && classOf(el).startsWith("cmp"));
  assert.deepEqual(rows.map((el) => el.getAttribute("href")), ["d", "c", "b", "a"].map((l) => `#/agents/mcc?revision=${l.repeat(64)}`));
  const cells = (el) => all(el).filter((c) => /^c /.test(classOf(c))).map((c) => c.textContent);
  assert.deepEqual(rows.map(cells), [
    ["dddddddddddd agentic Prompt D: not run yet", "no runs"],
    ["cccccccccccc workflow current The cheap one: read the home page, one fast model step", "8", "7", "1", "$0.0011", "$0.00016 cheapest", "2s"],
    ["bbbbbbbbbbbb agentic Prompt B: a rubric", "8", "8", "0", "$0.182", "$0.023", "1m 30s"],
    ["aaaaaaaaaaaa agentic Prompt A: the plain instructions", "8", "7", "1", "$0.107", "$0.015", "1m 00s"],
  ]);
  assert.deepEqual(rows.map((el) => all(el).filter((c) => classOf(c) === "pill ok").map((c) => c.textContent)), [[], ["cheapest"], [], []], "the cheapest cost per completed run");
  assert.deepEqual(rows.map(classOf), ["cmp", "cmp", "cmp", "cmp"]);

  const filtered = open(`#/agents/mcc?revision=${"b".repeat(64)}`, answers);
  await filtered.page.settle();
  assert.ok(filtered.api.calls.some((c) => c.path === "api/runs?agent=mcc"), "the comparison reads every run of the agent, whatever the filter");
  const on = all(filtered.page.app).filter((el) => el.tagName === "A" && classOf(el) === "cmp on");
  assert.deepEqual(on.map((el) => [el.getAttribute("href"), el.getAttribute("aria-current")]), [[`#/agents/mcc?revision=${"b".repeat(64)}`, "true"]]);
  assert.ok(api.calls.length > 0);
});

test("learn from this run: a completed run whose revision names the learn tool gets the button; it POSTs the run to /learn as JSON, disabled in flight, and says what it committed or why not", async () => {
  const learnRev = { ...revision(REV_B, true, "Learns"), body: { instructions: "Answer.", tools: ["read", "learn"], skills: {} } };
  const agentPage = { agent: AGENT_PAGE.agent, revisions: [learnRev, revision(REV_A, false, "First")] };
  const stored = (id, state, rev = REV_B) => ({ run: { id, agent: "calc", revision: rev, kind: "agentic", state, startedAt: "2026-10-23T06:00:00.000Z", endedAt: "2026-10-23T06:01:00.000Z", costUsd: 0.01 }, agent: "Calc", note: "Learns", rows: [] });
  let release;
  const answers = {
    "api/agents/calc": agentPage,
    "api/store": { agents: AGENTS },
    "v2/runs/run-1": [404, { error: { code: "not_found", message: "no run run-1" } }],
    "api/runs/run-1": stored("run-1", "completed"),
    "POST v2/agents/calc/learn": () => new Promise((resolve) => (release = resolve)),
  };
  const { page: shown, api } = open("#/runs/run-1", answers);
  await shown.settle();
  const learn = buttonNamed(shown, "Learn from this run");
  assert.ok(learn, "the button is on the run's head");
  assert.ok(all(all(shown.app).find((el) => classOf(el) === "card run-head")).includes(learn));
  learn.click();
  await shown.settle();
  assert.equal(learn.disabled, true, "disabled while the request is in flight");
  assert.deepEqual(api.writes(), [["POST", "v2/agents/calc/learn", { run_id: "run-1" }]]);
  assert.equal(api.calls.at(-1).headers["content-type"], "application/json");
  release([201, { revision: "e".repeat(64), note: `Learned from run-1 ${HOSTILE}`, learned: [".agents/skills/mcc/SKILL.md", ".agents/skills/mcc/notes.md"] }]);
  await shown.settle();
  const said = all(shown.app).find((el) => classOf(el) === "learned");
  assert.equal(said.textContent, "Committed revision eeeeeeeeeeee with 2 learned files. Open it");
  assert.deepEqual(all(said).filter((el) => el.tagName === "A").map((el) => el.getAttribute("href")), [`#/agents/calc?revision=${"e".repeat(64)}`]);

  for (const [status, code, message] of [[409, "not_continuable", "this run's revision is no longer current"], [422, "input_invalid", `run_id is not a completed run ${HOSTILE}`]]) {
    const refused = open("#/runs/run-1", { ...answers, "POST v2/agents/calc/learn": [status, { error: { code, message } }] });
    await refused.page.settle();
    buttonNamed(refused.page, "Learn from this run").click();
    await refused.page.settle();
    assert.deepEqual(problemText(refused.page), [`${status} ${message}`]);
    assert.equal(buttonNamed(refused.page, "Learn from this run").disabled, false, "the button is back for another try");
  }

  for (const [why, extra] of [
    ["a failed run", { "api/runs/run-1": stored("run-1", "failed") }],
    ["a revision without the learn tool", { "api/runs/run-1": stored("run-1", "completed", REV_A) }],
  ]) {
    const none = open("#/runs/run-1", { ...answers, ...extra });
    await none.page.settle();
    assert.equal(buttonNamed(none.page, "Learn from this run"), undefined, why);
  }
});

test("a tool this server's environment cannot bind is shown unbound in the form, naming the variables it needs", async () => {
  const capabilities = { ...CAPABILITIES, tools: [...CAPABILITIES.tools, { name: "browser", summary: "", nodes: true, available: false, missing: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"] }] };
  const { page } = open("#/new", { "v2/capabilities": capabilities });
  await page.settle();
  const box = all(page.app).find((el) => el.getAttribute("type") === "checkbox" && el.value === "browser");
  assert.equal(classOf(box.parentNode), "unbound");
  assert.equal(box.parentNode.getAttribute("title"), "This server's environment does not set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
  assert.equal(classOf(all(page.app).find((el) => el.getAttribute("type") === "checkbox" && el.value === "read").parentNode), "", "a tool it binds is plain");
});

test("an empty store says what to do: make a new agent, or seed the showcase with the exact command in a code block; a store with agents shows its agents", async () => {
  const empty = open("#/", { "api/store": { agents: [] } });
  await empty.page.settle();
  assertInert(empty.page.app);
  const block = all(empty.page.app).find((el) => classOf(el) === "empty-store");
  assert.equal(block.textContent, "No agents yet. New agentor seed the showcase:docker compose -f packages/serve/docker/compose.yaml exec agentrun node examples/agentrun-server/showcase.mjs --token-file /data/.token --runs");
  assert.deepEqual(all(block).filter((el) => el.tagName === "A").map((el) => [el.textContent, el.getAttribute("href")]), [["New agent", "#/new"]]);
  const code = all(block).find((el) => el.tagName === "CODE");
  assert.equal(code.parentNode.tagName, "PRE");
  assert.equal(code.textContent, "docker compose -f packages/serve/docker/compose.yaml exec agentrun node examples/agentrun-server/showcase.mjs --token-file /data/.token --runs");
  assert.ok(!empty.page.app.textContent.includes("No agents in this store yet."));

  const full = open("#/", { "api/store": { agents: AGENTS } });
  await full.page.settle();
  assert.equal(all(full.page.app).filter((el) => classOf(el) === "empty-store").length, 0);
  assert.equal(all(full.page.app).filter((el) => classOf(el) === "agent-tile").length, 2);
});
