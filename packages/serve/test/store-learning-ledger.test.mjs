// The learning ledger on the store itself (SQLite here, Postgres under `npm run test:pg`): what a run's end writes
// (learning_ledger, learning_spend: store/sqlite/run-patch.ts recordLedger) and how the readers read it
// (store-reads/learning.ts):
//   - an end records its row with why it was not served alone (`cost_stop`, `cut`); the ledger reads both tables as one
//     read, scoped to the runs asked for;
//   - a run's end again (after a reopen) writes its spend rows anew, none left from the end before; healCost records the
//     row again with the healed cost; a purge takes the run's row and every spend row it booked or that audits it,
//     but a figure it booked on another run's account: a keyed replay purged with its input keeps what it spent on the
//     paying run's key, that run's learning, with no revision named (its view, the ledger and the learning total agree);
//   - a run that ended with no row is recorded once, at the server's open (run-patch.ts backfillLedger), at the figures
//     its end would have written, a page at a time; an open after a stop partway records the rest, and once the ledger
//     is marked whole (store_meta.ledger_backfilled) no open reads the runs again; no read records one; each run is
//     locked before it is read again, so a heal another server commits meanwhile stands;
//   - a run a follow-up opened again whose row a build before #4050's split wrote (its job the first round's figure) is
//     recorded again once, at the server's open, a page at a time, then marked (store_meta.ledger_rerecorded); Postgres
//     0034 adds the mark, breaking for runners, as SQLite's version 18; the mark is set only by a pass that started with
//     no runner of an earlier build there (its row's `knows` null or below the floor): until then the server's next try
//     (Store.rerecordReopened, on a timer) records the runs again, so one such a runner ended meanwhile under the split
//     before is recorded under this one, with no restart; a runner of this build (keepPresence says what it knows) holds
//     no mark;
//   - a store the ledger's first release left (version 15, which a runner refuses until the server brings it to 18) has
//     its wrong rows recorded again at the open that drops their epoch (a shadow with no path or audit spend, a stale
//     row, an unknown cost its run now has, a run by hand with no path), by the ledger step alone (no earlier step runs
//     again), its mark set back so even a ledger marked whole is recorded again; Postgres 0030 runs again unharmed;
//   - the read before the window (Learning.byHandBefore) walks the by-hand index, no sort of the agent's rows;
//   - a cancel that wins an end keeping its job's end (keepsEnd) moves its ended_at after its row is written: the row
//     is read as written, no round read again;
//   - the money rule's read at a claim (pastRunsOverStore) is bounded: the agent's newest PAST_RUNS runs on no named disk,
//     the ledger of those runs alone, no agent-wide read; its
//     by-hand side is the job's own cost of the `agent` runs among the same runs as its served side (since the reset, no
//     named disk), and the cost page says the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { raw, sqliteOnly } from "./store-target.mjs";

const { agentCostOverStore, pastRunsOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { BY_HAND_BEFORE } = await import("../dist/store/sqlite/run-patch.js");
const { RUNNER_STALE_MS, SCHEMA_VERSION, StoreAwaitsServer } = await import("../dist/store/index.js");
const { keepPresence } = await import("../dist/runner/presence.js");
const { PAST_RUNS, workflowCostsOf } = await import("../dist/runner/workflow-first.js");
const { keepResetAt } = await import("../dist/learn/promote.js");
const { noteLearningChild } = await import("../dist/learning-work.js");
const { purgeRun } = await import("../dist/agent-delete.js");
const { sealRunLaunch } = await import("../dist/store/seal.js");

const C = "c".repeat(16);
const D = "d".repeat(16);
const AT = "2026-11-24T00:00:00.000Z";
/** A run the platform's call of `answer` at C served (its record's call, as the money rule counts it). */
const SERVED = { path: "workflow", workflow: "answer", workflow_digest: C, workflow_calls: [{ workflow: "answer", digest: C, caller: "platform", outcome: "answered", usd: 0.05 }] };
const KEPT = { meters: { tools: 0, tokens: 0.1, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0.1, browser: 0, others: 0 } }, spend: { usd: 0.1, basis: "list" }, learning: { state: "dropped", reason: null } };
/** A kept round `n`: its job's cost as it answered, its compile turn's (look_back_usd), and the draft it kept. */
const kept = (n, job, look, extra = {}) => ({ table: "learning_proposals", row: { round: n, turn: {}, proposal: { state: "dropped", reason: "empty", detail: "d", answered_at: AT, job_cost_usd: job, look_back_usd: look, ...extra } } });

/** A store with agent-1 and its revision, and `end`: run `id` made and ended at the clock's next second, its row's cost
 *  `costUsd` and its metrics, with `also`'s rows; on a named disk with `disk`; an audit's shadow with `audit`; a check's
 *  replay with `replay`; a launch that learns with `learns`; its input's words `input`; a sealed copy of a key `sealed`. */
async function ledgerStore(t) {
  const clock = { now: T0 };
  const { store, file } = await storeOn(t, { clock });
  await agentWithRevision(store, "agent-1", "rev-1");
  const end = async (id, costUsd, metrics = { path: "agent" }, { also = [], disk, audit, replay, learns, input = "q", sealed, revisionId = "rev-1" } = {}) => {
    clock.now += 1_000;
    const learning = learns ? { learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } } : {};
    await store.runs.create({ id, agentId: "agent-1", revisionId }, { body: { input: { content: input }, title: "t", place: { mode: "runner" }, ...(disk ? { archil_disk: { disk_id: disk, kind: "launch" } } : {}), ...(audit ? { audit } : {}), ...(replay ? { replay } : {}), ...learning }, ...(sealed ? { sealed } : {}) });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    clock.now += 1_000;
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, also.length ? { also } : undefined);
  };
  return { store, file, clock, end };
}

test("an end records its ledger row with why it was not served alone (cost_stop, cut); the ledger reads the rows and spend of the runs it is asked for", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("r-stop", 0.4, { path: "agent", not_served: "cost_stop" });
  await end("r-cut", 0.2, { path: "handed_back", workflow: "answer", workflow_digest: C, workflow_cut: true });
  await end("r-compile", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  const all = await store.learning.ledger("agent-1");
  const byId = new Map(all.rows.map((row) => [row.runId, row]));
  assert.deepEqual([byId.get("r-stop").notServed, byId.get("r-cut").notServed, byId.get("r-compile").notServed], ["cost_stop", "cut", null]);
  assert.equal(Object.hasOwn(byId.get("r-stop"), "epoch"), false, "a row says no epoch");
  const scoped = await store.learning.ledger("agent-1", ["r-cut", "r-compile"]);
  assert.deepEqual(scoped.rows.map((row) => row.runId).sort(), ["r-compile", "r-cut"], "the rows of the runs asked for alone");
  assert.deepEqual(scoped.spend.map((one) => [one.runId, one.kind, one.round, one.digest, one.usd]), [["r-compile", "compile", 1, C, 0.3]]);
  assert.deepEqual((await store.learning.ledger("agent-1", [])).rows, [], "no run asked for: none");
});

