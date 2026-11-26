// A run started while its agent's learning round was going names those runs (learning-rounds.ts openRoundsOf), and its
// first claim reads its seed again once they end (runner/learning-reseed.ts). Here, over a store of hand-made rows: which
// runs are named (never one queued or parked on a person, whatever it holds), and which claims read again (never one after
// the run's first turn; a read that fails keeps the start it had, without the runs it named).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRoundsOf } from "../dist/learning-rounds.js";
import { launchBody } from "../dist/run-launch.js";
import { reseededLaunchOf, roundWaitMsOf, ROUND_WAIT_ENV, ROUND_WAIT_MS } from "../dist/runner/learning-reseed.js";

const refused = (what) => () => {
  throw new Error(`${what} was read`);
};
const EMPTY_JOURNAL = { scanConversations: async () => ({ items: [] }) };
const EMPTY_RECORDS = { scanConversations: async () => ({ items: [] }), scanTasks: async () => ({ items: [] }), scanSubmissions: async () => ({ items: [] }) };
const TURNED_JOURNAL = { scanConversations: async () => ({ items: [{ id: 1 }] }), scanEntries: async () => ({ items: [{ id: 1, conversationId: 1, kind: "agentrun.message", data: {} }] }) };

test("a run queued or parked on a person is no open round, whatever it holds: a run started beside it names none", async () => {
  const store = {
    runs: { list: async () => [{ id: "run-queued", state: "queued" }, { id: "run-parked", state: "parked" }], launch: refused("a launch") },
    commands: refused("its commands"),
    readJournal: refused("its journal"),
    learning: { proposal: refused("its learning") },
  };
  assert.deepEqual(await openRoundsOf(store, "agent-1"), []);
});

/** An agent with one running run whose round is going (an earlier round of it ended: learning-rounds.ts roundOpen) and
 *  whose launch learns from a seed, holding `commands`. */
const goingRound = (commands) => ({
  runs: { list: async () => [{ id: "run-1", state: "running", epoch: 1 }], launch: async () => ({ runId: "run-1", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "" } }) }) },
  commands: async () => commands,
  readJournal: () => EMPTY_RECORDS,
  learning: { proposal: async () => ({ createdAt: 1, proposal: {} }) },
});

test("a running run whose round is going but holds no person's words is no open round: its round merges no correction", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([{ id: 1, kind: "message" }]), "agent-1"), []);
});

test("the same run holding a steer (a follow-up, a grade's words) is named", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([{ id: 1, kind: "message" }, { id: 2, kind: "steer" }]), "agent-1"), ["run-1"]);
});

test("an older running run with an open round is named behind sixty newer queued runs: the read lists running runs only", async () => {
  const queued = Array.from({ length: 60 }, (_, i) => ({ id: `run-q${String(i).padStart(2, "0")}`, state: "queued", startedAt: 1_000 + i })).reverse();
  const rows = [...queued, { id: "run-old", state: "running", epoch: 1, startedAt: 1 }];
  const round = goingRound([{ id: 1, kind: "steer" }]);
  // As the store lists them (Runs.list): newest first, its state filter and keyset boundary before its limit.
  round.runs.list = async ({ state, limit, before }) => {
    const listed = rows.filter((row) => (!state || row.state === state) && (!before || row.startedAt < before.startedAt || (row.startedAt === before.startedAt && row.id < before.id)));
    return limit === undefined ? listed : listed.slice(0, limit);
  };
  assert.deepEqual(await openRoundsOf(round, "agent-1"), ["run-old"]);
});

/** A claim store whose run `run-2` (epoch 1, no turn yet) names run `run-1`, whose round stays open (an earlier round of
 *  it ended and it runs again: learning-rounds.ts roundOpen); `own(reads)` is run-2's row at each read after the first,
 *  `commands(reads)` its command rows. Its seed is never read. */
function waitStore({ own, commands = () => [] }) {
  const written = [];
  let reads = 0;
  const launch = { runId: "run-2", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "", after: ["run-1"] } }), sealed: null, census: null, createdAt: 0 };
  const store = {
    runs: {
      launch: async () => launch,
      get: async (id) => {
        if (id === "run-1") return { id, agentId: "agent-1", state: "running", epoch: 1 };
        return reads++ === 0 ? { id, agentId: "agent-1", state: "running", epoch: 1 } : own(reads);
      },
      reseedLearning: async (_runId, learning, epoch) => (written.push({ learning, epoch }), true),
    },
    readJournal: () => EMPTY_RECORDS,
    commands: async (id) => (id === "run-2" ? commands(reads) : []),
    learning: { seed: refused("its seed"), proposal: async (id) => (id === "run-1" ? { createdAt: 1, proposal: {} } : undefined) },
  };
  return { store, written };
}

