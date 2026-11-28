// pi through the adapter loop: a shutdown's stop holds the claim's journal open past its seal only until the run's tool
// hosts' release has run, or the close's window ends (LoopDeps.releaseBy), whichever comes first (adapter-loop
// holdForRelease). After that the seal refuses as it did before the hold: a commit the run makes then never lands. The
// run's one tool call ignores its abort, so its result is written late: once the close's window has ended, or once the
// release (the spec has no beforeRelease hooks: it returns at once) is done and the session is closing.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
after(closeOpenSessions);

const RUN = "run-1";
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** What the late tool call answers, once the test lets it go. */
const LATE = "the late answer";

/** The run's journal records, read as the server reads them. */
async function recordsOf(server) {
  const row = await server.runs.get(RUN);
  return journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
}

for (const [label, window] of [["the close's window ends first", true], ["the release (no beforeRelease hooks) returns first", false]]) {
  test(`pi: a shutdown's hold on the journal ends when ${label}: a commit the run makes after it is refused, as without the hold`, { timeout: 60_000 }, async (t) => {
    const opened = await stores({ runners: 1 });
    await queue(opened.server, RUN);
    let started = () => {};
    const running = new Promise((resolve) => (started = resolve));
    let letGo = () => {};
    const held = new Promise((resolve) => (letGo = resolve));
    t.after(() => letGo());
    // Ignores its abort: only the test lets it go.
    const tools = { stubborn: { name: "stubborn", replaySafe: true, ask: false, run: async () => (started(), await held, LATE) } };
    const spec = piAdapterSpec({ script: [{ call: "stubborn" }, { say: "done" }], tools, hooks: quiet });
    let closing = () => {};
    const sessionClosing = new Promise((resolve) => (closing = resolve));
    // The session's close is the step after the release: seen, so the late answer comes after the release has returned.
    const createAdapter = createAdapterLoop(async (claim, run) => {
      const made = await spec(claim, run);
      return {
        ...made,
        adapter: {
          ...made.adapter,
          open: async (session, io) => {
            const opened = await made.adapter.open(session, io);
            const close = opened.close.bind(opened);
            opened.close = async () => {
              closing();
              await close();
            };
            return opened;
          },
        },
      };
    });
    // The close's window, when this case sets it: a short one, from the stop.
    let by;
    const createLoop = (deps) => createAdapter(new Proxy(deps, { get: (target, key) => (key === "releaseBy" && by !== undefined ? () => by : Reflect.get(target, key, target)) }));
    const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
    t.after(() => runner.close().catch(() => {}));
    await running;

    if (window) by = Date.now() + 300;
    const closed = runner.close();
    if (window) await until(() => Date.now() >= by + 200, "the close's window ended", 5_000);
    else await sessionClosing;
    letGo();
    await closed;

    const records = await recordsOf(opened.server);
    // The call's task stays as the stop found it, running: its end, committed once the call answered, was refused.
    const calls = records.tasks.filter((task) => task.kind === "pi.tool");
    assert.deepEqual(calls.map((task) => task.state.status), ["running"], `the late call's end never landed: ${JSON.stringify(calls)}`);
    const late = [...records.entries, ...records.tasks].filter((record) => JSON.stringify(record).includes(LATE));
    assert.deepEqual(late, [], "nor its answer");
    assert.equal(records.entries.filter((entry) => entry.kind === "pi.assistant").length, 1, "the run's journal holds the call's request, and no more");
  });
}
