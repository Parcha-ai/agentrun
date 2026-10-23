// `serveStore` and the bin on an agent store: the API over the store's reader and its run stores, with the reader and
// the workflow views injected (test/fixtures/store-sample.mjs), read-only and on loopback like `serveHome`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serveStore } from "../dist/serve/index.js";
import { AGENTS, BRIEF_GRAPH, BRIEF_WORKFLOW, buildSampleStore, fakeReader, fakeWorkflow, MCC_GRAPH_1, MCC_GRAPH_2, REVISIONS, RUN, RUNS } from "./fixtures/store-sample.mjs";
import { all, assertInert, mount } from "./page-dom.mjs";
import { request, scratch } from "./support.mjs";

const CLI = fileURLToPath(new URL("../dist/serve/cli.js", import.meta.url));
const linux = { skip: process.platform === "linux" ? undefined : "agent homes run on Linux only here", timeout: 60_000 };
const SIDE = ["-wal", "-shm", "-journal"];

/** Every file under `dir` but SQLite's side files, with its size, mtime and a hash of its bytes. */
const files = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile() && !SIDE.some((suffix) => entry.name.endsWith(suffix))).map((entry) => {
  const file = path.join(entry.parentPath, entry.name);
  const info = statSync(file);
  return { path: path.relative(dir, file), size: info.size, mtimeMs: info.mtimeMs, sha: createHash("sha256").update(readFileSync(file)).digest("hex") };
}).sort((a, b) => (a.path < b.path ? -1 : 1));

async function sample(options = {}) {
  const root = await buildSampleStore(await scratch());
  const reader = fakeReader();
  const workflow = fakeWorkflow(options.workflow);
  const served = await serveStore({ dir: root }, { openReader: reader.open, workflow: workflow.views });
  const get = async (target) => {
    const res = await request(served.url, { target });
    return { ...res, json: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(res.body) : undefined };
  };
  return { root, reader, workflow, served, get };
}

test("the picker: /api/store lists each agent with its current revision's kind, its revisions and its runs, read through a reader opened on a copy of the index that is removed", linux, async () => {
  const { root, reader, served, get } = await sample();
  const before = files(root);
  try {
    const store = await get("/api/store");
    assert.equal(store.status, 200);
    assert.deepEqual(store.json.agents.map((agent) => [agent.id, agent.name, agent.currentKind, agent.revisions, agent.runs]), [
      ["company-researcher", "Company researcher", "workflow", 3, 6],
      ["inbox-triage", "Inbox triage", "agentic", 1, 1],
      ["mcc-classifier", "MCC classifier", "workflow", 2, 4],
    ]);
    assert.equal(store.json.agents[0].current, REVISIONS.C.id);
    assert.equal(store.json.agents[0].description, AGENTS[0].description);
    assert.equal(reader.opened.length, 1);
    assert.notEqual(reader.opened[0], root, "the reader is opened on a copy of the index, not the store");
    assert.equal(existsSync(reader.opened[0]), false, "and the copy is removed once read");
    await get("/api/store");
    assert.equal(reader.opened.length, 1, "an index that did not change is not read again");
    const page = await get("/");
    assert.match(page.body, /<html lang="en" data-serve="store">/);
    assert.match(page.body, /<script src="\/graph\.js"><\/script>\n<script src="\/page\.js"><\/script>/, "the graph drawer, when it is there, loads before the page");
    assert.equal((await get("/page.js")).status, 200);
  } finally {
    await served.close();
  }
  assert.deepEqual(files(root), before, "nothing in the store changed but SQLite's side files");
});

