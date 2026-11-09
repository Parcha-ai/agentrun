// The CLI adapters' sessions on the run's journal (runner/sessions.ts, journalSessions): run-adapters' SessionStore bound to
// the one Harness a run's loop opens on store.journal(claim). It is the adapters' resume log only (a run's visible record
// is the loop's). A session's records land in that run's journal (a conversation per key, named by an
// `agentrun.session.key` entry on the root; a record per entry), fenced by the run's claim: a
// writer whose claim moved on is refused SessionFenced and so is every later append of its store, and a run reopened at
// the next epoch reads them back and goes on. sync() is one durable flush of the store.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SessionFenced } from "@parcha/agentrun-kernel";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { journalSessions } = await import("../dist/runner/sessions.js");
const ctx = BACKGROUND_CONTEXT;
const LEASE = 10_000;
const record = (n) => ({ kind: "kernel.test", data: { n, text: `record ${n}` } });

/** A store with run `runId` queued and claimed by `runner`, the run's one Harness on its journal, and its sessions. */
async function claimed(t, { runId = "run-1", runner = "runner-a", at } = {}) {
  const opened = at ?? (await storeOn(t));
  await queued(opened.store, runId);
  const claim = await opened.store.claim(runId, runner, { leaseMs: LEASE });
  assert.ok(claim, "the run is claimed");
  return { ...opened, claim, ...(await onClaim(opened.store, claim)) };
}

/** The run's Harness on store.journal(claim) and journalSessions on it, as the loop binds them (context: the loop's). */
async function onClaim(store, claim, context = ctx) {
  const harness = await Harness.open(store.journal(claim), { registry: createRegistry(), models: createModels() }, context);
  return { harness, sessions: journalSessions(harness, context, store) };
}

/** The store file's rows, read by a connection of the test's own. */
function rows(file, sql, ...params) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
const entriesOf = (file, runId) => rows(file, "SELECT conversation_id, record FROM pi_entries WHERE run_id = ? ORDER BY id", runId).map((row) => ({ conversation: row.conversation_id, ...JSON.parse(row.record) }));

test("R1: a session's records land in that run's journal, a conversation per key named on the root, and read() returns them in order", async (t) => {
  const { file, sessions } = await claimed(t);
  assert.deepEqual(await sessions.read("node-1"), [], "a key never opened has no records");
  const writer = await sessions.open("node-1");
  await writer.append([record(1), record(2)]);
  await writer.append([record(3)]);
  assert.deepEqual(await sessions.read("node-1"), [record(1), record(2), record(3)]);
  assert.deepEqual(await writer.read(), [record(1), record(2), record(3)]);
  const entries = entriesOf(file, "run-1");
  const named = entries.find((entry) => entry.kind === "agentrun.session.key" && entry.data?.key === "node-1");
  assert.ok(named, `the root names the key's conversation: ${JSON.stringify(entries)}`);
  assert.deepEqual(entries.filter((entry) => entry.conversation === named.data.conversation).map((entry) => entry.data), [1, 2, 3].map((n) => record(n).data), "each record is an entry of that conversation, in order");
});

test("R2: a writer whose claim moved on is refused SessionFenced and writes nothing, and every later append of its store is refused at once", async (t) => {
  const { store, file, clock, sessions } = await claimed(t);
  const writer = await sessions.open("node-1");
  await writer.append([record(1)]);
  const other = await sessions.open("node-2");
  // The claim lapses and another runner takes the run: the epoch moves on.
  clock.now = T0 + LEASE + 1;
  assert.ok(await store.claim("run-1", "runner-b", { leaseMs: LEASE }), "the next claim takes the run");
  const before = entriesOf(file, "run-1").length;
  await assert.rejects(writer.append([record(2)]), (error) => error instanceof SessionFenced && error.key === "node-1", "the fenced writer is refused SessionFenced");
  assert.equal(entriesOf(file, "run-1").length, before, "and wrote nothing");
  // Never retried under the newer epoch: every later append of this store is refused, whatever its key or writer.
  await assert.rejects(other.append([record(9)]), (error) => error instanceof SessionFenced && error.key === "node-2");
  await assert.rejects((async () => (await sessions.open("node-3")).append([record(7)]))(), SessionFenced);
  assert.equal(entriesOf(file, "run-1").length, before, "no later append wrote anything");
});

