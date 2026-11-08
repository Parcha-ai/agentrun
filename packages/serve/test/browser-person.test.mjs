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
function hands(root, { gates = () => ({ give: () => false }), timers, holdMs, now } = {}) {
  const held = { taken: 0, dropped: 0, refuse: null, notes: [] };
  const person = personHands({
    root, gates, timers, holdMs, now, pollMs: 60_000,
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
  // One instant: the ask's expiry is the take's hold's end, so nothing more is held for it.
  const { person, held } = hands(root, { now: () => 1_000_000 });
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
function fakeClock(start = 0) {
  let now = start;
  let next = 1;
  const due = new Map();
  return {
    now: () => now,
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
  const { person, held } = hands(root, { gates, timers: clock.timers, holdMs, now: clock.now });
  t.after(() => person.close());
  const tag = "ar-run-5-1";
  const ends = [];
  // As the live view does: a viewer present, the host's take, then the gate's hold, whose end ends the take.
  gates(tag).setPresent(true);
  const take = await person.take(tag);
  gates(tag).take((why, message) => { ends.push([why, message]); take.end(why); }, () => take.started());
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

test("after a re-hold the cap refused, the take-over and the ask it was shared with both end, the agent told the cap's words, and a new take-over is refused in them", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  // The ledger on the same clock as the timers: fifteen minutes pass for both.
  const { person, held } = hands(root, { gates, timers: clock.timers, holdMs, now: clock.now });
  t.after(() => person.close());
  const tag = "ar-run-6-1";
  gates(tag).setPresent(true);
  const asked = await person.handoff.request(ask(6, tag));
  const take = await person.take(tag);
  const ends = [];
  gates(tag).take((why) => { ends.push(why); take.end(why); }, () => take.started());
  held.refuse = "spend_cap_reached: Not sent: the run has spent $0.04 of its $0.05 cap, and more of your time in the browser could cost up to $0.03.";
  for (let minute = 0; minute < 16; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.deepEqual(ends, ["cap"], "the re-hold was refused: the take-over ended cap");
  assert.deepEqual(await person.handoff.outcome(asked.interactionId), { outcome: "expired", reason: held.refuse }, "the ask ends too: nothing outlives what is held");
  assert.deepEqual(await person.take(tag), { refused: held.refuse }, "Take over again with no room: refused in the cap's words, never driven unheld");
  assert.equal(held.taken, 1, "nothing more was held");
  // With room again, Take over holds the next stretch itself.
  held.refuse = null;
  const again = await person.take(tag);
  assert.ok("end" in again);
  assert.equal(held.taken, 2, "held, not driven unheld");
  again.end("given");
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

test("take-over time counts: what the person used stays held until a charge books it, so take-overs given back with no browser call between them meet the cap", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const { browserSpend } = await import("../dist/browser-cost.js");
  const { paidHolds, useSpend } = await import("../dist/cap.js");
  // $0.12 an hour under a $0.05 cap: each take-over holds 15 minutes ($0.03) up front.
  let spent = 0;
  useSpend({ cap: 0.05, spent: () => spent, add: (usd) => void (spent += usd ?? 0) });
  t.after(() => useSpend(undefined));
  const base = paidHolds();
  const spend = browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async () => undefined);
  const root = await scratch(t);
  const clock = fakeClock();
  const gates = createDrivingGates({ timers: clock.timers });
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, personTime: spend.personTime, carry: spend.carry, note: async () => {}, pollMs: 60_000 });
  t.after(() => person.close());
  const tag = "ar-run-12-1";
  gates(tag).setPresent(true);
  const taken = [];
  for (let round = 0; round < 5; round += 1) {
    const take = await person.take(tag);
    if ("refused" in take) { taken.push(take.refused); break; }
    gates(tag).take((why) => take.end(why), () => take.started());
    for (let minute = 0; minute < 10; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
    gates(tag).give();
    taken.push("held");
  }
  assert.deepEqual(taken.slice(0, 2), ["held", "held"]);
  assert.match(taken[2] ?? "", /^spend_cap_reached: Not sent: this run has spent \$0 and holds \$0\.04 for steps still running, of its \$0\.05 cap, and the next step, taking over the browser, could cost up to \$0\.03 /, "the third is refused: the 20 minutes used are held");
  assert.ok(Math.abs(paidHolds() - base - 0.04) < 1e-9, `held: ${paidHolds() - base}`);
});

test("while the cap refuses more of the person's time on a session, a new ask there is refused too, in its own words; and one that waited on a refused first hold is refused in its own words, not the take's", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  let refuse = false;
  let taken = 0;
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what) => (refuse ? { refused: `no room for ${what}` } : (taken += 1, { drop() {} })) });
  t.after(() => person.close());
  const tag = "ar-run-13-1";
  gates(tag).setPresent(true);
  await person.handoff.request(ask(13, tag));
  const take = await person.take(tag);
  gates(tag).take((why) => take.end(why), () => take.started());
  refuse = true;
  for (let minute = 0; minute < 16; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.equal(gates(tag).held(), false, "the re-hold was refused: the take-over ended");
  assert.deepEqual(await person.handoff.request(ask(14, tag)), { refused: "no room for handing the browser to you" }, "a new ask there is refused, in its own words");

  // A take and an ask on a fresh session at once: the first hold is refused, and the ask that waited on it asks for itself.
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const racing = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what) => { asked.push(what); if (what === "taking over the browser") await slow; return { refused: `no room for ${what}` }; } });
  t.after(() => racing.close());
  const other = "ar-run-14-1";
  const taking = racing.take(other);
  const asking = racing.handoff.request(ask(15, other));
  release();
  assert.deepEqual(await taking, { refused: "no room for taking over the browser" });
  assert.deepEqual(await asking, { refused: "no room for handing the browser to you" }, "the ask's own words");
  assert.deepEqual(asked, ["taking over the browser", "handing the browser to you"]);
});

