// The end-of-run turn of a CLI run (the loop keeps its record, record: "loop"): its answer is read the way pi's is, from
// the submission its request id names (submissionByRequest, then the answer entry's model text), so the step gets the
// answer (never "unanswered"); and what the model said in that turn is never on the run's visible record as a model
// message, nor is the step's prompt as the person's. A later claim that asks again is answered from that submission, and
// its CLI is not asked twice. Here the CLI is a scripted stand-in: it answers the run's input with the job's answer and
// any other turn with a note.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observed, queue, recorder, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const INPUT = "Find it.";

/** A CLI stand-in whose turns say one thing each: the job's answer to the input, a note to anything else. */
function standInCli(turns) {
  return {
    id: "stand-in-cli",
    capabilities: () => ({}),
    check: () => [],
    async open(_spec, io) {
      const state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        async send(text) {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          turns.push(text);
          turn = (async () => {
            io.onEvent({ type: "text", delta: text === INPUT ? "the job's answer" : "a note" });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

/** The adapter loop over the stand-in, the run's agent named, the end-of-run step `endOfRun` in its deps. */
function loopWith(turns, endOfRun) {
  const inner = createAdapterLoop(() => ({
    adapter: standInCli(turns),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: INPUT,
    record: "loop",
    agentId: "agent-1",
    hooks: quiet,
  }));
  return (deps) => inner({ ...deps, endOfRun });
}

const ended = (server) =>
  until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended and released", 10_000);

test("a CLI run's end-of-run answer is read from its submission, and is not on the run's record as a message", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const turns = [];
  const answers = [];
  const endOfRun = async (input) => {
    answers.push(await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 5_000 }));
    return undefined;
  };
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop: loopWith(turns, endOfRun), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await ended(opened.server);
  assert.deepEqual(answers, [{ ended: true, answer: "a note" }], "the step read the turn's answer");
  assert.deepEqual(turns, [INPUT, "What did you learn?"]);
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  assert.deepEqual(messagesOf(records).map((message) => [message.role, message.text]), [["person", INPUT], ["model", "the job's answer"]], "neither the step's prompt nor its answer is shown");
});

test("asked again for a run whose end-of-run turn already answered, the step is answered from its submission; the CLI is not asked twice", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const turns = [];
  const answers = [];
  const endOfRun = async (input) => {
    answers.push(await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 5_000 }));
    // Asked once more within the same claim (as a later claim would, after a lost one): its answer stands.
    answers.push(await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 5_000 }));
    return undefined;
  };
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop: loopWith(turns, endOfRun), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await ended(opened.server);
  assert.deepEqual(answers, [{ ended: true, answer: "a note" }, { ended: true, answer: "a note" }]);
  assert.deepEqual(turns, [INPUT, "What did you learn?"], "the CLI was asked once");
});
