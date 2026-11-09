// A runner that loses its claim writes a takeover note on the run's root conversation (RUN_RESUMED, `after: runner_lost`,
// app.ts / adapter-loop.ts) so the run's timeline says it went on. That note is a kernel record, not run content: the
// door's GET /events (a bare harness that is never taken over) never has it, and a client watching the live view must see
// the same envelopes whether or not a takeover happened. The bug: translate reads RUN_RESUMED as a kernel record to open
// the stream (its root and `started`), but the KERNEL skip set is `Object.values(KINDS)` only, and RUN_RESUMED lives in
// the timeline, not KINDS, so the resume entry — which carries no model — fell through to `entry_appended`, one extra event
// the door never sends. Under machine load the runner's lease ran out, the run was resumed, and the note landed right after
// the system message, so the parity tests saw an intermittent entry_appended there.
//
// Driven over a store whose reads are stepped by hand (no clock, no sleep): the same journal with and without the resume
// commit must stream the same events, however the polls fall. Red before the fix (the resume adds entry_appended), green
// after.
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
 *  `open()` starts revealing — the stream's opening snapshot (before start) must fold no commit, so nothing is revealed
 *  until then. The row reads final once every commit is revealed, so the stream ends on its own. */
function steppedStore(commits, perPoll) {
  let revealed = 0;
  let opened = false;
  const final = () => opened && revealed >= commits.length;
  const live = {
    read: async () => [undefined],
  };
  const jrnl = {
    async commitsAfter(after) {
      if (opened) revealed = Math.min(commits.length, revealed + perPoll);
      const items = commits.slice(0, revealed).filter((commit) => commit.seq > after);
      return { commits: items };
    },
    async close() {},
  };
  const store = {
    runs: { get: async () => ({ id: RUN, epoch: 1, state: final() ? "ended" : "running", runner: "runner-a" }) },
    journal: () => jrnl,
    live,
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