test("a process that takes up an earlier process's ask holds the person's time again; with no room the ask ends at the cap, the agent told its words, and nobody drives unheld", async (t) => {
  const root = await scratch(t);
  const before = hands(root, { holdMs: 60_000 });
  const first = await before.person.handoff.request(ask(16, "ar-run-16-1"));
  await sleep(5);
  const second = await before.person.handoff.request(ask(17, "ar-run-17-1"));
  before.person.close();
  const after = hands(root, { holdMs: 60_000 });
  t.after(() => after.person.close());
  assert.equal(await after.person.handoff.outcome(second.interactionId), "pending");
  await sleep(5);
  assert.deepEqual([after.held.taken, after.held.dropped], [1, 0], "taken up: its time held again");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await after.person.handoff.outcome(second.interactionId), "done");
  assert.equal(after.held.dropped, 1, "and dropped with its answer");
  // No room in the process that takes it up: the ask ends at the cap, as everyone on a session the cap refused does.
  after.held.refuse = "spend_cap_reached: no room";
  assert.equal(await after.person.handoff.outcome(first.interactionId), "pending");
  await sleep(5);
  assert.equal(after.held.taken, 1, "nothing more held");
  assert.deepEqual(await after.person.handoff.outcome(first.interactionId), { outcome: "expired", reason: "spend_cap_reached: no room" }, "expired, in the cap's words");
  assert.equal(openAsk(root), undefined, "nothing is left waiting: it ended");
});

test("an ask that arrives while the take-over's re-hold waits on the cap holds nothing the re-hold holds: one stretch, held once", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock(Date.now());
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  const held = [];
  let answerRehold;
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what, seconds) => {
    // The re-hold's answer from the cap is slow: the ask arrives while it waits.
    if (what === "more of your time in the browser") await new Promise((resolve) => { answerRehold = resolve; });
    held.push([what, Math.round(seconds)]);
    return { drop() {} };
  } });
  t.after(() => person.close());
  const tag = "ar-run-40-1";
  gates(tag).setPresent(true);
  const take = await person.take(tag);
  gates(tag).take((why) => take.end(why), () => take.started());
  for (let minute = 0; minute < 15; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.ok(answerRehold, "the re-hold at 15 minutes is waiting on the cap");
  const asked = person.handoff.request(ask(40, tag));
  await sleep(20);
  answerRehold();
  await asked;
  await sleep(20);
  assert.deepEqual(held, [["taking over the browser", 900], ["more of your time in the browser", 900]], "the stretch from 15 to 30 minutes is held once, not again for the ask");
});

