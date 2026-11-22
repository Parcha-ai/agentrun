// Source cutover is a store transaction: preparation may race a revision change or revocation, but stale admission
// writes no run, launch or firing. These tests use independent handles to the same real SQLite file / Postgres schema.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { onPostgres, raw } from "./store-target.mjs";
import { Connection } from "../dist/store/sqlite/connection.js";
import { PgConnection } from "../dist/store/postgres/connection.js";
const errors = await import("../dist/store/store.js");

const revision = (id, extra = {}) => ({ agentId: "agent-1", id, kind: "agentic", body: { instructions: id }, ...extra });
const run = (id, extra = {}) => ({ id, agentId: "agent-1", revisionId: "rev-1", ...extra });
const sourceGuard = { key: "fixture-source", fields: { active: true, generation: 1 } };
const launch = { body: { input: "A prepared source prompt." } };

async function pair(t) {
  const first = await storeOn(t);
  const second = await storeOn(t, { file: first.file, role: "runner", clock: first.clock });
  await agentWithRevision(first.store);
  await first.store.settings.put(sourceGuard.key, { ...sourceGuard.fields, extra: "kept" });
  return { ...first, other: second.store };
}

async function trigger(store) {
  return store.triggers.create({ id: "trigger-1", name: "source", agentId: "agent-1", enabled: true,
    source: { kind: "schedule" }, target: { kind: "start_run", agent_id: "agent-1", input: { content: "Work." } }, nextAt: null, catchupWindowS: null });
}

async function absent(store, file, id) {
  assert.equal(await store.runs.get(id), undefined, "no partial run");
  const db = await raw(file);
  try {
    assert.equal(await db.get("SELECT run_id FROM run_launch WHERE run_id = ?", id), undefined, "no launch");
    assert.equal(await db.get("SELECT run_id FROM run_origins WHERE run_id = ?", id), undefined, "no origin");
  } finally { await db.close(); }
}

test("a launch prepared before cutover is refused after it, with no run, launch or origin", async (t) => {
  const { store, other, file } = await pair(t);
  const prepared = run("stale", { expectedCurrent: (await other.agents.get("agent-1")).currentRevision,
    settingsGuards: [sourceGuard], origin: { key: "stale-origin", fingerprint: "prepared" } });
  await store.agents.addRevision(revision("managed", { ifCurrent: "rev-1", ifNoActiveRuns: true, settingsGuards: [sourceGuard] }));
  await assert.rejects(other.runs.create(prepared, launch), (e) => e instanceof errors.RevisionMoved && e.current === "managed");
  await absent(store, file, "stale");
  // The current pointer guard is distinct from the intentionally pinned source revision.
  await other.runs.create(run("capture", { expectedCurrent: "managed", settingsGuards: [sourceGuard] }), launch);
  assert.equal((await store.runs.get("capture")).revisionId, "rev-1");
  // Existing callers which do not request a guard retain their pinned-revision behavior.
  await other.runs.create(run("unguarded"), launch);
});

for (const state of ["queued", "running", "parked"]) {
  test(`a ${state} run wins admission before cutover: revision and description remain unchanged`, async (t) => {
    const { store, other } = await pair(t);
    await other.runs.create(run("active", { expectedCurrent: "rev-1" }), launch);
    if (state !== "queued") {
      const claim = await other.claim("active", "fixture-runner", { leaseMs: 60_000 });
      if (state === "parked") await other.release(claim, { state: "parked" });
    }
    assert.equal((await store.runs.get("active")).state, state);
    await assert.rejects(store.agents.addRevision(revision("managed", { ifCurrent: "rev-1", ifNoActiveRuns: true, description: "Moved" })),
      (e) => typeof errors.ActiveRuns === "function" && e instanceof errors.ActiveRuns && e.agentId === "agent-1" && e.runIds.includes("active"));
    assert.equal(await store.agents.revision("managed"), undefined);
    assert.deepEqual([(await store.agents.get("agent-1")).currentRevision, (await store.agents.get("agent-1")).description], ["rev-1", null]);
    assert.equal((await store.runs.get("active")).state, state, "cutover never stops or fails admitted work");
    await store.agents.addRevision(revision("ordinary"));
    assert.equal((await store.agents.get("agent-1")).currentRevision, "ordinary", "ordinary edits still work while runs are active");
  });
}

test("ended, failed and stopped history does not block the explicit no-active predicate", async (t) => {
  const { store } = await pair(t);
  for (const state of ["ended", "failed", "stopped"]) {
    await store.runs.create(run(state));
    const claim = await store.claim(state, "fixture-runner", { leaseMs: 60_000 });
    await store.runs.update(claim, { state });
  }
  await store.agents.addRevision(revision("managed", { ifCurrent: "rev-1", ifNoActiveRuns: true }));
  assert.equal((await store.agents.get("agent-1")).currentRevision, "managed");
});