test("a claim lost while it waits (the run's epoch moved) stops waiting at once and writes nothing", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "reseed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const { store, written } = waitStore({ own: (reads) => ({ id: "run-2", agentId: "agent-1", state: "running", epoch: reads > 2 ? 2 : 1 }) });
  const started = Date.now();
  const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1);
  assert.ok(Date.now() - started < 6_000, "it never waited to its bound");
  assert.deepEqual(row.body.learning.after, ["run-1"], "the row as it was");
  assert.deepEqual(written, [], "no write under a claim it no longer holds");
});

test("a person's cancel or stop while the claim waits ends the wait at once: the row as it was, nothing written", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "reseed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const running = () => ({ id: "run-2", agentId: "agent-1", state: "running", epoch: 1 });
  for (const kind of ["cancel", "stop"]) {
    const { store, written } = waitStore({ own: running, commands: (reads) => (reads > 2 ? [{ id: 7, runId: "run-2", kind, body: {}, createdAt: 1, takenAt: null, refused: null, tries: 0 }] : []) });
    const started = Date.now();
    const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1);
    assert.ok(Date.now() - started < 6_000, `${kind}: it never waited to its bound`);
    assert.deepEqual(row.body.learning.after, ["run-1"], `${kind}: the row as it was`);
    assert.deepEqual(written, [], `${kind}: nothing written`);
  }
});

/** A store with one run (`run-2`) at `epoch`, whose launch names `after`, its journal `journal`; its seed read throws. */
function claimStore({ epoch, journal, after = ["run-1"] }) {
  const written = [];
  const launch = { runId: "run-2", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "", after } }), sealed: null, census: null, createdAt: 0 };
  const store = {
    runs: {
      // As the store writes it (sqlite/run-launch.ts writeLaunchLearning): the body's learning member replaced.
      launch: async () => (written.length ? { ...launch, body: { ...launch.body, learning: written.at(-1) } } : launch),
      get: async (id) => (id === "run-2" ? { id, agentId: "agent-1", state: "running", epoch } : undefined),
      reseedLearning: async (_runId, learning) => (written.push(learning), true),
    },
    readJournal: () => journal,
    commands: async () => [],
    learning: { seed: async () => { throw new Error("the folder could not be read"); }, proposal: async () => undefined },
  };
  return { store, written };
}

test("a re-claimed run that already took a turn keeps the seed it started from: no wait, no read, no write", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "reseed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  for (const [epoch, journal] of [[3, EMPTY_JOURNAL], [1, TURNED_JOURNAL]]) {
    const { store, written } = claimStore({ epoch, journal });
    const started = Date.now();
    const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 60_000 })("run-2", epoch);
    assert.ok(Date.now() - started < 5_000, "it never waited");
    assert.equal(row.body.learning.seed, "save-1");
    assert.deepEqual(written, [], `epoch ${epoch}: its start is left as it is`);
  }
});

test("a first claim whose seed cannot be read again keeps the start it had, without the runs it waited on", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "reseed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const { store, written } = claimStore({ epoch: 1, journal: EMPTY_JOURNAL });
  const lines = [];
  const row = await reseededLaunchOf({ store, data, shown: async () => ({ text: (s) => s, name: (s) => s, holds: () => false }), log: (line) => lines.push(line), waitMs: 60_000 })("run-2", 1);
  assert.deepEqual(written, [{ seed: "save-1", section: "" }]);
  assert.deepEqual(row.body.learning, { seed: "save-1", section: "" });
  assert.ok(lines.some((line) => line.includes("could not be read again")), lines.join("\n"));
});

test("the wait's bound is the runner's own setting, else three minutes", () => {
  assert.equal(roundWaitMsOf({}), ROUND_WAIT_MS);
  assert.equal(ROUND_WAIT_MS, 180_000);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "0" }), 0);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "1500" }), 1500);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "soon" }), ROUND_WAIT_MS);
});