test("a process that lets go while its first hold is still being asked of the cap keeps nothing: the hold that comes back is dropped, and nothing is held again later", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock(Date.now());
  const holdMs = 15 * 60_000;
  const calls = [];
  let dropped = 0;
  let grant;
  const person = personHands({ root, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, gates: () => ({ give: () => false }), note: async () => {}, personTime: async (what) => {
    calls.push(what);
    if (calls.length === 1) await new Promise((resolve) => { grant = resolve; });
    return { drop: () => { dropped += 1; } };
  } });
  const taking = person.take("ar-run-41-1");
  await sleep(5);
  person.close();
  grant();
  const answer = await taking;
  assert.ok("refused" in answer, "the take that raced the close holds nothing");
  assert.equal(dropped, 1, "the hold that came back after the close is dropped");
  await clock.tick(2 * holdMs);
  assert.deepEqual(calls, ["taking over the browser"], "and nothing is held again");
  const asked = await person.handoff.request(ask(41, "ar-run-41-1"));
  assert.ok("refused" in asked, "a closed process makes no ask");
});

test("a take that ends before its hold goes live (the agent's call still running) writes no row: no hand-back without a take-over", async (t) => {
  const root = await scratch(t);
  const { person, held } = hands(root);
  t.after(() => person.close());
  for (const why of ["given", "idle", "away", "released", "cap"]) {
    const take = await person.take("ar-run-42-1");
    take.end(why);
  }
  await sleep(5);
  assert.deepEqual(held.notes, [], "nothing taken over, nothing handed back");
  assert.deepEqual([held.taken, held.dropped], [5, 5], "each one's time let go");
});

test("a take-over's row is written when its hold goes live, and a take whose hold never started is let go with no row", async (t) => {
  const root = await scratch(t);
  const { person, held } = hands(root);
  t.after(() => person.close());
  const take = await person.take("ar-run-18-1");
  await sleep(5);
  assert.deepEqual(held.notes, [], "no row while the hold is not live yet");
  take.started();
  await sleep(5);
  assert.deepEqual(held.notes, ["You took over the browser"]);
  take.end("given");
  await sleep(5);
  assert.deepEqual(held.notes, ["You took over the browser", "You handed the browser back"]);
  const never = await person.take("ar-run-19-1");
  never.cancel();
  await sleep(5);
  assert.deepEqual([held.notes.length, held.taken, held.dropped], [2, 2, 2], "cancelled: its hold dropped, no row");
});

test("the person's time a take-over holds never pauses the agent's run when the cap refuses it; an ask's does", async (t) => {
  const root = await scratch(t);
  const seen = [];
  const person = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, note: async () => {}, personTime: async (what, _seconds, options) => { seen.push([what, options?.pauses ?? true]); return { refused: "no room" }; } });
  t.after(() => person.close());
  await person.take("ar-run-20-1");
  await person.handoff.request(ask(20, "ar-run-21-1"));
  assert.deepEqual(seen, [["taking over the browser", false], ["handing the browser to you", true]]);
});

test("an ask that joins a take-over holds the person's time through its own expiry; a refused re-hold ends both, and the agent hears expired in the cap's words", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  const held = [];
  let refuse = null;
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what, seconds) => (refuse ? { refused: refuse } : (held.push([what, seconds]), { drop() {} })) });
  t.after(() => person.close());
  const tag = "ar-run-22-1";
  gates(tag).setPresent(true);
  const take = await person.take(tag);
  const ends = [];
  gates(tag).take((why) => { ends.push(why); take.end(why); }, () => take.started());
  for (let minute = 0; minute < 10; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  const asked = await person.handoff.request(ask(22, tag));
  assert.deepEqual(held, [["taking over the browser", 900], ["handing the browser to you", 600]], "the ask at minute 10 holds its extra ten minutes: through minute 25");
  refuse = "spend_cap_reached: Not sent: no room for more of your time.";
  for (let minute = 0; minute < 5; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.deepEqual(ends, ["cap"], "the re-hold refused at minute 15 ends the take-over");
  assert.deepEqual(await person.handoff.outcome(asked.interactionId), { outcome: "expired", reason: refuse }, "and the ask, the agent told the cap's words");
});

