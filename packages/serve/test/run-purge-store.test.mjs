// The store's half of a purge (DELETE /v2/runs/{run_id} and an archived agent's DELETE, agent-delete.ts), on SQLite and on
// Postgres alike. runs.purge keeps a final run's row as its tombstone (its id, agent, state, times and cost, its purge
// time set last) and removes every other row of it: no table but runs names it after, read from every table the schema
// made, except its kept learning's rows, blanked to their state (the learning meter, learning.spend, reads them). A run
// not final, or held by a runner, is refused, nothing written. agents.purge does the same for an archived agent once each
// of its runs is a tombstone: its revisions' content, its name and description go, its row stays. Another agent's rows
// are never touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { StoreConstraint, TriggersLeft } = await import("../dist/store/index.js");

const BODY = { instructions: "Answer the question.", tools: [], skills: {} };
const KEPT = { meters: { tools: 0.02, tokens: 0.1, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0.1, browser: 0, others: 0 } }, spend: { usd: 0.12, basis: "list" }, learning: { state: "dropped", reason: null } };

/** createInline arguments for run `runId` of agent `agentId` (made on its first run), started under origin key `origin`. */
const inline = (agentId, runId, origin) => ({
  agent: { id: agentId, name: `Expert ${agentId}`, description: "Answers.", ref: `host:expert:${agentId}` },
  revision: { id: `rev-${agentId}`, version: "1", kind: "agentic", body: BODY, skills: {} },
  run: { id: runId, ...(origin ? { origin: { key: origin } } : {}) },
  launch: { body: { input: { content: `The question run ${runId} was asked.` }, title: "a question", place: { mode: "runner" } } },
});

/** Run `runId` claimed, given a journal entry and a command, and ended with `patch`, its kept learning with it. */
async function ended(store, runId, held) {
  const patch = { state: "ended", costUsd: 0.12, summary: "What it answered." };
  const claim = held ?? (await store.claim(runId, "runner-a", { leaseMs: 30_000 }));
  assert.ok(claim, `run ${runId} is claimed`);
  await commitWrites(store.journal(claim), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, patch, { also: [{ table: "learning_proposals", row: { turn: { asked: "what it read" }, proposal: { state: "merged", detail: "What it learned." } } }] });
  return claim;
}

/** Every table the store's schema made, each row's `table.column` whose value names `id`, from the database itself. */
async function mentions(file, id) {
  const db = await raw(file, { readOnly: true });
  try {
    const tables = db.kind === "sqlite"
      ? await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      : await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name");
    assert.ok(tables.length > 20, `the schema's tables are read: ${tables.length}`);
    const found = new Set();
    for (const { name } of tables) {
      for (const row of await db.all(`SELECT * FROM "${name}"`)) {
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value !== null && typeof value === "object" ? JSON.stringify(value) : undefined;
          if (text?.includes(id)) found.add(`${name}.${column}`);
        }
      }
    }
    return [...found].sort();
  } finally {
    await db.close();
  }
}

/** Run `runId`'s row and its kept learning, as the database holds them. */
async function rowsOf(file, runId) {
  const db = await raw(file, { readOnly: true });
  try {
    const run = await db.get("SELECT state, cost_usd, summary, labels, sign_in_handed, listing, list_status, purged_at, metrics FROM runs WHERE id = ?", runId);
    const learning = await db.all("SELECT turn, proposal FROM learning_proposals WHERE run_id = ?", runId);
    const parse = (value) => (typeof value === "string" ? JSON.parse(value) : value);
    return { run: run && { ...run, metrics: parse(run.metrics) }, learning: learning.map((row) => ({ turn: parse(row.turn), proposal: parse(row.proposal) })) };
  } finally {
    await db.close();
  }
}

