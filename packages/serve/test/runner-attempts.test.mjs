// Each claim of a run is an attempt at its turn (store run_attempts), and a run's usage lines say which attempt each charge
// was made in. A runner's close mid-turn (what its process does on SIGTERM: cli.ts, runner/main.ts) drains the run and
// hands it back; the claim that takes it over works the same turn again, attempt 2, cause `drain`, and every request the
// first attempt made is the infrastructure's cost (`billable: false`), summed in `infra_usd`. A run no attempt of which was
// cut reads attempt 1, billable, and `infra_usd` 0. A runner that dies mid-turn leaves its claim to lapse: the next claim's
// cause is `crash`. Faux loops book model requests into the run's journal as the runner books them (runner.request and
// runner.turn in the harness's session); the expected lines are worked out by hand from what each attempt booked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startRunner } from "../dist/runner/runner.js";
import { runUsageOverStore } from "../dist/run-usage.js";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { PG_URL } from "./store-target.mjs";

const ROOT = 1;
const RUN = "run-1";
/** No poll after a runner's first (which claims the run): a close then has no claim in flight to wait on. */
const TIMING = { ...STEADY_LEASE, pollMs: 25, commandPollMs: 20 };
const micro = (usd) => (usd === null ? null : Math.round(usd * 1e6));

/**
 * Loops that book `plan[n]` (USD per model request) in the n-th claim of the run, each request in the harness's session
 * (its conversation made by the first claim, named on the root by its session key), then hold the turn: a claim whose
 * plan says `end` ends the run in its last commit; any other holds until it is stopped (a shutdown: interrupted). `claims`
 * keeps each claim the loops were started on, `booked` how many claims have booked.
 */
function bookingLoops(plan) {
  const claims = [];
  const state = { session: undefined, turn: 0, booked: 0 };
  const createLoop = (deps) => {
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const loop = {
      async start(claim) {
        const n = claims.push(claim) - 1;
        const step = plan[n] ?? { usd: [], end: true };
        const journal = deps.journal(claim);
        const writes = [];
        if (state.session === undefined) {
          state.session = await journal.mintId();
          writes.push({ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: state.session } });
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "harness", conversation: state.session } } });
        }
        for (const usd of step.usd) {
          const turn = ++state.turn;
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: state.session, kind: "runner.request", data: { turn, model: "m" } } });
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: state.session, kind: "runner.turn", data: { turn, usd, bookedUsd: usd, tableUsd: usd, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, rule: "answered" } } });
        }
        if (step.end) {
          const id = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: id });
          writes.push({ type: "entry", value: { id, conversationId: ROOT, kind: "message" } });
        }
        await commitWrites(journal, writes, BACKGROUND_CONTEXT);
        state.booked += 1;
        if (step.end) return { state: "ended" };
        await stopped;
        return { state: "interrupted" };
      },
      async command() {
        return { taken: true };
      },
      async stop() {
        stopNow();
      },
    };
    return loop;
  };
  return { claims, state, createLoop };
}

/** The runner `name` on `store` with `loops`, closed at the test's end. */
function runnerOn(t, store, loops, name, extra = {}) {
  const runner = startRunner({ store, createLoop: loops.createLoop, name, live: false, ...TIMING, ...extra });
  t.after(() => runner.close());
  return runner;
}

const rested = (server) => until(async () => {
  const row = await server.runs.get(RUN);
  return row.state === "ended" && row.runner === null && row;
}, "the run ended and was let go", 20_000);

test("a runner's close (SIGTERM) mid-turn hands the run back: the next claim is attempt 2 of the same turn, cause drain; attempt 1's lines are not billable, and infra_usd is their sum", async (t) => {
  const { server, runners: [a, b] } = await stores({ runners: 2 });
  await queue(server, RUN);
  // Attempt 1 books two requests ($0.01 and $0.02) and is cut mid-turn; attempt 2 books the turn again ($0.04) and ends.
  const loops = bookingLoops([{ usd: [0.01, 0.02] }, { usd: [0.04], end: true }]);
  const first = runnerOn(t, a, loops, "runner-a", { drainMs: 50 });
  await until(() => loops.state.booked === 1, "attempt 1 booked its requests");
  await first.close();
  assert.deepEqual([(await server.runs.get(RUN)).state, (await server.runs.get(RUN)).runner], ["running", null], "handed back still running");
  runnerOn(t, b, loops, "runner-b");
  await rested(server);

  assert.deepEqual(loops.claims.map((claim) => [claim.runner, claim.turn, claim.attempt]), [["runner-a", 1, 1], ["runner-b", 1, 2]], "the claim says its turn and attempt");
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.runner, row.turn, row.attempt, row.cause, row.cut, row.from]), [["runner-a", 1, 1, null, "drain", "queued"], ["runner-b", 1, 2, "drain", null, "running"]]);

  const usage = await runUsageOverStore(server, RUN);
  const lines = usage.lines.map((line) => [line.meter, line.model, line.attempt, line.billable, line.requests, micro(line.usd)]);
  assert.deepEqual(lines, [["tokens", "m", 1, false, 2, micro(0.03)], ["tokens", "m", 2, true, 1, micro(0.04)]], "a line per attempt: the cut one's two requests, then the redo's one");
  const cut = usage.lines.filter((line) => !line.billable);
  assert.equal(micro(usage.infra_usd), micro(cut.reduce((sum, line) => sum + line.usd, 0)), "infra_usd is the sum of the lines that are not billable");
  assert.equal(micro(usage.infra_usd), micro(0.03));
  assert.equal(micro(usage.total.usd), micro(0.07), "total still holds every line: nothing is charged differently");
});

