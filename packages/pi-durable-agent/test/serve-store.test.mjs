// `serveStore` and the bin on an agent store built through the store's own API (test/fixtures/store-sample.mjs): the
// API over the store's reader and the runs' own stores, read in place and read-only, on loopback like `serveHome`. The
// workflow run reader is the one stand-in; the graphs are the DSL's.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workflowGraph } from "@parcha/agentrun-dsl/graph";
import { AgentHomeError, durableProfileStore, openStoreReader } from "../dist/index.js";
import { serveStoreWith } from "../dist/serve/store.js";
import { BRIEF_WORKFLOW, buildSampleStore, MCC_WORKFLOW_2, PRIVATE, PROMPT_A, PROMPT_B, RUN, sampleReadRun, SKILL_MARKER } from "./fixtures/store-sample.mjs";
import { all, assertInert, mount } from "./page-dom.mjs";
import { ctx, openSession, request, scratch } from "./support.mjs";

const CLI = fileURLToPath(new URL("../dist/serve/cli.js", import.meta.url));
const HOT_JOURNAL = 'this store has an unfinished write from a run that stopped; open it once with write access to roll it back, for example: sqlite3 store.sqlite "PRAGMA integrity_check"';

/** Every file under `dir` with its size, mtime and a hash of its bytes. */
const files = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => {
  const file = path.join(entry.parentPath, entry.name);
  return { path: path.relative(dir, file), size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, sha: createHash("sha256").update(readFileSync(file)).digest("hex") };
}).sort((a, b) => (a.path < b.path ? -1 : 1));
/** The same, but for the run stores' shared-memory side files, which a read-only open of a WAL store may make. */
const mainFiles = (dir) => files(dir).filter((file) => !/-(wal|shm)$/.test(file.path));

async function sample(options = {}) {
  const { root, revisions } = await buildSampleStore(await scratch());
  const workflow = sampleReadRun(options);
  const served = await serveStoreWith({ dir: root }, {}, workflow.readWorkflowRun);
  const get = async (target) => {
    const res = await request(served.url, { target });
    return { ...res, json: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(res.body) : undefined };
  };
  return { root, revisions, workflow, served, get };
}

test("the picker: the store's agents, each with its current revision's kind and its run count, read in place without a write: the file stays byte-identical and the reader's handle cannot write", async () => {
  const { root, served, get } = await sample();
  const before = files(root);
  try {
    const store = await get("/api/store");
    assert.equal(store.status, 200);
    assert.deepEqual(store.json.agents.map((agent) => [agent.id, agent.name, agent.currentKind, agent.runs]), [
      ["company-researcher", "Company researcher", "workflow", 6],
      ["inbox-triage", "Inbox triage", "agentic", 1],
      ["mcc-classifier", "MCC classifier", "workflow", 4],
    ]);
    for (const target of ["/", "/api/agents/company-researcher", "/api/agents/mcc-classifier", "/api/runs", `/api/runs/${RUN.a1}`, `/api/runs/${RUN.c2}`, `/api/runs/${RUN.m2}`]) assert.ok([200].includes((await get(target)).status), target);
    assert.match((await get("/")).body, /<html lang="en" data-serve="store">/);
  } finally {
    await served.close();
  }
  assert.deepEqual(readdirSync(root).sort(), ["runs", "store.sqlite"], "no journal or side file beside store.sqlite");
  assert.deepEqual(mainFiles(root), before.filter((file) => !/-(wal|shm)$/.test(file.path)), "every store file is byte-identical, its mtime unmoved");
  const reader = openStoreReader(root);
  try {
    assert.throws(() => reader.db.exec("CREATE TABLE intruder (a)"), /readonly/i);
    assert.throws(() => reader.db.exec("DELETE FROM runs"), /readonly/i);
  } finally {
    reader.close();
  }
});

