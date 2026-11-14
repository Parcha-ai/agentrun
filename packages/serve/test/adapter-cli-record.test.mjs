// A CLI harness through the adapter loop keeps the run's visible record the way the kernel reads every harness's: the
// loop writes the person's input, each call's start (after the gate allowed it, before the call runs) and its end, and
// what the model said, as journal entries the one reader reads (runner/journal-reader.ts). A call a crash or a fault
// left with a start and no end is ended interrupted when the session opens again. A call its gate refuses (a deny, or a
// person's deny of its ask once its turn resumes) is on the record too, as pi writes one: its start and its end refused in
// the gate's words, the words the model is handed. Here the CLI is a scripted stand-in
// that calls its tools through the host's gate, as every CLI adapter's tool bridge does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { callsOf, journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { deniedText } = await import("../dist/runner/loop-contract.js");
const { deniedText: setToDenyText, STOPPED_WHILE_WAITING } = await import("../dist/refusal-words.js");
/** A lease no stall of a loaded machine outlasts: no case here is about the lease. On a short one (600 ms) a stall of the
 *  box while the call ran let the claim lapse unrenewed, the runner took the run back, and the reopened session ended the
 *  cut call interrupted, never done. */
const STEADY = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in: each turn says "Looking.", calls `tool` through the gate, then says what the tool answered. Like a
 *  CLI it keeps its own resume log (a record that its turn was sent): a session opened again after a fault finds the
 *  turn done, as a CLI that answered its cut-off call "interrupted" does, and sends nothing again. */
function standInCli(tool) {
  return {
    id: "stand-in-cli",
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

test("a call's end whose commit the store could not answer, and that landed, is the call's one end: never a second, interrupted, written beside it (Unanswered is outcome unknown)", async (t) => {
  const { Unanswered } = await import("../dist/store/index.js");
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { ran.push(args); return { text: "found" }; } };
  const inner = createAdapterLoop(() => ({
    adapter: standInCli("lookup"),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks: quiet,
    gate: () => "allow",
  }));
  // The store's commit of the call's end lands, and its answer is lost: the connection went silent after the COMMIT was sent.
  let lost = 0;
  const endsDone = (batches) => batches.some((batch) => batch.some((write) => write.type === "entry" && write.value.kind === KINDS.callEnd && write.value.data.status === "done"));
  const createLoop = (deps) =>
    inner({
      ...deps,
      journal: (claim) =>
        new Proxy(deps.journal(claim), {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "commit") return typeof value === "function" ? value.bind(target) : value;
            return async (batches, receive, ...rest) => {
              if (endsDone(batches) && lost++ === 0) {
                // The write lands but `receive` (the callback a returned commit calls for each batch) is never called: a
                // real unanswered commit throws before it runs, so the loop gets no success signal.
                await value.call(target, batches, () => {}, ...rest);
                throw new Unanswered("its commit", 10_000);
              }
              return value.call(target, batches, receive, ...rest);
            };
          },
        }),
    });
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run ended and released", 10_000);
  assert.equal(lost, 1, "the end's answer was lost once");
  const records = await recordAt(opened.server, row);
  const ends = records.entries.filter((entry) => entry.kind === KINDS.callEnd && entry.data.callId === "call-1");
  assert.deepEqual(ends.map((entry) => entry.data.status), ["done"], "the call has the one end that landed");
  assert.deepEqual(ran, [{ q: "x" }], "ran once");
});

/** A CLI stand-in whose tool bridge hands the model a refused call's words as its error result, as every CLI adapter's
 *  bridge does (run-adapters' toolBridge): its turn calls `tool` as call-1 through the gate; a deny is the call's result,
 *  never run; a park holds the call until the session closes. Its resume log keeps that the turn was sent: a session opened
 *  again finds it open and recovers it, issuing call-1 again under its id, as a CLI resumes the turn its call parked. */
