// The agent store: one folder, store.sqlite (four plain tables, the truth) and runs/<run id>/. Real stores in temp dirs.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, createAgentHome, openStore, openStoreReader } from "../dist/index.js";
import { DEFINITION, scratch } from "./support.mjs";
import { TOOLS, workflowDoc } from "./workflow-support.mjs";

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const A = { kind: "agentic", instructions: "Research the company.", skills: { "read/SKILL.md": "Read the site." }, tools: ["read"] };
const B = { ...A, instructions: "Research the company; cite sources." };
const MSG = 'this store has an unfinished write from a run that stopped; open it once with write access to roll it back, for example: sqlite3 store.sqlite "PRAGMA integrity_check"';
const WF = { kind: "workflow", workflow: workflowDoc(), tools: [...TOOLS] };

test("a revision's id is the hash of {agent, parent, kind, body}: the same four are one revision, going back is a new one, two agents with the same first body get two ids", async () => {
  const store = openStore(await scratch());
  const one = store.createAgent({ name: "Researcher" });
  const two = store.createAgent({ name: "Other" });
  const a1 = await store.commitRevision(one.id, A);
  const again = await store.commitRevision(one.id, { ...A, note: "another note" });
  assert.equal(again.id, a1.id, "the note is not in the id: the same agent, parent, kind and body is the same revision");
  assert.equal(again.note, undefined, "and the first row stays as it was written");
  await store.commitRevision(one.id, A, { setCurrent: true });
  const b = await store.commitRevision(one.id, B, { setCurrent: true });
  assert.equal(b.parent, a1.id, "its parent is the agent's current revision");
  const back = await store.commitRevision(one.id, A, { setCurrent: true });
  assert.notEqual(back.id, a1.id, "going back to the first body has another parent: a new revision");
  assert.equal(back.parent, b.id);
  const other = await store.commitRevision(two.id, A, { setCurrent: true });
  assert.notEqual(other.id, a1.id, "two agents committing the same first body get two ids");
  assert.deepEqual(store.listRevisions(one.id).map((r) => [r.id, r.current]), [[back.id, true], [b.id, false], [a1.id, false]], "newest first, current marked");
  store.close();
});

test("a revision is written once: the database refuses an UPDATE, and a row whose content was changed does not pass the id check", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "R" });
  const r = await store.commitRevision(agent.id, A, { setCurrent: true });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  assert.throws(() => db.prepare("UPDATE revisions SET note = 'x' WHERE id = ?").run(r.id), /written once/);
  db.exec("DROP TRIGGER revisions_are_written_once");
  db.prepare("UPDATE revisions SET body_json = ? WHERE id = ?").run(JSON.stringify({ ...r.body, instructions: "tampered" }), r.id);
  db.close();
  const again = openStore(dir);
  assert.throws(() => again.readRevision(r.id), (error) => refused("format")(error) && !/tampered/.test(error.message), "the id is checked against the content, and the message carries no value");
  again.close();
});

test("a revision of another agent is refused by setCurrent, by startRun, and the join never shows a run whose agent and revision disagree", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const x = store.createAgent({ name: "X" });
  const y = store.createAgent({ name: "Y" });
  const xr = await store.commitRevision(x.id, A, { setCurrent: true });
  assert.throws(() => store.setCurrent(y.id, xr.id), refused("invalid", /not a revision of that agent/));
  await assert.rejects(store.startRun({ agent: y.id, revision: xr.id }), refused("invalid", /not a revision of that agent/));
  await assert.rejects(store.commitRevision("nobody", A), refused("missing"));
  const run = await store.startRun({ agent: x.id });
  assert.equal(run.revision.id, xr.id);
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT runs.id FROM runs JOIN revisions ON revisions.id = runs.revision_id WHERE revisions.agent_id <> runs.agent_id").all(), []);
  db.close();
  store.close();
});

