// The learning ledger on the store itself (SQLite here, Postgres under `npm run test:pg`): what a run's end writes
// (learning_ledger, learning_spend: store/sqlite/run-patch.ts recordLedger) and how the readers read it
// (store-reads/learning.ts):
//   - an end records its row at the end it was written for (`epoch`, its run's epoch after it), with why it was not served alone
//     (`cost_stop`, `cut`); the ledger reads both tables as one read, scoped to the runs asked for;
//   - a run's end again (after a reopen) writes its spend rows anew, none left from the end before; healCost records the
//     row again with the healed cost; a purge takes the run's row and every spend row it booked or that audits it;
//   - a row an earlier build left behind (it ended the run again, or healed its cost, and wrote no ledger) is recorded
//     again where it is read, never shown stale; a run it ended with no row is recorded where it is read, at the figures
//     its end would have written;
//   - a grade's correction round ends its run again at the end it kept (keepsEnd): a runner of an earlier build that ends
//     it so writes no ledger, and the row its first end wrote is recorded again where it is read, the round's spend on
//     it; a cancel that wins such an end moves its ended_at after its row is written, and that row still stands;
//   - the money rule's read at a claim (pastRunsOverStore) is bounded: the agent's newest PAST_RUNS runs on no named disk,
//     the ledger of those runs alone, no agent-wide read, the runs with no standing row read at most 16 at a time; its
//     by-hand side is the job's own cost of the `agent` runs among the same runs as its served side (since the reset, no
//     named disk), and the cost page says the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { agentCostOverStore, ledgerRowStands, pastRunsOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { PAST_RUNS, workflowCostsOf } = await import("../dist/runner/workflow-first.js");
const { keepResetAt } = await import("../dist/learn/promote.js");

const C = "c".repeat(16);
const D = "d".repeat(16);
const AT = "2026-11-24T00:00:00.000Z";
const SERVED = { path: "workflow", workflow: "answer", workflow_digest: C };
const KEPT = { meters: { tools: 0, tokens: 0.1, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0.1, browser: 0, others: 0 } }, spend: { usd: 0.1, basis: "list" }, learning: { state: "dropped", reason: null } };
/** A kept round `n`: its job's cost as it answered, its compile turn's (look_back_usd), and the draft it kept. */
const kept = (n, job, look, extra = {}) => ({ table: "learning_proposals", row: { round: n, turn: {}, proposal: { state: "dropped", reason: "empty", detail: "d", answered_at: AT, job_cost_usd: job, look_back_usd: look, ...extra } } });

/** A store with agent-1 and its revision, and `end`: run `id` made and ended at the clock's next second, its row's cost
 *  `costUsd` and its metrics, with `also`'s rows; on a named disk with `disk`; an audit's shadow with `audit`; a launch
 *  that learns with `learns`. */
async function ledgerStore(t) {
  const clock = { now: T0 };
  const { store, file } = await storeOn(t, { clock });
  await agentWithRevision(store, "agent-1", "rev-1");
  const end = async (id, costUsd, metrics = { path: "agent" }, { also = [], disk, audit, learns } = {}) => {
    clock.now += 1_000;
    const learning = learns ? { learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } } : {};
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "q" }, title: "t", place: { mode: "runner" }, ...(disk ? { archil_disk: { disk_id: disk, kind: "launch" } } : {}), ...(audit ? { audit } : {}), ...learning } });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    clock.now += 1_000;
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, also.length ? { also } : undefined);
  };
  return { store, file, clock, end };
}

test("an end records its ledger row at its run's end (its epoch after that end), with why it was not served alone (cost_stop, cut); the ledger reads the rows and spend of the runs it is asked for", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("r-stop", 0.4, { path: "agent", not_served: "cost_stop" });
  await end("r-cut", 0.2, { path: "handed_back", workflow: "answer", workflow_digest: C, workflow_cut: true });
  await end("r-compile", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  const all = await store.learning.ledger("agent-1");
  const byId = new Map(all.rows.map((row) => [row.runId, row]));
  assert.deepEqual([byId.get("r-stop").notServed, byId.get("r-cut").notServed, byId.get("r-compile").notServed], ["cost_stop", "cut", null]);
  for (const id of ["r-stop", "r-cut", "r-compile"]) assert.equal(byId.get(id).epoch, (await store.runs.get(id)).epoch, `${id}: its row is for the end it was written at`);
  const scoped = await store.learning.ledger("agent-1", ["r-cut", "r-compile"]);
  assert.deepEqual(scoped.rows.map((row) => row.runId).sort(), ["r-compile", "r-cut"], "the rows of the runs asked for alone");
  assert.deepEqual(scoped.spend.map((one) => [one.runId, one.kind, one.round, one.digest, one.usd]), [["r-compile", "compile", 1, C, 0.3]]);
  assert.deepEqual((await store.learning.ledger("agent-1", [])).rows, [], "no run asked for: none");
});

