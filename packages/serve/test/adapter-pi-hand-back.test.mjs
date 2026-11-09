// A person's answer to the agent's browser hand-over, on pi through the adapter loop (runner/adapter-loop.ts): the
// server inserts it as a browser_hand_back row (its body { ask, outcome }), and the runner hands it to the run's loop,
// which applies it on the run's journal. The first answer for an ask is its answer: the loop commits the matching
// answered agent.handover entry ({ state, id, session, at }), taking the row in that commit, `at` the answer's own time
// (the row's), never the runner's clock. A second answer, an answer for an ask the run never made, and one that comes
// after the ask lapsed are refused in words; a lapsed ask's answer is its expiry, at the expiry's time. The ask itself is
// the run's browser host's entry (browser-person.ts), committed here through harnessReady's commit as that host does.
//
// The rows are inserted through a store of their own on the same file, its clock fixed at T0: a row's time is
// T0 whatever the runner's clock reads, so an entry that took the runner's clock would say so.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openSqliteStore, RunFinal } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { COMMAND_KINDS, sendCommand } = await import("../dist/runner/commands.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 15_000;
const T0 = Date.parse("2001-02-03T04:05:06.007Z");
const iso = (ms) => new Date(ms).toISOString();
const MINUTE = 60_000;
after(closeOpenSessions);

/** The hand-over the agent asks for, as the run's browser host commits it: the whole ask. */
const askOf = (n, { askedAt = T0 - MINUTE, expiresAt = T0 + 14 * MINUTE } = {}) => ({
  state: "waiting",
  id: `ask${String(n).padStart(29, "0")}`,
  session: `ar-run-1-${n}`,
  instruction: `Sign in to site ${n}`,
  completion_condition: `site ${n} shows the account`,
  asked_at: iso(askedAt),
  expires_at: iso(expiresAt),
  reason: `Sign in to site ${n}`,
});

async function setup(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-hand-back-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  // The person's rows: inserted at T0, whatever the time is. Opened as a runner's (the server's owner lock is taken), it
  // inserts rows as the server's store does.
  const person = await openSqliteStore({ dataDir: dir, role: "runner", now: () => T0 });
  const runners = [];
  const stores = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await person.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Hands over" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const start = async (createLoop) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    runners.push(startRunner({ store, createLoop, name: "runner-a", ...TIMING }));
  };
  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const read = (sql, ...args) => {
    const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
    try {
      return db.prepare(sql).all(...args).map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  /** The run's hand-over entries' data, in the order written. */
  const handovers = () => read("SELECT json_extract(record, '$.data') AS data FROM pi_entries WHERE run_id = ? AND json_extract(record, '$.kind') = 'agent.handover' ORDER BY rowid", "run-1").map((row) => JSON.parse(row.data));
  /** Each row once the runner has dealt with it (taken or refused): its id, taken or not, and why it was refused. */
  const settled = (ids) => until(async () => {
    const rows = (await server.commands("run-1", 0)).filter((row) => ids.includes(row.id));
    return rows.length === ids.length && rows.every((row) => row.takenAt !== null) && rows.map((row) => ({ id: row.id, refused: row.refused }));
  }, `rows ${ids.join(", ")} taken or refused`);
  const handBack = async (ask, outcome) => (await sendCommand(person, "run-1", { kind: "browser_hand_back", body: { ask, outcome } })).id;
  return { server, start, until, handovers, settled, handBack };
}

/** A run whose turn asks for the person (each ask in `asks` committed as the browser host commits it), then waits inside
 *  the call until the test lets it go, as pi-browser's wait does. */
async function askingRun(world, asks) {
  let commit;
  let asked;
  const askedNow = new Promise((resolve) => (asked = resolve));
  let letGo;
  const waiting = new Promise((resolve) => (letGo = resolve));
  const handoff = {
    name: "handoff", replaySafe: false, ask: false,
    run: async (_args, signal) => {
      for (const ask of asks) await commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "agent.handover", data: ask }), BACKGROUND_CONTEXT);
      asked();
      // Let go by the test, or cut when the runner closes (a failed test never leaves the run waiting).
      return await new Promise((resolve) => {
        waiting.then(resolve);
        signal?.addEventListener("abort", () => resolve("cut"), { once: true });
      });
    },
  };
  const spec = piAdapterSpec({ script: [{ call: "handoff" }, { say: "done" }], tools: { handoff }, hooks: quiet });
  const inner = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", harnessReady: (given) => (commit = given) }));
  await world.start(inner);
  await askedNow;
  return { letGo, ended: () => world.until(async () => {
    const row = await world.server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended") };
}

test("a browser hand-back is a command kind: its body names the ask and how it ended (done or cancelled), and the insert refuses it on a final run, as every kind", async (t) => {
  assert.ok(COMMAND_KINDS.has("browser_hand_back"));
  const world = await setup(t);
  await assert.rejects(sendCommand(world.server, "run-1", { kind: "browser_hand_back", body: { outcome: "done" } }), TypeError, "no ask");
  await assert.rejects(sendCommand(world.server, "run-1", { kind: "browser_hand_back", body: { ask: "a", outcome: "expired" } }), TypeError, "expired is the run's own answer, never a person's");
  await assert.rejects(sendCommand(world.server, "run-1", { kind: "browser_hand_back", body: { ask: "a" } }), TypeError, "no outcome");
  const run = await askingRun(world, []);
  run.letGo("nobody came");
  await run.ended();
  await assert.rejects(sendCommand(world.server, "run-1", { kind: "browser_hand_back", body: { ask: "a", outcome: "done" } }), RunFinal);
});

test("the first answer wins: it is taken by the answered entry's commit, at the answer's own time; a second answer for the same hand-over is refused in words, and writes nothing", async (t) => {
  const world = await setup(t);
  const ask = askOf(1);
  const run = await askingRun(world, [ask]);
  const done = await world.handBack(ask.id, "done");
  const again = await world.handBack(ask.id, "cancelled");
  const rows = await world.settled([done, again]);
  assert.deepEqual(rows, [
    { id: done, refused: null },
    { id: again, refused: "The agent's hand-over was already answered done." },
  ]);
  assert.deepEqual(world.handovers(), [ask, { state: "done", id: ask.id, session: ask.session, at: iso(T0) }], "one answer, at the person's time");
  run.letGo("handed back");
  await run.ended();
});

test("an answer for a hand-over the run never asked for is refused in words, and one that comes after the hand-over lapsed is too: the hand-over's answer is its expiry, at the expiry's time", async (t) => {
  const world = await setup(t);
  const lapsed = askOf(2, { askedAt: T0 - 16 * MINUTE, expiresAt: T0 - MINUTE });
  const run = await askingRun(world, [lapsed]);
  const unknown = await world.handBack(`ask${"9".repeat(29)}`, "done");
  const late = await world.handBack(lapsed.id, "done");
  const lateAgain = await world.handBack(lapsed.id, "cancelled");
  const rows = await world.settled([unknown, late, lateAgain]);
  assert.deepEqual(rows, [
    { id: unknown, refused: "This run's agent has not asked for you in its browser." },
    { id: late, refused: "The agent's hand-over expired before this answer." },
    { id: lateAgain, refused: "The agent's hand-over expired before this answer." },
  ]);
  assert.deepEqual(world.handovers(), [lapsed, { state: "expired", id: lapsed.id, session: lapsed.session, at: lapsed.expires_at }], "the expiry, once, at its own time");
  run.letGo("expired");
  await run.ended();
});