function refusingCli(tool, said) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "open_turn" : "new";
      let turn;
      const closing = new AbortController();
      const run = () => (async () => {
        const call = { callId: "call-1", tool, args: { q: "x" } };
        const answer = io.gate ? await io.gate(call) : "allow";
        if (answer !== "allow" && !("deny" in answer)) {
          await new Promise((resolve) => closing.signal.addEventListener("abort", resolve, { once: true }));
          return { status: "aborted" };
        }
        const result = answer === "allow" ? await spec.tools.find((each) => each.name === tool).call(call.args, { callId: call.callId, signal: io.signal }) : { text: answer.deny, isError: true };
        said.push(result);
        io.onEvent({ type: "text", delta: `It said ${result.text}` });
        io.onEvent({ type: "turn_end", status: "completed" });
        return { status: "completed" };
      })();
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = run();
        },
        async recover() {
          state = "idle";
          turn = run();
        },
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { closing.abort(); },
      };
    },
  };
}

/** The run's record as a reader reads it with the run at `row`. */
const recordAt = (server, row) => journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);

/** A CLI run of `refusingCli` on `tool`, its spec's gate `gate`: its row once it rests at `state`, its record and what the
 *  model was handed. `meanwhile(server, row)`: what the test does once the run parks at `row` (answers its ask), before it
 *  rests again. */
async function refusedRun(t, { gate, state = "ended", meanwhile }) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const said = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { ran.push(args); return { text: "found" }; } };
  const createLoop = createAdapterLoop(() => ({
    adapter: refusingCli("lookup", said),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find it.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks: quiet,
    gate,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const rested = (want) => until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === want && now.runner === null && now;
  }, `the run ${want} and released`, 10_000);
  if (meanwhile) await meanwhile(opened.server, await rested("parked"));
  const records = await recordAt(opened.server, await rested(state));
  return { ran, said, records };
}

/** The refused call's start and end as the record holds them: its call, its status and its output, in one commit's order. */
function refusedCall(records) {
  const ends = records.entries.filter((entry) => entry.kind === KINDS.callEnd);
  return { calls: callsOf(records).map((call) => [call.callId, call.tool, call.status]), outputs: ends.map((entry) => entry.data.output) };
}

for (const [how, decision, words] of [
  ["a deny set on its tool", "deny", setToDenyText("lookup")],
  ["a deny in the gate's own words (no one can approve its ask)", { deny: "Permission denied: lookup needs the owner's approval, and no one can give it." }, "Permission denied: lookup needs the owner's approval, and no one can give it."],
]) {
  test(`a CLI call its gate refuses, by ${how}, is on the record: its start and its end refused in the gate's words, which the model is handed, and it never runs (#2137)`, async (t) => {
    const { ran, said, records } = await refusedRun(t, { gate: () => decision });
    assert.deepEqual(ran, [], "never run");
    assert.deepEqual(said, [{ text: words, isError: true }], "the model is handed the refusal");
    assert.deepEqual(refusedCall(records), { calls: [["call-1", "lookup", "refused"]], outputs: [words] });
  });
}

test("a CLI call parked on its ask and denied with a note is on the record when its turn resumes: refused in the deny's words, never run (#2137)", async (t) => {
  const { ran, said, records } = await refusedRun(t, {
    gate: () => "ask",
    meanwhile: (server) => sendCommand(server, "run-1", { kind: "deny", body: { approval: "call-1", note: "not today" } }),
  });
  const words = deniedText("lookup", "not today");
  assert.deepEqual(ran, [], "never run");
  assert.deepEqual(said, [{ text: words, isError: true }], "the model is handed the deny");
  assert.deepEqual(refusedCall(records), { calls: [["call-1", "lookup", "refused"]], outputs: [words] });
});

/** The call starts on the record, in order: each one's call id and whether it was written parked. */
const startsOf = (records) => records.entries.filter((entry) => entry.kind === KINDS.callStart).map((entry) => [entry.data.callId, entry.data.parked === true]);

test("a CLI call parked on its ask is on the record while it waits, its start marked parked; the allow runs it once under that one start (#2371)", async (t) => {
  let waiting;
  const { ran, said, records } = await refusedRun(t, {
    gate: () => "ask",
    meanwhile: async (server, row) => {
      waiting = await recordAt(server, row);
      await sendCommand(server, "run-1", { kind: "approve", body: { approval: "call-1" } });
    },
  });
  assert.deepEqual(callsOf(waiting).map((call) => [call.callId, call.tool, call.status]), [["call-1", "lookup", "pending"]], "the parked call shows while it waits");
  assert.deepEqual(startsOf(waiting), [["call-1", true]], "its start, marked parked");
  assert.ok(callsOf(waiting)[0]?.startEntry < Number(waiting.entries.find((entry) => entry.kind === KINDS.ask).id), "the call's start reads before its ask");
  assert.deepEqual(ran, [{ q: "x" }], "run once, once allowed");
  assert.deepEqual(said.map((result) => result.text), ["found"], "the model is handed its result");
  assert.deepEqual(callsOf(records).map((call) => [call.callId, call.tool, call.status]), [["call-1", "lookup", "done"]]);
  assert.deepEqual(startsOf(records), [["call-1", true]], "one start for the call: the one written while it waited");
});