test("the bin serves the store page for a directory with a store.sqlite, and an agent home's page for a home", linux, async (t) => {
  const root = await buildSampleStore(await scratch());
  const child = spawn(process.execPath, [CLI, "serve", root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  while (!out.includes("\n")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(out, /^http:\/\/127\.0\.0\.1:\d+\/\n$/);
  assert.match((await request(out.trim(), { target: "/" })).body, /data-serve="store"/);
  const home = await request(out.trim(), { target: "/api/agent" });
  assert.equal(home.status, 404, "a store has no single agent");
  child.kill("SIGINT");
  assert.equal(await new Promise((resolve) => child.once("exit", (code) => resolve(code))), 0);
});

test("an agent: its revisions newest first with the current one marked and each one's run count; bad and unknown ids are refused", linux, async () => {
  const { served, get } = await sample();
  try {
    const agent = await get("/api/agents/company-researcher");
    assert.equal(agent.status, 200);
    assert.deepEqual([agent.json.agent.id, agent.json.agent.name, agent.json.agent.currentKind, agent.json.agent.runs, agent.json.agent.revisions], ["company-researcher", "Company researcher", "workflow", 6, 3]);
    assert.deepEqual(agent.json.revisions.map((r) => [r.id, r.kind, r.current, r.parent, r.runs, r.note]), [
      [REVISIONS.C.id, "workflow", true, REVISIONS.B.id, 2, "The cheap one: a workflow"],
      [REVISIONS.B.id, "agentic", false, REVISIONS.A.id, 2, "Prompt B: every fact cited"],
      [REVISIONS.A.id, "agentic", false, null, 2, "Prompt A: the first brief"],
    ]);
    assert.equal("body" in agent.json.revisions[0], false, "a listing carries no body");
    for (const target of ["/api/agents/..%2fstore.sqlite", "/api/agents/-x", `/api/agents/${"a".repeat(129)}`, `/api/agents/company-researcher/revisions/..%2f..`]) {
      const res = await get(target);
      assert.equal(res.status, 400, target);
      assert.match(res.json.error, /id is not/);
    }
    assert.equal((await get("/api/agents/nobody")).status, 404);
    assert.equal((await get("/api/agents/constructor")).status, 404, "a name like an Object property is not an agent");
    assert.equal((await get(`/api/agents/company-researcher/revisions/${REVISIONS.M1.id}`)).status, 404, "another agent's revision is not this agent's");
    assert.equal((await get(`/api/agents/company-researcher/revisions/${"0".repeat(64)}`)).status, 404);
  } finally {
    await served.close();
  }
});

test("an agentic revision: its prompt and, against its agentic parent, a line diff that loses no word, and its tools, model, thinking and skills as what changed", linux, async () => {
  const { served, get } = await sample();
  try {
    const b = (await get(`/api/agents/company-researcher/revisions/${REVISIONS.B.id}`)).json;
    assert.deepEqual([b.revision.id, b.revision.kind, b.revision.current, b.revision.parent], [REVISIONS.B.id, "agentic", false, REVISIONS.A.id]);
    assert.deepEqual(b.revision.body, { instructions: REVISIONS.B.body.instructions, skills: REVISIONS.B.body.skills, tools: ["web_search", "web_fetch", "write", "read"], model: "luna", thinking: "medium" });
    assert.deepEqual([b.parent.id, b.parent.kind, "body" in b.parent], [REVISIONS.A.id, "agentic", false]);
    assert.equal(b.diff.against, REVISIONS.A.id);
    const [a0, a1, a2, a3] = REVISIONS.A.body.instructions.split("\n");
    const [b0, , b2, , b4] = REVISIONS.B.body.instructions.split("\n");
    assert.deepEqual(b.diff.prompt, [{ op: "del", text: a0 }, { op: "add", text: b0 }, { op: "same", text: a1 }, { op: "del", text: a2 }, { op: "add", text: b2 }, { op: "same", text: a3 }, { op: "add", text: b4 }]);
    assert.deepEqual(b.diff.tools, { added: ["read"], removed: [] });
    assert.deepEqual(b.diff.skills, {
      added: [{ path: "cite/SKILL.md", sha256: REVISIONS.B.body.skills["cite/SKILL.md"] }],
      removed: [],
      changed: [{ path: "research-brief/SKILL.md", was: REVISIONS.A.body.skills["research-brief/SKILL.md"], now: REVISIONS.B.body.skills["research-brief/SKILL.md"] }],
    });
    assert.deepEqual([b.diff.model, b.diff.thinking], [undefined, { was: "low", now: "medium" }], "only what changed");
    const a = (await get(`/api/agents/company-researcher/revisions/${REVISIONS.A.id}`)).json;
    assert.deepEqual([a.parent, a.diff], [null, null], "the first revision has nothing to be compared with");
    assert.equal(a.revision.body.instructions, REVISIONS.A.body.instructions);
  } finally {
    await served.close();
  }
});

test("a workflow revision: its graph, and against a workflow parent graphDiff's answer as the drawer's marks (added, edited, removed); never the workflow's JSON", linux, async () => {
  const { served, get, workflow } = await sample();
  try {
    const m2 = (await get(`/api/agents/mcc-classifier/revisions/${REVISIONS.M2.id}`)).json;
    assert.deepEqual(m2.graph, MCC_GRAPH_2);
    assert.deepEqual(m2.revision.body, { skills: {}, tools: ["web_fetch"] }, "the workflow is drawn, not sent");
    assert.deepEqual(m2.diff, {
      against: REVISIONS.M1.id,
      marks: { added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: "Format the answer", kind: "code" }] },
      moved: ["/root/steps/2"],
    });
    assert.deepEqual(workflow.calls.map(([name, ...args]) => [name, ...args]), [
      ["readWorkflowGraph", REVISIONS.M2.body.workflow],
      ["readWorkflowGraph", REVISIONS.M1.body.workflow],
      ["diffWorkflowGraphs", MCC_GRAPH_1, MCC_GRAPH_2],
    ]);
    const m1 = (await get(`/api/agents/mcc-classifier/revisions/${REVISIONS.M1.id}`)).json;
    assert.deepEqual([m1.graph, m1.diff, m1.parent], [MCC_GRAPH_1, null, null]);
    const c = (await get(`/api/agents/company-researcher/revisions/${REVISIONS.C.id}`)).json;
    assert.deepEqual([c.graph, c.diff, c.parent.kind, c.revision.current], [BRIEF_GRAPH, null, "agentic", true], "a workflow whose parent is agentic has a graph and nothing to diff it with");
  } finally {
    await served.close();
  }
});

test("a workflow revision when the DSL peer is not installed: the revision and the words to install it, never a crash", linux, async () => {
  const { served, get } = await sample({ workflow: { missing: "@parcha/agentrun-dsl" } });
  try {
    const res = await get(`/api/agents/mcc-classifier/revisions/${REVISIONS.M2.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.graph, res.json.diff, res.json.unavailable], [null, null, "install @parcha/agentrun-dsl to see this workflow's graph"]);
    assert.equal(res.json.revision.id, REVISIONS.M2.id);
    assert.equal((await get(`/api/agents/company-researcher/revisions/${REVISIONS.B.id}`)).json.diff.against, REVISIONS.A.id, "an agentic revision needs no peer");
  } finally {
    await served.close();
  }
});

test("runs: one list across agents and revisions, newest first, filtered by agent and revision; a filter that is not an id is refused", linux, async () => {
  const { served, get } = await sample();
  try {
    const all = await get("/api/runs");
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.map((run) => run.id), RUNS.map((run) => run.id), "newest first");
    assert.deepEqual(Object.keys(all.json[0]).sort(), ["agent", "costUsd", "endedAt", "id", "kind", "revision", "startedAt", "state", "summary"]);
    const researcher = (await get("/api/runs?agent=company-researcher")).json;
    assert.deepEqual(researcher.map((run) => [run.revision, run.kind, run.state]), [
      [REVISIONS.C.id, "workflow", "escalated"], [REVISIONS.C.id, "workflow", "completed"],
      [REVISIONS.B.id, "agentic", "completed"], [REVISIONS.B.id, "agentic", "completed"],
      [REVISIONS.A.id, "agentic", "failed"], [REVISIONS.A.id, "agentic", "completed"],
    ]);
    const b = (await get(`/api/runs?agent=company-researcher&revision=${REVISIONS.B.id}`)).json;
    assert.deepEqual(b.map((run) => run.id), [RUN.b002.id, RUN.b001.id]);
    assert.deepEqual((await get(`/api/runs?revision=${REVISIONS.M2.id}`)).json.map((run) => run.state), ["stopped", "completed"]);
    assert.deepEqual((await get("/api/runs?agent=nobody")).json, []);
    for (const target of ["/api/runs?agent=..%2f", "/api/runs?revision=a%20b", `/api/runs?agent=${"a".repeat(129)}`, "/api/runs?agent="]) {
      const res = await get(target);
      assert.equal(res.status, 400, target);
      assert.match(res.json.error, /id is not/);
    }
  } finally {
    await served.close();
  }
});

test("an agentic run: its row, its agent and revision, and its store's entries as the timeline, read-only; a running run's open call is still running", linux, async () => {
  const { root, served, get } = await sample();
  const before = files(root);
  try {
    const done = await get(`/api/runs/${RUN.a001.id}`);
    assert.equal(done.status, 200);
    assert.deepEqual(done.json.run, RUN.a001);
    assert.deepEqual(done.json.agent, { id: "company-researcher", name: "Company researcher" });
    assert.deepEqual([done.json.revision.id, done.json.revision.kind, done.json.revision.note, "body" in done.json.revision], [REVISIONS.A.id, "agentic", "Prompt A: the first brief", false]);
    assert.equal(done.json.stored, true);
    assert.deepEqual(done.json.rows.filter((row) => row.kind !== "usage").map((row) => row.kind), ["user_message", "thinking", "tool_use", "tool_result", "tool_use", "tool_use", "tool_result", "tool_result", "tool_use", "tool_result", "phase", "final_answer"]);
    assert.equal(done.json.rows[0].text, "Research Caterpillar Inc..");
    const failed = (await get(`/api/runs/${RUN.a002.id}`)).json;
    assert.ok(failed.rows.some((row) => row.kind === "tool_result" && row.tool_status === "failed"), "the 403 is a failed result");
    const live = (await get(`/api/runs/${RUN.d001.id}`)).json;
    assert.equal(live.run.state, "running");
    assert.deepEqual(live.rows.map((row) => row.kind), ["user_message", "thinking", "tool_use", "usage"], "a running run's open call has no result yet");
    for (const target of ["/api/runs/..%2f..%2fstore.sqlite", "/api/runs/-x", `/api/runs/${"a".repeat(129)}`]) assert.equal((await get(target)).status, 400, target);
    assert.equal((await get("/api/runs/none")).status, 404);
    assert.equal((await get("/api/runs/constructor")).status, 404);
  } finally {
    await served.close();
  }
  assert.deepEqual(files(root), before, "reading the runs changed nothing in the store");
});

test("a run's store that is a link out of the store is not read, and a run whose store is gone has its row and no entries", linux, async () => {
  const { root, served, get } = await sample();
  try {
    const runDir = path.join(root, "company-researcher", "runs", RUN.b001.id);
    const outside = path.join(await scratch(), "elsewhere");
    mkdirSync(outside);
    cpSync(path.join(runDir, "store", "run.sqlite"), path.join(outside, "run.sqlite"));
    renameSync(path.join(runDir, "store"), path.join(runDir, "store.moved"));
    symlinkSync(outside, path.join(runDir, "store"));
    const linked = await get(`/api/runs/${RUN.b001.id}`);
    assert.equal(linked.status, 500);
    assert.match(linked.json.error, /not inside the store/);
    assert.ok(!linked.body.includes(root), "no path in the answer");
    const gone = path.join(root, "company-researcher", "runs", RUN.b002.id);
    renameSync(gone, `${gone}.away`);
    const away = await get(`/api/runs/${RUN.b002.id}`);
    assert.equal(away.status, 200);
    assert.deepEqual([away.json.stored, away.json.rows, away.json.run.id], [false, [], RUN.b002.id]);
  } finally {
    await served.close();
  }
});

test("a workflow run: its row and the workflow views' record of it (each node's state, where an escalation stopped it), read from a copy of its store", linux, async () => {
  const { root, served, get, workflow } = await sample();
  const before = files(root);
  try {
    const escalated = await get(`/api/runs/${RUN.c002.id}`);
    assert.equal(escalated.status, 200);
    assert.deepEqual([escalated.json.run.state, escalated.json.run.summary, escalated.json.stored], ["escalated", "escalated at No public record", true]);
    assert.deepEqual(escalated.json.workflow.graph, BRIEF_GRAPH);
    assert.deepEqual(escalated.json.workflow.escalatedAt, { path: "/root/steps/1/branches/private/body", label: "No public record" });
    assert.equal(escalated.json.workflow.outcome, "escalated");
    assert.equal(escalated.json.workflow.status["/root/steps/1/branches/private/body"], "escalated");
    assert.equal(escalated.json.workflow.status["/root/steps/1/branches/public/body"], "not-run");
    assert.equal("rows" in escalated.json, false, "a workflow run has no timeline of its own here");
    const [[name, input, existed]] = workflow.calls;
    assert.equal(name, "readWorkflowRun");
    assert.deepEqual([input.runId, input.revision.body.workflow], [RUN.c002.id, BRIEF_WORKFLOW]);
    assert.ok(existed && !input.storePath.startsWith(root) && !existsSync(input.storePath), "the views read a copy of the run's store, removed after");
    const done = (await get(`/api/runs/${RUN.c001.id}`)).json;
    assert.deepEqual([done.workflow.outcome, done.workflow.escalatedAt, done.workflow.status["/root/steps/2"]], ["completed", undefined, "done"]);
    const missing = (await get(`/api/runs/${RUN.e002.id}`)).json;
    assert.deepEqual([missing.run.state, missing.stored, missing.workflow], ["missing", false, null], "a run whose directory is gone has its row only");
    assert.equal(workflow.calls.length, 2, "and nothing is read for it");
  } finally {
    await served.close();
  }
  assert.deepEqual(files(root), before, "nothing in the store changed");
});

test("a workflow run when the DSL peer is not installed: the run's row and the words to install it", linux, async () => {
  const { served, get } = await sample({ workflow: { missing: "@parcha/agentrun-dsl" } });
  try {
    const res = await get(`/api/runs/${RUN.c002.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.run.state, res.json.workflow, res.json.unavailable], ["escalated", null, "install @parcha/agentrun-dsl to see this workflow's graph"]);
  } finally {
    await served.close();
  }
});

test("a run with no cost recorded has no cost in the API, never a cost of 0", linux, async () => {
  const { served, get } = await sample();
  try {
    const listed = (await get("/api/runs?agent=company-researcher")).json.find((run) => run.id === RUN.b002.id);
    assert.equal("costUsd" in listed, false);
    assert.equal("costUsd" in (await get(`/api/runs/${RUN.b002.id}`)).json.run, false);
    assert.equal((await get(`/api/runs/${RUN.b001.id}`)).json.run.costUsd, 0.312);
  } finally {
    await served.close();
  }
});

/** The page's fetch, answered by the server at `url`, and a wait until every request it made has its answer drawn. */
function serverFetch(url) {
  const pending = new Set();
  const fetch = (target) => {
    const job = request(url, { target: `/${target}` }).then((res) => ({ ok: res.status < 300, status: res.status, text: async () => res.body }));
    pending.add(job);
    job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  };
  const idle = async (page) => {
    do {
      await Promise.allSettled([...pending]);
      await page.settle();
    } while (pending.size);
  };
  return { fetch, idle };
}

test("the fixture store, rendered: the page over the server's own answers shows three agents, the hero's three revisions with B diffed against A and C a graph, and runs in every state", linux, async () => {
  const { served } = await sample();
  const classOf = (el) => el.getAttribute("class") ?? "";
  const pills = (node) => all(node).filter((el) => classOf(el).startsWith("pill ")).map((el) => [classOf(el), el.textContent]);
  const open = async (hash) => {
    const server = serverFetch(served.url);
    const page = mount({}, hash, { serve: "store", fetch: server.fetch });
    await server.idle(page);
    assertInert(page.app);
    assert.doesNotMatch(page.app.textContent, /Could not read/, hash);
    return page;
  };
  try {
    const picker = await open("#/");
    const tiles = all(picker.app).filter((el) => el.tagName === "A" && classOf(el) === "agent-tile");
    assert.deepEqual(tiles.map((el) => [el.getAttribute("href"), pills(el)[0][1]]), [["#/agents/company-researcher", "workflow"], ["#/agents/inbox-triage", "agentic"], ["#/agents/mcc-classifier", "workflow"]]);
    assert.ok(tiles[0].textContent.includes("3 revisions") && tiles[0].textContent.includes("6 runs") && tiles[1].textContent.includes("1 run"));

    const hero = await open("#/agents/company-researcher");
    const blocks = all(hero.app).filter((el) => classOf(el).startsWith("revision"));
    assert.deepEqual(blocks.map((el) => [classOf(el), all(el).find((n) => classOf(n) === "rev-note").textContent]), [["revision current", "The cheap one: a workflow"], ["revision", "Prompt B: every fact cited"], ["revision", "Prompt A: the first brief"]]);
    assert.ok(blocks[0].textContent.includes(`Its parent ${REVISIONS.B.id.slice(0, 12)} is an agentic revision`));
    assert.deepEqual(all(blocks[0]).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node")).map((el) => el.querySelectorAll("b")[0].textContent), BRIEF_GRAPH.nodes.map((node) => node.label), "C's graph, as text without the drawer");
    const lines = all(blocks[1]).filter((el) => classOf(el).startsWith("line ")).map((el) => [classOf(el).slice(5), el.textContent.slice(1)]);
    assert.deepEqual(lines.filter(([op]) => op === "add").map(([, text]) => text), [REVISIONS.B.body.instructions.split("\n")[0], REVISIONS.B.body.instructions.split("\n")[2], REVISIONS.B.body.instructions.split("\n")[4]]);
    assert.equal(lines.length, 7, "every line of A and B");
    assert.ok(all(blocks[2]).some((el) => el.tagName === "PRE" && el.textContent === REVISIONS.A.body.instructions));
    const rows = all(hero.app).filter((el) => el.tagName === "A" && classOf(el) === "run");
    assert.deepEqual(rows.map((el) => [el.getAttribute("href").slice(-4), pills(el)[0][1]]), [["c002", "escalated"], ["c001", "completed"], ["b002", "completed"], ["b001", "completed"], ["a002", "failed"], ["a001", "completed"]]);
    assert.deepEqual(pills(rows[0])[0], ["pill escalated", "escalated"], "escalated is its own state");
    assert.ok(rows[2].textContent.includes("unknown") && !rows[2].textContent.includes("$0"), "a null cost reads unknown");

    const filtered = await open(`#/agents/company-researcher?revision=${REVISIONS.B.id}`);
    assert.equal(all(filtered.app).filter((el) => el.tagName === "A" && classOf(el) === "run").length, 2);

    const mcc = await open("#/agents/mcc-classifier");
    const [m2] = all(mcc.app).filter((el) => classOf(el).startsWith("revision"));
    assert.deepEqual(all(m2).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node")).map(classOf), ["node", "node", "node added", "node edited", "node added"]);
    assert.ok(m2.textContent.includes("Format the answer (code)") && m2.textContent.includes("1 moved"));
    assert.deepEqual(all(mcc.app).filter((el) => el.tagName === "A" && classOf(el) === "run").map((el) => pills(el)[0][1]), ["stopped", "completed", "missing", "completed"]);

    const escalated = await open(`#/runs/${RUN.c002.id}`);
    const fired = all(escalated.app).filter((el) => classOf(el) === "node fired");
    assert.equal(fired.length, 1);
    assert.ok(fired[0].textContent.includes("No public record") && fired[0].textContent.includes("stopped here"));
    assert.ok(!pills(escalated.app).some(([cls]) => cls === "pill error"), "the escalation is never drawn as failed");
    assert.match(escalated.app.textContent, /Escalated at No public record/);

    const agentic = await open(`#/runs/${RUN.a001.id}`);
    assert.deepEqual(pills(agentic.app).slice(0, 2), [["pill ok", "completed"], ["pill agentic", "agentic"]]);
    assert.ok(all(agentic.app).some((el) => classOf(el) === "row answer"), "the timeline ends with the answer");
    assert.ok(agentic.app.textContent.includes("$0.409") && agentic.app.textContent.includes("4 tool calls"));

    const gone = await open(`#/runs/${RUN.e002.id}`);
    assert.deepEqual(pills(gone.app)[0], ["pill missing", "missing"]);
    assert.match(gone.app.textContent, /This run's directory is not in the store/);
  } finally {
    await served.close();
  }
});