test("an agent: its revisions newest first, the current one marked; an agentic one diffed against its agentic parent; a first one with nothing to compare", async () => {
  const { revisions, served, get } = await sample();
  try {
    const page = (await get("/api/agents/company-researcher")).json;
    assert.deepEqual([page.agent.id, page.agent.currentKind, page.agent.runs], ["company-researcher", "workflow", 6]);
    assert.deepEqual(page.revisions.map((r) => [r.id, r.kind, r.current, r.parent, r.parentKind, r.note]), [
      [revisions.C.id, "workflow", true, revisions.B.id, "agentic", "The cheap one: a workflow"],
      [revisions.B.id, "agentic", false, revisions.A.id, "agentic", "Prompt B: every fact cited"],
      [revisions.A.id, "agentic", false, null, null, "Prompt A: the first brief"],
    ]);
    const [c, b, a] = page.revisions;
    assert.deepEqual(b.body, revisions.B.body);
    const [a0, a1, a2, a3] = PROMPT_A.split("\n");
    const [b0, , b2, , b4] = PROMPT_B.split("\n");
    assert.deepEqual(b.diff, {
      against: revisions.A.id,
      prompt: [{ op: "del", text: a0 }, { op: "add", text: b0 }, { op: "same", text: a1 }, { op: "del", text: a2 }, { op: "add", text: b2 }, { op: "same", text: a3 }, { op: "add", text: b4 }],
      tools: { added: ["read"], removed: [] },
      skills: { added: ["cite/SKILL.md"], removed: [], changed: ["research-brief/SKILL.md"] },
      thinking: { was: "low", now: "medium" },
    }, "every line of both prompts; only what else changed");
    assert.equal(a.diff, null);
    assert.deepEqual([c.graph, c.diff, c.body], [JSON.parse(JSON.stringify(workflowGraph(BRIEF_WORKFLOW))), null, { tools: ["web.fetch", "filings.search"], skills: {} }], "a workflow's graph, never its JSON; its parent is agentic, so no diff");
  } finally {
    await served.close();
  }
});

test("a workflow revision against a workflow parent: graphDiff's added, edited (changed and rewritten) and removed nodes as the drawer's marks", async () => {
  const { revisions, served, get } = await sample();
  try {
    const [m2, m1] = (await get("/api/agents/mcc-classifier")).json.revisions;
    assert.deepEqual(m2.graph, JSON.parse(JSON.stringify(workflowGraph(MCC_WORKFLOW_2))));
    assert.deepEqual(m2.diff, { against: revisions.M1.id, added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: "Format the answer", kind: "call" }] });
    assert.equal(m1.diff, null, "a first revision has no diff");
  } finally {
    await served.close();
  }
});

test("runs: newest first across agents and revisions, filtered by agent and revision; a run whose directory is gone says so; ids that are not ids are refused", async () => {
  const { revisions, served, get } = await sample();
  try {
    const runs = (await get("/api/runs")).json;
    assert.deepEqual(runs.map((run) => run.id), [RUN.c2, RUN.c1, RUN.t1, RUN.m4, RUN.m3, RUN.b2, RUN.b1, RUN.a2, RUN.a1, RUN.m2, RUN.m1]);
    assert.deepEqual(runs.map((run) => run.state), ["escalated", "completed", "running", "stopped", "completed", "completed", "completed", "failed", "completed", "completed", "completed"]);
    assert.deepEqual(runs.filter((run) => run.gone).map((run) => run.id), [RUN.m2]);
    assert.equal("costUsd" in runs.find((run) => run.id === RUN.b2), false, "no cost recorded is no cost, never 0");
    assert.deepEqual((await get("/api/runs?agent=company-researcher")).json.map((run) => run.id), [RUN.c2, RUN.c1, RUN.b2, RUN.b1, RUN.a2, RUN.a1]);
    assert.deepEqual((await get(`/api/runs?agent=company-researcher&revision=${revisions.B.id}`)).json.map((run) => run.id), [RUN.b2, RUN.b1]);
    assert.deepEqual((await get("/api/runs?agent=nobody")).json, []);
    for (const target of ["/api/runs?agent=..%2f", "/api/runs?revision=a%20b", "/api/runs?agent=", "/api/agents/..%2fstore.sqlite", "/api/agents/-x", `/api/runs/${"a".repeat(129)}`]) {
      const res = await get(target);
      assert.deepEqual([res.status, res.json], [400, { error: 'an id is not letters, digits, ".", "_" or "-"' }], target);
    }
    for (const target of ["/api/agents/nobody", "/api/agents/constructor", "/api/runs/none", "/api/runs/toString", "/api/nothing"]) assert.equal((await get(target)).status, 404, target);
  } finally {
    await served.close();
  }
});

