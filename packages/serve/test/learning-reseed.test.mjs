// A run started while its agent's learning round was going names those runs (learning-rounds.ts openRoundsOf), and its
// first claim reads its seed again once they end (runner/learning-reseed.ts). Here, over a store of hand-made rows: which
// runs are named (only one whose end-of-run learning step runs: never one queued, parked on a person or in a follow-up's
// turn, whatever it holds), and which claims read again (never one after the run's first turn; a read that fails keeps
// the start it had, without the runs it named), how the wait ends (a claim gone starts no loop; an abort or a stop ends it
// at once), how often it reads, and what a failed read counts as.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRoundsOf } from "../dist/learning-rounds.js";
import { launchBody, readLaunchBody } from "../dist/run-launch.js";
import { CLAIM_GONE, createDispatchLoop } from "../dist/runner/dispatch.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { POLL_FIRST_MS, POLL_MAX_MS, pollPauseMs, reseededLaunchOf, roundWaitMsOf, ROUND_WAIT_ENV, ROUND_WAIT_MS } from "../dist/runner/learning-reseed.js";
import { heldRedactor } from "../dist/runner/redact.js";
import { storeOn } from "./store-helpers.mjs";

const refused = (what) => () => {
  throw new Error(`${what} was read`);
};
const EMPTY_JOURNAL = { scanConversations: async () => ({ items: [] }) };
const TURNED_JOURNAL = { scanConversations: async () => ({ items: [{ id: 1 }] }), scanEntries: async () => ({ items: [{ id: 1, conversationId: 1, kind: "agentrun.message", data: {} }] }) };
/** A run's root journal of entries of `kinds`, in order (a job's end kept for its look-back carries its end), scanned
 *  as the store scans it (Storage.scanEntries): newest first unless asked oldest first, in one page. */
const journalOf = (kinds) => {
  const entries = kinds.map((kind, i) => ({ id: i + 1, conversationId: 1, kind, data: kind === KINDS.jobEnd ? { end: { state: "ended" }, endedAt: 5 } : {} }));
  return {
    scanConversations: async () => ({ items: [{ id: 1 }] }),
    scanEntries: async (query) => ({ items: query?.order === "ascending" ? entries : [...entries].reverse() }),
  };
};
/** A follow-up's turn running: its first round's job end kept and that round ended, the follow-up's job not yet ended. */
const MID_TURN = journalOf(["agentrun.message", KINDS.jobEnd, KINDS.end, "agentrun.message"]);
/** The follow-up's end-of-run learning step running: its job's end kept after the run's last end. */
const LEARNING_END = journalOf(["agentrun.message", KINDS.jobEnd, KINDS.end, "agentrun.message", KINDS.jobEnd]);
const TAKEN_STEER = { id: 2, runId: "run-1", kind: "steer", body: { text: "Correction" }, createdAt: 1, takenAt: 2, refused: null, tries: 0 };
/** A person's next message to that run, not taken yet: it waits while the run's look-back runs to its end and merges. */
const WAITING_STEER = { id: 3, runId: "run-1", kind: "steer", body: { text: "And one more thing" }, createdAt: 3, takenAt: null, refused: null, tries: 0 };
const SHOWN = async () => ({ text: (s) => s, name: (s) => s, holds: () => false });

test("a run queued or parked on a person is no open round, whatever it holds: a run started beside it names none", async () => {
  const store = {
    runs: { list: async () => [{ id: "run-queued", state: "queued" }, { id: "run-parked", state: "parked" }], launch: refused("a launch") },
    commands: refused("its commands"),
    commandsOf: refused("its commands"),
    readJournal: refused("its journal"),
    learning: { proposal: refused("its learning") },
  };
  assert.deepEqual(await openRoundsOf(store, "agent-1"), []);
});

/** An agent with one running run (`run-1`) whose launch learns from a seed, its journal `journal`, holding `commands`,
 *  an earlier round of it kept (a proposal). Its commands are read in one read for the page (commandsOf), never one by one. */
const goingRound = (commands, journal = LEARNING_END) => ({
  runs: { list: async () => [{ id: "run-1", state: "running", epoch: 1 }], launch: async () => ({ runId: "run-1", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "" } }) }) },
  commands: refused("one run's commands"),
  commandsOf: async (cursors) => new Map(cursors.map(({ runId }) => [runId, commands])),
  readJournal: () => journal,
  learning: { proposal: async () => ({ createdAt: 1, proposal: {} }) },
});