test("the skills are content-addressed, and the input is checked before anything is written", async () => {
  const store = openStore(await scratch());
  const agent = store.createAgent({ name: "S" });
  const r = await store.commitRevision(agent.id, A);
  assert.match(r.body.skills["read/SKILL.md"], /^[0-9a-f]{64}$/);
  await assert.rejects(store.commitRevision(agent.id, { ...A, skills: { "../x": "no" } }), refused("invalid", /skill path/));
  await assert.rejects(store.commitRevision(agent.id, { kind: "agentic", instructions: 3 }), refused("invalid", /instructions/));
  await assert.rejects(store.commitRevision(agent.id, { kind: "other" }), refused("invalid"));
  assert.equal(store.listRevisions(agent.id).length, 1);
  store.close();
});

test("a workflow revision is checked by the real workflow check before a write, and a refusal writes nothing", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "W" });
  await store.commitRevision(agent.id, A);
  const wf = await store.commitRevision(agent.id, WF);
  assert.equal(wf.kind, "workflow");
  await assert.rejects(store.commitRevision(agent.id, { ...WF, workflow: { v: 2, name: "bad" } }), refused("invalid", /not valid/));
  assert.equal(store.listRevisions(agent.id).length, 2, "the refused check wrote nothing");
  store.close();
});

test("commit, then cp only store.sqlite to a fresh folder: every row is there", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Copy me" });
  const r = await store.commitRevision(agent.id, A, { setCurrent: true });
  const copy = `${dir}-copy`;
  mkdirSync(copy);
  cpSync(path.join(dir, "store.sqlite"), path.join(copy, "store.sqlite")); // the store is still open: every commit is already in this one file
  store.close();
  const reader = openStoreReader(copy);
  assert.deepEqual(reader.listAgents().map((a) => [a.name, a.current, a.currentKind, a.runs]), [["Copy me", r.id, "agentic", 0]]);
  assert.equal(reader.readRevision(r.id).body.instructions, A.instructions);
  reader.close();
  rmSync(copy, { recursive: true, force: true });
});

test("the reader opens the file read-only, writes nothing, and gives a run's store path inside the folder", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "R" });
  store.close();
  const reader = openStoreReader(dir);
  assert.throws(() => reader.db.exec("INSERT INTO agents (id, name, created_at) VALUES ('z', 'z', 'z')"), /readonly/i);
  assert.equal(reader.runStorePath("run-1"), path.join(path.resolve(dir), "runs", "run-1", "store", "run.sqlite"));
  assert.throws(() => reader.runStorePath("../x"), refused("invalid"));
  const nowhere = path.join(dir, "nowhere");
  assert.throws(() => openStoreReader(nowhere), refused("missing", /^there is no store\.sqlite in that folder$/));
  assert.throws(() => openStoreReader(nowhere), (error) => !error.message.includes(nowhere) && !error.message.includes(path.basename(dir)));
  reader.close();
});

test("busyTimeoutMs 0: a store another connection holds throws SQLite's busy error at once, never 'exists'; an id taken is still 'exists'", async () => {
  const dir = await scratch();
  const store = openStore(dir, { busyTimeoutMs: 0 });
  const reader = openStoreReader(dir, { busyTimeoutMs: 0 });
  store.createAgent({ name: "Taken", id: "taken" });
  const holder = new DatabaseSync(path.join(dir, "store.sqlite"), { timeout: 0 });
  holder.exec("BEGIN EXCLUSIVE");
  const busy = (error) => error?.code === "ERR_SQLITE_ERROR" && (error.errcode & 0xff) === 5;
  const from = Date.now();
  assert.throws(() => store.createAgent({ name: "B" }), busy);
  assert.throws(() => reader.listAgents(), busy);
  assert.ok(Date.now() - from < 1_000, `it threw at once: ${Date.now() - from} ms`);
  holder.exec("ROLLBACK");
  holder.close();
  assert.equal(store.createAgent({ name: "B", id: "b" }).id, "b");
  assert.throws(() => store.createAgent({ name: "Taken", id: "taken" }), refused("exists"));
  for (const busyTimeoutMs of [-1, 1.5, "0"]) {
    assert.throws(() => openStore(dir, { busyTimeoutMs }), refused("invalid"));
    assert.throws(() => openStoreReader(dir, { busyTimeoutMs }), refused("invalid"));
  }
  reader.close();
  store.close();
});

