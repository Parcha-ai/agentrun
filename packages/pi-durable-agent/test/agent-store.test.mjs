// The agent store: one folder, store.sqlite (four plain tables, the truth) and runs/<run id>/. Real stores in temp dirs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, createAgentHome, openStore, openStoreReader } from "../dist/index.js";
import { openStoreChecking } from "../dist/agent-store.js";
import { DEFINITION, scratch } from "./support.mjs";

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const A = { kind: "agentic", instructions: "Research the company.", skills: { "read/SKILL.md": "Read the site." }, tools: ["read"] };
const B = { ...A, instructions: "Research the company; cite sources." };
const WF = { kind: "workflow", workflow: { id: "wf", nodes: [] }, tools: [] };

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
  await assert.rejects(store.commitRevision(agent.id, { kind: "agentic", instructions: "" }), refused("invalid", /instructions/));
  await assert.rejects(store.commitRevision(agent.id, { kind: "other" }), refused("invalid"));
  assert.equal(store.listRevisions(agent.id).length, 1);
  store.close();
});

test("a workflow revision is checked before a write, a refusal writes nothing, and an agentic commit never calls the check", async () => {
  const dir = await scratch();
  const calls = [];
  const store = openStoreChecking(dir, async (body) => { calls.push(body); if (body.workflow.id === "bad") throw new AgentHomeError("invalid", "the workflow is not valid"); });
  const agent = store.createAgent({ name: "W" });
  await store.commitRevision(agent.id, A);
  assert.deepEqual(calls, []);
  const wf = await store.commitRevision(agent.id, WF);
  assert.deepEqual([calls.length, wf.kind], [1, "workflow"]);
  await assert.rejects(store.commitRevision(agent.id, { ...WF, workflow: { id: "bad", nodes: [] } }), refused("invalid", /not valid/));
  assert.equal(store.listRevisions(agent.id).length, 2, "the refused check wrote nothing");
  store.close();
});

test("commit, then cp only store.sqlite to a fresh folder: every row is there", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Copy me" });
  const r = await store.commitRevision(agent.id, A, { setCurrent: true });
  store.close();
  const copy = `${dir}-copy`;
  mkdirSync(copy);
  cpSync(path.join(dir, "store.sqlite"), path.join(copy, "store.sqlite"));
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
  assert.throws(() => openStoreReader(path.join(dir, "nowhere")), refused("missing"));
  reader.close();
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
  const { spawnSync } = await import("node:child_process");
  // a child begins a transaction, writes, and dies before it commits (a hard exit)
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1] + "/store.sqlite");
    db.exec("PRAGMA journal_mode = DELETE"); db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO agents (id, name, created_at) VALUES ('half', 'half', 'x')").run();
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