test("an end records its run's learned workflow calls on its ledger row, the agent's own as well as the platform's, each checked as read; a run that called none keeps none", async (t) => {
  const { store, end } = await ledgerStore(t);
  const calls = [
    { workflow: "answer", digest: C, caller: "platform", outcome: "handed_back", usd: 0.25 },
    { workflow: "answer", digest: D, caller: "agent", outcome: "answered", usd: null },
  ];
  await end("r-called", 1, { path: "handed_back", workflow: "answer", workflow_digest: C, workflow_calls: [...calls, { workflow: "answer", caller: "agent" }] });
  await end("r-none", 1, { path: "agent" });
  const byId = new Map((await store.learning.ledger("agent-1")).rows.map((row) => [row.runId, row]));
  assert.deepEqual(byId.get("r-called").workflowCalls, calls, "each call as its end wrote it, one off its shape left out");
  assert.deepEqual(byId.get("r-none").workflowCalls, []);
});

test("a run's end again writes its spend rows anew, none left from the end before; healCost records its row again; a purge takes its row and every spend row it booked or that audits it", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("r1", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  assert.deepEqual((await store.learning.ledger("agent-1", ["r1"])).spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3]]);
  // A follow-up opens it again; its second end drafted D in its second round.
  const steer = await store.runs.reopen("r1", { kind: "steer", body: { text: "again" } });
  const claim = await store.claim("r1", "runner-a", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  clock.now += 1_000;
  await store.runs.update(claim, { state: "ended", costUsd: 2, metrics: { path: "agent" } }, { also: [kept(2, 1.5, 0.2, { compiled: { workflow: "answer", digest: D } })] });
  const again = await store.learning.ledger("agent-1", ["r1"]);
  assert.deepEqual(again.spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3], [2, D, 0.2]], "each round's compile once: the rows of the end before are replaced, not added to");

  await end("r2", null);
  assert.equal((await store.learning.ledger("agent-1", ["r2"])).rows[0].cost, "unknown");
  const ended = await store.runs.get("r2");
  assert.equal(await store.runs.healCost("r2", { epoch: ended.epoch, endedAt: ended.endedAt }, { costUsd: 0.7, costUpperBound: false }), true);
  assert.deepEqual((({ cost, jobUsd }) => ({ cost, jobUsd }))((await store.learning.ledger("agent-1", ["r2"])).rows[0]), { cost: "known", jobUsd: 0.7 }, "the healed cost is the job's");

  await end("audit.r1", 0.05, { path: "audit", audit: { of: "r1", workflow: "answer", digest: D } });
  await store.runs.purge("r1", KEPT);
  const left = await store.learning.ledger("agent-1");
  assert.deepEqual(left.rows.map((row) => row.runId).sort(), ["audit.r1", "r2"], "the purged run's row is gone");
  assert.deepEqual(left.spend.filter((one) => one.runId === "r1" || one.ofRun === "r1"), [], "and every spend row it booked or that audits it");
});

// Review on #3914 (round 5, money): a keyed replay reads its input from `replay.of` and spends on the key of
// `replay.paid_by`. A purge of that input purges the replay first (agent-delete.ts purgeRun), but the paying run is not
// purged: what the replay spent stays its learning, read the same by its view, the agent's ledger and the learning total.
// Only that figure stays: the replay's sealed copy of the key, its input, and the revision its spend row named go.
test("a purge of a keyed replay's input keeps what the replay spent on the paying run's key: the run's view, the agent's ledger and the learning total read it as before; only the figure stays, the replay's sealed copy and input gone", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  const words = ["input", "words", process.pid].join("-");
  await end("s0", 0.3, { path: "agent" }, { input: words });
  await end("p1", 0.4);
  await noteLearningChild(store.settings, "p1", { run: "rp1", kind: "replay", at: clock.now, keyed: true });
  const sealed = sealRunLaunch(Buffer.alloc(32, 9), "rp1", { model: { key: "not-a-secret-run-key", origin: "https://gateway.test" } });
  await end("rp1", 0.2, {}, { replay: { of: "s0", workflow: "answer", digest: C, paid_by: "p1" }, input: words, sealed });
  const read = async () => {
    const view = await runAllInOverStore(store, "p1");
    const agent = await agentCostOverStore(store, "agent-1");
    const row = agent.runs.find((run) => run.run_id === "p1");
    return { view: [view.check_usd, view.learning_usd, view.all_in_usd], ledger: [row?.check_usd, row?.learning_usd, row?.total_usd], learning: agent.bill.learning_usd };
  };
  const before = await read();
  assert.deepEqual([before.view[0], before.ledger], [0.2, before.view], `the replay's cost is p1's check, read the same by its view and the ledger: ${JSON.stringify(before)}`);

  // The input's purge, as DELETE /v2/runs/{run_id} runs it: the replay made from it is purged first.
  const KEPT_NONE = { meters: null, spend: { usd: 0, basis: "list" }, learning: null };
  const host = { store, madeFrom: (id) => store.runs.madeFrom(id), forgetCopies: async () => {}, forgetRun: async () => {}, kept: async () => KEPT_NONE, turnOver: async () => false, waitMs: 60_000, pollMs: 20 };
  await purgeRun(host, "s0");
  assert.deepEqual([(await store.runs.get("s0")).purgedAt !== null, (await store.runs.get("rp1")).purgedAt !== null, (await store.runs.get("p1")).purgedAt], [true, true, null], "the input and its replay purged, the paying run not");
  assert.deepEqual(await read(), before, "the paying run's check, learning and all-in, in its view, the agent's ledger and the learning total, as before the purge");

  // Only the figure: the replay's spend row names no revision, and its launch (the sealed copy, the input) is gone.
  const { spend } = await store.learning.ledger("agent-1", ["rp1"]);
  assert.deepEqual(spend.map((one) => [one.runId, one.kind, one.ofRun, one.workflow, one.digest, one.usd]), [["rp1", "check", "p1", null, null, 0.2]], JSON.stringify(spend));
  for (const id of ["rp1", "s0"]) {
    const launch = await store.runs.launch(id).catch(() => undefined);
    assert.deepEqual([launch?.sealed ?? null, JSON.stringify(launch?.body ?? null).includes(words)], [null, false], `${id}: no sealed copy and no input after the purge`);
  }
  // The paying run's own purge takes the row with it.
  await purgeRun(host, "p1");
  assert.deepEqual((await store.learning.ledger("agent-1")).spend.filter((one) => one.ofRun === "p1"), [], "gone with the paying run's purge");
});

