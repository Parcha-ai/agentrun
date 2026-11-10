// The runner's tests on module A's store (store/, SqliteStore on a file of its own, or on Postgres a schema of its own when
// AGENTRUN_TEST_PG_URL is set: store-target.mjs): the server's store sets the schema up, and each runner opens it as a
// runner, as a runner process does. `observed` records what a test reads back
// (claims, journal commits, flushes and releases in order) and can fail a runner's renews; faux loops write real journal
// commits (pi-durable's commitWrites), with the run's end staged in the last one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";

import { dropSchema, freshSchema, onPostgres, PG_URL } from "./store-target.mjs";

const { openPostgresStore, openSqliteStore } = await import("../dist/store/index.js");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lease no stall of a loaded machine outlasts, for a test whose runner is never meant to lose its claim: a claim lost
 *  to a stall (no renew ran) is retaken, and what the test reads (a count, a call's status) is then the takeover's, not
 *  the property's. A takeover or fence test keeps its short lease and forces the loss itself. */
export const STEADY_LEASE = Object.freeze({ leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000 });

/** A clock the test moves, for a runner's claim deadline (RunnerOptions.clock): its timers fire only when `advance` moves
 *  the clock past them, so a deadline case is driven by the test, never by a box's load. Nothing else in the runner (its
 *  polls, renews, the store's clock) reads it. */
export function fakeClock(start = Date.now()) {
  let now = start;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++next;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    /** Moves the clock `ms` on, firing every timer due by then, earliest first. */
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

/** One order for what happened in this process (a commit tried, a stop told), finer than a millisecond: two things in
 *  the same ms are still one before the other. */
let happened = 0;
export const nextOrder = () => ++happened;

/** Polls `check` until it returns a truthy value, or fails after `ms` naming `what`. */
export async function until(check, what, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(5);
  }
}

// Stores close and their files go once the file's tests are done: node:test runs a test's after-hooks in the order they
// were added, so a store closed by a hook added before a runner's close would close under the runner.
const opened = [];
after(async () => {
  for (const { stores, dir, schema } of opened.splice(0)) {
    for (const store of stores) await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    if (schema) await dropSchema(schema);
  }
});

/** The store at the test's place, as `role`: the file in `dir`, or on Postgres the schema `schema`. */
const openAt = ({ file, schema }, role, now) => (schema ? openPostgresStore({ url: PG_URL, schema, role, testClock: now }) : openSqliteStore({ file, role, now }));

/**
 * A store file of its own: the server's store (schema set up), and `runners` more opened on the same file as runners.
 * Every store's clock is real time plus `clock.skewMs`, so a test can move the store's now (as a clock that jumped).
 */
export async function stores({ runners = 1 } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-runner-"));
  const schema = onPostgres ? await freshSchema() : undefined;
  const file = schema ? `pg:${schema}` : join(dir, "store.sqlite");
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const entry = { stores: [], dir, schema };
  opened.push(entry);
  const server = await openAt({ file, schema }, "server", now);
  entry.stores.push(server);
  const forRunners = [];
  for (let i = 0; i < runners; i++) {
    const store = await openAt({ file, schema }, "runner", now);
    entry.stores.unshift(store);
    forRunners.push(store);
  }
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  return { server, runners: forRunners, clock, file };
}

/** A queued run on the server's store. */
export const queue = (server, id) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });

/** A command row as the store holds it now. */
export const commandRow = async (store, runId, id) => (await store.commands(runId, id - 1)).find((command) => command.id === id);

/** What the runners' stores did, shared by the `observed` stores of one test. */
export function recorder() {
  return {
    /** Every claim that landed: { runId, runner, epoch, at (ms), until }. */
    claims: [],
    /** Every journal commit that stored a batch: { runId, epoch, runner, startedAt, at }. */
    commits: [],
    /** In order: "flush", "release <run>", and "<state> <run>" for a commit that staged a state other than running. */
    ops: [],
    /** Runner names whose renews fail as a busy store's would. */
    blockRenew: new Set(),
    /** The size of each batch a runner claimed (claimMany), in order. */
    batches: [],
    /** Every call the runner made of its store for a run, as it was made: { op, runId, order }. */
    calls: [],
    /** When set (a promise), the next renews wait for it before they reach the store; renewsHeld counts them. */
    holdRenew: undefined,
    renewsHeld: 0,
    /** When set, each flush waits this long before it reaches the store (a slow disk, or a loaded machine). */
    flushDelayMs: 0,
  };
}

