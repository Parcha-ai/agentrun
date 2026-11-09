// A runner that loses its claim writes a takeover note on the run's root conversation (RUN_RESUMED, `after: runner_lost`,
// app.ts / adapter-loop.ts) so the run's timeline says it went on. That note joins the run's record — the live view's
// snapshot carries it and the timeline renders its "Resumed after its runner was lost" phase row — but it is NOT a live
// stream event: a takeover ends the door's watch, so a reader meets the note only in a reconnect's snapshot, never as a
// commit on the open stream. The live view polls across a takeover, so without the fix it streamed the note's
// entry_appended — one event the door never delivers and the parity door (a bare harness, never taken over) never has.
// Under machine load the runner's lease ran out, the run was resumed, and the note landed right after the system message,
// so the parity tests saw an intermittent entry_appended there.
//
// The fix (live/stream.ts): watchRun drops the resume note from the events it delivers, while translate still appends it
// to the state the snapshot reads. Driven over a store whose reads are stepped by hand (no clock, no sleep): the same
// journal with and without the resume commit streams the same events, however the polls fall, and the snapshot still keeps
// the note. Red before the fix (the resume adds entry_appended), green after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, shape } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");
const { RUN_RESUMED } = await import("@parcha/pi-durable-agent/timeline");

const RUN = "run-1";
const ROOT = 1;

/** The entries, tasks and submissions of a one-input run as stored commits, each its own seq. `resumed`: a runner-lost
 *  takeover note on the root, right after the system message, as a run taken over mid-turn has. */
function journal({ resumed }) {
  const model = (role, content) => [{ role, content }];
  const commits = [
    { entries: [{ kind: "pi.user", id: 10, conversationId: ROOT, model: model("user", "hi") }],
      submissions: [{ type: "input", id: 11, conversationId: ROOT, status: "placed", requestId: "agentrun:input" }],
      tasks: [{ kind: "pi.generation", id: 12, conversationId: ROOT, state: { status: "pending" } }], documents: [] },
    { entries: [{ kind: "pi.system", id: 13, conversationId: ROOT, model: model("system", "you are a test") }],
      submissions: [], tasks: [], documents: [] },
    ...(resumed
      ? [{ entries: [{ kind: RUN_RESUMED, id: 14, conversationId: ROOT, data: { after: "runner_lost", runner: "runner-a", at: 1 } }],
          submissions: [], tasks: [], documents: [] }]
      : []),
    { entries: [{ kind: "pi.assistant", id: 15, conversationId: ROOT, model: model("assistant", [{ type: "text", text: "done" }]) }],
      submissions: [{ type: "input", id: 11, conversationId: ROOT, status: "done", requestId: "agentrun:input" }],
      tasks: [{ kind: "pi.generation", id: 12, conversationId: ROOT, state: { status: "terminal" } }], documents: [] },
  ];
  return commits.map((commit, index) => ({ seq: index + 1, ...commit }));
}

/** A LiveStore whose journal reveals its commits as the live view asks for them, `perPoll` at a time: a poll that reads
 *  `commitsAfter` sees only what has been revealed, so the resume commit can land on its own poll (the worst interleaving).
 *  `open()` starts revealing — the stream's opening snapshot (before start) folds only what is already revealed, so by
 *  default nothing is until then. `prevealed`: every commit is revealed from the start, so the opening snapshot folds the
 *  whole run (a reader that connects after a takeover). The row reads final once every commit is revealed. */
function steppedStore(commits, perPoll, prevealed = false) {
  let revealed = prevealed ? commits.length : 0;
  let opened = prevealed;
  const final = () => opened && revealed >= commits.length;
  const jrnl = {
    async commitsAfter(after) {
      if (opened && !prevealed) revealed = Math.min(commits.length, revealed + perPoll);
      const items = commits.slice(0, revealed).filter((commit) => commit.seq > after);
      return { commits: items };
    },
    async close() {},
  };
  const store = {
    runs: { get: async () => ({ id: RUN, epoch: 1, state: final() ? "ended" : "running", runner: "runner-a" }) },
    journal: () => jrnl,
    live: { read: async () => [undefined] },
  };
  return { store, open: () => void (opened = true) };
}

/** The events the live view streams for `commits`, revealing `perPoll` commits per poll. */
async function streamOf(t, commits, perPoll) {
  const { store, open } = steppedStore(commits, perPoll);
  const stream = await watchRun(store, RUN, { pollMs: 1 });
  t.after(() => stream.stop());
  const got = collect(stream);
  open();
  await stream.closed;
  return got.events();
}

/** The opening snapshot of a reader that connects after the whole run (the resume included) is already stored. */
async function snapshotOf(t, commits) {
  const { store } = steppedStore(commits, 99, true);
  const stream = await watchRun(store, RUN, { pollMs: 1 });
  t.after(() => stream.stop());
  return stream.snapshot;
}

test("a runner-lost resume note is not an event: the live stream is the same with and without it", async (t) => {
  const plain = shape(await streamOf(t, journal({ resumed: false }), 99));
  // The resume commit on its own poll (perPoll 1): the worst interleaving for a poll landing between the two writes.
  const withResume = shape(await streamOf(t, journal({ resumed: true }), 1));
  assert.equal(withResume.includes("entry_appended"), false, `a resume note must not stream as entry_appended: ${JSON.stringify(withResume)}`);
  assert.deepEqual(withResume, plain, "a takeover changes nothing a client sees");
});

test("the resume note streams the same however the polls fall", async (t) => {
  // All commits at once, versus one per poll: per-commit translation makes the output the same, resume note suppressed.
  const atOnce = shape(await streamOf(t, journal({ resumed: true }), 99));
  const stepped = shape(await streamOf(t, journal({ resumed: true }), 1));
  assert.deepEqual(stepped, atOnce, "poll timing does not change the stream");
  assert.equal(atOnce.includes("entry_appended"), false, "and never an entry_appended for the resume");
});

test("a whole run with a resume note inside one poll: run_start then run_end, each once, no resume event", async (t) => {
  // The one-poll interleaving (live-run-within-a-tick): the run starts, is taken over, and ends, all between two reads of
  // the store (perPoll 99, so the first poll after it opens drains every commit at once). The resume note must not add an
  // event, and run_start/run_end stay one each — the same stream a run never taken over gives.
  const events = await streamOf(t, journal({ resumed: true }), 99);
  const types = events.map((event) => event.type);
  assert.equal(types.filter((type) => type === "run_start").length, 1, `one run_start: ${JSON.stringify(types)}`);
  assert.equal(types.filter((type) => type === "run_end").length, 1, `one run_end: ${JSON.stringify(types)}`);
  assert.ok(types.indexOf("run_start") < types.indexOf("run_end"), "run_start first");
  assert.equal(types.includes("entry_appended"), false, "no entry_appended for the resume");
  assert.deepEqual(shape(events), shape(await streamOf(t, journal({ resumed: false }), 99)), "the stream of a run never taken over");
});

test("the resume note stays in the snapshot: a reader that connects after the takeover still sees it", async (t) => {
  // Dropped from the live stream, the note is still the run's record: translate keeps it in the state the snapshot reads,
  // so a reader connecting after the takeover (and the timeline built from that snapshot) shows the resume phase.
  const snapshot = await snapshotOf(t, journal({ resumed: true }));
  const kinds = (snapshot.entries ?? []).map((entry) => entry.kind);
  assert.ok(kinds.includes(RUN_RESUMED), `the snapshot keeps the resume note: ${JSON.stringify(kinds)}`);
});
