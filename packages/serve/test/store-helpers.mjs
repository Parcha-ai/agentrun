// Shared by the store's tests: a store on a file in a directory of its own (removed after the test), on a clock the test
// moves, and an agent with one revision.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "../dist/store/sqlite/store.js";

export const T0 = Date.parse("2026-11-08T05:00:00Z");

/** The server's store on a new file, at `clock.now` (ms). `role`/`file`: a second process's store on the same file. */
export async function storeOn(t, { clock = { now: T0 }, file, role = "server" } = {}) {
  const dir = file ? undefined : mkdtempSync(join(tmpdir(), "store-"));
  const path = file ?? join(dir, "store.sqlite");
  const store = await openSqliteStore({ file: path, role, now: () => clock.now });
  t.after(async () => {
    await store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return { store, file: path, clock, dir: dir ?? join(path, "..") };
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
