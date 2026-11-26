// The runner's refuse (LoopDeps.refuse): how a row its loop took for now and refused later (the dispatch's replay of a
// row buffered before its inner loop was chosen) is written refused. It writes under the claim the runner holds now, as
// the runner's own delivery does; a write the store fences loses the claim, as there; and once the run's end sealed the
// claim it writes nothing, so a refusal that lands while a failed resume counts its try never takes the row that try is
// counted on. Through the runner and its store, with faux loops that hand the test their deps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { Fenced } from "../dist/store/store.js";
import { fauxLoops, queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

/** A row id no run has: the store wrapper below answers for it, so the faux loop never takes it. */
const ROW = 1_000_000;

/** `store` with the methods in `over` in place of its own, every other one its own. */
const overriding = (store, over) => new Proxy(store, {
  get(target, name) {
    if (Object.hasOwn(over, name)) return over[name];
    const value = Reflect.get(target, name);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/** The runner's store, its takes of ROW answered by `answer(claim)` (recorded in `takes`), every other call the store's.
 *  `over`: more of its methods in place of the store's. */
function takingRow(store, answer, over = {}) {
  const takes = [];
  return {
    takes,
    store: overriding(store, {
      ...over,
      take: async (claim, commandId, ...rest) => {
        if (commandId !== ROW) return store.take(claim, commandId, ...rest);
        takes.push({ claim, rest });
        return answer(claim);
      },
    }),
  };
}

/** A runner over `store` whose runs' loops are faux and long-lived: `loops` is each loop made, with its deps. */
function running(t, store, timing = {}) {
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const events = [];
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", ...STEADY_LEASE, pollMs: 20, commandPollMs: 30, onEvent: (event) => void events.push(event), ...timing });
  t.after(() => runner.close());
  return { faux, events };
}

test("a refusal is written under the claim the runner holds now: the one its last renew returned, as its delivery writes one", { timeout: 60_000 }, async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const renewed = [];
  const { store: watched, takes } = takingRow(store, async () => {}, {
    renewMany: async (claims, options) => {
      const results = await store.renewMany(claims, options);
      renewed.push(...results.filter((one) => !(one instanceof Error)));
      return results;
    },
  });
  const { faux } = running(t, watched, { renewEveryMs: 50 });
  await queue(server, "run-1");
  const loop = await until(() => faux.loops[0]?.claim && faux.loops[0], "the run's loop started");
  const first = loop.claim;
  await until(() => renewed.some((one) => one.until > first.until), "a renew moved the claim on");
  await loop.deps.refuse(ROW, "not now");
  assert.equal(takes.length, 1, "written once");
  const { claim } = takes[0];
  assert.ok(claim.until > first.until && renewed.some((one) => one.until === claim.until), `under a claim a renew returned, not the claim the loop started on (until ${first.until}): ${JSON.stringify(claim)}`);
  assert.deepEqual(takes[0].rest, ["refused", "not now"]);
});

test("a refusal whose write the store fences loses the claim, as the runner's delivery does, and the refuse itself resolves", { timeout: 60_000 }, async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const { store: fencing } = takingRow(store, async (claim) => {
    throw new Fenced(claim.runId, claim.epoch);
  });
  const { faux, events } = running(t, fencing);
  await queue(server, "run-1");
  const loop = await until(() => faux.loops[0]?.claim && faux.loops[0], "the run's loop started");
  await loop.deps.refuse(ROW, "not now");
  const lost = events.filter((event) => event.type === "claim-lost");
  assert.deepEqual(lost.map((event) => [event.runId, event.why]), [["run-1", "fenced"]], `the claim is lost as fenced: ${JSON.stringify(events.map((event) => event.type))}`);
  await until(() => loop.stopCalls.some((stop) => stop.kind === "claim-lost"), "the loop is stopped for the lost claim");
  assert.ok(!events.some((event) => event.type === "refused"), "nothing said refused");
});
