// The person's turns with a run's browser, in the run's process and in the server (browser-person.ts), without a run: the
// ask's record and its answer, and the person's time held under the cap. The cap, the gates and the clock are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerAsk, openAsk, personHands } from "../dist/browser-person.js";
import { scratch } from "./support.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (n, tag) => ({ requestId: `00000000-0000-4000-8000-00000000000${n}`, sessionTag: tag, instruction: `Do thing ${n}`, completionCondition: `thing ${n} is done` });

/** The run's process's side on `root`, with a cap that grants every hold (or refuses once `refuse` is set), counting them. */
function hands(root, { gates = () => ({ give: () => false }), timers, holdMs } = {}) {
  const held = { taken: 0, dropped: 0, refuse: null, notes: [] };
  const person = personHands({
    root, gates, timers, holdMs, pollMs: 60_000,
    personTime: async () => {
      if (held.refuse) return { refused: held.refuse };
      held.taken += 1;
      return { drop: () => { held.dropped += 1; } };
    },
    note: async (kind, data) => { held.notes.push(data.summary ?? data.reason); },
  });
  return { person, held };
}

test("a hand-back answers the newest ask still waiting: with two asks (two conversations), answering one, then answering again, answers the other", async (t) => {
  const root = await scratch(t);
  const { person } = hands(root);
  t.after(() => person.close());
  const first = await person.handoff.request(ask(1, "ar-run-1-1"));
  await sleep(5);
  const second = await person.handoff.request(ask(2, "ar-run-2-1"));
  assert.equal(openAsk(root)?.id, second.interactionId, "the newest waits first");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(second.interactionId), "done");
  assert.equal(openAsk(root)?.id, first.interactionId, "the other still waits");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true }, "the second answer answers the other ask");
  assert.equal(await person.handoff.outcome(first.interactionId), "done");
  assert.equal(openAsk(root), undefined);
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: false }, "with none waiting, the newest's answer");
  assert.deepEqual(answerAsk(root, "cancelled"), { outcome: "done", first: false });
});

test("the person's time on one session is held once: a take then an ask shares the take's hold (and an ask then a take the ask's), dropped once both are over", async (t) => {
  const root = await scratch(t);
  const { person, held } = hands(root);
  t.after(() => person.close());
  const tag = "ar-run-3-1";
  const take = await person.take(tag);
  assert.ok("end" in take);
  const asked = await person.handoff.request(ask(3, tag));
  assert.equal(held.taken, 1, "take, then ask: one hold");
  take.end("given");
  assert.equal(held.dropped, 0, "the ask still holds the person's time after the take ends");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(asked.interactionId), "done");
  assert.equal(held.dropped, 1, "dropped once, with the ask");

  const other = "ar-run-4-1";
  const second = await person.handoff.request(ask(4, other));
  const again = await person.take(other);
  assert.equal(held.taken, 2, "ask, then take: one more hold, not two");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(second.interactionId), "done");
  assert.equal(held.dropped, 1, "the take still holds it");
  again.end("answered");
  assert.equal(held.dropped, 2);
});

/** A clock the test moves: `set` and `clear` as timers take them, `tick(ms)` fires what is due. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const due = new Map();
  return {
    timers: { set: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; }, clear: (id) => void due.delete(id) },
    async tick(ms) {
      now += ms;
      for (;;) {
        const ready = [...due].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        due.delete(ready[0]);
        ready[1].run();
        await sleep(5);
      }
    },
  };
}

test("a take-over kept alive past its hold holds the person's time again each holdMs; with no room the browser goes back to the agent, ended cap, in the cap's words", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  const { person, held } = hands(root, { gates, timers: clock.timers, holdMs });
  t.after(() => person.close());
  const tag = "ar-run-5-1";
  const ends = [];
  // As the live view does: a viewer present, the host's take, then the gate's hold, whose end ends the take.
  gates(tag).setPresent(true);
  const take = await person.take(tag);
  gates(tag).take((why, message) => { ends.push([why, message]); take.end(why); });
  assert.equal(held.taken, 1);
  for (let minute = 0; minute < 20; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.equal(held.taken, 2, "20 minutes of steady input: held a second time at 15");
  assert.equal(gates(tag).held(), true);
  held.refuse = "spend_cap_reached: Not sent: the run has spent $0.04 of its $0.05 cap, and more of your time in the browser could cost up to $0.03.";
  for (let minute = 0; minute < 11; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.deepEqual(ends, [["cap", held.refuse]], "no room at 30 minutes: the hold ends cap, with the cap's words");
  assert.equal(gates(tag).held(), false);
  assert.equal(held.dropped, 2, "both holds dropped");
  assert.ok(held.notes.includes(`The browser went back to the agent at the run's spend cap: ${held.refuse}`), JSON.stringify(held.notes));
});