test("an ask that joins a take-over and cannot hold its extra time is refused in the cap's words", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  let calls = 0;
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async () => (++calls === 1 ? { drop() {} } : { refused: "no room for the ask's extra time" }) });
  t.after(() => person.close());
  const tag = "ar-run-23-1";
  gates(tag).setPresent(true);
  await person.take(tag);
  await clock.tick(5 * 60_000);
  assert.deepEqual(await person.handoff.request(ask(23, tag)), { refused: "no room for the ask's extra time" });
});

test("an ask a restarted process takes up holds through its own expiry: joining a take-over that holds through T+15, an ask expiring at T+25 holds the ten minutes between", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const tag = "ar-run-24-1";
  // The process that asked, before the restart: its ask expires 25 minutes on.
  const before = hands(root, { holdMs: 25 * 60_000 });
  const asked = await before.person.handoff.request(ask(24, tag));
  before.person.close();
  // The next process, its clock at T: the owner takes over (held through T+15), and at T+10 the resumed wait polls.
  const clock = fakeClock(Date.now());
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  const held = [];
  const after = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what, seconds) => (held.push([what, Math.round(seconds)]), { drop() {} }) });
  t.after(() => after.close());
  gates(tag).setPresent(true);
  const take = await after.take(tag);
  gates(tag).take((why) => take.end(why), () => take.started());
  for (let minute = 0; minute < 10; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.equal(await after.handoff.outcome(asked.interactionId), "pending");
  await sleep(10);
  assert.equal(held.length, 2, JSON.stringify(held));
  assert.equal(held[1][0], "handing the browser to you");
  assert.ok(Math.abs(held[1][1] - 600) <= 2, `the ten minutes from T+15 to its expiry at T+25 are held: ${JSON.stringify(held)}`);
});

test("a re-hold holds only past what is held already: take at 0, an ask at 10 (held through 25), the re-hold at 15 holds 5 minutes (through 30), and a cap of exactly that time is never refused", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock(Date.now());
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  // A cap with room for 30 minutes of the person's time, no more.
  let room = 30 * 60;
  const held = [];
  const person = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async (what, seconds) => {
    if (Math.round(seconds) > room) return { refused: `no room for ${Math.round(seconds)} s` };
    room -= Math.round(seconds);
    held.push([what, Math.round(seconds)]);
    return { drop() {} };
  } });
  t.after(() => person.close());
  const tag = "ar-run-25-1";
  gates(tag).setPresent(true);
  const take = await person.take(tag);
  const ends = [];
  gates(tag).take((why) => { ends.push(why); take.end(why); }, () => take.started());
  for (let minute = 0; minute < 10; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  await person.handoff.request(ask(25, tag));
  for (let minute = 0; minute < 6; minute += 1) { gates(tag).input(); await clock.tick(60_000); }
  assert.deepEqual(held, [["taking over the browser", 900], ["handing the browser to you", 600], ["more of your time in the browser", 300]], "each minute held once");
  assert.deepEqual(ends, [], "the cap with room for the real time refuses nothing");
});

