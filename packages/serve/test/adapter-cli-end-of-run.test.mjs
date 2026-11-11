// The end-of-run turn of a CLI run (the loop keeps its record, record: "loop"): its answer is read the way pi's is, from
// the submission its request id names (submissionByRequest, then the answer entry's model text), so the step gets the
// answer (never "unanswered"); and what the model said in that turn is never on the run's visible record as a model
// message, nor is the step's prompt as the person's. A later claim that asks again is answered from that submission, and
// its CLI is not asked twice. An answer the parser refuses is asked for again once, in the same session (the runner's
// reflect hook, as on pi), and the second answer is the one checked. Here the CLI is a scripted stand-in: it answers the
// run's input with the job's answer and any other turn with its next scripted reply, else a note.
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

/** A CLI stand-in whose turns say one thing each: the job's answer to the input, the next of `replies` to anything else
 *  (a note once they run out). */
function standInCli(turns, replies = []) {
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
          const say = text === INPUT ? "the job's answer" : (replies.shift() ?? "a note");
          turn = (async () => {
            io.onEvent({ type: "text", delta: say });
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

/** The adapter loop over the stand-in (`replies`: its scripted end-of-run answers), the run's agent named, the end-of-run
 *  step `endOfRun` in its deps. */
function loopWith(turns, endOfRun, replies = []) {
  const inner = createAdapterLoop(() => ({
    adapter: standInCli(turns, replies),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: INPUT,
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
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

test("an unparsed answer is asked again once: the runner's reflect hook on a CLI run re-asks in the same session, says why, and proposes the second answer", async (t) => {
  const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
  const { parseReflection } = await import("../dist/learn/index.js");
  const skill = (fence) => `${fence}skill find-policies\n---\nname: find-policies\ndescription: Find a store's refund policy\n---\n# Find policies\n\nOpen /policies/ first.\n${fence}`;
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const turns = [];
  const hook = createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: [INPUT] }),
    check: async ({ turn }) => {
      const parsed = parseReflection(turn.answer);
      if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
      return { state: "proposed", notes: parsed.notes.length, skills: parsed.skills?.length ?? 0, workflows: 0, proposal: { skills: parsed.skills } };
    },
    newRunId: () => "run-1-learning",
  });
  // The first answer opens its skill with three backticks (out of format), the second with four.
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop: loopWith(turns, hook, [skill("```"), skill("````")]), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await ended(opened.server);
  // The learning run it queued is claimed by the same runner, whenever it is: once it has ended, run-1's turns are still
  // only run-1's (#2343 review: it must never count in them).
  await until(async () => (await opened.server.runs.get("run-1-learning"))?.state === "ended", "the learning run ran too", 10_000);
  assert.equal(turns.length, 3,`the job, the end-of-run turn and its one re-ask: ${JSON.stringify(turns)}`);
  assert.match(turns[2], /^Your answer could not be read: a skill's block must open with four backticks/, "the re-ask says why, in the parser's words");
  const kept = await opened.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.skills, 1, "the skill is proposed");
  assert.equal(kept.turn.answer, skill("````"), "the turn kept is the second answer");
  assert.ok(await opened.server.runs.get("run-1-learning"), "one learning run queued");
});
