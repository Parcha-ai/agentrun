// The agent store's run half: store.startRun pins a revision and seeds the run's folder, store.carryBack ends the run once.
// Real stores in temp dirs; no model calls. The runs are read with plain SQL, read-only, as serve reads them.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore } from "../dist/index.js";
import { openStoreChecking } from "../dist/agent-store.js";
import { scratch } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;
/** The refusal carries no value: nothing of the input (an id, a path, a skill's text) is in its message. */
const valueFree = (...values) => (error) => values.every((value) => !String(error.message).includes(value));
const A = { kind: "agentic", instructions: "Research the company.", skills: { "read/SKILL.md": "Read the site.\n" }, tools: ["read"] };
const B = { kind: "agentic", instructions: "Research the company; cite sources.", skills: { "cite/SKILL.md": "Cite.\n" }, tools: ["read", "cite"] };
const WF = { kind: "workflow", workflow: { id: "wf", nodes: [] }, tools: [] };
const runs = (dir) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT * FROM runs ORDER BY started_at, id").all(); } finally { db.close(); }
};
const joined = (dir) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT runs.id, agents.name, revisions.id AS revision, revisions.kind, runs.state FROM runs JOIN revisions ON revisions.id = runs.revision_id JOIN agents ON agents.id = runs.agent_id AND agents.id = revisions.agent_id").all();
  } finally { db.close(); }
};

async function aStore() {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = await store.createAgent({ name: "Researcher" });
  const a = await store.commitRevision(agent.id, A, { setCurrent: true });
  const b = await store.commitRevision(agent.id, B);
  return { dir, store, agent, a, b };
}

