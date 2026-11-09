// A claim that started a turn waits for that turn's end. A session's state is the session as open found it (the
// adapter contract's SessionState), and a CLI adapter reads idle from the moment it sends its turn (the Claude Agent,
// Codex and OpenCode adapters do): the adapter loop must not take that for "no turn" and end the run before the model's
// first call. Here the session is a stand-in that reads idle once its turn is sent, and whose turn makes its call only
// once the loop waits for the turn's end (turnEnd()): a loop that never waits ends the run with the call never made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
// One runner that never loses its claim: a lease no stall of a loaded machine runs out (a claim lost to a stall would be
// retaken, and the run read back would be the takeover's).
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A session that reads idle as soon as its turn is sent, as the CLI adapters do. Its turn calls `tool` once, when the
 *  loop first waits for the turn's end. */
function idleOnSend(tool) {
  return {
    id: "idle-on-send",
    capabilities: () => ({}),
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let release;
      const waited = new Promise((resolve) => (release = resolve));
      let turn;
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            await waited;
            await spec.tools.find((each) => each.name === tool).call({}, { callId: "call-1", signal: io.signal });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: () => {
          release();
          return turn;
        },
        async interrupt() {},
        async close() {},
      };
    },
  };
}

test("a session that reads idle once its turn is sent: the run waits for the turn, and ends only after its call", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "safe", call: async () => { ran.push("lookup"); return { text: "found" }; } };
  const createLoop = createAdapterLoop(() => ({
    adapter: idleOnSend("lookup"),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return !["queued", "running"].includes(now.state) && now.runner === null && now;
  }, "the run settled", 5_000);
  assert.equal(row.state, "ended");
  assert.deepEqual(ran, ["lookup"], "the turn's call ran before the run ended");
});