test("runs.purge keeps a final run's row as its tombstone and no other table names it but its kept learning, blanked; a run not final is refused, nothing written; another run's rows are kept", async (t) => {
  const { store, file } = await storeOn(t);
  await store.runs.createInline(inline("agent-9", "run-a", "key-a"));
  await store.runs.createInline(inline("agent-9", "run-b", "key-b"));
  await store.triggers.create({ id: "trig-9", agentId: "agent-9", name: "nightly", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: "agent-9", input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0 });
  const db = await raw(file);
  await db.run("UPDATE triggers SET last_run_id = ? WHERE id = ?", "run-a", "trig-9");
  await db.close();

  // Queued: refused, nothing written.
  await assert.rejects(store.runs.purge("run-a", KEPT), StoreConstraint, "a queued run is not purged");
  const claim = await store.claim("run-a", "runner-a", { leaseMs: 30_000 });
  await assert.rejects(store.runs.purge("run-a", KEPT), StoreConstraint, "nor one a runner holds");
  assert.equal((await store.runs.get("run-a")).purgedAt, null, "nothing was written");
  assert.ok(await store.runOfOrigin("key-a"), "nor removed");

  await ended(store, "run-a", claim);
  await ended(store, "run-b");
  const before = await mentions(file, "run-a");
  assert.ok(before.includes("run_launch.run_id") && before.includes("run_origins.run_id") && before.includes("pi_conversations.run_id") && before.includes("triggers.last_run_id"), `the run is named across the store before: ${before}`);
  const sibling = await mentions(file, "run-b");

  await store.runs.purge("run-a", KEPT);

  assert.deepEqual(await mentions(file, "run-a"), ["learning_proposals.run_id", "runs.id"], "only its tombstone and its kept learning's row name it");
  const { run, learning } = await rowsOf(file, "run-a");
  assert.deepEqual([run.state, run.cost_usd, run.summary, run.labels, run.sign_in_handed, run.listing, run.list_status], ["ended", 0.12, null, null, null, null, null], "state and cost kept, content blanked");
  assert.ok(Number.isInteger(Number(run.purged_at)) && run.purged_at !== null, "its purge time is set");
  assert.deepEqual(run.metrics.purged, KEPT, "what its spend read from its journal is kept on it");
  assert.deepEqual(learning, [{ turn: {}, proposal: { state: "merged" } }], "its kept learning is its state alone");
  assert.equal(await store.runOfOrigin("key-a"), undefined, "its origin is gone");
  await assert.rejects(store.runs.launch("run-a"), "its launch record is gone");
  assert.equal(await store.learning.proposal("run-a"), undefined, "no learning reader reads it");

  // The row reads as a tombstone, and only the readers that sum ask for it.
  const tomb = await store.runs.get("run-a");
  assert.ok(tomb.purgedAt !== null);
  assert.deepEqual((await store.runs.list({ agentId: "agent-9" })).map((one) => one.id), ["run-b"], "no list shows it");
  assert.deepEqual((await store.runs.list({ agentId: "agent-9", purged: true })).map((one) => one.id).sort(), ["run-a", "run-b"], "a list that sums does");
  assert.deepEqual((await store.runs.every("agent-9")).map((one) => [one.id, one.purgedAt !== null]).sort(), [["run-a", true], ["run-b", false]]);
  await assert.rejects(store.runs.reopen("run-a", { kind: "steer", body: { text: "And eight?" } }), "a tombstone is never opened again");

  // Its sibling's rows are as they were.
  assert.deepEqual(await mentions(file, "run-b"), sibling, "another run's rows are kept");
  assert.ok(await store.runOfOrigin("key-b"));

  // A second purge writes nothing.
  await store.runs.purge("run-a", { meters: null, spend: { usd: 99 } });
  assert.deepEqual((await rowsOf(file, "run-a")).run.metrics.purged, KEPT, "a second purge is no work");
});

test("agents.purge refuses while a run of the agent is not a tombstone, or a trigger of it is left; then keeps its row, blanked, with its revisions' content gone; another agent is never touched", async (t) => {
  const { store, file } = await storeOn(t);
  await agentWithRevision(store, "agent-1", "rev-1");
  await agentWithRevision(store, "agent-2", "rev-2");
  for (const [id, agentId, revisionId] of [["run-1", "agent-1", "rev-1"], ["run-2", "agent-2", "rev-2"]]) {
    await store.runs.create({ id, agentId, revisionId }, { body: { input: { content: "What is six times seven?" } } });
    await ended(store, id);
  }
  await store.triggers.create({ id: "trig-1", agentId: "agent-1", name: "nightly", enabled: false, source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: "agent-1", input: { content: "Answer." } }, nextAt: null, catchupWindowS: 0 });
  await store.agents.archive("agent-1", true);
  const other = await mentions(file, "agent-2");

  await assert.rejects(store.agents.purge("agent-1"), StoreConstraint, "a run not purged keeps the agent");
  await store.runs.purge("run-1", KEPT);
  await assert.rejects(store.agents.purge("agent-1"), TriggersLeft, "and a trigger left");
  assert.equal((await store.agents.get("agent-1")).purgedAt, null, "nothing written");
  await store.triggers.remove("trig-1");

  await store.agents.purge("agent-1");
  const agent = await store.agents.get("agent-1");
  assert.deepEqual([agent.name, agent.description, agent.archivedAt !== null, agent.purgedAt !== null], ["", null, true, true], "its row stays, blanked, archived and purged");
  assert.deepEqual((await store.agents.revisions("agent-1")).map((revision) => [revision.id, revision.body, revision.skills, revision.note]), [["rev-1", {}, null, null]], "its revisions' content is gone, their ids kept");
  assert.deepEqual((await store.agents.list({ archived: true })).map((one) => one.id), [], "no list shows it");
  assert.deepEqual((await store.agents.list({ archived: true, purged: true })).map((one) => one.id), ["agent-1"], "a list that sums does");

  assert.deepEqual(await mentions(file, "agent-2"), other, "the other agent's rows are as they were");
  assert.deepEqual((await store.agents.revisions("agent-2"))[0].body, { instructions: "Answer." });
  assert.equal((await store.runs.get("run-2")).purgedAt, null);

  // A second purge writes nothing.
  await store.agents.purge("agent-1");
  assert.equal((await store.agents.get("agent-1")).purgedAt, agent.purgedAt);
});