test("importHome turns a beta.24 home into one agent with one agentic revision, set as current; twice is the same revision", async () => {
  const dir = await scratch();
  const home = await createAgentHome(path.join(await scratch(), "home"), { definition: DEFINITION, skills: { "cite/SKILL.md": "Cite every claim." } });
  const store = openStore(dir);
  const agent = await store.importHome(home.dir);
  assert.equal(agent.id, home.identity.id);
  const r = store.readRevision(agent.current);
  assert.deepEqual([r.kind, r.body.instructions, r.body.tools, Object.keys(r.body.skills)], ["agentic", DEFINITION.instructions, DEFINITION.tools, ["cite/SKILL.md"]]);
  assert.equal((await store.importHome(home.dir)).current, agent.current, "the same home again is the same revision");
  assert.equal(store.listRevisions(agent.id).length, 1);
  store.close();
});

test("startRun seeds the run's directory first, then inserts the row; carryBack ends the row once and refuses a second call", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Runner" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  const run = await store.startRun({ agent: agent.id });
  assert.deepEqual(store.listRuns().map((r) => [r.id, r.state, r.kind]), [[run.runId, "running", "agentic"]]);
  assert.equal(run.dir, path.join(path.resolve(dir), "runs", run.runId));
  store.carryBack(run.runId, { state: "escalated", costUsd: 0.5, summary: "escalated at gate" });
  assert.deepEqual(store.listRuns().map((r) => [r.state, r.costUsd, r.summary]), [["escalated", 0.5, "escalated at gate"]]);
  assert.throws(() => store.carryBack(run.runId, { state: "completed" }), refused("exists"));
  assert.throws(() => store.carryBack("nope", { state: "completed" }), refused("missing"));
  assert.throws(() => store.carryBack(run.runId, { state: "running" }), refused("invalid"));
  store.close();
});