test("a run that ended with no ledger row (a build before the ledger ended it) is recorded once, at the server's open, at the figures its end would have written; no read records it", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("r1", 1);
  await end("r2", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  await end("s1", 0.1, SERVED);
  const figures = async (on) => ({
    page: (await agentCostOverStore(on, "agent-1")).runs.map((run) => [run.run_id, run.cost_usd, run.learning_usd, run.compile_usd, run.total_usd]),
    run: await runAllInOverStore(on, "r2"),
    past: await pastRunsOverStore(on, "agent-1"),
    ledger: await on.learning.ledger("agent-1"),
  });
  const before = await figures(store);
  assert.deepEqual(before.page.find(([id]) => id === "r2"), ["r2", 1, 0.3, 0.3, 1.3]);
  const db = await raw(file);
  await db.run("DELETE FROM learning_ledger WHERE run_id IN (?, ?)", "r1", "r2");
  await db.run("DELETE FROM learning_spend WHERE run_id IN (?, ?)", "r1", "r2");
  // As an earlier build left the store: ended runs with no row, the ledger never marked whole.
  await db.run("UPDATE store_meta SET ledger_backfilled = 0 WHERE singleton = 1");
  await db.close();
  await pastRunsOverStore(store, "agent-1");
  assert.deepEqual((await store.learning.ledger("agent-1", ["r1", "r2"])).rows, [], "a read records neither");
  await store.close();
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.deepEqual(await figures(reopened), before, "the server's open recorded both from their run rows and rounds, as their ends did");
});

test("a ledger an earlier build made keeps no calls: the server's open adds the column before its backfill, which records each run with its calls; a runner waits for it", sqliteOnly("SQLite adds the column at the server's open; Postgres in migration 0031, before the same backfill"), async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("s1", 0.1, SERVED);
  await end("h1", 1);
  await store.close();
  const db = await raw(file);
  // As that build left the store: no calls column, and ended runs with no row, the ledger never marked whole.
  await db.run("ALTER TABLE learning_ledger DROP COLUMN workflow_calls");
  await db.run("DELETE FROM learning_ledger");
  await db.run("UPDATE store_meta SET ledger_backfilled = 0 WHERE singleton = 1");
  await db.close();
  await assert.rejects(storeOn(t, { file, clock, role: "runner" }), (error) => error instanceof StoreAwaitsServer, "a runner waits for the server that adds the column");
  const { store: reopened } = await storeOn(t, { file, clock });
  const byId = new Map((await reopened.learning.ledger("agent-1")).rows.map((row) => [row.runId, row]));
  assert.deepEqual([byId.get("s1")?.workflowCalls, byId.get("h1")?.workflowCalls], [SERVED.workflow_calls, []], "the backfill wrote each run's calls from its metrics");
});

test("a cancel that wins an end keeping its job's end (keepsEnd) moves its ended_at after its row is written: the row is read as written, and no read records it again", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("R", 1.1, { path: "agent" }, { also: [kept(1, 1, 0.1, { compiled: { workflow: "answer", digest: C } })] });
  const first = await store.runs.get("R");
  const steer = await store.runs.reopen("R", { kind: "steer", body: { text: "the answer is B", feedback: { round: 2, correct: false, kept: { endedAt: first.endedAt } } } }, { endedAt: first.endedAt });
  const claim = await store.claim("R", "runner-a", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  // A person's message and a cancel wait at the round's end: the cancel is that message's run's, and wins it at this
  // commit's time (run-patch.ts refuseLeftovers), after the end wrote its row.
  await store.command("R", { kind: "steer", body: { text: "and again?" } });
  await store.command("R", { kind: "cancel" });
  clock.now += 5_000;
  await store.runs.update(claim, { state: "ended", costUsd: 1.4, metrics: { path: "agent" }, endedAt: first.endedAt, keepsEnd: true }, { also: [kept(2, 1, 0.3, { compiled: { workflow: "answer", digest: D } })] });
  const after = await store.runs.get("R");
  assert.deepEqual([after.state, after.outcome], ["stopped", "cancelled"]);
  assert.ok(after.endedAt > first.endedAt, `the cancel's commit moved its ended_at: ${first.endedAt} then ${after.endedAt}`);
  const row = (await store.learning.ledger("agent-1", ["R"])).rows[0];
  assert.deepEqual([row.cost, row.jobUsd], ["known", 1], "the row its end wrote");
  // No read records it again: its rounds are never read.
  const rounds = [];
  const counted = new Proxy(store, {
    get: (target, key) => (key === "learning" ? new Proxy(target.learning, { get: (inner, name) => (name === "proposal" ? (...args) => (rounds.push(args), inner.proposal(...args)) : typeof inner[name] === "function" ? inner[name].bind(inner) : inner[name]) }) : Reflect.get(target, key)),
  });
  for (let read = 0; read < 3; read++) await pastRunsOverStore(counted, "agent-1");
  assert.deepEqual(rounds, [], "three reads at a claim, no round read");
});