test("an ask the cap ended keeps the cap's words across a restart: the next process's wait hears expired, with them", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const root = await scratch(t);
  const clock = fakeClock(Date.now());
  const holdMs = 15 * 60_000;
  const gates = createDrivingGates({ timers: clock.timers, holdIdleMs: holdMs });
  let refuse = null;
  const before = personHands({ root, gates, timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000, note: async () => {}, personTime: async () => (refuse ? { refused: refuse } : { drop() {} }) });
  const tag = "ar-run-26-1";
  gates(tag).setPresent(true);
  const asked = await before.handoff.request(ask(26, tag));
  refuse = "spend_cap_reached: no room for more of your time";
  await clock.tick(holdMs);
  await sleep(10);
  assert.deepEqual(await before.handoff.outcome(asked.interactionId), { outcome: "expired", reason: refuse });
  before.close();
  const after = hands(root);
  t.after(() => after.person.close());
  assert.deepEqual(await after.person.handoff.outcome(asked.interactionId), { outcome: "expired", reason: refuse }, "the cap's words outlive the process");
});

test("an ask's words are redacted before they are cut to their bound: a held value that straddles the cut leaves no prefix of it in the record", async (t) => {
  const root = await scratch(t);
  const value = ["held", "value", "made", "in", "this", "test"].join("-");
  const instruction = `${"x".repeat(1990)}${value} and more`;
  const person = personHands({ root, gates: () => ({}), pollMs: 60_000, note: async () => {}, personTime: async () => ({ drop() {} }), redact: (text) => text.replaceAll(value, "[redacted]") });
  t.after(() => person.close());
  const asked = await person.handoff.request({ requestId: "00000000-0000-4000-8000-000000000099", sessionTag: "ar-run-27-1", instruction, completionCondition: `${"y".repeat(1995)}${value}` });
  const record = readFileSync(join(root, "browser-ask", `${asked.interactionId}.json`), "utf8");
  for (let k = 4; k <= value.length; k += 1) assert.ok(!record.includes(value.slice(0, k)), `no prefix of the held value (${k} chars) in the record`);
});

test("two conversations that ask with the same request id, each on its own session, are two asks: each shows its own instruction, gets its own answer, and ends its own take-over", async (t) => {
  const root = await scratch(t);
  const ended = [];
  const { person } = hands(root, { gates: (tag) => ({ give: (why) => { ended.push([tag, why]); return true; } }) });
  t.after(() => person.close());
  const same = "00000000-0000-4000-8000-000000000009";
  const first = await person.handoff.request({ requestId: same, sessionTag: "ar-run-9-1", instruction: "Sign in on the first", completionCondition: "the first is signed in" });
  await sleep(5);
  const second = await person.handoff.request({ requestId: same, sessionTag: "ar-run-9-2", instruction: "Sign in on the second", completionCondition: "the second is signed in" });
  assert.notEqual(second.interactionId, first.interactionId, "two asks, not one shared");
  assert.equal(openAsk(root)?.instruction, "Sign in on the second", "the second shows its own instruction");
  assert.deepEqual(answerAsk(root, "cancelled"), { outcome: "cancelled", first: true });
  assert.equal(await person.handoff.outcome(second.interactionId), "cancelled");
  assert.equal(await person.handoff.outcome(first.interactionId), "pending", "the first still waits for its own answer");
  assert.deepEqual(ended, [["ar-run-9-2", "answered"]], "only the second's session's take-over ended");
  assert.equal(openAsk(root)?.instruction, "Sign in on the first");
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(first.interactionId), "done");
  assert.deepEqual(ended, [["ar-run-9-2", "answered"], ["ar-run-9-1", "answered"]]);
});