test("a run made from another (a replay of its input, an audit's shadow) is never made of a purged run: runs.create refuses it (RunPurged), nothing written; runs.purge refuses a run while one made from it is not purged (RunsMadeFromLeft), nothing written", async (t) => {
  const { store, file } = await storeOn(t);
  await agentWithRevision(store, "agent-1", "rev-1");
  const INPUT = "What the source run was asked.";
  const made = (id, link) => store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: INPUT }, ...link } });
  for (const id of ["run-a", "run-b"]) {
    await made(id, {});
    await ended(store, id);
  }
  // A replay of run-a's input made before its purge (a live claim read its launch first): its purge waits for it.
  await made("replay-a", { replay: { of: "run-a", workflow: "flow", digest: "d1" } });
  const left = await store.runs.purge("run-a", KEPT).then(() => undefined, (error) => error);
  assert.ok(left instanceof StoreConstraint, `refused as a constraint: ${left}`);
  assert.deepEqual([left.name, left.runs], ["RunsMadeFromLeft", ["replay-a"]], "the purge names the replay");
  assert.equal((await store.runs.get("run-a")).purgedAt, null, "nothing written");
  assert.ok(await store.runs.launch("run-a"), "its launch is kept");
  // An audit's shadow of run-b holds run-b's purge the same way, and the store finds it as it finds a replay.
  await made("audit.run-b", { audit: { of: "run-b", workflow: "flow", digest: "d1" } });
  const shadowLeft = await store.runs.purge("run-b", KEPT).then(() => undefined, (error) => error);
  assert.deepEqual([shadowLeft?.name, shadowLeft?.runs], ["RunsMadeFromLeft", ["audit.run-b"]], `the purge names the shadow: ${shadowLeft}`);
  assert.deepEqual(await store.runs.madeFrom("run-b"), ["audit.run-b"]);

  // Each made-from run purged first, then its run: the purges go through.
  for (const id of ["replay-a", "audit.run-b"]) {
    await ended(store, id);
    await store.runs.purge(id, KEPT);
  }
  await store.runs.purge("run-a", KEPT);
  await store.runs.purge("run-b", KEPT);
  assert.ok((await store.runs.get("run-a")).purgedAt !== null);

  // Made after the purge (a claim that read run-a's launch before it): refused, nothing written.
  for (const [id, link] of [["replay-late", { replay: { of: "run-a", workflow: "flow", digest: "d1" } }], ["audit.late", { audit: { of: "run-a", workflow: "flow", digest: "d1" } }]]) {
    const refused = await made(id, link).then(() => undefined, (error) => error);
    assert.deepEqual([refused?.name, refused?.runId], ["RunPurged", "run-a"], `${id} is refused: ${refused}`);
    assert.equal(await store.runs.get(id), undefined, `${id}: nothing written`);
  }
  assert.deepEqual(await mentions(file, INPUT), [], "the source's input is nowhere in the store");
  // A replay of a run that is not purged is made as before.
  await store.runs.create({ id: "run-c", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Another." } } });
  await store.runs.create({ id: "replay-c", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Another." }, replay: { of: "run-c", workflow: "flow", digest: "d1" } } });
  assert.ok(await store.runs.get("replay-c"));
});