test("R2: once the claim's signal is aborted (the claim lost, or the runner shutting down), the store refuses every append SessionFenced", async (t) => {
  const opened = await storeOn(t);
  await queued(opened.store, "run-1");
  const claim = await opened.store.claim("run-1", "runner-a", { leaseMs: LEASE });
  const lost = new AbortController();
  const { sessions } = await onClaim(opened.store, claim, withAbortSignal(lost.signal, ctx));
  const writer = await sessions.open("node-1");
  await writer.append([record(1)]);
  lost.abort(new Error("the claim was lost"));
  await assert.rejects(writer.append([record(2)]), SessionFenced);
  assert.deepEqual((await sessions.read("node-1")).map((r) => r.data.n), [1], "nothing after the abort");
});

test("keys() lists every session key of the run: an earlier claim's, read before any open, and each this store opens after", async (t) => {
  const { store, clock, sessions } = await claimed(t);
  await (await sessions.open("node-1")).append([record(1)]);
  await (await sessions.open("node-2")).append([record(2)]);
  clock.now = T0 + LEASE + 1;
  const next = await store.claim("run-1", "runner-b", { leaseMs: LEASE });
  const reopened = await onClaim(store, next);
  assert.deepEqual((await reopened.sessions.keys()).sort(), ["node-1", "node-2"], "the earlier claim's keys, before any open");
  await reopened.sessions.open("node-3");
  assert.deepEqual((await reopened.sessions.keys()).sort(), ["node-1", "node-2", "node-3"], "and one this store opened");
});

test("R3: a run reopened at the next epoch reads its sessions back and goes on from them", async (t) => {
  const { store, clock, sessions } = await claimed(t);
  const writer = await sessions.open("node-1");
  await writer.append([record(1), record(2)]);
  clock.now = T0 + LEASE + 1;
  const next = await store.claim("run-1", "runner-b", { leaseMs: LEASE });
  assert.equal(next.epoch, 2, "the next claim's epoch");
  const reopened = await onClaim(store, next);
  assert.deepEqual(await reopened.sessions.read("node-1"), [record(1), record(2)], "the next epoch reads what the last one wrote");
  const resumed = await reopened.sessions.open("node-1");
  await resumed.append([record(3)]);
  assert.deepEqual((await reopened.sessions.read("node-1")).map((r) => r.data.n), [1, 2, 3], "and goes on from it, in the same conversation");
});

test("R4: the newest open of a key is its one writer: an earlier writer's append is refused SessionFenced and writes nothing", async (t) => {
  const { sessions } = await claimed(t);
  const first = await sessions.open("node-1");
  await first.append([record(1)]);
  const second = await sessions.open("node-1");
  await assert.rejects(first.append([record(2), record(3)]), (error) => error instanceof SessionFenced && error.key === "node-1");
  await second.append([record(4)]);
  assert.deepEqual((await sessions.read("node-1")).map((r) => r.data.n), [1, 4]);
});

test("R5: sync() is one durable flush of the store", async (t) => {
  const { file, sessions } = await claimed(t);
  const writer = await sessions.open("node-1");
  await writer.append([record(1)]);
  const flushes = () => rows(file, "SELECT flushes FROM store_meta")[0].flushes;
  const before = flushes();
  await writer.sync();
  assert.equal(flushes(), before + 1, "one FULL commit of the store");
});

test("R6: two runs' sessions with the same key stay apart", async (t) => {
  const a = await claimed(t, { runId: "run-a" });
  const b = await claimed(t, { runId: "run-b", at: a });
  await (await a.sessions.open("node-1")).append([record(1)]);
  await (await b.sessions.open("node-1")).append([record(2)]);
  assert.deepEqual((await a.sessions.read("node-1")).map((r) => r.data.n), [1]);
  assert.deepEqual((await b.sessions.read("node-1")).map((r) => r.data.n), [2]);
});
