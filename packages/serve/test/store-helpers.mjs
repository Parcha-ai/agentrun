// Shared by the store's tests: a store of its own (a file in a directory of its own, or on Postgres a schema of its own:
// store-target.mjs), removed after the test, on a clock the test moves, and an agent with one revision.
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { STORE_FILE } from "../dist/store/sqlite/store.js";
import { dropSchema, freshSchema, onPostgres, PG_URL, schemaOf } from "./store-target.mjs";

export const T0 = Date.parse("2026-11-08T05:00:00Z");

/** The server's store on a new file (or schema), at `clock.now` (ms). `role`/`file`: a second process's store on the same
 *  place (`file` is the place a first storeOn answered: a path, or "pg:<schema>" on Postgres). `dir` is a scratch
 *  directory of the test's either way. */
export async function storeOn(t, { clock = { now: T0 }, file, role = "server" } = {}) {
  const dir = file && !onPostgres ? undefined : mkdtempSync(join(tmpdir(), "store-"));
  const now = () => clock.now;
  let store;
  let place;
  let made;
  if (onPostgres) {
    const schema = schemaOf(file) ?? (made = await freshSchema());
    place = `pg:${schema}`;
    try {
      // The test's clock runs the deadlines too (testClock), as SQLite's store clock does, so a test can jump past a lease.
      store = await openPostgresStore({ url: PG_URL, schema, role, testClock: now });
    } catch (error) {
      if (made) await dropSchema(made);
      if (dir) rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  } else {
    place = file ?? join(dir, "store.sqlite");
    store = await openSqliteStore({ file: place, role, now });
  }
  t.after(async () => {
    await store.close();
    if (made) await dropSchema(made);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return { store, file: place, clock, dir: dir ?? join(place, "..") };
}

/** An agent and its first revision. */
export async function agentWithRevision(store, agentId = "agent-1", revisionId = "rev-1") {
  await store.agents.create({ id: agentId, name: agentId }, { id: revisionId, kind: "agentic", body: { instructions: "Answer." } });
}

/** An agent, its revision and one queued run. */
export async function queued(store, runId = "run-1") {
  if (!(await store.agents.get("agent-1"))) await agentWithRevision(store);
  return store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
}

/** Seed a data directory's store (the new store) for the read-side suites, so none opens the old agent store against a
 *  server's data: agents and their one revision through the store API (agents.create, with a harness when given), then the
 *  runs as rows. `agents`: [[id, name, harness?]]. `runs`: each {id?, agent, state, costUsd?, metrics?, startedMs, endedMs?,
 *  source?} — a completed or escalated run is state 'ended' (escalated keeps outcome 'escalated'), failed and stopped are
 *  their own, a run left 'running' is one the store did not end; `source` makes it an imported run. `archived`:
 *  [["run"|"agent", id]]. The runs go in as one direct INSERT into the new store's runs table (ms times, metrics and
 *  imported_from as JSON), the fast path the read-side suites need for their many rows. Returns the revision id per agent. */
export async function seedRuns(data, agents, runs, archived = []) {
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  const revisions = {};
  for (const [id, name, harness] of agents) {
    const revisionId = `rev-${id}`;
    await store.agents.create({ id, name }, { id: revisionId, kind: "agentic", body: { instructions: "Answer.", ...(harness ? { harness } : {}) } });
    revisions[id] = revisionId;
  }
  await store.close();
  const db = new DatabaseSync(join(data, STORE_FILE));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO runs (id, agent_id, revision_id, state, epoch, cost_usd, metrics, outcome, imported_from, started_at, ended_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)");
    runs.forEach((run, i) => {
      const id = run.id ?? `run-${i}`;
      const state = run.state === "completed" || run.state === "escalated" ? "ended" : run.state;
      insert.run(
        id, run.agent, revisions[run.agent], state, run.costUsd ?? null,
        run.metrics ? JSON.stringify(run.metrics) : null, run.state === "escalated" ? "escalated" : null,
        run.source ? JSON.stringify({ source: run.source, session: id }) : null, run.startedMs, run.endedMs ?? null,
      );
    });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  if (archived.length) {
    const writer = await openSqliteStore({ dataDir: data, role: "server" });
    for (const [kind, id] of archived) await (kind === "agent" ? writer.agents.archive(id, true) : writer.runs.archive(id, true));
    await writer.close();
  }
  return { revisions };
}
