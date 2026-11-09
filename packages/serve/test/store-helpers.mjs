// Shared by the store's tests: a store of its own (a file in a directory of its own, or on Postgres a schema of its own:
// store-target.mjs), removed after the test, on a clock the test moves, and an agent with one revision.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
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
      store = await openPostgresStore({ url: PG_URL, schema, role, now });
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