test("a running run whose round is going but holds no person's words is no open round: its round merges no correction", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([{ id: 1, kind: "message", takenAt: 1, refused: null }]), "agent-1"), []);
});

test("the same run holding a steer (a follow-up, a grade's words) is named while its end-of-run learning step runs", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([{ id: 1, kind: "message", takenAt: 1, refused: null }, TAKEN_STEER]), "agent-1"), ["run-1"]);
});

test("a run in a follow-up's turn is not named, though an earlier round of it ended and it holds the steer: a run started mid-turn starts from the seed as it is", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([TAKEN_STEER], MID_TURN), "agent-1"), []);
});

test("a run looking back with a person's next message waiting untaken is still named: its look-back runs to its end and merges the correction", async () => {
  assert.deepEqual(await openRoundsOf(goingRound([TAKEN_STEER, WAITING_STEER]), "agent-1"), ["run-1"]);
});

test("an older running run with an open round is named behind sixty newer queued runs: the read lists running runs only", async () => {
  const queued = Array.from({ length: 60 }, (_, i) => ({ id: `run-q${String(i).padStart(2, "0")}`, state: "queued", startedAt: 1_000 + i })).reverse();
  const rows = [...queued, { id: "run-old", state: "running", epoch: 1, startedAt: 1 }];
  const round = goingRound([TAKEN_STEER]);
  // As the store lists them (Runs.list): newest first, its state filter and keyset boundary before its limit.
  round.runs.list = async ({ state, limit, before }) => {
    const listed = rows.filter((row) => (!state || row.state === state) && (!before || row.startedAt < before.startedAt || (row.startedAt === before.startedAt && row.id < before.id)));
    return limit === undefined ? listed : listed.slice(0, limit);
  };
  assert.deepEqual(await openRoundsOf(round, "agent-1"), ["run-old"]);
});

test("a POST over 120 running runs reads their commands in one read a page (three), not one a run, and the journal of the steered run alone", async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `run-${String(i).padStart(3, "0")}`, state: "running", epoch: 1, startedAt: 1_000 - i }));
  const reads = { commandsOf: 0, journals: [] };
  const store = {
    runs: {
      list: async ({ limit, before }) => rows.filter((row) => !before || row.startedAt < before.startedAt).slice(0, limit),
      launch: async () => ({ body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "" } }) }),
    },
    commands: refused("one run's commands"),
    commandsOf: async (cursors) => (reads.commandsOf++, new Map(cursors.filter(({ runId }) => runId === "run-077").map(({ runId }) => [runId, [{ ...TAKEN_STEER, runId }]]))),
    readJournal: (id) => (reads.journals.push(id), LEARNING_END),
  };
  assert.deepEqual(await openRoundsOf(store, "agent-1"), ["run-077"]);
  assert.deepEqual([reads.commandsOf, reads.journals], [3, ["run-077"]]);
});

/** A claim store whose run `run-2` (at `epoch`, no turn yet) names run `run-1`, whose round stays open (its end-of-run
 *  learning step runs: LEARNING_END); `own(reads)` is run-2's row at each read after the first, `commands(reads)` its
 *  command rows, `other()` run-1's row (a throw is a failed read). Its seed is read from `seed`. */
function waitStore({ own = () => ({ id: "run-2", agentId: "agent-1", state: "running", epoch: 1 }), commands = () => [], other = () => ({ id: "run-1", agentId: "agent-1", state: "running", epoch: 1 }), otherCommands = () => [TAKEN_STEER], seed = refused("its seed"), epoch = 1 } = {}) {
  const written = [];
  let reads = 0;
  const launch = { runId: "run-2", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "", after: ["run-1"] } }), sealed: null, census: null, createdAt: 0 };
  const store = {
    runs: {
      launch: async () => launch,
      get: async (id) => {
        if (id === "run-1") return other();
        return reads++ === 0 ? { id, agentId: "agent-1", state: "running", epoch } : own(reads);
      },
      reseedLearning: async (_runId, learning, at) => (written.push({ learning, epoch: at }), true),
    },
    readJournal: (id) => (id === "run-1" ? LEARNING_END : EMPTY_JOURNAL),
    commands: async (id) => (id === "run-2" ? commands(reads) : otherCommands()),
    learning: { seed, proposal: async () => undefined },
  };
  return { store, written };
}