test("an ask record in the old shape (named by the request id alone) is no ask: it is never shown, answered, or matched to a session", async (t) => {
  const root = await scratch(t);
  const { mkdirSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  mkdirSync(join(root, "browser-ask"), { mode: 0o700 });
  const old = createHash("sha256").update("00000000-0000-4000-8000-000000000008").digest("base64url").slice(0, 22);
  writeFileSync(join(root, "browser-ask", `${old}.json`), `${JSON.stringify({ id: old, tag: "ar-run-8-1", instruction: "Old", completion_condition: "old", asked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() })}\n`, { mode: 0o600 });
  assert.equal(openAsk(root), undefined);
  assert.equal(askShown(root, [{ kind: "waiting", session: "ar-run-8-1" }], "waiting"), undefined);
  assert.equal(answerAsk(root, "done"), undefined, "nothing to answer");
  // A process that resumes a wait on that old id hears it is gone, never waits on it forever.
  const { person } = hands(root);
  t.after(() => person.close());
  assert.equal(await person.handoff.outcome(old), "expired");
});

test("a process that takes up an ask near its expiry holds the person's time only through that expiry: with 2 minutes left it holds 2 minutes, not 15, and a cap with 5 minutes of room takes it", async (t) => {
  const root = await scratch(t);
  const before = hands(root);
  const asked = await before.person.handoff.request(ask(21, "ar-run-21-1"));
  before.person.close();
  // The next process, 13 minutes into the ask's 15: a cap with room for 5 minutes of the person's time.
  const seconds = [];
  const person = personHands({
    root, gates: () => ({ give: () => false }), now: () => Date.now() + 13 * 60_000, pollMs: 60_000, note: async () => {},
    personTime: async (_what, s) => (seconds.push(s), s > 300 ? { refused: "spend_cap_reached: 5 minutes of room" } : { drop() {} }),
  });
  t.after(() => person.close());
  assert.equal(await person.handoff.outcome(asked.interactionId), "pending");
  await sleep(5);
  assert.equal(seconds.length, 1, JSON.stringify(seconds));
  assert.ok(seconds[0] > 110 && seconds[0] <= 120, `held ${seconds[0]} s, the 2 minutes left`);
  assert.equal(await person.handoff.outcome(asked.interactionId), "pending", "not ended at the cap: what it holds fits the room left");
});

test("a process that takes up an ask already past its expiry holds none of the person's time", async (t) => {
  const root = await scratch(t);
  const before = hands(root);
  const asked = await before.person.handoff.request(ask(22, "ar-run-22-1"));
  before.person.close();
  const seconds = [];
  const person = personHands({
    root, gates: () => ({ give: () => false }), now: () => Date.now() + 16 * 60_000, pollMs: 60_000, note: async () => {},
    personTime: async (_what, s) => (seconds.push(s), { drop() {} }),
  });
  t.after(() => person.close());
  await person.handoff.outcome(asked.interactionId);
  await sleep(5);
  assert.deepEqual(seconds, [], "nothing held at or past its expiry");
});

test("a take-over the person hands back (given) answers the open ask on its session done, once; one that ends idle, away or at the cap leaves it open; another session's ask is never answered", async (t) => {
  for (const why of ["idle", "away", "cap", "released"]) {
    const root = await scratch(t);
    const { person } = hands(root);
    const asked = await person.handoff.request(ask(31, "ar-run-31-1"));
    const take = await person.take("ar-run-31-1");
    take.started();
    take.end(why);
    assert.equal(await person.handoff.outcome(asked.interactionId), "pending", `ended ${why}: the ask stays open`);
    assert.equal(openAsk(root)?.id, asked.interactionId, why);
    person.close();
  }
  const root = await scratch(t);
  const { person, held } = hands(root);
  t.after(() => person.close());
  const a = await person.handoff.request(ask(32, "ar-run-32-a"));
  await sleep(5);
  const b = await person.handoff.request(ask(33, "ar-run-32-b"));
  const take = await person.take("ar-run-32-a");
  take.started();
  take.end("given");
  assert.equal(await person.handoff.outcome(a.interactionId), "done", "handed back: its session's ask is done");
  assert.equal(await person.handoff.outcome(b.interactionId), "pending", "the other session's ask is not answered");
  assert.equal(openAsk(root)?.id, b.interactionId);
  assert.equal(held.dropped, 1, "the given session's hold dropped once (the take's and the ask's are one)");
  // The console's Done after it answers the newest ask still waiting (b's), never a's twice.
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(b.interactionId), "done");
  assert.deepEqual(answerAsk(root, "cancelled"), { outcome: "done", first: false }, "nothing waiting: the newest's answer, written no more");
});