test("a run's end again writes its spend rows anew, none left from the end before; healCost records its row again; a purge takes its row and every spend row it booked or that audits it", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("r1", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  assert.deepEqual((await store.learning.ledger("agent-1", ["r1"])).spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3]]);
  // A follow-up opens it again; its second end drafted D in its second round.
  const first = await store.runs.get("r1");
  const steer = await store.runs.reopen("r1", { kind: "steer", body: { text: "again" } });
  const claim = await store.claim("r1", "runner-a", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  clock.now += 1_000;
  await store.runs.update(claim, { state: "ended", costUsd: 2, metrics: { path: "agent" } }, { also: [kept(2, 1.5, 0.2, { compiled: { workflow: "answer", digest: D } })] });
  const again = await store.learning.ledger("agent-1", ["r1"]);
  assert.deepEqual(again.spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3], [2, D, 0.2]], "each round's compile once: the rows of the end before are replaced, not added to");
  const second = await store.runs.get("r1");
  assert.ok(second.epoch > first.epoch, `a second end: epoch ${first.epoch} then ${second.epoch}`);
  assert.equal(again.rows[0].epoch, second.epoch, "its row is for its second end");

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

test("a ledger row an earlier build left behind is recorded again where it is read: a run it ended again, and a cost it healed, read as they are now", async (t) => {
  const { store, file, end } = await ledgerStore(t);
  await end("r-again", 1);
  await end("r-healed", null);
  // A runner of the build before ends r-again again (a follow-up's end, at a later time and a new cost: its claim and its
  // end each move the epoch), and a server of that build heals r-healed's cost (at the same epoch): neither writes the
  // ledger.
  const db = await raw(file);
  await db.run("UPDATE runs SET ended_at = ended_at + 5000, epoch = epoch + 2, cost_usd = ? WHERE id = ?", 2, "r-again");
  await db.run("UPDATE runs SET cost_usd = ? WHERE id = ?", 0.7, "r-healed");
  await db.close();
  assert.equal((await runAllInOverStore(store, "r-again")).usd, 2, "the run read: its cost now, never its row's from the end before");
  assert.equal((await runAllInOverStore(store, "r-healed")).usd, 0.7, "the healed cost");
  const page = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(page.runs.map((run) => [run.run_id, run.cost_usd]), [["r-again", 2], ["r-healed", 0.7]], "the cost page reads the same");
});