test("the money rule's read at a claim is bounded: the agent's newest PAST_RUNS runs on no named disk and their ledger alone, no agent-wide read", async (t) => {
  const { store, end } = await ledgerStore(t);
  assert.equal(typeof PAST_RUNS, "number", "the window is one number the launch and the cost page share");
  await end("r1", 1);
  await end("s1", 0.1, SERVED);
  const calls = [];
  const spy = (name, object, keys) => new Proxy(object, { get: (target, key) => (keys.includes(key) ? (...args) => (calls.push([`${name}.${String(key)}`, ...args]), target[key](...args)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const counted = new Proxy(store, {
    get: (target, key) => (key === "runs" ? spy("runs", target.runs, ["list", "learningStarts"]) : key === "learning" ? spy("learning", target.learning, ["ledger", "kept"]) : Reflect.get(target, key)),
  });
  const past = await pastRunsOverStore(counted, "agent-1");
  assert.equal(past.runs.length, 2);
  assert.deepEqual(calls.filter(([name]) => name === "runs.list"), [["runs.list", { agentId: "agent-1", disk: null, limit: PAST_RUNS }]], "one page of the newest runs on no named disk");
  const ledgers = calls.filter(([name]) => name === "learning.ledger");
  assert.equal(ledgers.length, 1);
  assert.deepEqual([ledgers[0][1], [...ledgers[0][2]].sort()], ["agent-1", ["r1", "s1"]], "the ledger of those runs alone");
  assert.deepEqual(calls.filter(([name]) => name === "learning.kept" || name === "runs.learningStarts"), [], "no read of every run the agent has");
});

test("the money rule's by-hand side is the job's own cost of the agent's runs on its own path among the same runs as its served side: since its learning's reset, on no named disk; the cost page says the same", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("old", 5);
  clock.now += 1_000;
  await keepResetAt(store.settings, "agent-1", clock.now);
  // Its job $1, its compile turn $0.30: by hand it is $1, its all-in $1.30.
  await end("r1", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  await end("on-disk", 9, { path: "agent" }, { disk: "disk-a" });
  for (const id of ["s1", "s2", "s3"]) await end(id, 0.1, SERVED);
  await end("late", 2);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual([past.by_hand, past.by_hand_unknown], [{ runs: 2, mean_usd: 1.5 }, 0], "r1's job and late's: not the run before the reset ($5), not the one on a named disk ($9), never r1's compile turn");
  const page = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(page.workflows.map((one) => one.by_hand), [{ runs: 2, mean_usd: 1.5 }], "the cost page's money rule reads the same runs");
  assert.notDeepEqual(page.summary.before, past.by_hand, "the series' before is over every run it shows, a wider set");
});

test("once the newest PAST_RUNS runs hold no run by hand, the money rule holds the workflow to the newest runs by hand before them: 500 served, then 10 at twice the by-hand cost, stops it", async (t) => {
  const { store, end } = await ledgerStore(t);
  for (let at = 0; at < 10; at++) await end(`h${String(at).padStart(2, "0")}`, 1);
  for (let at = 0; at < PAST_RUNS; at++) await end(`s${String(at).padStart(3, "0")}`, 0.1, SERVED);
  for (let at = 0; at < 10; at++) await end(`x${String(at).padStart(2, "0")}`, 2, SERVED);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.equal(past.runs.filter((run) => run.metrics.path === "agent").length, 0, "no run by hand in the window");
  assert.deepEqual(past.by_hand, { runs: 10, mean_usd: 1 }, "the 10 by hand before the window");
  assert.deepEqual(workflowCostsOf(past).map((one) => [one.state, one.served, one.by_hand]), [["needs_revision", { runs: 10, mean_usd: 2 }, { runs: 10, mean_usd: 1 }]]);
  assert.deepEqual((await agentCostOverStore(store, "agent-1")).workflows.map((one) => one.state), ["needs_revision"], "the cost page says the same");
});

test("one by-hand rule in the window and before it: a run whose end named no path is the agent's when its launch does not learn (its row says agent), unknown when it does", async (t) => {
  const { store, end } = await ledgerStore(t);
  for (let at = 0; at < 10; at++) await end(`h${String(at).padStart(2, "0")}`, 1, {});
  // Newer than those, nearer the window: runs that learn whose end named no path, at $9. Never the agent's by hand.
  for (let at = 0; at < 3; at++) await end(`l${at}`, 9, {}, { learns: true });
  const rows = new Map((await store.learning.ledger("agent-1")).rows.map((row) => [row.runId, row.path]));
  assert.deepEqual([rows.get("h00"), rows.get("l0")], ["agent", null], "the row says it: agent for a launch that does not learn, null for one that does");
  for (let at = 0; at < PAST_RUNS; at++) await end(`s${String(at).padStart(3, "0")}`, 0.1, SERVED);
  for (let at = 0; at < 10; at++) await end(`x${String(at).padStart(2, "0")}`, 2, SERVED);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual(past.by_hand, { runs: 10, mean_usd: 1 }, "the 10 by hand before the window, as the window would read them; the runs that learn left out");
  assert.deepEqual((await agentCostOverStore(store, "agent-1")).workflows.map((one) => one.state), ["needs_revision"]);
});

test("one by-hand rule in the window and before it: a run of a workflow revision is never by hand, though its row says agent (a standalone workflow's launch does not learn and names no path)", async (t) => {
  const { store, end } = await ledgerStore(t);
  await store.agents.addRevision({ agentId: "agent-1", id: "rev-wf", kind: "workflow", body: {}, advance: false });
  for (let at = 0; at < 10; at++) await end(`h${String(at).padStart(2, "0")}`, 1);
  // Newer than those, nearer the window: the agent's runs as a workflow, at $5, each row on the agent path.
  for (let at = 0; at < 10; at++) await end(`w${String(at).padStart(2, "0")}`, 5, {}, { revisionId: "rev-wf" });
  const rows = new Map((await store.learning.ledger("agent-1")).rows.map((row) => [row.runId, row.path]));
  assert.equal(rows.get("w00"), "agent", "the row says agent");
  assert.deepEqual((await pastRunsOverStore(store, "agent-1")).by_hand, { runs: 10, mean_usd: 1 }, "in the window: the 10 by hand, the workflow's runs left out");
  for (let at = 0; at < PAST_RUNS; at++) await end(`s${String(at).padStart(3, "0")}`, 0.1, SERVED);
  for (let at = 0; at < 10; at++) await end(`x${String(at).padStart(2, "0")}`, 2, SERVED);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual(past.by_hand, { runs: 10, mean_usd: 1 }, "before the window: the same 10, as the window would read them; the workflow's runs left out");
  assert.deepEqual(workflowCostsOf(past).map((one) => one.state), ["needs_revision"], "$2 served against $1 by hand, never against a mean the workflow's $5 runs raise");
});

test("a run's view priced other than its row reads it as its end records it, from its launch as the end does: a check's replay whose end named no path is that replay at any figure, carrying no learning and no all-in", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("p1", 0.4, {});
  await end("r1", 0.2, {}, { replay: { of: "s0", workflow: "answer", digest: C, paid_by: "p1" } });
  const rows = new Map((await store.learning.ledger("agent-1")).rows.map((row) => [row.runId, row.path]));
  assert.equal(rows.get("r1"), "replay", "its end's row reads it from its launch");
  // At its row's cost, and at another (an imported run's estimate, a booking where its end stored none): a replay's spend
  // is the run it checks for, so it carries none of its own either way.
  for (const priced of [undefined, 0.25]) {
    const cost = await runAllInOverStore(store, "r1", priced);
    assert.deepEqual([cost.learning_usd, cost.all_in_usd, cost.share_usd], [0, 0, 0], `priced at ${priced ?? "its row"}: ${JSON.stringify(cost)}`);
  }
});

test("a shadow that failed before its end wrote its metrics books its cost at its end, on the run its launch audits", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("s1", 0.1, SERVED);
  await end("audit.s1", 0.05, {}, { audit: { of: "s1", workflow: "answer", digest: C } });
  const ledger = await store.learning.ledger("agent-1");
  assert.deepEqual(ledger.rows.filter((row) => row.runId === "audit.s1").map((row) => row.path), ["audit"]);
  assert.deepEqual(ledger.spend.map((one) => [one.runId, one.kind, one.ofRun, one.usd]), [["audit.s1", "audit", "s1", 0.05]]);
  assert.equal((await runAllInOverStore(store, "s1")).shadow_usd, 0.05);
});

test("a store the ledger's first release left: its wrong rows are recorded again at the server's open that drops their epoch, at the figures their ends write now", sqliteOnly("a SQLite store with each ledger row's epoch; Postgres repairs in migration 0030"), async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("h1", 1, {});
  await end("h2", 1);
  await end("s1", 0.1, SERVED);
  await end("audit.s1", 0.05, {}, { audit: { of: "s1", workflow: "answer", digest: C } });
  await end("s2", 0.1, SERVED);
  await end("audit.s2", 0.05, {}, { audit: { of: "s2", workflow: "answer", digest: C } });
  const figures = async (on) => ({ ledger: await on.learning.ledger("agent-1"), s1: await runAllInOverStore(on, "s1"), past: await pastRunsOverStore(on, "agent-1") });
  const now = await figures(store);
  assert.deepEqual(now.past.by_hand, { runs: 2, mean_usd: 1 });
  await store.close();
  const db = await raw(file);
  // The store as that release left it: each row's epoch (its run's then), no whole-ledger mark, no by-hand index.
  await db.run("ALTER TABLE learning_ledger ADD COLUMN epoch INTEGER");
  await db.run("UPDATE learning_ledger SET epoch = (SELECT epoch FROM runs WHERE runs.id = learning_ledger.run_id)");
  if ((await db.all("SELECT name FROM pragma_table_info('store_meta')")).some((column) => column.name === "ledger_backfilled")) await db.run("ALTER TABLE store_meta DROP COLUMN ledger_backfilled");
  await db.run("DROP INDEX IF EXISTS learning_ledger_by_hand");
  // And the rows it could write wrong: a shadow that failed first, with no path and no audit spend; a run by hand whose
  // end named no path; an unknown cost its run has now (a heal its reader then recorded on read); a row an end wrote
  // before the run ended again (its epoch behind its run's); an audit's shadow on another path.
  await db.run("UPDATE learning_ledger SET path = NULL WHERE run_id IN ('audit.s1', 'h1')");
  await db.run("DELETE FROM learning_spend WHERE run_id = 'audit.s1'");
  await db.run("UPDATE learning_ledger SET cost = 'unknown', job_usd = NULL WHERE run_id = 'h2'");
  await db.run("UPDATE learning_ledger SET job_usd = 9, epoch = epoch - 1 WHERE run_id = 's2'");
  await db.run("UPDATE learning_ledger SET path = 'agent' WHERE run_id = 'audit.s2'");
  // At that release's version, 15: a runner of this build refuses it until the server brings it to 18 (the ledger step
  // writes 16, the learning rows step 17, the split's step 18), and a runner of 15 (whose end writes the epoch) refuses a
  // version it does not know.
  await db.run("ALTER TABLE store_meta DROP COLUMN ledger_rerecorded");
  await db.run("UPDATE store_meta SET schema_version = 15 WHERE singleton = 1");
  await db.close();
  assert.equal(SCHEMA_VERSION, 18);
  await assert.rejects(storeOn(t, { file, clock, role: "runner" }), (error) => error instanceof StoreAwaitsServer && /bring this store from version 15 to 18/.test(error.message));
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.deepEqual(await figures(reopened), now, "every wrong row recorded again from its run, as its end writes it");
  const after = await raw(file);
  assert.deepEqual([(await after.get("SELECT schema_version AS v FROM store_meta")).v, (await after.all("SELECT name FROM pragma_table_info('learning_ledger') WHERE name = 'epoch'")).length], [18, 0], "18, the epoch gone (the ledger step), the learning rows and the split's mark after it");
  await after.close();
});

test("a store at 15 comes to this version by the ledger step and then the learning rows and split steps alone: no earlier step runs again (a stop at that step leaves 15; a purged run's tombstone keeps its disk), and with the epoch there the mark is set back, so a ledger marked whole has its wrong rows recorded again", sqliteOnly("SQLite's upgrade chain; Postgres has migrations"), async (t) => {
  const { Connection } = await import("../dist/store/sqlite/connection.js");
  const { store, file, clock, end } = await ledgerStore(t);
  await end("h1", 1);
  await end("p1", 1, undefined, { disk: "disk-p" });
  // Purged: its launch body gone, its tombstone keeps its disk. Running the disk step (14 to 15) again would null it.
  await store.runs.purge("p1", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  assert.equal((await store.runs.get("p1")).disk, "disk-p");
  const rows = (await store.learning.ledger("agent-1")).rows;
  await store.close();
  let db = await raw(file);
  // The ledger's first release with its mark already whole: each row's epoch, the mark at 1, and h1's row wrong (the
  // unknown cost its run now has).
  await db.run("ALTER TABLE learning_ledger ADD COLUMN epoch INTEGER");
  await db.run("UPDATE learning_ledger SET epoch = (SELECT epoch FROM runs WHERE runs.id = learning_ledger.run_id)");
  await db.run("UPDATE learning_ledger SET cost = 'unknown', job_usd = NULL WHERE run_id = 'h1'");
  await db.run("UPDATE store_meta SET schema_version = 15, ledger_backfilled = 1 WHERE singleton = 1");
  await db.close();
  const version = async () => {
    const read = await raw(file);
    try {
      return Number((await read.get("SELECT schema_version AS v FROM store_meta WHERE singleton = 1")).v);
    } finally {
      await read.close();
    }
  };
  // A stop at the ledger step's write: no step before it ran, so nothing stamped an earlier version (the purge step stamps
  // 14, and an open at 14 runs the disk step).
  const write = Connection.prototype.write;
  Connection.prototype.write = function (statements, options) {
    return statements.some(({ sql }) => sql === "UPDATE store_meta SET schema_version = 16 WHERE singleton = 1") ? Promise.reject(new Error("stopped at the ledger step")) : write.call(this, statements, options);
  };
  try {
    await assert.rejects(storeOn(t, { file, clock }), /stopped at the ledger step/);
  } finally {
    Connection.prototype.write = write;
  }
  assert.equal(await version(), 15, "still 15: neither the purge step nor the disk step ran");
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.equal(await version(), 18, "the ledger step's 16, then the learning rows step's 17, then the split's 18");
  assert.equal((await reopened.runs.get("p1")).disk, "disk-p", "the tombstone keeps its disk: the disk step did not run again");
  assert.deepEqual((await reopened.learning.ledger("agent-1")).rows, rows, "h1's row recorded again at its run's figures: the mark set back to 0 with the epoch, so the open's backfill ran");
  db = await raw(file);
  assert.equal(Number((await db.get("SELECT ledger_backfilled AS whole FROM store_meta WHERE singleton = 1")).whole), 1, "marked whole again once recorded");
  await db.close();
});

test("Postgres migration 0030 repairs the same rows, only while their epoch is there and before it drops it, and makes the same by-hand index and mark, each only where missing", async () => {
  const { readFile } = await import("node:fs/promises");
  const { LEARNING_LEDGER_BY_HAND, LEARNING_LEDGER_REPAIR } = await import("../dist/store/schema.js");
  const flat = (sql) => sql.replace(/\s+/g, " ").trim();
  const text = flat((await readFile(new URL("../dist/store/postgres/migrations/0030_learning_ledger_epoch.sql", import.meta.url), "utf8")).replace(/--[^\n]*/g, ""));
  const guard = text.indexOf("IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'learning_ledger' AND column_name = 'epoch') THEN");
  const drop = text.indexOf("ALTER TABLE learning_ledger DROP COLUMN IF EXISTS epoch;");
  assert.ok(guard >= 0 && drop > guard, "the repair runs only while the epoch is there, the drop after it");
  for (const sql of LEARNING_LEDGER_REPAIR) {
    const at = text.indexOf(`EXECUTE $repair$${flat(sql)}$repair$;`);
    assert.ok(at > guard && at < text.indexOf("END IF;"), sql);
  }
  assert.ok(text.includes(`${flat(LEARNING_LEDGER_BY_HAND)};`), LEARNING_LEDGER_BY_HAND);
  assert.ok(text.includes("ALTER TABLE store_meta ADD COLUMN IF NOT EXISTS ledger_backfilled"));
});

test("the read before the window walks the by-hand index (learning_ledger_by_hand): no sort of the agent's ledger, whatever its size", sqliteOnly("SQLite's query plan"), async (t) => {
  const { store, file, end } = await ledgerStore(t);
  for (let at = 0; at < 10; at++) await end(`h${String(at).padStart(2, "0")}`, 1);
  for (let at = 0; at < PAST_RUNS; at++) await end(`s${String(at).padStart(3, "0")}`, 0.1, SERVED);
  assert.deepEqual((await pastRunsOverStore(store, "agent-1")).by_hand, { runs: 10, mean_usd: 1 }, "the window full: the 10 by hand before it");
  await store.close();
  const db = await raw(file);
  await db.exec("ANALYZE");
  const plan = (await db.all(`EXPLAIN QUERY PLAN ${BY_HAND_BEFORE}`, "agent-1", T0, "s000", 10)).map((row) => row.detail);
  await db.close();
  assert.ok(plan.some((step) => step.includes("USING INDEX learning_ledger_by_hand")), plan.join("\n"));
  assert.ok(!plan.some((step) => step.includes("TEMP B-TREE")), plan.join("\n"));
});

test("the backfill locks each run before it reads it again: a heal that commits meanwhile is read, never overwritten with the cost unknown", sqliteOnly("a seam over SQLite's connection stands in for a second server's heal on Postgres"), async (t) => {
  const { Connection } = await import("../dist/store/sqlite/connection.js");
  const { SQLITE } = await import("../dist/store/dialect.js");
  const { backfillLedger, recordLedger, runOf, RUN_COLUMNS } = await import("../dist/store/sqlite/run-patch.js");
  const { store, file, clock, end } = await ledgerStore(t);
  await end("x", null);
  await store.close();
  let db = await raw(file);
  // Ended with no row (an earlier build), the ledger not marked whole: the next server's open backfills it.
  await db.run("DELETE FROM learning_ledger WHERE run_id = 'x'");
  await db.run("UPDATE store_meta SET ledger_backfilled = 0 WHERE singleton = 1");
  await db.close();
  // Another server heals x's cost (Runs.healCost: its UPDATE and its ledger row, one transaction). On Postgres the
  // backfill's re-read at READ COMMITTED sees it only once it has committed: a lock on the run waits for that commit,
  // and with no lock the heal lands between the re-read and the write. The seam runs it at that point.
  const heal = async (tx) => recordLedger(tx, runOf(await tx.get(`UPDATE runs SET cost_usd = 0.7 WHERE id = 'x' RETURNING ${RUN_COLUMNS}`)), clock.now);
  const steps = [];
  const connection = await Connection.open(file);
  t.after(() => connection.close().catch(() => undefined));
  const seam = {
    dialect: { ...SQLITE, lockRow: async (tx, table, column, value) => { steps.push(["lock", table, value]); if (value === "x") await heal(tx); } },
    get: (...args) => connection.get(...args),
    all: (...args) => connection.all(...args),
    transaction: (callback, options) => connection.transaction((tx) => callback(new Proxy(tx, {
      get: (target, key) => key !== "get" ? (typeof target[key] === "function" ? target[key].bind(target) : target[key]) : async (sql, ...params) => {
        const row = await target.get(sql, ...params);
        if (sql.startsWith(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)) {
          steps.push(["read", params[0]]);
          if (!steps.some(([kind, , id]) => kind === "lock" && id === params[0])) await heal(target);
        }
        return row;
      },
    })), options),
  };
  await backfillLedger(seam, () => clock.now);
  await connection.close();
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.deepEqual((await reopened.learning.ledger("agent-1", ["x"])).rows.map((row) => [row.cost, row.jobUsd]), [["known", 0.7]], "the healed row stands");
  assert.deepEqual(steps, [["lock", "runs", "x"], ["read", "x"]], "the run locked, then read again, in the page's transaction");
});

test("the server's open records the runs with no row a page at a time and marks the ledger whole: an open after a stop partway records the rest, once; an open after that reads no run again", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  for (let at = 0; at < 70; at++) await end(`r${String(at).padStart(2, "0")}`, 1);
  const whole = (await store.learning.ledger("agent-1")).rows;
  await store.close();
  let db = await raw(file);
  // A stop partway through the first backfill: a page recorded, the rest not, the ledger not marked whole.
  await db.run("DELETE FROM learning_ledger WHERE run_id >= ?", "r40");
  await db.run("UPDATE store_meta SET ledger_backfilled = 0 WHERE singleton = 1");
  await db.close();
  let { store: again } = await storeOn(t, { file, clock });
  assert.deepEqual((await again.learning.ledger("agent-1")).rows, whole, "the rest recorded at the next open");
  await again.close();
  ({ store: again } = await storeOn(t, { file, clock }));
  assert.deepEqual((await again.learning.ledger("agent-1")).rows, whole, "an open again changes nothing");
  await again.close();
  db = await raw(file);
  assert.equal(Number((await db.get("SELECT ledger_backfilled AS whole FROM store_meta WHERE singleton = 1")).whole), 1, "marked whole");
  await db.run("DELETE FROM learning_ledger WHERE run_id = ?", "r00");
  await db.close();
  ({ store: again } = await storeOn(t, { file, clock }));
  assert.deepEqual((await again.learning.ledger("agent-1", ["r00"])).rows, [], "marked whole: no open reads the runs again");
});

/** Rewrites run `runId`'s ledger row as a build before #4050's split wrote it for a run a follow-up opened again: its job
 *  its first round's figure (`firstJob`), the rest of its row (`rowUsd`) its look-back; and marks the store as no server
 *  of this build has opened it yet (store_meta.ledger_rerecorded 0). */
async function oldSplit(db, runId, firstJob, rowUsd) {
  await db.run("UPDATE learning_ledger SET job_usd = ?, look_back_usd = ? WHERE run_id = ?", firstJob, Math.round((rowUsd - firstJob) * 1e9) / 1e9, runId);
  await db.run("UPDATE store_meta SET ledger_rerecorded = 0 WHERE singleton = 1");
}

test("a run a follow-up opened again whose row an earlier build wrote (its job the first round's figure, the follow-up its look-back) is recorded again under this build's split, once, at the server's open, a page at a time: its usd is its row less every round's look-back and its learning leaves the follow-up out; a run of one round and a purged run are left as they are, and once marked no open reads the runs again", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  // R: round 1's job $0.90 and its end-of-run turn $0.10; a follow-up of $5.50 (model and a paid call) and its own
  // end-of-run turn $0.10. Its row: $6.60.
  await end("R", 6.6, { path: "agent" }, { also: [kept(1, 0.9, 0.1), kept(2, 6.5, 0.1)] });
  // Past one page (64 runs a transaction) of runs with a follow-up, and one run of one round.
  for (let at = 0; at < 66; at++) await end(`m${String(at).padStart(2, "0")}`, 2, { path: "agent" }, { also: [kept(1, 0.5, 0.1), kept(2, 1.8, 0.2)] });
  await end("one", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3)] });
  // Purged with its follow-up: its purge took its row, and the pass writes none back.
  await end("P", 2, { path: "agent" }, { also: [kept(1, 0.5, 0.1), kept(2, 1.8, 0.2)] });
  await store.runs.purge("P", { meters: null, spend: { usd: 2, basis: "list" }, learning: null });
  const now = await runAllInOverStore(store, "R");
  assert.deepEqual([now.usd, now.learning_usd, now.followup_usd], [6.4, 0, 0], "this build's split: the follow-up is the job's");
  const rows = (await store.learning.ledger("agent-1")).rows;
  await store.close();
  let db = await raw(file);
  await oldSplit(db, "R", 0.9, 6.6);
  for (let at = 0; at < 66; at++) await oldSplit(db, `m${String(at).padStart(2, "0")}`, 0.5, 2);
  await db.close();
  let { store: again } = await storeOn(t, { file, clock });
  const read = await runAllInOverStore(again, "R");
  assert.ok(read.usd >= 5.5, `usd holds the follow-up's $5.50 (its paid call among it): ${JSON.stringify(read)}`);
  assert.deepEqual(read, now, "R recorded again from its row and rounds, as this build's end records it");
  assert.deepEqual((await again.learning.ledger("agent-1")).rows, rows, "every run with a follow-up recorded again, past the first page; the run of one round as it was; no row for the purged run");
  await again.close();
  // Marked: an open after it reads no run again, so a row written as the earlier build wrote it stays.
  db = await raw(file);
  await db.run("UPDATE learning_ledger SET job_usd = 0.9, look_back_usd = 5.7 WHERE run_id = 'R'");
  await db.close();
  ({ store: again } = await storeOn(t, { file, clock }));
  assert.deepEqual((await again.learning.ledger("agent-1", ["R"])).rows.map((row) => [row.jobUsd, row.lookBackUsd]), [[0.9, 5.7]], "marked: no open reads the runs again");
});