test("one hand-back, one row: a give that answers the session's open ask writes one 'You handed the browser back', as a give with no ask and the console's Done each do", async (t) => {
  const rows = (held) => held.notes.filter((said) => said === "You handed the browser back").length;
  // A give while an ask is open on the session: it answers the ask, and the timeline says so once.
  const withAsk = hands(await scratch(t));
  t.after(() => withAsk.person.close());
  const asked = await withAsk.person.handoff.request(ask(41, "ar-run-41-1"));
  const take = await withAsk.person.take("ar-run-41-1");
  take.started();
  take.end("given");
  assert.equal(await withAsk.person.handoff.outcome(asked.interactionId), "done");
  assert.equal(rows(withAsk.held), 1, JSON.stringify(withAsk.held.notes));
  // A give with no ask open.
  const bare = hands(await scratch(t));
  t.after(() => bare.person.close());
  const alone = await bare.person.take("ar-run-42-1");
  alone.started();
  alone.end("given");
  assert.equal(rows(bare.held), 1, JSON.stringify(bare.held.notes));
  // The console's Done, no take-over.
  const root = await scratch(t);
  const routed = hands(root);
  t.after(() => routed.person.close());
  const other = await routed.person.handoff.request(ask(43, "ar-run-43-1"));
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await routed.person.handoff.outcome(other.interactionId), "done");
  assert.equal(rows(routed.held), 1, JSON.stringify(routed.held.notes));
});

test("an ask whose waiting row cannot be written fails, and says so: nothing is held or left open, and asking again shows it", async (t) => {
  const root = await scratch(t);
  let failRow = true;
  const held = { taken: 0, dropped: 0, notes: [] };
  const person = personHands({
    root, gates: () => ({ give: () => false }), pollMs: 60_000,
    personTime: async () => (held.taken += 1, { drop: () => { held.dropped += 1; } }),
    note: async (kind, data) => {
      if (kind === "agent.handover" && failRow) throw new Error("the run's store refused the row");
      held.notes.push(data.summary ?? data.reason);
    },
  });
  t.after(() => person.close());
  const first = await person.handoff.request(ask(51, "ar-run-51-1"));
  assert.ok("refused" in first, `the request says it failed: ${JSON.stringify(first)}`);
  assert.match(first.refused, /could not be shown/);
  assert.deepEqual([held.taken, held.dropped], [1, 1], "its hold dropped");
  assert.equal(openAsk(root), undefined, "nothing left waiting");
  failRow = false;
  const second = await person.handoff.request(ask(51, "ar-run-51-1"));
  assert.ok("interactionId" in second, JSON.stringify(second));
  assert.equal(openAsk(root)?.id, second.interactionId, "asked again: it waits");
  assert.deepEqual(held.notes, ["Do thing 51"], "its waiting row written");
  assert.equal(askShown(root, [{ kind: "waiting", session: "ar-run-51-1" }])?.id, second.interactionId, "the owner sees it");
});

test("an ask's waiting entry carries the whole hand-over, as the server reads it: id, session, instruction, done-when condition, asked and expiry times; and so does one a later process commits for an ask whose row never came", async (t) => {
  const root = await scratch(t);
  const entries = [];
  const note = async (kind, data) => void entries.push({ kind, data });
  const grant = async () => ({ drop() {} });
  const first = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, personTime: grant, note });
  t.after(() => first.close());
  const asked = await first.handoff.request(ask(61, "ar-run-61-1"));
  const record = openAsk(root);
  assert.equal(record?.id, asked.interactionId, "the ask waits");
  // The server's reader (browser-commands.ts waitingAsk) needs every one of these; the timeline reads `reason`.
  const whole = { state: "waiting", id: asked.interactionId, session: "ar-run-61-1", instruction: "Do thing 61", completion_condition: "thing 61 is done", asked_at: record.asked_at, expires_at: record.expires_at, reason: "Do thing 61" };
  const handovers = () => entries.filter((entry) => entry.kind === "agent.handover").map((entry) => entry.data);
  assert.deepEqual(handovers(), [whole], "the ask's entry is the whole record");
  first.close();
  // A later process takes the ask up and finds no waiting row for it (the earlier one ended between record and row).
  const later = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, personTime: grant, note, waiting: async () => 0 });
  t.after(() => later.close());
  assert.deepEqual(await later.handoff.request(ask(61, "ar-run-61-1")), { interactionId: asked.interactionId });
  assert.deepEqual(handovers(), [whole, whole], "the row committed for it is the whole record too");
});

