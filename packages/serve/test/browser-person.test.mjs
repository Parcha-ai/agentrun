// The person's turns with a run's browser, in the run's process and in the server (browser-person.ts), without a run: the
// ask's record and its answer, and the person's time held under the cap. The cap, the gates and the clock are fakes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerAsk, askShown, openAsk, personHands } from "../dist/browser-person.js";
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

test("after a re-hold the cap refused, a new take-over on that session is refused in the cap's words, while the ask it was shared with goes on", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  const { person, held } = hands(root, { gates, timers: clock.timers, holdMs });
  t.after(() => person.close());
  const tag = "ar-run-6-1";
  gates(tag).setPresent(true);
  const asked = await person.handoff.request(ask(6, tag));
  const take = await person.take(tag);
  const ends = [];
  gates(tag).take((why) => { ends.push(why); take.end(why); });
  held.refuse = "spend_cap_reached: Not sent: the run has spent $0.04 of its $0.05 cap, and more of your time in the browser could cost up to $0.03.";
  for (let minute = 0; minute < 16; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.deepEqual(ends, ["cap"], "the re-hold was refused: the take-over ended cap");
  assert.equal(await person.handoff.outcome(asked.interactionId), "pending", "the ask goes on");
  held.refuse = null;
  assert.deepEqual(await person.take(tag), { refused: "spend_cap_reached: Not sent: the run has spent $0.04 of its $0.05 cap, and more of your time in the browser could cost up to $0.03." }, "Take over again: refused in the cap's words, never driven unheld");
  assert.equal(held.taken, 1, "nothing more was held");
});

test("a process that resumes polling an ask an earlier process made, without asking again, takes it up: it reads the owner's answer, or writes its expiry", async (t) => {
  const root = await scratch(t);
  const before = hands(root, { holdMs: 60_000 });
  const first = await before.person.handoff.request(ask(7, "ar-run-7-1"));
  await sleep(5);
  const second = await before.person.handoff.request(ask(8, "ar-run-8-1"));
  before.person.close();
  // The next process: pi-browser's wait polls `outcome` by id, and never calls `request` for these again.
  const after = hands(root, { holdMs: 60_000 });
  t.after(() => after.person.close());
  assert.equal(await after.person.handoff.outcome(second.interactionId), "pending");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await after.person.handoff.outcome(second.interactionId), "done", "the owner's answer reaches the resumed wait");
  // The other ask, past its expiry when the next process takes it up: that process writes the expiry, and the wait hears it.
  const file = join(root, "browser-ask", `${first.interactionId}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expires_at: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 });
  const later = hands(root, { holdMs: 60_000 });
  t.after(() => later.person.close());
  assert.equal(await later.person.handoff.outcome(first.interactionId), "expired");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: false }, "nothing left waiting");
});

test("two conversations ask: answering the newer leaves the older shown and answerable, whatever rows came after it; answering it ends both", async (t) => {
  const root = await scratch(t);
  const { person } = hands(root);
  t.after(() => person.close());
  const older = await person.handoff.request(ask(9, "ar-run-9-1"));
  await sleep(5);
  const newer = await person.handoff.request(ask(10, "ar-run-10-1"));
  const waiting = (tag) => ({ kind: "waiting", session: tag });
  const answered = { kind: "tool_result", tool_name: "browser_request_handoff" };
  const rows = [waiting("ar-run-9-1"), waiting("ar-run-10-1")];
  assert.equal(askShown(root, rows)?.id, newer.interactionId, "the newer is shown first");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(newer.interactionId), "done");
  // The newer ask's result comes after both waiting rows.
  rows.push(answered);
  assert.equal(askShown(root, rows)?.id, older.interactionId, "the older still waits, and is shown");
  assert.equal(askShown(root, rows, "waiting")?.id, older.interactionId);
  assert.deepEqual(answerAsk(root, "cancelled"), { outcome: "cancelled", first: true }, "and is answerable");
  assert.equal(await person.handoff.outcome(older.interactionId), "cancelled");
  rows.push(answered);
  assert.equal(askShown(root, rows), undefined, "both done");
});

test("an ask whose waiting row has not come yet is not shown, though an earlier ask on the same session has one", async (t) => {
  const root = await scratch(t);
  const { person } = hands(root);
  t.after(() => person.close());
  const tag = "ar-run-11-1";
  const first = await person.handoff.request(ask(11, tag));
  const rows = [{ kind: "waiting", session: tag }];
  assert.equal(askShown(root, rows)?.id, first.interactionId);
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(first.interactionId), "done");
  rows.push({ kind: "tool_result", tool_name: "browser_request_handoff" });
  await sleep(5);
  const second = await person.handoff.request(ask(12, tag));
  assert.equal(askShown(root, rows), undefined, "its own row is not in yet");
  rows.push({ kind: "waiting", session: tag });
  assert.equal(askShown(root, rows)?.id, second.interactionId);
});