const tmpData = async (t) => {
  const data = await mkdtemp(join(tmpdir(), "reseed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
};

test("a claim lost while it waits (the run's epoch moved) stops waiting at once, writes nothing, and answers the claim gone", async (t) => {
  const data = await tmpData(t);
  const { store, written } = waitStore({ own: (reads) => ({ id: "run-2", agentId: "agent-1", state: "running", epoch: reads > 2 ? 2 : 1 }) });
  const started = Date.now();
  const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1);
  assert.ok(Date.now() - started < 6_000, "it never waited to its bound");
  assert.equal(row, CLAIM_GONE, "no loop starts on a claim it no longer holds");
  assert.deepEqual(written, [], "no write under a claim it no longer holds");
});

/** A dispatch over `launchOf`, its runner deps' signal `signal`, recording whether it chose a loop. */
function dispatchOver(launchOf, signal) {
  const chosen = [];
  const dispatch = createDispatchLoop({ launchOf, resolve: (harness) => (chosen.push(harness), undefined) })({ redact: heldRedactor((text) => text), journal: () => ({}), flush: async () => {}, signal });
  return { dispatch, chosen };
}

const CLAIM_2 = { runId: "run-2", runner: "runner-a", epoch: 1, until: 0, from: "queued" };

test("the dispatch starts no loop on a launch read that saw its claim go (its epoch moved during the wait): it ends interrupted", async (t) => {
  const data = await tmpData(t);
  const { store } = waitStore({ own: (reads) => ({ id: "run-2", agentId: "agent-1", state: "running", epoch: reads > 2 ? 2 : 1 }) });
  const { dispatch, chosen } = dispatchOver(reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 }), new AbortController().signal);
  assert.deepEqual(await dispatch.start(CLAIM_2), { state: "interrupted" });
  assert.deepEqual(chosen, [], "no harness was resolved, no loop started");
});

test("a claim lost or a runner closing (the claim's signal aborted) ends the wait at once: no loop chosen, nothing written", async (t) => {
  const data = await tmpData(t);
  for (const reason of ["claim-lost", "shutdown"]) {
    const { store, written } = waitStore();
    const abort = new AbortController();
    const { dispatch, chosen } = dispatchOver(reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 }), abort.signal);
    const started = Date.now();
    const end = dispatch.start(CLAIM_2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // As the runner does (runner.ts loseClaim, close): the loop told to stop, then the claim's signal aborted.
    const stopped = dispatch.stop({ kind: reason });
    abort.abort();
    assert.deepEqual(await end, { state: "interrupted" }, reason);
    await stopped;
    assert.ok(Date.now() - started < 3_000, `${reason}: it never waited to its bound`);
    assert.deepEqual(chosen, [], `${reason}: no loop chosen on a claim it no longer holds`);
    assert.deepEqual(written, [], `${reason}: nothing written`);
  }
});

test("the wait itself returns at once on its signal's abort, the row as it is, nothing written", async (t) => {
  const data = await tmpData(t);
  const { store, written } = waitStore();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 600);
  t.after(() => clearTimeout(timer));
  const started = Date.now();
  const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1, abort.signal);
  assert.ok(Date.now() - started < 3_000, "it never waited to its bound");
  assert.deepEqual(row.body.learning.after, ["run-1"], "the row as it was");
  assert.deepEqual(written, [], "nothing written");
});

/** A dispatch over `launchOf` whose harness resolves to a loop that runs until it is told to stop, recording its choice
 *  and the stops it is given. */
function dispatchWithLoop(launchOf) {
  const seen = { chosen: 0, stops: [] };
  let finish = () => {};
  const inner = {
    start: () => new Promise((resolve) => (finish = resolve)),
    stop: async (reason) => {
      seen.stops.push(reason);
      finish({ state: "stopped" });
    },
    command: async () => ({ taken: true }),
  };
  const dispatch = createDispatchLoop({ launchOf, resolve: async () => (seen.chosen++, () => inner) })({ redact: heldRedactor((text) => text), journal: () => ({}), flush: async () => {}, signal: new AbortController().signal });
  return { dispatch, seen };
}

