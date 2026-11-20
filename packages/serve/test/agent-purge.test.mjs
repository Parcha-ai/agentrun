// DELETE /v2/agents/{agent_id} of an agent made here (agent-delete.ts purgeAgent): once archived it is purged by the same
// rule as a run. Its revisions' content, its learning, its triggers, its sign-ins, its computer, disk and folders go; each
// of its runs becomes a tombstone; its own row stays as its tombstone (its id, archive and purge times), and every route
// of it is 410 purged. What its runs cost stays in every total. Not archived: 409 agent_not_archived. A run of it live:
// 409 run_not_final, nothing purged. Purging one agent never touches another. Another system's agent keeps its delete
// whole (agent-delete.test.mjs).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { shadowRunId } from "../dist/learn/audit.js";
import { runFolder } from "../dist/workspace/paths.js";
import { agent, FAUX, follow, serve, startInProcessRunner } from "./support.mjs";

const WINDOW = "from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";

/** A server with a runner of the test's own beside it, which `halt()` closes: a run the test writes to the store after
 *  that is claimed by the test alone, never raced by a runner. */
async function haltable(t, options = {}) {
  const server = await serve(t, { ...options, runner: false });
  const close = await startInProcessRunner(server.data, { ...options, faux: FAUX, mcpOwn: server.own });
  let closed;
  const halt = () => (closed ??= close());
  t.after(halt);
  return { ...server, halt };
}

/** `table.column` of each row of the store's file whose value has `text`. */
function mentions(data, text) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const found = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          const held = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
          if (held?.includes(text)) found.push(`${name}.${column}`);
        }
      }
    }
    return [...new Set(found)].sort();
  } finally {
    db.close();
  }
}