/** store_meta.ledger_rerecorded on the store at `file`, read beside the store open on it. */
async function rerecordedMark(file) {
  const db = await raw(file);
  try {
    return Number((await db.get("SELECT ledger_rerecorded AS split FROM store_meta WHERE singleton = 1")).split);
  } finally {
    await db.close();
  }
}

test("the reopened runs are marked recorded again only by a pass that started with no runner of an earlier build there: one that ends a reopened run under the split before after the open's pass has it recorded under this build's split at the server's next try, with no restart, which then marks it; a runner of this build holds no mark", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  // R: recorded again by the open's pass. S: ended by the earlier runner after that pass, under the split before.
  await end("R", 6.6, { path: "agent" }, { also: [kept(1, 0.9, 0.1), kept(2, 6.5, 0.1)] });
  await end("S", 2, { path: "agent" }, { also: [kept(1, 0.5, 0.1), kept(2, 1.8, 0.2)] });
  const rows = (await store.learning.ledger("agent-1")).rows;
  // A runner of an earlier build, there now on the store's clock: its row says no schema version it knows (a build before
  // runners.knows), as a runner of 17 (SQLite) or before 0034 (Postgres) writes it.
  await store.runners.put({ runner: "runner-before", incarnation: "i-before", refused: null, version: "0.1.0", slots: 4 });
  await store.close();
  let db = await raw(file);
  await oldSplit(db, "R", 0.9, 6.6);
  await db.close();
  const { store: again } = await storeOn(t, { file, clock });
  assert.deepEqual((await again.learning.ledger("agent-1", ["R"])).rows, rows.filter((row) => row.runId === "R"), "the open's pass records R again all the same");
  assert.equal(await rerecordedMark(file), 0, "an earlier runner was there at the pass's start: not marked");
  assert.equal(await again.rerecordReopened(), false, "still there at the next try: not marked");
  assert.equal(await rerecordedMark(file), 0);
  // That runner ends S as its build does: the row under the split before, after the server's passes.
  db = await raw(file);
  await db.run("UPDATE learning_ledger SET job_usd = 0.5, look_back_usd = 1.5 WHERE run_id = 'S'");
  await db.close();
  // Its row goes stale (it stopped at the floor and left): the server's next try, the same store, no restart.
  clock.now += RUNNER_STALE_MS + 1;
  assert.equal(await again.rerecordReopened(), true, "none there at its start: marked");
  assert.deepEqual((await again.learning.ledger("agent-1")).rows, rows, "S recorded under this build's split");
  assert.equal(await rerecordedMark(file), 1);
  assert.equal(await again.rerecordReopened(), true, "marked: a try after reads no run again");
  // A runner of this build says on its row the version it knows (keepPresence, from the store it opened): at the floor or
  // above, so it holds no mark.
  db = await raw(file);
  await db.run("UPDATE store_meta SET ledger_rerecorded = 0 WHERE singleton = 1");
  await db.close();
  const presence = keepPresence(again.runners, "runner-now", null, { renewMs: 3_600_000 });
  t.after(() => presence.stop());
  await presence.relay(null);
  const { known, runnerFloor } = await again.schemaState();
  const [now] = await again.runners.live(RUNNER_STALE_MS);
  assert.deepEqual([now.runner, now.knows], ["runner-now", known], "its row says the version its build knows");
  assert.ok(now.knows >= runnerFloor, `${now.knows} at the floor (${runnerFloor}) or above`);
  assert.equal(await again.rerecordReopened(), true, "a runner of this build there: marked");
});

