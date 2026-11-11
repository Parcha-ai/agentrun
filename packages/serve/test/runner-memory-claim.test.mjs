// A runner claims by memory as well as by count (RunnerOptions.memory): each run weighs what a run of its harness
// reserves (a claude-agent run 288 MiB, a pi run 128), and the runner claims a waiting run only while the runs it holds
// and that run fit its budget. A run that does not fit waits queued, and so does every run behind it (oldest first, so a
// heavy run is never passed over for ever by light ones). A run heavier than the whole budget is claimed when the runner
// holds nothing, so it is never stuck. The budget and the weights are a test's: no memory is allocated. Each loop holds
// its turn until the test lets it end, and "nothing more is claimed" is read across the runner's own polls (onBeat).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startRunner } from "../dist/runner/runner.js";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20 };
const ROOT = 1;
/** A test's weights: a run whose id says heavy weighs a claude-agent run's 288 MiB, any other a pi run's 128. */
const WEIGHT = (runId) => (runId.includes("heavy") ? 288 : 128);
const weigh = async (runIds) => new Map(runIds.map((id) => [id, WEIGHT(id)]));

/** Loops whose one turn is held until `finish(runId)`: then it commits its answer and ends. Tracks the MiB held at once. */
function heldTurns() {
  const loops = new Map();
  let heldMib = 0;
  let most = 0;
  const createLoop = (deps) => {
    let finishTurn;
    const answered = new Promise((resolve) => (finishTurn = resolve));
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const loop = {
      claim: null,
      finishTurn: () => finishTurn(),
      async start(claim) {
        loop.claim = claim;
        loops.set(claim.runId, loop);
        heldMib += WEIGHT(claim.runId);
        most = Math.max(most, heldMib);
        try {
          const how = await Promise.race([answered.then(() => "answered"), stopped.then(() => "stop")]);
          if (how === "stop") return { state: "interrupted" };
          const journal = deps.journal(claim);
          const id = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: id });
          await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id, conversationId: ROOT, kind: "message" } }], BACKGROUND_CONTEXT);
          return { state: "ended" };
        } finally {
          heldMib -= WEIGHT(claim.runId);
        }
      },
      async command() {
        return { taken: true };
      },
      async stop() {
        stopNow();
      },
    };
    return loop;
  };
  return { loops, createLoop, most: () => most };
}

async function memoryRunner(t, budgetMib, ids) {
  const { server, runners: [store] } = await stores();
  for (const id of ids) await queue(server, id);
  const turns = heldTurns();
  const events = [];
  let beats = 0;
  const runner = startRunner({ store: observed(store, recorder()), createLoop: turns.createLoop, name: "runner-a", loops: 10, memory: { budgetMib, weigh }, onEvent: (event) => events.push(event), onBeat: () => void beats++, ...TIMING });
  t.after(() => {
    for (const loop of turns.loops.values()) loop.finishTurn();
    return runner.close();
  });
  /** Three more beats of the runner: polls, each of which would claim a waiting run it had room for. */
  const polls = async () => {
    const seen = beats;
    await until(() => beats >= seen + 3, "three more runner beats");
  };
  const held = () => runner.held().map((claim) => claim.runId).sort();
  const state = async (id) => (await server.runs.get(id)).state;
  const released = (id) => until(() => events.some((event) => event.type === "released" && event.runId === id), `${id} released`);
  return { turns, polls, held, state, released };
}

test("a 400 MiB budget holds one claude-agent run: the next heavy run waits queued, and the light run behind it waits too, though it would fit", async (t) => {
  const { turns, polls, held, state, released } = await memoryRunner(t, 400, ["run-1-heavy", "run-2-heavy", "run-3-light"]);
  await until(() => turns.loops.has("run-1-heavy"), "the first heavy run claimed");
  await polls();
  assert.deepEqual(held(), ["run-1-heavy"], "288 held: a second 288 would pass the 400 budget, and the light run waits behind it");
  assert.equal(await state("run-2-heavy"), "queued");
  assert.equal(await state("run-3-light"), "queued");
  turns.loops.get("run-1-heavy").finishTurn();
  await released("run-1-heavy");
  await until(() => turns.loops.has("run-2-heavy"), "the second heavy run claimed once the first ended");
  await polls();
  assert.deepEqual(held(), ["run-2-heavy"], "288 + 128 = 416 is past 400: the light run still waits");
  assert.equal(await state("run-3-light"), "queued");
  turns.loops.get("run-2-heavy").finishTurn();
  await until(() => turns.loops.has("run-3-light"), "the light run claimed once the heavy one ended");
  turns.loops.get("run-3-light").finishTurn();
  await released("run-3-light");
  assert.ok(turns.most() <= 400, `never more than the budget held at once: ${turns.most()} MiB`);
});

test("light runs fill the budget by weight, not by count: 400 MiB holds three pi runs, and the fourth waits", async (t) => {
  const { turns, polls, held, state } = await memoryRunner(t, 400, ["run-1", "run-2", "run-3", "run-4"]);
  await until(() => turns.loops.size === 3, "three light runs claimed");
  await polls();
  assert.deepEqual(held(), ["run-1", "run-2", "run-3"], "3 x 128 = 384 fits; a fourth would be 512");
  assert.equal(await state("run-4"), "queued");
  turns.loops.get("run-1").finishTurn();
  await until(() => turns.loops.has("run-4"), "the fourth claimed once one ended");
  assert.ok(turns.most() <= 400, `never more than the budget held at once: ${turns.most()} MiB`);
});

test("a run heavier than the whole budget is claimed when the runner holds nothing, so it never waits for ever", async (t) => {
  const { turns, polls, held, state } = await memoryRunner(t, 200, ["run-1-heavy", "run-2"]);
  await until(() => turns.loops.has("run-1-heavy"), "the heavy run claimed alone");
  await polls();
  assert.deepEqual(held(), ["run-1-heavy"], "it runs alone: nothing is claimed beside it");
  assert.equal(await state("run-2"), "queued");
  turns.loops.get("run-1-heavy").finishTurn();
  await until(() => turns.loops.has("run-2"), "the next claimed once it ended");
});