test("a person's stop or cancel while the claim waits reaches the dispatch: the wait ends at once, nothing written, and the loop starts already stopped", async (t) => {
  const data = await tmpData(t);
  for (const cancel of [false, true]) {
    const { store, written } = waitStore();
    const { dispatch, seen } = dispatchWithLoop(reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 }));
    const started = Date.now();
    const end = dispatch.start(CLAIM_2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // As the runner delivers a person's stop or cancel row (runner.ts stopLoop): the dispatch's stop, the loop not chosen yet.
    const reason = { kind: "command", commandId: 7, ...(cancel ? { cancel: true } : {}) };
    const stopped = dispatch.stop(reason);
    assert.deepEqual(await end, { state: "stopped" }, `cancel ${cancel}`);
    await stopped;
    assert.ok(Date.now() - started < 3_000, `cancel ${cancel}: it never waited to its bound`);
    assert.equal(seen.chosen, 1, `cancel ${cancel}: the loop is chosen, so the run ends stopped in its own commit`);
    assert.deepEqual(seen.stops, [reason], `cancel ${cancel}: the loop starts already stopped`);
    assert.deepEqual(written, [], `cancel ${cancel}: nothing written`);
  }
});

const SEED_UNREAD = async () => {
  throw new Error("the folder could not be read");
};

test("the wait reads less often the longer it lasts: 250 ms, doubling to 2 s, the last pause cut at the bound", async (t) => {
  const data = await tmpData(t);
  assert.deepEqual([POLL_FIRST_MS, POLL_MAX_MS, [0, 1, 2, 3, 4, 40].map(pollPauseMs)], [250, 2_000, [250, 500, 1_000, 2_000, 2_000, 2_000]]);
  const { store, written } = waitStore({ seed: SEED_UNREAD });
  let clock = 0;
  const pauses = [];
  const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 7_000, now: () => clock, sleep: async (ms) => void (pauses.push(ms), (clock += ms)) })("run-2", 1);
  assert.deepEqual(pauses, [250, 500, 1_000, 2_000, 2_000, 1_250]);
  assert.deepEqual(written.map((one) => one.learning), [{ seed: "save-1", section: "" }], "timed out: it read again (here a failed read, so the start it had)");
  assert.deepEqual(row.body.learning, { seed: "save-1", section: "" });
});

test("a failed read of the round's run counts its round as still open: the claim waits on to its bound, never an early read without the correction", async (t) => {
  const data = await tmpData(t);
  const { store } = waitStore({ other: () => { throw new Error("the store is busy"); }, seed: SEED_UNREAD });
  let clock = 0;
  const lines = [];
  await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: (line) => lines.push(line), waitMs: 3_000, now: () => clock, sleep: async (ms) => void (clock += ms) })("run-2", 1);
  assert.equal(clock, 3_000, "it waited to its bound");
  assert.ok(lines.some((line) => line.includes("did not end within 3 s")), lines.join("\n"));
});

test("a claim waiting on a round whose run gets a person's next message (untaken, its look-back still merging) waits on: never an early read without the correction", async (t) => {
  const data = await tmpData(t);
  const { store } = waitStore({ otherCommands: () => [TAKEN_STEER, WAITING_STEER], seed: SEED_UNREAD });
  let clock = 0;
  const lines = [];
  await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: (line) => lines.push(line), waitMs: 3_000, now: () => clock, sleep: async (ms) => void (clock += ms) })("run-2", 1);
  assert.equal(clock, 3_000, "it waited to its bound");
  assert.ok(lines.some((line) => line.includes("did not end within 3 s")), lines.join("\n"));
});