/** Agent `id` made here with `instructions`, and one completed run of it: the run's id. */
async function agentWithRun(api, id, instructions) {
  assert.equal((await api("POST", "/agents", agent(id, { instructions }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: `A question for ${id}.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  return run.body.run_id;
}

const money = async (api) => ({
  meter: (await api("GET", `/usage?${WINDOW}&group_by=meter`)).body,
  agent: (await api("GET", `/usage?${WINDOW}&group_by=agent`)).body,
  stats: (await api("GET", "/stats")).body,
});

test("an archived agent made here is purged: its runs tombstones, its definition gone, its row a tombstone (410 purged), its runs' money kept; the other agent untouched; a second DELETE 204", { timeout: 180_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  const gone = await agentWithRun(api, "gone-agent", "The instructions only this agent holds.");
  const kept = await agentWithRun(api, "kept-agent", "The other agent's instructions.");
  await halt();
  const shadow = shadowRunId(gone);
  const agentRevision = (await store.agents.get("gone-agent")).currentRevision;
  await store.runs.create({ id: shadow, agentId: "gone-agent", revisionId: agentRevision }, { body: { input: { content: "Again." } } });
  await store.runs.update(await store.claim(shadow, "runner-test", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.07 });
  const keptBefore = { agent: (await api("GET", "/agents/kept-agent")).body, run: (await api("GET", `/runs/${kept}`)).body, where: mentions(data, "The other agent's instructions.") };

  const live = await api("DELETE", "/agents/gone-agent");
  assert.deepEqual([live.status, live.body.error?.code], [409, "agent_not_archived"], JSON.stringify(live.body));
  assert.equal((await api("POST", "/agents/gone-agent/archive")).status, 200);
  const before = await money(api);

  const deleted = await api("DELETE", "/agents/gone-agent");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

  assert.deepEqual(await money(api), before, "/usage by meter and agent, and /stats, are as they were");
  const read = await api("GET", "/agents/gone-agent");
  assert.deepEqual([read.status, read.body.error?.code], [410, "purged"], JSON.stringify(read.body));
  assert.deepEqual(Object.keys(read.body.error.details).sort(), ["agent_id", "archived_at", "purged_at"]);
  assert.equal(read.body.error.details.agent_id, "gone-agent");
  for (const path of ["/agents/gone-agent/runs", "/agents/gone-agent/learning"]) {
    assert.equal((await api("GET", path)).status, 410, `GET ${path} is 410`);
  }
  for (const run of [gone, shadow]) assert.equal((await api("GET", `/runs/${run}`)).status, 410, `its run ${run} is a tombstone`);
  assert.ok(!(await api("GET", "/agents?archived=true")).body.agents?.some((one) => one.id === "gone-agent"), "no list shows it");
  assert.deepEqual(mentions(data, "The instructions only this agent holds."), [], "its definition is gone");
  assert.deepEqual(mentions(data, gone), ["runs.id"], "its run is named by its tombstone alone (its shadow's is named after it)");
  assert.ok(!existsSync(dirname(runFolder(data, "gone-agent", gone))), "its run's folder is gone");

  // The other agent is as it was.
  assert.deepEqual((await api("GET", "/agents/kept-agent")).body, keptBefore.agent);
  assert.deepEqual((await api("GET", `/runs/${kept}`)).body, keptBefore.run);
  assert.deepEqual(mentions(data, "The other agent's instructions."), keptBefore.where);
  assert.ok(existsSync(dirname(runFolder(data, "kept-agent", kept))), "and its run's folder");

  assert.equal((await api("DELETE", "/agents/gone-agent")).status, 204, "a second DELETE is 204");
  assert.deepEqual(await money(api), before);
});

test("an archived agent with a live run is 409 run_not_final, nothing purged; once the run ends, the DELETE purges it", { timeout: 120_000 }, async (t) => {
  const { api, store, halt } = await haltable(t);
  const done = await agentWithRun(api, "busy", "Answer.");
  await halt();
  assert.equal((await api("POST", "/agents/busy/archive")).status, 200);
  // A run that reached it before its archive, still held by a runner.
  const revisionId = (await store.agents.get("busy")).currentRevision;
  await store.runs.create({ id: "held-1", agentId: "busy", revisionId }, { body: { input: { content: "Still going." } } });
  const claim = await store.claim("held-1", "runner-test", { leaseMs: 120_000 });

  const refused = await api("DELETE", "/agents/busy");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, ["held-1"]);
  assert.equal((await store.agents.get("busy")).purgedAt, null, "the agent is not purged");
  assert.equal((await store.runs.get(done)).purgedAt, null, "nor its ended run");

  await store.runs.update(claim, { state: "stopped", outcome: "cancelled" });
  assert.equal((await api("DELETE", "/agents/busy")).status, 204);
  for (const run of [done, "held-1"]) assert.ok((await store.runs.get(run)).purgedAt !== null, `${run} is a tombstone`);
});

for (const step of ["after_step_2", "in_step_3"]) {
  test(`an agent's purge stopped ${step.replaceAll("_", " ")} is not purged yet; the next DELETE finishes it`, { timeout: 120_000 }, async (t) => {
    const crash = { done: false };
    const { api, store } = await serve(t, {
      agentDeleteAt: (at) => {
        if (at !== step || crash.done) return;
        crash.done = true;
        throw new Error(`stopped ${at}`);
      },
    });
    const first = await agentWithRun(api, "half", "Answer.");
    const second = await api("POST", "/agents/half/runs", { input: { content: "Another." } });
    await follow(api, second.body.run_id, ["completed"]);
    assert.equal((await api("POST", "/agents/half/archive")).status, 200);
    const stopped = await api("DELETE", "/agents/half");
    assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
    assert.equal((await store.agents.get("half")).purgedAt, null, "the agent is not purged yet");
    assert.equal((await api("GET", "/agents/half")).status, 200);
    assert.equal((await api("DELETE", "/agents/half")).status, 204);
    assert.equal((await api("GET", "/agents/half")).status, 410);
    for (const run of [first, second.body.run_id]) assert.ok((await store.runs.get(run)).purgedAt !== null, `${run} is a tombstone`);
  });
}