test("a run whose turn no claim cut: one attempt, its lines billable, infra_usd 0", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const loops = bookingLoops([{ usd: [0.01, 0.02], end: true }]);
  runnerOn(t, a, loops, "runner-a");
  await rested(server);
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.turn, row.attempt, row.cause, row.cut]), [[1, 1, null, null]]);
  const usage = await runUsageOverStore(server, RUN);
  assert.deepEqual(usage.lines.map((line) => [line.attempt, line.billable, micro(line.usd)]), [[1, true, micro(0.03)]]);
  assert.equal(usage.infra_usd, 0);
});

test("a runner that dies mid-turn (no release) leaves its claim to lapse: the claim that takes the run over is attempt 2, cause crash", async (t) => {
  const { server, runners: [a, b] } = await stores({ runners: 2 });
  await queue(server, RUN);
  const loops = bookingLoops([{ usd: [0.01] }, { usd: [0.01], end: true }]);
  const short = { leaseMs: 400, renewEveryMs: 100, stopMarginMs: 100 };
  const first = runnerOn(t, a, loops, "runner-a", short);
  await until(() => loops.state.booked === 1, "attempt 1 booked");
  first.kill();
  runnerOn(t, b, loops, "runner-b", short);
  await rested(server);
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.runner, row.turn, row.attempt, row.cause, row.cut]), [["runner-a", 1, 1, null, null], ["runner-b", 1, 2, "crash", null]]);
  const usage = await runUsageOverStore(server, RUN);
  assert.deepEqual(usage.lines.map((line) => [line.attempt, line.billable]), [[1, false], [2, true]]);
  assert.equal(micro(usage.infra_usd), micro(0.01));
});

test("a lapse its runner lived to say reads lease_lapse, on the cut attempt and the cause of the one after it, whichever was written first", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const one = await a.claim(RUN, "runner-a", { leaseMs: 1 });
  await until(async () => (await server.runs.claimable()).includes(RUN), "the lease ran out");
  const two = await a.claim(RUN, "runner-b");
  assert.deepEqual([two.turn, two.attempt], [1, 2]);
  assert.equal((await server.runAttempts.forRun(RUN))[1].cause, "crash", "read as a crash until its runner says otherwise");
  await a.runAttempts.lapsed(RUN, one.epoch);
  await a.runAttempts.lapsed(RUN, one.epoch);
  assert.deepEqual((await server.runAttempts.forRun(RUN)).map((row) => [row.attempt, row.cause, row.cut]), [[1, null, "lease_lapse"], [2, "lease_lapse", null]], "idempotent");
});

test("a claim that does not take over a cut turn starts the run's next turn, attempt 1: a park's resume, a release with nothing cut", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const one = await a.claim(RUN, "runner-a");
  await a.release(one, { state: "parked", wakeAt: 0 });
  const two = await a.claim(RUN, "runner-a");
  assert.equal(two.from, "parked");
  // A release that says nothing cut (an older runner's, or a follow-up's reopen of an ended run) is a new turn too.
  await a.release(two, {});
  const three = await a.claim(RUN, "runner-a");
  assert.equal(three.from, "running");
  await a.release(three, { cut: "retry" });
  const four = await a.claim(RUN, "runner-a");
  assert.deepEqual([one, two, three, four].map((claim) => [claim.turn, claim.attempt]), [[1, 1], [2, 1], [3, 1], [3, 2]]);
  const rows = await server.runAttempts.forRun(RUN);
  assert.deepEqual(rows.map((row) => [row.turn, row.attempt, row.cause, row.cut]), [[1, 1, null, null], [2, 1, null, null], [3, 1, null, "retry"], [3, 2, "retry", null]]);
  assert.ok(rows.every((row, i) => i === 0 || row.journalFrom >= rows[i - 1].journalFrom), "each claim's first journal id is at or after the one before");
});

/** Removes the attempt row of `runId`'s claim at `epoch` from the store at `file` (stores' `file`: a SQLite path, or
 *  `pg:<schema>`), as a runner of an earlier build, which writes none, would have left that claim. */