test("a claim whose first read of its own row or of its journal fails hands the run back (the claim gone, tried again): never a start without the wait, never a failed run", async (t) => {
  const data = await tmpData(t);
  const busy = async () => {
    throw new Error("the store is busy");
  };
  const rowUnread = waitStore();
  rowUnread.store.runs.get = busy;
  assert.equal(await reseededLaunchOf({ store: rowUnread.store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1), CLAIM_GONE, "its row unread");
  assert.deepEqual(rowUnread.written, [], "its row unread: nothing written");
  const journalUnread = waitStore();
  journalUnread.store.readJournal = (id) => (id === "run-2" ? { scanConversations: busy } : LEARNING_END);
  assert.equal(await reseededLaunchOf({ store: journalUnread.store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 12_000 })("run-2", 1), CLAIM_GONE, "its journal unread");
  assert.deepEqual(journalUnread.written, [], "its journal unread: nothing written");
});

test("a failed read of the run's own row while it waits is tried at the next read, never an end of the wait", async (t) => {
  const data = await tmpData(t);
  // run-2's own row fails at its second and third read; run-1's round ends at the fourth pass.
  let passes = 0;
  const { store, written } = waitStore({
    own: (reads) => {
      if (reads <= 3) throw new Error("the store is busy");
      return { id: "run-2", agentId: "agent-1", state: "running", epoch: 1 };
    },
    other: () => (++passes >= 4 ? { id: "run-1", agentId: "agent-1", state: "ended", epoch: 2 } : { id: "run-1", agentId: "agent-1", state: "running", epoch: 1 }),
    seed: SEED_UNREAD,
  });
  let clock = 0;
  const row = await reseededLaunchOf({ store, data, shown: SHOWN, log: () => undefined, waitMs: 60_000, now: () => clock, sleep: async (ms) => void (clock += ms) })("run-2", 1);
  assert.equal(passes, 4, "it read on past its own row's failed reads");
  assert.notEqual(row, CLAIM_GONE);
  assert.deepEqual(written.map((one) => one.learning), [{ seed: "save-1", section: "" }], "the round ended: it read again and wrote");
});

/** A store with one run (`run-2`) at `epoch`, whose launch names `after`, its journal `journal`; its seed read throws.
 *  `reread`: what a read of its launch after the write answers (the store read back). */
function claimStore({ epoch, journal, after = ["run-1"], reread }) {
  const written = [];
  const launch = { runId: "run-2", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "", after } }), sealed: null, census: null, createdAt: 0 };
  const store = {
    runs: {
      // As the store writes it (sqlite/run-launch.ts writeLaunchLearning): the body's learning member replaced.
      launch: async () => (written.length ? (reread ? reread() : { ...launch, body: { ...launch.body, learning: written.at(-1) } }) : launch),
      get: async (id) => (id === "run-2" ? { id, agentId: "agent-1", state: "running", epoch } : undefined),
      reseedLearning: async (_runId, learning) => (written.push(learning), true),
    },
    readJournal: () => journal,
    commands: async () => [],
    learning: { seed: SEED_UNREAD, proposal: async () => undefined },
  };
  return { store, written };
}

test("a re-claimed run that already took a turn keeps the seed it started from: no wait, no read, no write", async (t) => {
  const data = await tmpData(t);
  for (const epoch of [1, 3]) {
    const { store, written } = claimStore({ epoch, journal: TURNED_JOURNAL });
    const started = Date.now();
    const row = await reseededLaunchOf({ store, data, shown: refused("the secrets"), log: () => undefined, waitMs: 60_000 })("run-2", epoch);
    assert.ok(Date.now() - started < 5_000, "it never waited");
    assert.equal(row.body.learning.seed, "save-1");
    assert.deepEqual(written, [], `epoch ${epoch}: its start is left as it is`);
  }
});

test("a claim of an untouched run handed back before its first turn (epoch 3) still reads its seed again: an empty journal and `after` are the gate, not the epoch", async (t) => {
  const data = await tmpData(t);
  const { store, written } = claimStore({ epoch: 3, journal: EMPTY_JOURNAL });
  const row = await reseededLaunchOf({ store, data, shown: SHOWN, log: () => undefined, waitMs: 60_000 })("run-2", 3);
  assert.deepEqual(written, [{ seed: "save-1", section: "" }], "it read again (the run it named is gone, so its round ended) and wrote, without `after`");
  assert.deepEqual(row.body.learning, { seed: "save-1", section: "" });
});

test("a first claim whose seed cannot be read again keeps the start it had, without the runs it waited on", async (t) => {
  const data = await tmpData(t);
  const { store, written } = claimStore({ epoch: 1, journal: EMPTY_JOURNAL });
  const lines = [];
  const row = await reseededLaunchOf({ store, data, shown: SHOWN, log: (line) => lines.push(line), waitMs: 60_000 })("run-2", 1);
  assert.deepEqual(written, [{ seed: "save-1", section: "" }]);
  assert.deepEqual(row.body.learning, { seed: "save-1", section: "" });
  assert.ok(lines.some((line) => line.includes("could not be read again")), lines.join("\n"));
});