test("a runner of this build started under the same name as a runner of an earlier build still ending its runs leaves that runner's row as it is: the mark waits until that runner went", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("R", 6.6, { path: "agent" }, { also: [kept(1, 0.9, 0.1), kept(2, 6.5, 0.1)] });
  const rows = (await store.learning.ledger("agent-1")).rows;
  // A rolling restart: the earlier build's process, still draining, and this build's, started under its name.
  await store.runners.put({ runner: "runner-1", incarnation: "i-before", refused: null, version: "0.1.0", slots: 4 });
  await store.close();
  // R's row as the build before wrote it, and the store as no server of this build opened it.
  let db = await raw(file);
  await oldSplit(db, "R", 0.9, 6.6);
  await db.close();
  const { store: again } = await storeOn(t, { file, clock });
  assert.equal(await rerecordedMark(file), 0, "the earlier runner there at the open's pass: not marked");
  const presence = keepPresence(again.runners, "runner-1", null, { renewMs: 3_600_000, incarnation: "i-now" });
  t.after(() => presence.stop());
  await presence.relay(null);
  assert.deepEqual((await again.runners.live(RUNNER_STALE_MS)).map((row) => [row.incarnation, row.knows]), [["i-before", null]], "the draining runner is still the one there");
  assert.equal(await again.rerecordReopened(), false, "the earlier runner is still there: not marked");
  // It ends R under the split before as it drains (after the passes), then goes.
  db = await raw(file);
  await db.run("UPDATE learning_ledger SET job_usd = 0.9, look_back_usd = 5.7 WHERE run_id = 'R'");
  await db.close();
  clock.now += RUNNER_STALE_MS + 1;
  await presence.relay(null);
  assert.deepEqual((await again.runners.live(RUNNER_STALE_MS)).map((row) => [row.incarnation, row.knows]), [["i-now", (await again.schemaState()).known]], "gone: this build's process has the name");
  assert.equal(await again.rerecordReopened(), true, "marked");
  assert.deepEqual((await again.learning.ledger("agent-1")).rows, rows, "R recorded under this build's split");
});