/** `store` (the runner's part of it), recording into `record`. */
export function observed(store, record) {
  // A runner that died (record.dieAfterStopped: right after its store wrote a stopped run) writes nothing more.
  const alive = () => {
    if (record.dead) throw new Error("the runner process died");
  };
  const called = (op, runId) => record.calls.push({ op, runId, order: nextOrder() });
  return {
    runs: {
      async update(claim, patch, rows) {
        alive();
        called("update", claim.runId);
        const row = await store.runs.update(claim, patch, rows);
        if (record.dieAfterStopped && patch.state === "stopped") record.dead = true;
        return row;
      },
      claimable: (options) => store.runs.claimable(options),
      async claimMany(runner, k, options) {
        const claims = await store.runs.claimMany(runner, k, options);
        const at = Date.now();
        for (const claim of claims) record.claims.push({ runId: claim.runId, runner, epoch: claim.epoch, at, until: claim.until, from: claim.from });
        if (claims.length) record.batches.push(claims.length);
        return claims;
      },
    },
    async claim(runId, runner, options) {
      const claim = await store.claim(runId, runner, options);
      if (claim) record.claims.push({ runId, runner, epoch: claim.epoch, at: Date.now(), until: claim.until });
      return claim;
    },
    async renew(claim, options) {
      if (record.blockRenew.has(claim.runner)) throw Object.assign(new Error("the store stayed locked past its busy timeout"), { name: "StoreBusy" });
      if (record.holdRenew) {
        record.renewsHeld += 1;
        await record.holdRenew;
      }
      called("renew", claim.runId);
      return store.renew(claim, options);
    },
    // The runner's renew of all it holds, in one transaction: the same hooks as renew's, the hold once for the batch.
    async renewMany(claims, options) {
      if (claims.some((claim) => record.blockRenew.has(claim.runner))) throw Object.assign(new Error("the store stayed locked past its busy timeout"), { name: "StoreBusy" });
      if (record.holdRenew) {
        record.renewsHeld += 1;
        await record.holdRenew;
      }
      for (const claim of claims) called("renew", claim.runId);
      return store.renewMany(claims, options);
    },
    async release(claim, options) {
      alive();
      called("release", claim.runId);
      await store.release(claim, options);
      record.ops.push(`release ${claim.runId}`);
    },
    journal(claim) {
      const journal = store.journal(claim);
      let staged;
      return new Proxy(journal, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "stage") {
            return (next) => {
              staged = next;
              return value.call(target, next);
            };
          }
          if (property === "commit") {
            return async (...args) => {
              alive();
              const startedAt = Date.now();
              const startedOrder = nextOrder();
              const result = await value.apply(target, args);
              if (result.stored > 0) {
                record.commits.push({ runId: claim.runId, epoch: claim.epoch, runner: claim.runner, startedAt, startedOrder, at: Date.now() });
                const state = staged?.run?.state;
                if (state && state !== "running") record.ops.push(`${state} ${claim.runId}`);
                // The runner's own end commit of a stopped run (endRun) counts as its stopped write, as runs.update does.
                if (record.dieAfterStopped && state === "stopped") record.dead = true;
                staged = undefined;
              }
              return result;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async flush() {
      alive();
      called("flush");
      if (record.flushDelayMs > 0) await sleep(record.flushDelayMs);
      await store.flush();
      record.ops.push("flush");
    },
    commands: (runId, after) => (called("commands", runId), store.commands(runId, after)),
    commandsOf: (cursors) => {
      for (const cursor of cursors) called("commands", cursor.runId);
      return store.commandsOf(cursors);
    },
    take: async (claim, id, outcome, reason) => (alive(), called("take", claim.runId), store.take(claim, id, outcome, reason)),
    retry: async (claim, id) => (alive(), called("retry", claim.runId), store.retry(claim, id)),
  };
}

const ROOT = 1;

/**
 * Faux loops: each start() runs `turns` turns of `turnMs`, one journal commit per turn, and ends with the run's state
 * staged in its last commit. A steer, approve or raise handed to it is staged as a take in its next commit; a stop row
 * ends it as stopped with the take in that commit. `park: true` parks the first start (state parked in its last commit)
 * and the next start ends it. `stubborn: true` ignores stop() and the signal and keeps committing, so only the runner's
 * own fence keeps its writes out. Every loop made is in `loops`, with its received commands and its commit errors.
 */
export function fauxLoops({ turns = 3, turnMs = 10, park = false, stubborn = false, work } = {}) {
  const loops = [];
  const parkedRuns = new Set();
  const rooted = new Set();
  const write = async (journal, runId, staged) => {
    const writes = [];
    if (!rooted.has(runId)) writes.push({ type: "conversation", value: { id: ROOT } });
    const id = await journal.mintId();
    writes.push({ type: "entry", value: { id, conversationId: ROOT, kind: "message" } });
    // A run patch and a take are keyed to their effect: this commit's entry.
    if (staged) journal.stage({ ...staged, ...(staged.run || staged.also ? { effect: id } : {}), ...(staged.take ? { take: staged.take.map((command) => ({ command, effect: id })) } : {}) });
    await commitWrites(journal, writes, BACKGROUND_CONTEXT);
    rooted.add(runId);
  };
  const createLoop = (deps) => {
    let stopReason = null;
    let wake = () => {};
    let done;
    const ended = new Promise((resolve) => (done = resolve));
    const loop = {
      deps,
      claim: null,
      received: [],
      pending: [],
      stopCalls: [],
      commitErrors: [],
      journal: null,
      /** Ends a stubborn loop at its next turn (a test's cleanup). */
      halted: false,
      /** One more commit now, as a late write of a loop whose runner stopped answering. */
      commitNow: () => write(loop.journal, loop.claim.runId),
      async start(claim) {
        loop.claim = claim;
        const journal = deps.journal(claim);
        loop.journal = journal;
        try {
          if (park && !parkedRuns.has(claim.runId)) {
            parkedRuns.add(claim.runId);
            await write(journal, claim.runId, { run: { state: "parked" } });
            return { state: "parked" };
          }
          for (let turn = 0; stubborn ? !loop.halted : turn < turns; turn++) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, turnMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
              if (!stubborn) deps.signal.addEventListener("abort", wake, { once: true });
            });
            if (work) work();
            if (stopReason && !stubborn) {
              if (stopReason.kind === "command") {
                await write(journal, claim.runId, { run: { state: "stopped" }, take: [stopReason.commandId] });
                return { state: "stopped" };
              }
              return { state: "interrupted" };
            }
            const take = loop.pending.splice(0).map((command) => command.id);
            // When the commit was tried (a commit begun before a stop may be refused after it), and when it was refused.
            const startedAt = Date.now();
            const startedOrder = nextOrder();
            try {
              await write(journal, claim.runId, take.length ? { take } : undefined);
            } catch (error) {
              loop.commitErrors.push({ startedAt, startedOrder, at: Date.now(), name: error.name });
              if (!stubborn) throw error;
            }
          }
          const take = loop.pending.splice(0).map((command) => command.id);
          await write(journal, claim.runId, { run: { state: "ended" }, ...(take.length ? { take } : {}) });
          return { state: "ended" };
        } finally {
          done();
        }
      },
      async command(command) {
        loop.received.push({ ...command, at: Date.now() });
        loop.pending.push(command);
        return { taken: true };
      },
      async stop(reason) {
        loop.stopCalls.push({ ...reason, at: Date.now(), order: nextOrder() });
        stopReason = reason;
        wake();
        if (!stubborn) await ended;
      },
    };
    loops.push(loop);
    return loop;
  };
  return { loops, createLoop };
}
