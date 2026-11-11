// A CLI's own client that issues a call again under the SAME call id once the run's record already holds that call's end
// (as a CLI re-issues an unparked call after its native resume) is answered from that end: the host's tool is never run
// a second time. Here the CLI is a scripted stand-in that calls its tool through the host twice under one call id.
// The claim's lease is longer than the run can take, so the first case is one claim whatever the machine's load (a
// 600 ms lease lapsed mid-call on a loaded CI runner). A claim that does lapse mid-call is the second case, made
// deterministic by moving the store's clock past the lease while the call runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 10_000, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in whose one turn calls `tool` under call id "call-1", then again under the same id; what each call
 *  answered is kept in `answers`. */
function sameCallTwice(tool, answers) {
  return {
    id: "stand-in-cli",
    capabilities: () => ({}),
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            const host = spec.tools.find((each) => each.name === tool);
            for (let i = 0; i < 2; i++) {
              const call = { callId: "call-1", tool, args: { line: "once" } };
              const answer = io.gate ? await io.gate(call) : "allow";
              if (answer !== "allow") throw new Error("not allowed");
              io.onEvent({ type: "tool_start", callId: call.callId, name: tool, args: call.args });
              const result = await host.call(call.args, { callId: call.callId, signal: io.signal });
              answers.push(result);
              io.onEvent({ type: "tool_end", callId: call.callId, name: tool, isError: Boolean(result.isError), result: result.text });
            }
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

/** One run of the stand-in on a runner; `during(sent)`: what the write does once it has sent, before it answers. Its
 *  end row, every call the tool was sent, what each issue answered, and the call's start and end on the record. */
async function sameCallRun(t, during = async () => {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const sent = [];
  const answers = [];
  const write = { name: "mcp__fake__write", description: "Write a line.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { sent.push(args); await during(opened, sent); return { text: `wrote ${args.line}` }; } };
  const createLoop = createAdapterLoop(() => ({
    adapter: sameCallTwice("mcp__fake__write", answers),
    session: { key: "root", label: "root", system: [], tools: [write], context: "fresh" },
    input: "Write it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks: quiet,
    gate: () => "allow",
  }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended and released", 20_000);
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const of = (kind) => entries.filter((entry) => entry.kind === kind && entry.data?.callId === "call-1").map((entry) => entry.data);
  return { row, sent, answers: answers.map((answer) => [answer.text, Boolean(answer.isError)]), starts: of("agentrun.call.start"), ends: of("agentrun.call.end") };
}

test("a CLI call issued again under a call id whose end the record holds is answered from that end, and never sent again", async (t) => {
  const { sent, answers, starts, ends } = await sameCallRun(t);
  assert.deepEqual(sent, [{ line: "once" }], "sent once");
  assert.deepEqual(answers, [["wrote once", false], ["wrote once", false]], "the second answered from the first's end");
  assert.deepEqual([starts.length, ends.map((end) => end.status)], [1, ["done"]], "one start, one end on the record");
});

// The claim lapses while the call runs: its end is never committed (the lost claim's write is fenced), so the next claim
// ends the cut call interrupted, and the CLI's issues of that id are answered from that end. The write may have taken
// effect, so it is never sent again, and the model is told so.
test("a call whose claim lapses while it runs is ended interrupted by the next claim, and the CLI's issues of its id are answered from that end, never sent again", async (t) => {
  const { sent, answers, starts, ends } = await sameCallRun(t, async (opened, sent) => {
    if (sent.length !== 1) return;
    opened.clock.skewMs += 2 * TIMING.leaseMs;
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  assert.deepEqual(sent, [{ line: "once" }], "sent once, never again after the lapse");
  assert.ok(answers.length >= 2 && answers.every(([text, isError]) => isError && /^interrupted: .*may or may not have taken effect/.test(text)), `each issue on the next claim answered interrupted: ${JSON.stringify(answers)}`);
  assert.deepEqual([starts.length, ends.map((end) => end.status)], [1, ["interrupted"]], "one start, ended interrupted once on the record");
});