test("an agentic run: its row, agent and note, and its own store's entries as the timeline; a running run's open call is still open; a store linked out of the folder is refused", async () => {
  const { root, served, get } = await sample();
  try {
    const done = (await get(`/api/runs/${RUN.a1}`)).json;
    assert.deepEqual([done.run.id, done.run.state, done.agent, done.note], [RUN.a1, "completed", "Company researcher", "Prompt A: the first brief"]);
    assert.deepEqual(done.rows.filter((row) => row.kind !== "usage").map((row) => row.kind), ["user_message", "thinking", "tool_use", "tool_result", "tool_use", "tool_use", "tool_result", "tool_result", "tool_use", "tool_result", "phase", "final_answer"]);
    const live = (await get(`/api/runs/${RUN.t1}`)).json;
    assert.deepEqual(live.rows.map((row) => row.kind), ["user_message", "thinking", "tool_use", "usage"], "no result yet for a running run's call");
    const gone = (await get(`/api/runs/${RUN.m2}`)).json;
    assert.deepEqual([gone.gone, gone.rows, gone.workflow], [true, undefined, undefined]);

    const store = path.join(root, "runs", RUN.b1, "store");
    const outside = path.join(await scratch(), "elsewhere");
    mkdirSync(outside);
    cpSync(path.join(store, "run.sqlite"), path.join(outside, "run.sqlite"));
    renameSync(store, `${store}.moved`);
    symlinkSync(outside, store);
    const linked = await get(`/api/runs/${RUN.b1}`);
    assert.deepEqual([linked.status, linked.json], [500, { error: "the run's store is not inside the store" }], "no path in the answer");
  } finally {
    await served.close();
  }
});

test("a workflow run: the reader is given the run's own store and its revision's workflow; the answer is the graph, each node's state, where an escalation stopped it, and a completed run's output", async () => {
  const { root, revisions, served, get, workflow } = await sample();
  try {
    const escalated = (await get(`/api/runs/${RUN.c2}`)).json;
    assert.deepEqual(workflow.calls.map((call) => [call.runId, call.storePath, call.revision]), [[RUN.c2, path.join(root, "runs", RUN.c2, "store", "run.sqlite"), revisions.C]], "the run's own store, in place, and its verified revision");
    assert.deepEqual([escalated.run.state, escalated.workflow.outcome, escalated.workflow.escalatedAt, escalated.workflow.status[PRIVATE], escalated.workflow.output], ["escalated", "escalated", { path: PRIVATE, label: "No public record" }, "escalated", undefined]);
    assert.deepEqual(escalated.workflow.graph, JSON.parse(JSON.stringify(workflowGraph(BRIEF_WORKFLOW))));
    const completed = (await get(`/api/runs/${RUN.c1}`)).json;
    assert.deepEqual([completed.workflow.outcome, completed.workflow.output], ["completed", { brief: "Caterpillar Inc. makes heavy machinery; its 10-K is cited." }]);
  } finally {
    await served.close();
  }
});

