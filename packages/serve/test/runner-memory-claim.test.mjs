// A runner claims by memory as well as by count (RunnerOptions.memory): each run weighs what a run of its harness
// reserves (a claude-agent run 288 MiB, a pi run 128), and the runner claims a waiting run only while the runs it holds
// and that run fit its budget. A run that does not fit waits queued, and so does every run behind it (oldest first, so a
// heavy run is never passed over for ever by light ones). A run heavier than the whole budget is claimed when the runner
// holds nothing, so it is never stuck; one whose harness never fits the runner's memory at all (RunnerMemory.refuses) is
// failed in words, never started. The budget and the weights are a test's: no memory is allocated. Each loop holds
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

async function memoryRunner(t, budgetMib, ids, refuses) {
  const { server, runners: [store] } = await stores();
  for (const id of ids) await queue(server, id);
  const turns = heldTurns();
  const events = [];
  let beats = 0;
  const runner = startRunner({ store: observed(store, recorder()), createLoop: turns.createLoop, name: "runner-a", loops: 10, memory: { budgetMib, weigh, ...(refuses ? { refuses } : {}) }, onEvent: (event) => events.push(event), onBeat: () => void beats++, ...TIMING });
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
  const summary = async (id) => (await server.runs.get(id)).summary;
  const released = (id) => until(() => events.some((event) => event.type === "released" && event.runId === id), `${id} released`);
  return { turns, polls, held, state, summary, released, events };
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

test("a run the runner's memory can never hold (its harness never fits here) is failed in the memory's words, never started or held, and the runs behind it are claimed", async (t) => {
  const WHY = "This server has 512 MB of memory and keeps 128 MB for itself; an opencode run needs about 704 MB more, so it can't start here.";
  const { turns, polls, held, state, summary, released, events } = await memoryRunner(t, 384, ["run-1-huge", "run-2-heavy", "run-3"], (id) => (id.includes("huge") ? WHY : undefined));
  await released("run-1-huge");
  await until(() => turns.loops.has("run-2-heavy") && turns.loops.has("run-3"), "the runs behind it claimed");
  await polls();
  assert.equal(turns.loops.has("run-1-huge"), false, "no loop was made for it: nothing of it ran on this runner");
  assert.deepEqual(held(), ["run-2-heavy", "run-3"], "it holds no place and weighs nothing: 288 + 128 fit the 384");
  assert.deepEqual([await state("run-1-huge"), await summary("run-1-huge")], ["failed", WHY]);
  assert.deepEqual(events.filter((event) => event.type === "released" && event.runId === "run-1-huge").map((event) => event.end), ["failed"]);
});

test("the weights and the budget a runner claims by (memory-claim.ts): each run by the harness its launch names, of the host's memory less the server's", async () => {
  const { runnerMemory, claimMibOf } = await import("../dist/runner/memory-claim.js");
  const { server } = await stores();
  const launched = (id, harness) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: harness === undefined ? {} : { harness } });
  await launched("run-claude", "claude-agent");
  await launched("run-codex", "codex");
  await launched("run-opencode", "opencode");
  await launched("run-pi", "pi");
  await launched("run-default", undefined);
  await launched("run-learning", "learning");
  await queue(server, "run-no-launch");
  const MiB = 2 ** 20;
  const memory = runnerMemory(server, 2048 * MiB);
  assert.equal(memory.budgetMib, 2048 - 128, "a 2 GB host less the server's 128 MiB");
  const weights = await memory.weigh(["run-claude", "run-codex", "run-opencode", "run-pi", "run-default", "run-learning", "run-no-launch"]);
  assert.deepEqual(Object.fromEntries(weights), { "run-claude": 288, "run-codex": 192, "run-opencode": 704, "run-pi": 128, "run-default": 128, "run-learning": 128, "run-no-launch": 128 });
  assert.equal(claimMibOf("claude-agent"), 288);
  // The bug this fixes, in numbers: the default count on a 2 GB host is 15 (pi's), and 15 claude-agent runs weigh 4320 MiB;
  // by weight the budget holds 6.
  assert.equal(Math.floor(memory.budgetMib / 128), 15);
  assert.equal(Math.floor(memory.budgetMib / 288), 6);
  assert.deepEqual(["run-claude", "run-opencode", "run-pi"].map((id) => memory.refuses(id)), [undefined, undefined, undefined], "on 2 GB every harness fits");
  // A runner in a 512 MB container (384 MiB for runs): an opencode run never fits, in the server's admission's words
  // (host.ts neverFits); a claude-agent run does; a pi run always has one place, even on 200 MB.
  const small = runnerMemory(server, 512 * MiB);
  await small.weigh(["run-claude", "run-opencode", "run-pi", "run-learning", "run-no-launch"]);
  assert.equal(small.refuses("run-opencode"), "This server has 512 MB of memory and keeps 128 MB for itself; an opencode run needs about 704 MB more, so it can't start here. pi, claude-agent and codex runs fit.");
  assert.deepEqual(["run-claude", "run-pi", "run-learning", "run-no-launch"].map((id) => small.refuses(id)), [undefined, undefined, undefined, undefined]);
  const tiny = runnerMemory(server, 200 * MiB);
  await tiny.weigh(["run-pi", "run-claude"]);
  assert.equal(tiny.refuses("run-pi"), undefined, "pi always has one place");
  assert.match(tiny.refuses("run-claude"), /^This server has 200 MB of memory .*a claude-agent run needs about 288 MB more/);
});

test("a claim that throws after others landed keeps those: the runs already claimed start, and the one that threw is claimed at a later poll", async (t) => {
  const { server, runners: [store] } = await stores();
  for (const id of ["run-1", "run-2"]) await queue(server, id);
  const turns = heldTurns();
  // The store's claim of run-2 throws once (a busy store), after run-1's landed in the same poll.
  let thrown = false;
  const flaky = new Proxy(store, {
    get(target, prop) {
      if (prop === "claim")
        return async (runId, ...rest) => {
          if (runId === "run-2" && !thrown) {
            thrown = true;
            throw new Error("the store is busy");
          }
          return target.claim(runId, ...rest);
        };
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const errors = [];
  const runner = startRunner({ store: flaky, createLoop: turns.createLoop, name: "runner-a", loops: 10, memory: { budgetMib: 1000, weigh }, onEvent: (event) => event.type === "error" && errors.push(event), ...TIMING });
  t.after(() => {
    for (const loop of turns.loops.values()) loop.finishTurn();
    return runner.close();
  });
  await until(() => turns.loops.has("run-1"), "run-1, claimed before the throw, starts");
  await until(() => turns.loops.has("run-2"), "run-2 claimed at a later poll");
  assert.ok(thrown, "the claim threw once");
  assert.ok(errors.some((event) => event.step === "claim" && /busy/.test(event.message)), JSON.stringify(errors));
});