/** The run's process on the runner's path: its hand-over answers are entries of the run's journal (`journal`, the
 *  hand-over entries' data in order, shared by every process of the run), read through `answered` (the first answer
 *  for an ask is its answer), never the answer files. Its other rows are `rows`. */
function journalHands(root, journal, { gates = () => ({ give: () => false }) } = {}) {
  const rows = [];
  const person = personHands({
    root, gates, pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => void (kind === "agent.handover" ? journal.push(data) : rows.push(data.summary)),
    answered: async (id) => {
      const first = journal.find((data) => data.id === id && ["done", "cancelled", "expired"].includes(data.state));
      return first && { outcome: first.state, at: first.at, ...(first.reason ? { reason: first.reason } : {}) };
    },
  });
  return { person, rows };
}
const answers = (journal) => journal.filter((data) => data.state !== "waiting");
const T0 = "2001-02-03T04:05:06.007Z";

test("on the runner's path a journal answer resolves the agent's wait with that outcome, the first for the ask: an answer file is not read", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const { person, rows } = journalHands(root, journal);
  t.after(() => person.close());
  const { interactionId: id } = await person.handoff.request(ask(71, "ar-run-71-1"));
  // An answer on disk (the server's old route): not this path's.
  assert.deepEqual(answerAsk(root, "done"), { outcome: "done", first: true });
  assert.equal(await person.handoff.outcome(id), "pending", "the answer file is not read");
  journal.push({ state: "cancelled", id, session: "ar-run-71-1", at: T0 }, { state: "done", id, session: "ar-run-71-1", at: "2001-02-03T04:06:00.000Z" });
  assert.equal(await person.handoff.outcome(id), "cancelled", "the journal's first answer");
  assert.equal(await person.handoff.outcome(id), "cancelled");
  assert.deepEqual(rows, ["You cancelled the agent's hand-over"], "its one row");
  assert.equal(answers(journal).length, 2, "nothing more written");
});

test("on the runner's path an ask that lapsed is answered by its expiry in the journal, at the expiry's time, and the wait hears expired", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const before = journalHands(root, journal);
  const { interactionId: id } = await before.person.handoff.request(ask(72, "ar-run-72-1"));
  before.person.close();
  // Past its expiry when the next process takes it up.
  const file = join(root, "browser-ask", `${id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expires_at: T0 }), { mode: 0o600 });
  const after = journalHands(root, journal);
  t.after(() => after.person.close());
  assert.equal(await after.person.handoff.outcome(id), "expired");
  assert.deepEqual(answers(journal), [{ state: "expired", id, session: "ar-run-72-1", at: T0 }], "the expiry, at its own time");
  assert.deepEqual(after.rows, ["The agent's hand-over expired before you answered it"]);
  assert.equal(await after.person.handoff.outcome(id), "expired");
  assert.equal(answers(journal).length, 1, "written once");
});

test("on the runner's path the person handing the browser back from the live view answers the session's ask done in the journal, once", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const { person, rows } = journalHands(root, journal);
  t.after(() => person.close());
  const tag = "ar-run-73-1";
  const { interactionId: id } = await person.handoff.request(ask(73, tag));
  const taken = await person.take(tag);
  taken.started();
  taken.end("given");
  assert.equal(await person.handoff.outcome(id), "done");
  const [answer, ...more] = answers(journal);
  assert.deepEqual(more, [], "one answer");
  assert.deepEqual({ ...answer, at: typeof answer?.at }, { state: "done", id, session: tag, at: "string" }, "the live view's hand-back, in the journal");
  assert.ok(Number.isFinite(Date.parse(answer.at)), answer.at);
  assert.deepEqual(rows, ["You took over the browser", "You handed the browser back"]);
});