test("an abort that comes while the seed is read again (its wait over) writes nothing: `after` stays, so the next claim waits on those rounds again", async (t) => {
  const data = await tmpData(t);
  const { store, written } = claimStore({ epoch: 1, journal: EMPTY_JOURNAL });
  const abort = new AbortController();
  // As a runner closing does mid-read: the signal aborts while the seed is read again (here a read that fails, so the
  // abort lands as its failure is logged, before the start without `after` would be written).
  const shown = async () => {
    abort.abort();
    return SHOWN();
  };
  const row = await reseededLaunchOf({ store, data, shown, log: () => abort.abort(), waitMs: 60_000 })("run-2", 1, abort.signal);
  assert.deepEqual(written, [], "nothing written, neither the new start nor the start without `after`");
  assert.deepEqual(row.body.learning.after, ["run-1"], "the row as it was");
});

test("the row a claim runs on is built from what it wrote, never read back: a read back that fails or answers the old seed changes nothing", async (t) => {
  const data = await tmpData(t);
  const rereads = [
    () => {
      throw new Error("the store is busy");
    },
    () => ({ runId: "run-2", body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, learning: { seed: "save-OLD", section: "", after: ["run-1"] } }) }),
  ];
  for (const reread of rereads) {
    const { store, written } = claimStore({ epoch: 1, journal: EMPTY_JOURNAL, reread });
    const row = await reseededLaunchOf({ store, data, shown: SHOWN, log: () => undefined, waitMs: 60_000 })("run-2", 1);
    assert.deepEqual(row.body.learning, written.at(-1));
    assert.equal(row.body.place.mode, "runner", "the rest of the body as it was");
  }
});

test("a fenced write the store refuses (the claim lapsed or moved) answers the claim gone: no loop starts", async (t) => {
  const data = await tmpData(t);
  const { store } = claimStore({ epoch: 1, journal: EMPTY_JOURNAL });
  store.runs.reseedLearning = async () => false;
  assert.equal(await reseededLaunchOf({ store, data, shown: SHOWN, log: () => undefined, waitMs: 60_000 })("run-2", 1), CLAIM_GONE);
});

test("the wait's bound is the runner's own setting, else three minutes", () => {
  assert.equal(roundWaitMsOf({}), ROUND_WAIT_MS);
  assert.equal(ROUND_WAIT_MS, 180_000);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "0" }), 0);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "1500" }), 1500);
  assert.equal(roundWaitMsOf({ [ROUND_WAIT_ENV]: "soon" }), ROUND_WAIT_MS);
});

test("the store's reseed write is fenced by the claim (fence.ts claimFence): a lapsed lease or a moved epoch writes nothing; a held claim writes the learning member alone", async (t) => {
  const clock = { now: 1_800_000_000_000 };
  const { store } = await storeOn(t, { clock });
  const body = launchBody({ input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { seed: "save-1", section: "", after: ["run-1"] } });
  await store.runs.createInline({
    agent: { id: "agent-r", name: "Reseeded", description: null, ref: "host:expert:r" },
    revision: { id: "rev-r", version: "1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {} }, skills: {} },
    run: { id: "run-r" },
    launch: { body },
  });
  const claim = await store.claim("run-r", "runner-a", { leaseMs: 1_000 });
  assert.ok(claim, "claimed");
  const learning = { seed: "save-2", section: "", waited: "ended" };
  // Its lease run out, the run not claimed again yet: the epoch alone would let it write.
  clock.now += 2_000;
  assert.equal(await store.runs.reseedLearning("run-r", learning, claim.epoch), false, "a lapsed lease writes nothing");
  assert.deepEqual(readLaunchBody((await store.runs.launch("run-r")).body).learning.after, ["run-1"]);
  // Claimed again: the old epoch writes nothing, the new claim writes.
  const again = await store.claim("run-r", "runner-b", { leaseMs: 30_000 });
  assert.ok(again && again.epoch > claim.epoch, "claimed again");
  assert.equal(await store.runs.reseedLearning("run-r", learning, claim.epoch), false, "the old epoch writes nothing");
  assert.equal(await store.runs.reseedLearning("run-r", learning, again.epoch), true);
  const written = (await store.runs.launch("run-r")).body;
  assert.deepEqual([written.learning, written.place, written.input], [learning, body.place, body.input]);
});