test("a retained capture revision appends without moving current, and still honors CAS and rollback", async (t) => {
  const { store, other } = await pair(t);
  await store.agents.addRevision(revision("managed"));
  await other.agents.addRevision(revision("capture", { advance: false, ifCurrent: "managed", description: "Retained source", settingsGuards: [sourceGuard] }));
  assert.equal((await store.agents.get("agent-1")).currentRevision, "managed");
  assert.equal((await store.agents.get("agent-1")).description, "Retained source");
  assert.equal((await store.agents.revision("capture")).parent, "managed");
  await assert.rejects(other.agents.addRevision(revision("stale-capture", { advance: false, ifCurrent: "rev-1", description: "Stale" })), errors.RevisionMoved);
  assert.equal(await store.agents.revision("stale-capture"), undefined);
  assert.equal((await store.agents.get("agent-1")).description, "Retained source");
  await store.agents.put({ id: "empty", name: "Empty" });
  await store.agents.addRevision({ ...revision("retained-first", { advance: false, ifCurrent: null }), agentId: "empty" });
  assert.equal((await store.agents.get("empty")).currentRevision, null);
  await store.runs.create({ id: "empty-capture", agentId: "empty", revisionId: "retained-first", expectedCurrent: null });
  await assert.rejects(store.runs.create({ id: "wrong-null", agentId: "agent-1", revisionId: "rev-1", expectedCurrent: null }), errors.RevisionMoved);
});

test("a completed revocation refuses revision, run and firing atomically", async (t) => {
  const { store, other, file } = await pair(t);
  await trigger(store);
  await store.triggers.record("trigger-1", [{ key: "due", by: "schedule", nominalAt: null, status: "due" }]);
  await other.settings.put(sourceGuard.key, { active: false, generation: 2 });
  await assert.rejects(store.agents.addRevision(revision("revoked", { settingsGuards: [sourceGuard], description: "Revoked" })), errors.StoreConstraint);
  await assert.rejects(store.runs.create(run("revoked-run", { settingsGuards: [sourceGuard] }), launch), errors.StoreConstraint);
  await assert.rejects(store.triggers.fire({ triggerId: "trigger-1", key: "due" }, run("revoked-fire", { settingsGuards: [sourceGuard] }), { launch }), errors.StoreConstraint);
  assert.equal(await store.agents.revision("revoked"), undefined);
  assert.deepEqual([(await store.agents.get("agent-1")).currentRevision, (await store.agents.get("agent-1")).description], ["rev-1", null]);
  await absent(store, file, "revoked-run");
  await absent(store, file, "revoked-fire");
  assert.equal((await store.triggers.firing("trigger-1", "due")).status, "due");
  assert.equal((await store.triggers.get("trigger-1")).lastRunId, null);
  await other.settings.remove(sourceGuard.key);
  await assert.rejects(store.runs.create(run("missing-grant", { settingsGuards: [sourceGuard] })), errors.StoreConstraint);
});

test("retained trigger firing refuses a stale revision or a trigger moved to another agent", async (t) => {
  const { store, other, file } = await pair(t);
  await trigger(store);
  await store.agents.addRevision(revision("managed", { ifNoActiveRuns: true }));
  await assert.rejects(other.triggers.fire({ triggerId: "trigger-1", key: "stale" }, run("stale-fire", { expectedCurrent: "rev-1" }), { launch }), errors.RevisionMoved);
  await absent(store, file, "stale-fire");
  assert.equal(await store.triggers.firing("trigger-1", "stale"), undefined);
  await agentWithRevision(store, "agent-2", "rev-2");
  await store.triggers.update("trigger-1", { agentId: "agent-2" });
  await assert.rejects(other.triggers.fire({ triggerId: "trigger-1", key: "moved" }, run("moved-fire", { expectedCurrent: "managed" }), { launch }), errors.StoreConstraint);
  await absent(store, file, "moved-fire");
  assert.equal(await store.triggers.firing("trigger-1", "moved"), undefined);
  assert.equal((await store.triggers.get("trigger-1")).lastRunId, null);
});

// Pause one real SQL transaction after a statement returns. Only the adapter boundary is instrumented; all SQL,
// independent handles, row locks, commit/rollback and caller results are real. No sleeps establish ordering.
function holdAfter(t, matches) {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const attempted = Promise.withResolvers();
  const prototype = onPostgres ? PgConnection.prototype : Connection.prototype;
  const original = prototype.transaction;
  const write = prototype.write;
  let held = false;
  t.mock.method(prototype, "write", function (...args) {
    if (held) attempted.resolve();
    return write.apply(this, args);
  });
  t.mock.method(prototype, "transaction", function (callback, options) {
    if (held) attempted.resolve();
    return original.call(this, (tx) => callback(new Proxy(tx, {
      get(target, name) {
        const method = Reflect.get(target, name);
        if (typeof method !== "function") return method;
        return async (...args) => {
          const result = await method.apply(target, args);
          if (!held && matches(name, args)) {
            held = true;
            entered.resolve();
            await resumed.promise;
          }
          return result;
        };
      },
    })), options);
  });
  t.after(() => resumed.resolve());
  return { entered: entered.promise, attempted: attempted.promise, release: () => resumed.resolve() };
}