test("startRun pins the current revision at start: it returns the verified revision, seeds the folder from it, and a later setCurrent changes nothing", async () => {
  const { dir, store, agent, a, b } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  assert.deepEqual(Object.keys(run).sort(), ["agentId", "dir", "revision", "runId", "storePath", "workspace"]);
  assert.equal(run.agentId, agent.id);
  assert.deepEqual({ id: run.revision.id, kind: run.revision.kind }, { id: a.id, kind: "agentic" });
  assert.deepEqual(run.revision.body, a.body);
  assert.equal(run.dir, path.join(dir, "runs", run.runId));
  assert.equal(await readFile(path.join(run.workspace, ".agents/skills/read/SKILL.md"), "utf8"), "Read the site.\n");
  assert.ok(existsSync(run.storePath), "the run's own pi-durable store is seeded");
  await store.setCurrent(agent.id, b.id);
  assert.deepEqual(runs(dir).map((r) => [r.id, r.agent_id, r.revision_id, r.state]), [[run.runId, agent.id, a.id, "running"]], "the row names the pinned revision, not the new current");
  assert.match(runs(dir)[0].started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(runs(dir)[0].ended_at, null);
  await store.close();
});

test("startRun with a named revision runs that one, with that revision's skills only", async () => {
  const { store, agent, b } = await aStore();
  const run = await store.startRun({ agent: agent.id, revision: b.id });
  assert.equal(run.revision.id, b.id);
  assert.equal(await readFile(path.join(run.workspace, ".agents/skills/cite/SKILL.md"), "utf8"), "Cite.\n");
  assert.equal(existsSync(path.join(run.workspace, ".agents/skills/read/SKILL.md")), false);
  await store.close();
});

test("startRun refuses, with no value in the message and nothing written: no current revision and none named, an unknown revision, a revision of another agent, an unknown agent", async () => {
  const { dir, store, agent } = await aStore();
  const bare = await store.createAgent({ name: "Bare" });
  const other = await store.createAgent({ name: "Other" });
  const theirs = await store.commitRevision(other.id, A, { setCurrent: true });
  const cases = [
    [{ agent: bare.id }, bare.id],
    [{ agent: agent.id, revision: theirs.id }, theirs.id],
    [{ agent: "no-such-agent" }, "no-such-agent"],
  ];
  for (const [options, value] of cases) await assert.rejects(store.startRun(options), (e) => refused("invalid")(e) && valueFree(value)(e));
  await assert.rejects(store.startRun({ agent: agent.id, revision: "0".repeat(64) }), (e) => refused("missing")(e) && valueFree("0".repeat(64))(e), "an unknown revision is missing");
  assert.deepEqual(runs(dir), [], "no row");
  assert.equal(existsSync(path.join(dir, "runs")) ? readdirSync(path.join(dir, "runs")).length : 0, 0, "no directory");
  await store.close();
});

test("the join never shows a run whose agent and revision disagree", async () => {
  const { dir, store, agent } = await aStore();
  const other = await store.createAgent({ name: "Other" });
  const theirs = await store.commitRevision(other.id, B, { setCurrent: true });
  await store.startRun({ agent: agent.id });
  await store.startRun({ agent: other.id });
  await assert.rejects(store.startRun({ agent: agent.id, revision: theirs.id }), refused("invalid"));
  const rows = joined(dir);
  assert.equal(rows.length, 2);
  assert.equal(runs(dir).length, 2);
  await store.close();
});

test("a workflow revision's run returns its body, the workflow inside revision.body, and its row names the kind", async () => {
  const dir = await scratch();
  const store = openStoreChecking(dir, () => undefined);
  const agent = await store.createAgent({ name: "Flow" });
  const wf = await store.commitRevision(agent.id, WF, { setCurrent: true });
  const run = await store.startRun({ agent: agent.id });
  assert.equal(run.revision.kind, "workflow");
  assert.deepEqual(run.revision.body.workflow, WF.workflow);
  assert.deepEqual(joined(dir).map((r) => [r.revision, r.kind]), [[wf.id, "workflow"]]);
  await store.close();
});

test("a revision whose stored content no longer matches its id is refused before anything is seeded", async () => {
  const { dir, store, agent, a } = await aStore();
  await store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("DROP TRIGGER revisions_are_written_once");
  db.prepare("UPDATE revisions SET body_json = ? WHERE id = ?").run(JSON.stringify({ ...a.body, instructions: "tampered" }), a.id);
  db.close();
  const again = openStore(dir);
  await assert.rejects(again.startRun({ agent: agent.id }), (e) => refused("format")(e) && valueFree("tampered")(e));
  assert.deepEqual(runs(dir), []);
  await again.close();
});

test("a skill whose bytes no longer match their sha256 is refused (format), and nothing is written", async () => {
  const { dir, store, agent } = await aStore();
  await store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.prepare("UPDATE skills SET content = ?").run("something else\n");
  db.close();
  const again = openStore(dir);
  await assert.rejects(again.startRun({ agent: agent.id }), (e) => refused("format")(e) && valueFree("something else")(e));
  assert.deepEqual(runs(dir), []);
  await again.close();
});

test("a seed that fails throws and writes no row; the same start works once the cause is gone", async () => {
  const { dir, store, agent } = await aStore();
  await writeFile(path.join(dir, "runs"), "not a directory");
  await assert.rejects(store.startRun({ agent: agent.id }));
  assert.deepEqual(runs(dir), [], "no row");
  await rm(path.join(dir, "runs"));
  const run = await store.startRun({ agent: agent.id });
  assert.equal(runs(dir).length, 1);
  assert.ok(existsSync(run.storePath));
  await store.close();
});

test("an insert that fails after the seed leaves no row and no directory: the row is written last", async () => {
  const { dir, store, agent } = await aStore();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("CREATE TRIGGER no_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'stop'); END");
  db.close();
  await assert.rejects(store.startRun({ agent: agent.id }));
  assert.deepEqual(runs(dir), []);
  assert.deepEqual(existsSync(path.join(dir, "runs")) ? readdirSync(path.join(dir, "runs")) : [], [], "the seeded directory was removed");
  await store.close();
});

test("carryBack ends the row once: state, ended_at, cost and summary; a second call is refused and changes nothing", async () => {
  const { dir, store, agent } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  await store.carryBack(run.runId, { state: "completed", costUsd: 0.02, summary: "Acme sells anvils." });
  const [row] = runs(dir);
  assert.deepEqual({ state: row.state, cost_usd: row.cost_usd, summary: row.summary }, { state: "completed", cost_usd: 0.02, summary: "Acme sells anvils." });
  assert.match(row.ended_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.throws(() => store.carryBack(run.runId, { state: "failed", summary: "overwritten?" }), (e) => refused("exists")(e) && valueFree(run.runId)(e));
  const [after] = runs(dir);
  assert.deepEqual({ state: after.state, summary: after.summary, ended_at: after.ended_at }, { state: "completed", summary: "Acme sells anvils.", ended_at: row.ended_at });
  await store.close();
});

test("each ended state is its own state; one outside the set, an unknown run, a bad cost or a bad summary is refused and ends nothing; escalated is final", async () => {
  const { dir, store, agent } = await aStore();
  for (const state of ["completed", "failed", "stopped", "escalated"]) {
    const run = await store.startRun({ agent: agent.id });
    await store.carryBack(run.runId, { state, ...(state === "escalated" ? { summary: "escalated at gate-2" } : {}) });
  }
  assert.deepEqual(runs(dir).map((r) => r.state).sort(), ["completed", "escalated", "failed", "stopped"]);
  assert.equal(runs(dir).find((r) => r.state === "escalated").summary, "escalated at gate-2");
  assert.ok(runs(dir).every((r) => r.ended_at !== null), "every ended state, escalated too, has an end");
  const run = await store.startRun({ agent: agent.id });
  for (const state of ["running", "done", "", 3, undefined, "Completed"]) assert.throws(() => store.carryBack(run.runId, { state }), refused("invalid"));
  for (const costUsd of [-1, Number.NaN, "1", Infinity]) assert.throws(() => store.carryBack(run.runId, { state: "completed", costUsd }), refused("invalid"));
  for (const summary of ["", 3, "x".repeat(5_000)]) assert.throws(() => store.carryBack(run.runId, { state: "completed", summary }), refused("invalid"));
  assert.throws(() => store.carryBack("no-such-run", { state: "completed" }), (e) => refused("missing")(e) && valueFree("no-such-run")(e));
  assert.equal(runs(dir).find((r) => r.id === run.runId).state, "running", "nothing above ended the run");
  await store.close();
});

test("the run folder is today's: its store opens as a pi-durable store, and its work folder holds the revision's skills", async () => {
  const { openHost } = await import("./support.mjs");
  const { AgentDoc, ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
  const { ctx } = await import("./support.mjs");
  const { store, agent } = await aStore();
  const run = await store.startRun({ agent: agent.id });
  const host = await openHost(run.storePath);
  await host.root(ctx, { agent: { instructions: run.revision.body.instructions } });
  assert.equal((await host.snapshot(AgentDoc, ROOT_CONVERSATION_ID, ctx))?.instructions, "Research the company.");
  await host.close(ctx);
  assert.deepEqual(readdirSync(run.workspace).sort(), [".agents"]);
  await store.close();
});

test("the free home functions are unchanged next to the store: a free startRun of a home still seeds from its own definition", async () => {
  const { startRun, createAgentHome } = await import("../dist/index.js");
  const { DEFINITION } = await import("./support.mjs");
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { runId: "free-1", host: "test" });
  assert.deepEqual(run.agent, { instructions: DEFINITION.instructions, tools: DEFINITION.tools });
});