test("a CLI call parked on its ask that a stop withdraws reads not run on the record and never runs (#2371)", async (t) => {
  const { ran, said, records } = await refusedRun(t, { gate: () => "ask", state: "stopped", meanwhile: (server) => sendCommand(server, "run-1", { kind: "stop" }) });
  assert.deepEqual([ran, said], [[], []], "never run, nothing handed to the model");
  assert.deepEqual(refusedCall(records), { calls: [["call-1", "lookup", "refused"]], outputs: [STOPPED_WHILE_WAITING] });
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

/** A CLI stand-in whose one answer asks for two calls at once (both started before either ends, as Codex and Claude Code
 *  run parallel calls), then answers once both are back. */
function twoCallCli(tool, closes = { count: 0 }) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            io.onEvent({ type: "text", delta: "Looking twice." });
            const calls = [{ callId: "call-1", tool, args: { q: "a" } }, { callId: "call-2", tool, args: { q: "b" } }];
            for (const call of calls) {
              if ((io.gate ? await io.gate(call) : "allow") !== "allow") throw new Error("not allowed");
              io.onEvent({ type: "tool_start", callId: call.callId, name: tool, args: call.args });
            }
            const host = spec.tools.find((each) => each.name === tool);
            const results = await Promise.all(calls.map((call) => host.call(call.args, { callId: call.callId, signal: io.signal })));
            calls.forEach((call, index) => io.onEvent({ type: "tool_end", callId: call.callId, name: tool, isError: false, result: results[index].text }));
            io.onEvent({ type: "text", delta: "Both found." });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { closes.count += 1; },
      };
    },
  };
}

// Ported from harness-multi-tool.test.mjs (deleted at the cutover, its read-back the run's own database): on a harness
// other than pi, two tool calls in one answer, then the closing answer. The run completes; each call is recorded once,
// done, never interrupted; and the timeline shows each call once, above its own result.
test("a CLI run whose one answer asks for two calls at once: the run completes, each call is recorded and shown once, done, above its result", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async (args) => { ran.push(args.q); return { text: `found ${args.q}` }; } };
  const closes = { count: 0 };
  const createLoop = createAdapterLoop(() => ({
    adapter: twoCallCli("lookup", closes),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Find both.",
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
  assert.deepEqual(ran.sort(), ["a", "b"], "each call ran once");
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  assert.deepEqual(callsOf(records).map((call) => [call.callId, call.status]), [["call-1", "done"], ["call-2", "done"]], "each call recorded once, done");
  const rows = await runTimeline(opened.server, "run-1", BACKGROUND_CONTEXT, { settled: true });
  const shown = (kind) => rows.filter((r) => r.kind === kind);
  const callRows = shown("tool_use");
  assert.deepEqual(callRows.map((r) => r.tool_use_id).sort(), ["call-1", "call-2"], `each call shown once: ${JSON.stringify(rows.map((r) => [r.kind, r.id, r.tool_use_id]))}`);
  const resultRows = shown("tool_result");
  assert.deepEqual(resultRows.map((r) => r.tool_use_id).sort(), ["call-1", "call-2"], "each result shown once");
  for (const call of callRows) {
    const result = resultRows.find((r) => r.tool_use_id === call.tool_use_id);
    assert.ok(rows.indexOf(call) < rows.indexOf(result), `call ${call.tool_use_id} above its result`);
    assert.notEqual(result.tool_status, "interrupted", `call ${call.tool_use_id} not interrupted`);
  }
  assert.deepEqual(messagesOf(records).map((message) => [message.role, message.text]), [["person", "Find both."], ["model", "Looking twice."], ["model", "Both found."]]);
  // Ported from harness-close.test.mjs: the harness's session is closed once its run is let go, so none of the CLI's own
  // processes outlives the claim.
  assert.equal(closes.count, 1, "the CLI session closed once at the run's release");
});