for (const lane of ["run", "trigger"]) {
test(`cutover holding the agent lock serializes a concurrent stale ${lane} start on another handle`, { timeout: 15_000 }, async (t) => {
  const { store, other, file } = await pair(t);
  if (lane === "trigger") await trigger(store);
  const hold = holdAfter(t, (method, [sql, id]) => method === "get" && sql.startsWith("SELECT current_revision,") && id === "agent-1");
  const move = store.agents.addRevision(revision("managed", { ifCurrent: "rev-1", ifNoActiveRuns: true }));
  await hold.entered;
  const prepared = run("racing-start", { expectedCurrent: "rev-1" });
  const started = lane === "run" ? other.runs.create(prepared, launch)
    : other.triggers.fire({ triggerId: "trigger-1", key: "racing" }, prepared, { launch });
  const refused = assert.rejects(started, errors.RevisionMoved);
  await hold.attempted;
  hold.release();
  await Promise.all([move, refused]);
  await absent(store, file, "racing-start");
  if (lane === "trigger") assert.equal(await store.triggers.firing("trigger-1", "racing"), undefined);
});

test(`${lane} admission holding the agent lock prevents a concurrent cutover from passing its idle check`, { timeout: 15_000 }, async (t) => {
  const { store, other } = await pair(t);
  if (lane === "trigger") await trigger(store);
  const hold = holdAfter(t, (method, [sql, id]) => method === "get" && sql.startsWith("SELECT current_revision,") && id === "agent-1");
  const prepared = run("racing-start", { expectedCurrent: "rev-1" });
  const started = lane === "run" ? other.runs.create(prepared, launch)
    : other.triggers.fire({ triggerId: "trigger-1", key: "racing" }, prepared, { launch });
  await hold.entered;
  const moved = store.agents.addRevision(revision("managed", { ifCurrent: "rev-1", ifNoActiveRuns: true }));
  const refused = assert.rejects(moved, (e) => typeof errors.ActiveRuns === "function" && e instanceof errors.ActiveRuns);
  await hold.attempted;
  hold.release();
  await Promise.all([started, refused]);
  assert.equal((await store.agents.get("agent-1")).currentRevision, "rev-1");
  assert.equal(await store.agents.revision("managed"), undefined);
  assert.equal((await store.runs.get("racing-start")).state, "queued");
});
}

test("source guard holds revocation behind admitted work until the transaction commits", { timeout: 15_000 }, async (t) => {
  const { store, other } = await pair(t);
  const hold = holdAfter(t, (method, [sql, key]) => method === "get" && sql.startsWith("UPDATE settings SET value = value") && key === sourceGuard.key);
  const admitted = store.runs.create(run("first", { settingsGuards: [sourceGuard] }), launch);
  await hold.entered;
  // The attempted gate confirms the second handle entered its real conditional write while admission holds the row.
  const revoked = other.settings.replaceIf(sourceGuard.key, { active: true, generation: 1, extra: "kept" }, { active: false, generation: 2 });
  await hold.attempted;
  hold.release();
  await admitted;
  assert.equal(await revoked, true);
  await assert.rejects(store.runs.create(run("late", { settingsGuards: [sourceGuard] })), errors.StoreConstraint);
  assert.equal((await store.runs.get("first")).state, "queued");
  assert.equal(await store.runs.get("late"), undefined);
});

test("snapshot publication checks source revocation in the same write as the latest-pointer CAS", async (t) => {
  const { store, other } = await pair(t);
  const before = { latest: "old", sequence: 1 };
  await store.settings.put("source-publication", before);
  await other.settings.put(sourceGuard.key, { active: false, generation: 2 });
  await assert.rejects(store.settings.replaceIf("source-publication", before, { latest: "late", sequence: 2 }, undefined, [sourceGuard]), errors.StoreConstraint);
  assert.deepEqual(await store.settings.get("source-publication"), before);
  assert.equal(await store.settings.replaceIf("source-publication", { latest: "stale" }, { latest: "wrong" }), false, "ordinary stale CAS remains a no-op");
  assert.equal(await store.settings.replaceIf("missing-publication", before, { latest: "wrong" }), false, "ordinary absent-row CAS remains a no-op");
  assert.equal(await store.settings.replaceIf("source-publication", before, { latest: "ordinary" }), true, "unguarded default unchanged");
});

test("guarded publication holds revocation until its pointer commit", { timeout: 15_000 }, async (t) => {
  const { store, other } = await pair(t);
  const before = { latest: "old" }, after = { latest: "accepted" };
  await store.settings.put("source-publication", before);
  const hold = holdAfter(t, (method, [sql, key]) => method === "get" && sql.startsWith("UPDATE settings SET value = value") && key === sourceGuard.key);
  const published = store.settings.replaceIf("source-publication", before, after, undefined, [sourceGuard]);
  await hold.entered;
  const revoked = other.settings.replaceIf(sourceGuard.key, { active: true, generation: 1, extra: "kept" }, { active: false, generation: 2 });
  await hold.attempted;
  hold.release();
  assert.equal(await published, true);
  assert.equal(await revoked, true);
  assert.deepEqual(await store.settings.get("source-publication"), after);
  await assert.rejects(store.settings.replaceIf("source-publication", after, { latest: "late" }, undefined, [sourceGuard]), errors.StoreConstraint);
});