test("a SQLite store at 17 gains runners.knows at the split's step (18): the row a runner of 17 put reads as knowing nothing, and while that runner is there the mark waits", sqliteOnly("SQLite's upgrade chain; Postgres 0034 adds the column"), async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("R", 6.6, { path: "agent" }, { also: [kept(1, 0.9, 0.1), kept(2, 6.5, 0.1)] });
  await store.close();
  const db = await raw(file);
  await db.run("ALTER TABLE runners DROP COLUMN knows");
  await db.run("ALTER TABLE store_meta DROP COLUMN ledger_rerecorded");
  await db.run("INSERT INTO runners (runner, incarnation, refused, host, port, seen_at, version, slots) VALUES ('runner-17', 'i-17', NULL, NULL, NULL, ?, '0.1.0', 4)", clock.now);
  await db.run("UPDATE store_meta SET schema_version = 17 WHERE singleton = 1");
  await db.close();
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.deepEqual((await reopened.runners.live(RUNNER_STALE_MS)).map((row) => [row.runner, row.knows]), [["runner-17", null]]);
  assert.equal(await rerecordedMark(file), 0, "the runner of 17 there at the open's pass: not marked");
  clock.now += RUNNER_STALE_MS + 1;
  assert.equal(await reopened.rerecordReopened(), true, "gone: marked at the next try");
});