async function forgetAttempt(file, runId, epoch) {
  if (file.startsWith("pg:")) {
    const { PgConnection } = await import("../dist/store/index.js");
    const connection = await PgConnection.open({ url: PG_URL, schema: file.slice(3) });
    try {
      await connection.write([{ sql: "DELETE FROM run_attempts WHERE run_id = ? AND epoch = ?", params: [runId, epoch] }]);
    } finally {
      await connection.close();
    }
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { timeout: 5_000 });
  try {
    db.prepare("DELETE FROM run_attempts WHERE run_id = ? AND epoch = ?").run(runId, epoch);
  } finally {
    db.close();
  }
}

test("a claim an earlier build's runner made writes no row: when it crashes, the claim that takes over starts a new turn, and the turn before it is never read as redone", async (t) => {
  const { server, runners: [a], file } = await stores();
  await queue(server, RUN);
  // A runner of this build works turn 1 and lets the run go with nothing cut (its turn done, a follow-up to come).
  const one = await a.claim(RUN, "runner-new");
  await a.release(one, {});
  // A runner of the earlier build (beside this server through a rolling upgrade) claims the run, writes no attempt row,
  // and dies: its lease runs out.
  const old = await a.claim(RUN, "runner-old", { leaseMs: 1 });
  await forgetAttempt(file, RUN, old.epoch);
  await until(async () => (await server.runs.claimable()).includes(RUN), "the earlier runner's lease ran out");
  const three = await a.claim(RUN, "runner-new");
  assert.deepEqual([three.from, three.lost?.runner], ["running", "runner-old"], "taken from the crashed claim");
  // The latest row is turn 1's (epoch 1), not the claim taken over (epoch 3): no redo of turn 1.
  assert.deepEqual([three.turn, three.attempt], [2, 1]);
  const rows = await server.runAttempts.forRun(RUN);
  assert.deepEqual(rows.map((row) => [row.epoch, row.turn, row.attempt, row.cause, row.cut]), [[one.epoch, 1, 1, null, null], [three.epoch, 2, 1, null, null]]);
  // Turn 1's work stays billable: attemptTags marks an attempt not billable only when a later claim of its turn is the
  // next attempt, and no row of turn 1 is attempt 2.
  assert.deepEqual(rows.filter((row) => row.turn === 1).map((row) => row.attempt), [1]);
});

/** A takeover held part way, as a claim's transaction is between its UPDATE of the run and its attempt row: the run's row
 *  locked, as a claim's UPDATE locks it, on the store at `file` (stores' `file`). `insert` writes the takeover's row with
 *  the cause it read before the lapse was said (crash); `commit` ends it. */
async function heldTakeover(file, runId) {
  const row = (epoch) => ({ sql: "INSERT INTO run_attempts (run_id, epoch, turn, attempt, cause, runner, from_state, journal_from, claimed_at) VALUES (?, ?, 1, 2, 'crash', 'runner-b', 'running', 1, ?)", params: [runId, epoch, Date.now()] });
  if (file.startsWith("pg:")) {
    const { PgConnection } = await import("../dist/store/index.js");
    const connection = await PgConnection.open({ url: PG_URL, schema: file.slice(3) });
    let insert, commit;
    const held = new Promise((resolveHeld) => {
      const done = connection.transaction(async (tx) => {
        await tx.run("SELECT 1 FROM runs WHERE id = ? FOR NO KEY UPDATE", runId);
        let inserted;
        const wrote = new Promise((resolve) => (inserted = resolve));
        let ended;
        const ending = new Promise((resolve) => (ended = resolve));
        insert = async (epoch) => {
          const { sql, params } = row(epoch);
          await tx.run(sql, ...params);
          inserted();
        };
        commit = async () => {
          ended();
          await done;
          await connection.close();
        };
        resolveHeld();
        await wrote;
        await ending;
      });
    });
    await held;
    return { insert: (epoch) => insert(epoch), commit: () => commit() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { timeout: 5_000 });
  db.exec("BEGIN IMMEDIATE");
  return {
    insert: async (epoch) => {
      const { sql, params } = row(epoch);
      db.prepare(sql).run(...params);
    },
    commit: async () => {
      db.exec("COMMIT");
      db.close();
    },
  };
}

test("a lapse said while the claim taking the run over is between its read and its row waits for that row, then corrects its crash to lease_lapse", async (t) => {
  const { server, runners: [a], file } = await stores();
  await queue(server, RUN);
  const one = await a.claim(RUN, "runner-a", { leaseMs: 1 });
  await until(async () => (await server.runs.claimable()).includes(RUN), "the lease ran out");
  // The takeover has read attempt 1's row (no cut yet: a crash) and holds the run's row, its own row not yet written.
  const takeover = await heldTakeover(file, RUN);
  let said = false;
  const lapse = a.runAttempts.lapsed(RUN, one.epoch).then(() => (said = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(said, false, "the lapse waits for the takeover in flight");
  await takeover.insert(one.epoch + 1);
  await takeover.commit();
  await lapse;
  assert.deepEqual((await server.runAttempts.forRun(RUN)).map((row) => [row.attempt, row.cause, row.cut]), [[1, null, "lease_lapse"], [2, "lease_lapse", null]], "the takeover's crash, said as the lapse it was");
});