test("a workflow run its reader refuses is that refusal's one line beside the run's row; any other failure is a plain 500", async () => {
  const refused = await sample({ refuse: new AgentHomeError("format", "a run in the keyed layout is not read here") });
  try {
    const res = await refused.get(`/api/runs/${RUN.c2}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.refused, res.json.run.state, res.json.run.costUsd, res.json.run.summary, res.json.workflow], ["a run in the keyed layout is not read here", "escalated", 0.018, "escalated at No public record", undefined]);
  } finally {
    await refused.served.close();
  }
  const broken = await sample({ refuse: new Error(`boom at ${"/secret/path"}`) });
  try {
    const res = await broken.get(`/api/runs/${RUN.c2}`);
    assert.deepEqual([res.status, res.json], [500, { error: "the agent store could not be read" }]);
  } finally {
    await broken.served.close();
  }
});

test("no answer holds a skill's text or a run's saved sign-in: only what an exporter may copy is served", async () => {
  const { root, served, get } = await sample();
  const session = await openSession(path.join(root, "runs", RUN.a1, "store", "run.sqlite"));
  await durableProfileStore(session).resolve("practice", async () => "PROFILE-MARKER-7731");
  await session.close(ctx);
  try {
    for (const target of ["/api/store", "/api/agents/company-researcher", "/api/agents/inbox-triage", "/api/agents/mcc-classifier", "/api/runs", `/api/runs/${RUN.a1}`, `/api/runs/${RUN.b1}`, `/api/runs/${RUN.c2}`]) {
      const { body } = await get(target);
      for (const secret of [SKILL_MARKER, "PROFILE-MARKER-7731", "browser.profiles", "agent.leases", "agent.vault"]) assert.ok(!body.includes(secret), `${target} holds ${secret}`);
    }
  } finally {
    await served.close();
  }
});

test("a store a writer was killed in mid-transaction: the picker and an agent page answer the store's one plain line, serve stays up, and store.sqlite and its journal stay byte-identical", async () => {
  const { root } = await buildSampleStore(await scratch());
  const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1] + "/store.sqlite");
    db.exec("PRAGMA journal_mode = DELETE"); db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO agents (id, name, created_at) VALUES ('half', 'half', 'x')").run();
    for (let i = 0; i < 3000; i++) db.prepare("INSERT INTO skills (sha256, content) VALUES (?, ?)").run("s" + i, "x".repeat(4096) + i);
    process.kill(process.pid, "SIGKILL");`, root]);
  assert.equal(killed.signal, "SIGKILL");
  const hashes = () => ["store.sqlite", "store.sqlite-journal"].map((name) => createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex"));
  const before = hashes();
  const served = await serveStoreWith({ dir: root }, {}, sampleReadRun().readWorkflowRun);
  try {
    for (const target of ["/api/store", "/api/agents/company-researcher", "/api/store"]) {
      const res = await request(served.url, { target });
      assert.deepEqual([res.status, JSON.parse(res.body)], [500, { error: HOT_JOURNAL }], target);
    }
    assert.equal((await request(served.url, { target: "/" })).status, 200, "serve is still up");
  } finally {
    await served.close();
  }
  assert.deepEqual(hashes(), before, "store.sqlite and its journal are byte-identical");
});

test("the bin serves the store's page for a folder holding a store.sqlite, drawing a workflow and reading a workflow run with what it loads on demand", { timeout: 60_000 }, async (t) => {
  const { root, revisions } = await buildSampleStore(await scratch());
  const child = spawn(process.execPath, [CLI, "serve", root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  while (!out.includes("\n")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(out, /^http:\/\/127\.0\.0\.1:\d+\/\n$/);
  const url = out.trim();
  assert.match((await request(url, { target: "/" })).body, /data-serve="store"/);
  assert.equal(JSON.parse((await request(url, { target: "/api/store" })).body).agents.length, 3);
  const mcc = JSON.parse((await request(url, { target: "/api/agents/mcc-classifier" })).body);
  assert.deepEqual(mcc.revisions[0].diff, { against: revisions.M1.id, added: ["/root/steps/1", "/root/steps/3"], edited: ["/root/steps/2"], removed: [{ label: "Format the answer", kind: "call" }] });
  const run = JSON.parse((await request(url, { target: `/api/runs/${RUN.c2}` })).body);
  assert.deepEqual(run.workflow.graph.nodes.map((node) => node.label), ["chain", "Read the site", "Jev: public or private", "Check the filing", "No public record"], "./workflow's own readWorkflowRun reads the run");
  child.kill("SIGINT");
  assert.equal(await new Promise((resolve) => child.once("exit", (code) => resolve(code))), 0);
});

test("an agentic agent's pages never load the DSL or ./workflow; a workflow revision's page loads the DSL's graph", async () => {
  const { root } = await buildSampleStore(await scratch());
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({ resolve: (specifier, context, next) => (loaded.push(specifier), next(specifier, context)) });
    const { serveStore } = await import(process.argv[1]);
    const served = await serveStore({ dir: process.argv[2] });
    const workflowish = () => [...new Set(loaded.filter((name) => name.startsWith("@parcha/agentrun-dsl") || name.startsWith("@parcha/agentrun-pi") || name.endsWith("/workflow.js")))];
    for (const target of ["api/store", "api/agents/inbox-triage", "api/runs", "api/runs/${RUN.a1}", "api/runs/${RUN.t1}"]) await fetch(served.url + target);
    const agentic = workflowish();
    await fetch(served.url + "api/agents/mcc-classifier");
    console.log(JSON.stringify({ agentic, workflow: workflowish() }));
    await served.close();`, new URL("../dist/serve/index.js", import.meta.url).href, root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const { agentic, workflow } = JSON.parse(child.stdout);
  assert.deepEqual(agentic, [], "nothing of the DSL, agentrun-pi or ./workflow");
  assert.deepEqual(workflow, ["@parcha/agentrun-dsl/graph"], "the DSL's graph once a workflow is drawn, and nothing else");
});

/** The page's fetch, answered by the server at `url`, and a wait until every answer it asked for is drawn. */
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

test("the fixture store, rendered from the server's own answers: three agents, the hero's revisions C, B and A with B diffed against A, its runs in every state, an escalated workflow run and a gone one", async () => {
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
    assert.deepEqual(all(picker.app).filter((el) => classOf(el) === "agent-tile").map((el) => [el.getAttribute("href"), pills(el)[0][1]]), [["#/agents/company-researcher", "workflow"], ["#/agents/inbox-triage", "agentic"], ["#/agents/mcc-classifier", "workflow"]]);

    const hero = await open("#/agents/company-researcher");
    const blocks = all(hero.app).filter((el) => el.tagName === "ARTICLE");
    assert.deepEqual(blocks.map((el) => [classOf(el), all(el).find((n) => classOf(n) === "rev-note").textContent]), [["revision current", "The cheap one: a workflow"], ["revision", "Prompt B: every fact cited"], ["revision", "Prompt A: the first brief"]]);
    assert.deepEqual(all(blocks[0]).filter((el) => el.tagName === "LI" && classOf(el).startsWith("node")).map((el) => el.querySelectorAll("b")[0].textContent), ["chain", "Read the site", "Jev: public or private", "Check the filing", "No public record"]);
    assert.equal(all(blocks[1]).filter((el) => classOf(el).startsWith("line ")).length, 7, "every line of A and B");
    const rows = all(hero.app).filter((el) => el.tagName === "A" && classOf(el) === "run");
    assert.deepEqual(rows.map((el) => pills(el)[0]), [["pill escalated", "escalated"], ["pill ok", "completed"], ["pill ok", "completed"], ["pill ok", "completed"], ["pill error", "failed"], ["pill ok", "completed"]]);
    assert.ok(rows[2].textContent.includes("unknown") && !rows[2].textContent.includes("$0"), "a missing cost reads unknown");

    const mcc = await open("#/agents/mcc-classifier");
    assert.ok(all(mcc.app).filter((el) => el.tagName === "A" && classOf(el) === "run")[2].textContent.includes("its directory is gone"));

    const escalated = await open(`#/runs/${RUN.c2}`);
    const fired = all(escalated.app).filter((el) => classOf(el) === "node fired");
    assert.ok(fired.length === 1 && fired[0].textContent.includes("No public record") && fired[0].textContent.includes("stopped here"));
    assert.ok(!pills(escalated.app).some(([cls]) => cls === "pill error"), "never drawn as failed");

    const answered = await open(`#/runs/${RUN.c1}`);
    assert.ok(answered.app.textContent.includes("Caterpillar Inc. makes heavy machinery; its 10-K is cited."));

    const agentic = await open(`#/runs/${RUN.a1}`);
    assert.ok(all(agentic.app).some((el) => classOf(el) === "row answer") && agentic.app.textContent.includes("$0.409") && agentic.app.textContent.includes("4 tool calls"));

    const gone = await open(`#/runs/${RUN.m2}`);
    assert.match(gone.app.textContent, /This run's directory is gone/);
  } finally {
    await served.close();
  }
});