test("a writer killed mid-transaction leaves a hot journal: the FOLDER copied whole opens with the last commit and a clean integrity check", async () => {
  const dir = await scratch();
  const first = openStore(dir);
  const agent = first.createAgent({ name: "Hot" });
  const committed = await first.commitRevision(agent.id, A, { setCurrent: true });
  first.close();
  // a child begins a transaction, writes, and dies before it commits (a hard exit)
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1] + "/store.sqlite");
    db.exec("PRAGMA journal_mode = DELETE"); db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO agents (id, name, created_at) VALUES ('half', 'half', 'x')").run();
    for (let i = 0; i < 3000; i++) db.prepare("INSERT INTO skills (sha256, content) VALUES (?, ?)").run("s" + i, "x".repeat(4096) + i);
    process.exit(0);`, dir], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const copy = `${dir}-whole`;
  cpSync(dir, copy, { recursive: true });
  const reopened = openStore(copy);
  assert.deepEqual(reopened.listAgents().map((a) => [a.id, a.current]), [[agent.id, committed.id]], "the last commit is there, and the half-written row is not");
  reopened.close();
  const db = new DatabaseSync(path.join(copy, "store.sqlite"));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
  rmSync(copy, { recursive: true, force: true });
});

test("a parent must be the agent's own revision: a current pointing at another agent's revision is refused by commitRevision", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const x = store.createAgent({ name: "X" });
  const y = store.createAgent({ name: "Y" });
  const xr = await store.commitRevision(x.id, A, { setCurrent: true });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.prepare("UPDATE agents SET current_revision = ? WHERE id = ?").run(xr.id, y.id); // a store edited outside the API
  db.close();
  const again = openStore(dir);
  await assert.rejects(again.commitRevision(y.id, B), refused("invalid", /parent is not a revision of that agent/));
  again.close();
});

test("a seed that fails writes no row and leaves no directory", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Seed" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  writeFileSync(path.join(dir, "runs"), "not a directory"); // runs/ cannot be made, so the seed fails
  await assert.rejects(store.startRun({ agent: agent.id }));
  assert.deepEqual(store.listRuns(), [], "no row");
  store.close();
});

test("an agentic-only store (create, commit, start, carry back) never loads the DSL or the pi package: a resolve hook records every load", async () => {
  const dir = await scratch();
  const hook = path.join(dir, "hook.mjs");
  writeFileSync(hook, `import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent('export async function resolve(s, c, n) { if (/agentrun-(dsl|pi)/.test(s)) { process.stderr.write("LOADED " + s + "\\\\n"); } return n(s, c); }'), import.meta.url);`);
  const script = `import { openStore } from ${JSON.stringify(path.resolve("dist/index.js"))};
    const store = openStore(process.argv[1]); const a = store.createAgent({ name: "Plain" });
    await store.commitRevision(a.id, { kind: "agentic", instructions: "x", tools: [] }, { setCurrent: true });
    const run = await store.startRun({ agent: a.id }); store.carryBack(run.runId, { state: "completed" }); store.close();`;
  const ran = spawnSync(process.execPath, ["--import", hook, "--input-type=module", "-e", script, path.join(dir, "folder")], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.doesNotMatch(ran.stderr, /LOADED/, "nothing of the DSL or agentrun-pi was resolved");
});

test("a store written by a newer version is refused, by openStore and by openStoreReader, with no value in the message", async () => {
  const dir = await scratch();
  openStore(dir).close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("PRAGMA user_version = 2");
  db.close();
  assert.throws(() => openStore(dir), refused("format", /^this store was written by a newer version$/));
  assert.throws(() => openStoreReader(dir), refused("format", /^this store was written by a newer version$/));
});

test("errors carry no value: a bad skill path and a skill that is not text are fixed sentences", async () => {
  const store = openStore(await scratch());
  const agent = store.createAgent({ name: "E" });
  await assert.rejects(store.commitRevision(agent.id, { ...A, skills: { "../secret-name": "x" } }), (e) => refused("invalid")(e) && !/secret-name/.test(e.message));
  await assert.rejects(store.commitRevision(agent.id, { ...A, skills: { "ok/SKILL.md": 7 } }), (e) => refused("invalid", /^a skill is not text$/)(e));
  store.close();
});

test("a store with a hot journal: openStoreReader says so in one named error and changes no file; openStore rolls it back and the reader then opens", async () => {
  const dir = await scratch();
  const first = openStore(dir);
  const agent = first.createAgent({ name: "Hot" });
  first.close();
  spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1] + "/store.sqlite");
    db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO agents (id, name, created_at) VALUES ('half', 'half', 'x')").run();
    const big = "x".repeat(4096); // enough pages to spill the cache into the file, so the journal holds what a rollback needs
    for (let i = 0; i < 3000; i++) db.prepare("INSERT INTO skills (sha256, content) VALUES (?, ?)").run("s" + i, big + i);
    process.exit(0);`, dir], { encoding: "utf8" });
  const files = () => readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f)).toString("hex")]);
  const before = files();
  assert.ok(before.some(([f]) => f === "store.sqlite-journal"), "the killed writer left a hot journal");
  assert.throws(() => openStoreReader(dir), refused("busy", new RegExp(`^${MSG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)));
  assert.deepEqual(files(), before, "the reader changed no file and made no side file");
  const writer = openStore(dir);
  assert.deepEqual(writer.listAgents().map((a) => a.id), [agent.id], "the unfinished write was rolled back");
  writer.close();
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.listAgents().map((a) => a.id), [agent.id]);
  reader.close();
});

test("startRun takes no run id: the store mints every id, so two overlapping starts are two runs with their files intact", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Racer" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  await assert.rejects(store.startRun({ agent: agent.id, runId: "mine" }), refused("invalid", /no run id/));
  assert.equal(store.listRuns().length, 0, "the refused call wrote no row");
  assert.equal(existsSync(path.join(dir, "runs", "mine")), false);
  const runs = await Promise.all(Array.from({ length: 4 }, () => store.startRun({ agent: agent.id })));
  assert.equal(new Set(runs.map((r) => r.runId)).size, 4, "the minted ids are unique");
  for (const run of runs) assert.equal(existsSync(run.storePath), true, "every run's store is intact");
  assert.equal(store.listRuns().length, 4);
  store.close();
});

test("importHome takes a valid beta.24 home with empty instructions", async () => {
  const store = openStore(await scratch());
  const home = await createAgentHome(path.join(await scratch(), "home"), { definition: { ...DEFINITION, instructions: "" } });
  const agent = await store.importHome(home.dir);
  assert.equal(store.readRevision(agent.current).body.instructions, "");
  store.close();
});

test("importHome is all or nothing: a failure after the agent row leaves the store unchanged, and a retry succeeds", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const home = await createAgentHome(path.join(await scratch(), "home"), { definition: DEFINITION, skills: { "cite/SKILL.md": "Cite every claim." } });
  const raw = new DatabaseSync(path.join(dir, "store.sqlite"));
  raw.exec("CREATE TRIGGER fail_revisions BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(store.importHome(home.dir));
  const count = (table) => raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.deepEqual(["agents", "revisions", "skills", "runs"].map(count), [0, 0, 0, 0], "no agent, revision or skill row was left");
  assert.deepEqual(store.listAgents(), []);
  raw.exec("DROP TRIGGER fail_revisions");
  raw.close();
  const agent = await store.importHome(home.dir);
  assert.equal(store.listRevisions(agent.id).length, 1);
  assert.notEqual(store.readRevision(agent.current), undefined);
  store.close();
});

test("a failing open closes its handle: a newer version and a file that is no database leave nothing open", () => {
  const openOn = (file) => readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(file); } catch { return false; } }).length;
  return (async () => {
    const dir = await scratch();
    openStore(dir).close();
    const file = path.join(dir, "store.sqlite");
    const db = new DatabaseSync(file); db.exec("PRAGMA user_version = 2"); db.close();
    for (let i = 0; i < 3; i++) assert.throws(() => openStore(dir), refused("format"));
    assert.equal(openOn(file), 0, "the version refusal left no handle");
    const bad = await scratch();
    writeFileSync(path.join(bad, "store.sqlite"), "this is not a database, ".repeat(200));
    for (let i = 0; i < 3; i++) assert.throws(() => openStore(bad));
    assert.equal(openOn(path.join(bad, "store.sqlite")), 0, "the unreadable file left no handle");
  })();
});

test("ifCurrent makes a commit a compare-and-swap: a stale expected current is refused (stale) inside the write and writes nothing", async () => {
  const store = openStore(await scratch());
  const agent = store.createAgent({ name: "Guarded" });
  const first = await store.commitRevision(agent.id, A, { setCurrent: true, ifCurrent: null });
  const second = await store.commitRevision(agent.id, B, { setCurrent: true, ifCurrent: first.id });
  assert.equal(second.parent, first.id);
  const before = store.listRevisions(agent.id);
  await assert.rejects(store.commitRevision(agent.id, { ...A, instructions: "A third." }, { setCurrent: true, ifCurrent: first.id }), refused("stale"));
  await assert.rejects(store.commitRevision(agent.id, { ...A, instructions: "A third." }, { setCurrent: true, ifCurrent: null }), refused("stale"), "null expects no current revision");
  assert.deepEqual(store.listRevisions(agent.id), before, "no revision written and the current one unchanged");
  await assert.rejects(store.commitRevision(agent.id, A, { ifCurrent: 7 }), refused("invalid"));
  store.close();
});
