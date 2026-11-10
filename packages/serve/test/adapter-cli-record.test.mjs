// A CLI harness through the adapter loop keeps the run's visible record the way the kernel reads every harness's: the
// loop writes the person's input, each call's start (after the gate allowed it, before the call runs) and its end, and
// what the model said, as journal entries the one reader reads (runner/journal-reader.ts). A call a crash or a fault
// left with a start and no end is ended interrupted when the session opens again. Here the CLI is a scripted stand-in
// that calls its tools through the host's gate, as every CLI adapter's tool bridge does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observed, queue, recorder, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { callsOf, journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
/** A lease no stall of a loaded machine outlasts: no case here is about the lease. On a short one (600 ms) a stall of the
 *  box while the call ran let the claim lapse unrenewed, the runner took the run back, and the reopened session ended the
 *  cut call interrupted, never done. */
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in: each turn says "Looking.", calls `tool` through the gate, then says what the tool answered. Like a
 *  CLI it keeps its own resume log (a record that its turn was sent): a session opened again after a fault finds the
 *  turn done, as a CLI that answered its cut-off call "interrupted" does, and sends nothing again. */
function standInCli(tool) {
  return {
    id: "stand-in-cli",
    capabilities: () => ({}),
    check: () => [],
    async open(spec, io) {
      let state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        // `state` stays as open found it (the contract's SessionState), as a CLI adapter's does: a turn in flight is
        // known by turnEnd(), never by reading state after send().
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          // As the Claude Agent adapter does: idle from the moment its turn is sent.
          state = "idle";
          turn = (async () => {
            io.onEvent({ type: "text", delta: "Looking." });
            const call = { callId: "call-1", tool, args: { q: "x" } };
            const answer = io.gate ? await io.gate(call) : "allow";
            if (answer !== "allow") throw new Error("not allowed");
            io.onEvent({ type: "tool_start", callId: call.callId, name: tool, args: call.args });
            const host = spec.tools.find((each) => each.name === tool);
            const result = await host.call(call.args, { callId: call.callId, signal: io.signal });
            io.onEvent({ type: "tool_end", callId: call.callId, name: tool, isError: Boolean(result.isError), result: result.text });
            io.onEvent({ type: "text", delta: `It said ${result.text}.` });
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

test("a CLI run's record: the person's input, the call's start and end around it, and what the model said", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { ran.push(args); return { text: "found" }; } };
  const createLoop = createAdapterLoop(() => ({
    adapter: standInCli("lookup"),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks: quiet,
    gate: () => "allow",
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended and released", 5_000);
  assert.deepEqual(ran, [{ q: "x" }]);
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const calls = callsOf(records);
  assert.deepEqual(calls.map((call) => [call.callId, call.tool, call.status, call.replaySafe]), [["call-1", "lookup", "done", false]]);
  const messages = messagesOf(records);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["person", "Find it."], ["model", "Looking."], ["model", "It said found."]]);
  assert.ok(messages[1].entry < calls[0].startEntry && calls[0].endEntry < messages[2].entry, "in the order they happened");
});

test("a call a fault cut off after it ran ends interrupted when the session opens again, and never runs twice", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { ran.push(args); return { text: "found" }; } };
  let faults = 0;
  const hooks = { beforeIntent: async () => {}, beforeResult: async () => { if (faults++ === 0) throw new Error("a fault after the call ran"); } };
  const createLoop = createAdapterLoop(() => ({
    adapter: standInCli("lookup"),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks,
    gate: () => "allow",
  }), { restartLimit: 3 });
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run ended and released", 10_000);
  assert.equal(row.state, "ended");
  assert.deepEqual(ran, [{ q: "x" }], "ran once");
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  assert.deepEqual(callsOf(records).map((call) => [call.callId, call.status]), [["call-1", "interrupted"]]);
});

test("a pi-style run (the adapter keeps its own record) gets no call or message entries from the loop", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "safe", call: async () => ({ text: "found" }) };
  const createLoop = createAdapterLoop(() => ({
    adapter: standInCli("lookup"),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended and released", 5_000);
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  assert.deepEqual(callsOf(records), []);
  assert.deepEqual(messagesOf(records), []);
});