test("a run that ended with no ledger row (a runner of the build before ended it) is recorded where it is read, among runs that have one, at the figures its end would have written", async (t) => {
  const { store, file, end } = await ledgerStore(t);
  await end("r1", 1);
  await end("r2", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  await end("s1", 0.1, SERVED);
  const figures = async () => ({
    page: (await agentCostOverStore(store, "agent-1")).runs.map((run) => [run.run_id, run.cost_usd, run.learning_usd, run.compile_usd, run.total_usd]),
    run: await runAllInOverStore(store, "r2"),
    past: await pastRunsOverStore(store, "agent-1"),
  });
  const before = await figures();
  const db = await raw(file);
  await db.run("DELETE FROM learning_ledger WHERE run_id = ?", "r2");
  await db.run("DELETE FROM learning_spend WHERE run_id = ?", "r2");
  await db.close();
  assert.equal((await store.learning.ledger("agent-1", ["r2"])).rows.length, 0, "r2 has no row now");
  assert.deepEqual(await figures(), before, "read from its run row and its rounds, as its end records it");
  assert.deepEqual(before.page.find(([id]) => id === "r2"), ["r2", 1, 0.3, 0.3, 1.3]);
});

/** Run `id`'s ledger rows (learning_ledger, learning_spend), as a raw read gives them: what `restore` writes back. */
async function ledgerRowsOf(file, id) {
  const db = await raw(file);
  const rows = { ledger: await db.all("SELECT * FROM learning_ledger WHERE run_id = ?", id), spend: await db.all("SELECT * FROM learning_spend WHERE run_id = ?", id) };
  await db.close();
  return rows;
}

/** Run `id`'s ledger rows back as `saved` had them, whatever an end wrote since: a runner of the build before the ledger
 *  ends it and writes none. */
async function restore(file, id, saved) {
  const db = await raw(file);
  await db.run("DELETE FROM learning_ledger WHERE run_id = ?", id);
  await db.run("DELETE FROM learning_spend WHERE run_id = ?", id);
  for (const [table, rows] of [["learning_ledger", saved.ledger], ["learning_spend", saved.spend]]) {
    for (const row of rows) await db.run(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
  }
  await db.close();
}

/** The figures a reader shows of run `id`: its run read's, its cost page row's and the bill's compile spend by revision. */
async function shown(store, id) {
  const run = await runAllInOverStore(store, id);
  const page = await agentCostOverStore(store, "agent-1");
  const row = page.runs.find((one) => one.run_id === id);
  return {
    run: [run.usd, run.compile_usd, run.followup_usd, run.learning_usd],
    page: [row.cost_usd, row.learning_usd, row.compile_usd, row.followup_usd, row.total_usd],
    bill: page.bill.revisions.map((one) => [one.digest, one.compile_usd]).sort(),
  };
}

test("a grade's correction round that a runner of the build before ends at the end it kept (keepsEnd) leaves no row standing: its round's compile and follow-up are read on the run", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  // A new build ends R at T1: its job $1, its compile turn $0.10 drafting C.
  await end("R", 1.1, { path: "agent" }, { also: [kept(1, 1, 0.1, { compiled: { workflow: "answer", digest: C } })] });
  const first = await store.runs.get("R");
  const saved = await ledgerRowsOf(file, "R");
  // The owner grades R with words: its correction round opens it again at the end it has (learn/feedback-round.ts
  // openFeedbackRound: a steer naming the kept end, reopened only at that end).
  const steer = await store.runs.reopen("R", { kind: "steer", body: { text: "the answer is B", feedback: { round: 2, correct: false, kept: { endedAt: first.endedAt } } } }, { endedAt: first.endedAt });
  // A runner of the build before runs the round: the corrections line and a compile turn drafting D ($0.30), and ends R
  // at T1 again (runner/adapter-loop.ts: the round keeps its job's end), writing no ledger.
  const claim = await store.claim("R", "runner-old", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  clock.now += 5_000;
  await store.runs.update(claim, { state: "ended", costUsd: 1.4, metrics: { path: "agent" }, endedAt: first.endedAt, keepsEnd: true }, { also: [kept(2, 1, 0.3, { compiled: { workflow: "answer", digest: D } })] });
  const after = await store.runs.get("R");
  assert.equal(after.endedAt, first.endedAt, "the round's end is the end it kept");
  assert.ok(after.epoch > first.epoch, `its end moved the run's epoch: ${first.epoch} then ${after.epoch}`);
  // What the round's end recorded, read from the run's row and its rounds (as for a run with no row): the truth.
  const truth = await shown(store, "R");
  assert.deepEqual(truth.bill, [[C, 0.1], [D, 0.3]], "each revision its compile turn");
  assert.deepEqual(truth.page.slice(0, 3), [1, 0.4, 0.4], "its job $1, both rounds' look-back $0.40, both compile turns");
  await restore(file, "R", saved);
  assert.deepEqual(await shown(store, "R"), truth, "read as the round left it: never the first end's figures");
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual(past.runs.map((one) => one.allInUsd), [1.4], "the money rule's all-in with the round's spend");
  const left = (await store.learning.ledger("agent-1", ["R"])).rows[0];
  assert.equal(ledgerRowStands(left, after), false, "the row its first end wrote no longer stands for it");
});

test("a cancel that wins an end keeping its job's end (keepsEnd) moves its ended_at after its row is written: the row stands, and no read records it again", async (t) => {
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
  assert.equal(ledgerRowStands(row, after), true, "the row its end wrote stands for it");
  assert.equal(row.jobUsd, 1);
  // No read records it again: its rounds are never read.
  const rounds = [];
  const counted = new Proxy(store, {
    get: (target, key) => (key === "learning" ? new Proxy(target.learning, { get: (inner, name) => (name === "proposal" ? (...args) => (rounds.push(args), inner.proposal(...args)) : typeof inner[name] === "function" ? inner[name].bind(inner) : inner[name]) }) : Reflect.get(target, key)),
  });
  for (let read = 0; read < 3; read++) await pastRunsOverStore(counted, "agent-1");
  assert.deepEqual(rounds, [], "three reads at a claim, no round read");
});

test("the money rule's read records the runs it has no standing row for a few at a time: never one by one, never more than 16 at once", async (t) => {
  const { store, file, end } = await ledgerStore(t);
  const ids = Array.from({ length: 40 }, (_, at) => `r${String(at).padStart(2, "0")}`);
  for (const id of ids) await end(id, 1);
  // Ended under a runner of the build before: no row, so each is recorded from its run row and its rounds.
  const db = await raw(file);
  await db.run("DELETE FROM learning_ledger WHERE agent_id = ?", "agent-1");
  await db.close();
  let open = 0;
  let most = 0;
  const counted = new Proxy(store, {
    get: (target, key) => (key === "learning" ? new Proxy(target.learning, {
      get: (inner, name) => (name === "proposal" ? async (...args) => {
        most = Math.max(most, ++open);
        try { return await inner.proposal(...args); } finally { open -= 1; }
      } : typeof inner[name] === "function" ? inner[name].bind(inner) : inner[name]),
    }) : Reflect.get(target, key)),
  });
  const past = await pastRunsOverStore(counted, "agent-1");
  assert.equal(past.by_hand?.runs, 40, "every run read");
  assert.ok(most > 1 && most <= 16, `the rounds read at most 16 runs at once, more than one: ${most}`);
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

test("a shadow that failed before its end wrote its metrics books its cost at its end, on the run its launch audits", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("s1", 0.1, SERVED);
  await end("audit.s1", 0.05, {}, { audit: { of: "s1", workflow: "answer", digest: C } });
  const ledger = await store.learning.ledger("agent-1");
  assert.deepEqual(ledger.rows.filter((row) => row.runId === "audit.s1").map((row) => row.path), ["audit"]);
  assert.deepEqual(ledger.spend.map((one) => [one.runId, one.kind, one.ofRun, one.usd]), [["audit.s1", "audit", "s1", 0.05]]);
  assert.equal((await runAllInOverStore(store, "s1")).shadow_usd, 0.05);
});
