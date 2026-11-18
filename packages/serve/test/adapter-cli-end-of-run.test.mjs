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
 *  step `endOfRun` in its deps. Only run-1's turns are `turns` and only it takes `replies`: a learning run its end queues,
 *  which the same runner claims whenever it does, talks to a stand-in of its own. */
function loopWith(turns, endOfRun, replies = []) {
  const inner = createAdapterLoop((claim) => ({
    adapter: claim.runId === "run-1" ? standInCli(turns, replies) : standInCli([]),
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

test("a draft the checks refuse is asked again in the same session: the runner's reflect hook on a CLI run says why, and commits the second draft", async (t) => {
  const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
  const flow = JSON.stringify({ v: 2, name: "find-policies", schemas: {}, root: { node: "chain", steps: [] } });
  const block = `\`\`\`\`workflow find-policies\n---\ndescription: Find a store's refund policy\n---\n${flow}\n\`\`\`\``;
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const turns = [];
  const checks = [{ errors: ["workflows/find-policies/workflow.json: its dry run failed"] }];
  const committed = [];
  const hook = createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0 }),
    feedback: async () => [],
    correctionRefused: async () => [],
    compileFacts: async () => ({ mode: "new", reference: "REF", traces: [], tools: [], judges: false }),
    checkDraft: async ({ draft }) => checks.shift() ?? { errors: [], kept: { name: draft.name, files: [{ path: "workflows/find-policies/workflow.json", text: flow }] }, digest: "d1" },
    commit: async (input) => (committed.push(input), { ok: true, commit: "c1" }),
  });
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop: loopWith(turns, hook, [block, block]), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await ended(opened.server);
  assert.equal(turns.length, 3, `the job, the compile turn and its one re-ask: ${JSON.stringify(turns)}`);
  assert.match(turns[1], /^One more turn: write this agent's job as a learned workflow\./);
  assert.match(turns[2], /^Your workflow draft did not pass the checks \(attempt 2 of 4\)/, "the re-ask says why, in the checks' words");
  assert.match(turns[2], /its dry run failed/);
  const kept = await opened.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.compiled.attempts.map((attempt) => attempt.ok), [false, true]);
  assert.deepEqual(committed.map(({ draft }) => draft?.name), ["find-policies"], "the second draft is committed, once");
});

/** A CLI stand-in whose session survives its runner: what it was sent and what it finished are in the session's own
 *  records, so a process opened after a crash finds the turn it was in (open_turn); recover() resumes that turn and
 *  settleOpenTurn() closes it unanswered. A turn `hold` says yes to never ends (its runner is killed under it). */
function durableCli(log, hold) {
  return {
    id: "stand-in-cli",
    capabilities: () => ({}),
    check: () => [],
    async open(_spec, io) {
      const records = await io.writer.read();
      const sent = records.filter((record) => record.kind === "stand-in.sent");
      const done = records.filter((record) => record.kind === "stand-in.done").length;
      let state = sent.length === 0 ? "new" : sent.length > done ? "open_turn" : "idle";
      const cut = sent.at(-1)?.data?.text;
      let turn;
      const answer = (text) => {
        const say = text === INPUT ? "the job's answer" : /graded/.test(text) ? "the round's note" : "a note";
        turn = (async () => {
          await io.writer.append([{ kind: "stand-in.done", data: null }]);
          io.onEvent({ type: "text", delta: say });
          io.onEvent({ type: "turn_end", status: "completed" });
          return { status: "completed" };
        })();
      };
      return {
        get state() { return state; },
        async send(text) {
          await io.writer.append([{ kind: "stand-in.sent", data: { text } }]);
          log.sent.push(text);
          state = "idle";
          if (hold(text)) turn = new Promise(() => {});
          else answer(text);
        },
        async recover() {
          log.recovered.push(cut);
          state = "idle";
          answer(cut);
        },
        async settleOpenTurn() {
          log.settled.push(cut);
          state = "idle";
        },
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

test("a CLI feedback round whose runner died mid end-of-run turn: the next claim settles that turn, never recovers it as the job's, and asks it again once (#2668)", async (t) => {
  const opened = await stores({ runners: 2 });
  await queue(opened.server, "run-1");
  const log = { sent: [], recovered: [], settled: [] };
  let held = 0;
  const hold = (text) => /graded/.test(text) && held++ === 0;
  let round = 1;
  const answers = [];
  const endOfRun = async (input) => {
    answers.push(await input.ask("What did you learn?", { origin: "reflect", deadlineMs: 5_000, round }));
    return undefined;
  };
  const loop = createAdapterLoop((claim) => ({
    adapter: claim.runId === "run-1" ? durableCli(log, hold) : standInCli([]),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: INPUT,
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    agentId: "agent-1",
    hooks: quiet,
  }));
  const createLoop = (deps) => loop({ ...deps, endOfRun });
  const first = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  let second;
  t.after(async () => {
    first.kill();
    await second?.close();
  });
  const once = await ended(opened.server);
  // A grade's correction round: the run opens again on its words, and the claim goes to its end-of-run step alone.
  round = 2;
  await opened.server.runs.reopen("run-1", { kind: "steer", body: { text: "Wrong: the answer is 41.", feedback: { round: "correction", correct: false } } });
  await until(async () => log.sent.some((text) => /graded/.test(text)), "the round's end-of-run turn was sent", 10_000);
  first.kill();
  // The first claim's lease runs out for the next runner at once.
  opened.clock.skewMs += 60_000;
  second = startRunner({ store: opened.runners[1], createLoop, name: "runner-b", ...TIMING });
  await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now.endedAt > once.endedAt && now;
  }, "the round ended and released", 10_000);
  const looks = log.sent.filter((text) => /graded/.test(text));
  assert.equal(looks.length, 2, `the look-back was sent once on each claim, never twice on one: ${JSON.stringify(log.sent)}`);
  assert.deepEqual(log.recovered, [], "the cut look-back is never recovered as the job's turn");
  assert.deepEqual(log.settled, looks.slice(0, 1), "the next claim settled the cut look-back");
  assert.deepEqual(answers.at(-1), { ended: true, answer: "the round's note" }, "the step read the second ask's answer");
});