test("Postgres migration 0034 adds the same mark and runners.knows only where missing, the mark unset, and is breaking for runners (an earlier runner writes a reopened run's row under the split before)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { RUNNERS, STORE_META_LEDGER_RERECORDED } = await import("../dist/store/schema.js");
  const { marksBreaking } = await import("../dist/store/postgres/migrate.js");
  const sql = await readFile(new URL("../dist/store/postgres/migrations/0034_learning_ledger_rerecorded.sql", import.meta.url), "utf8");
  assert.ok(marksBreaking(sql), "-- runners: breaking in its leading comment");
  const text = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assert.ok(text.includes("ALTER TABLE store_meta ADD COLUMN IF NOT EXISTS ledger_rerecorded BIGINT NOT NULL DEFAULT 0 CHECK (ledger_rerecorded IN (0, 1));"), text);
  assert.match(STORE_META_LEDGER_RERECORDED, /ledger_rerecorded INTEGER NOT NULL DEFAULT 0 CHECK \(ledger_rerecorded IN \(0, 1\)\)/);
  assert.ok(text.includes("ALTER TABLE runners ADD COLUMN IF NOT EXISTS knows INTEGER;"), text);
  assert.match(RUNNERS, /\bknows INTEGER\b/, "SQLite's fresh runners table has it too");
  assert.ok(text.endsWith("UPDATE store_meta SET schema_version = 34 WHERE singleton = 1;"), text);
});
