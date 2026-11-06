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
  gates(tag).take((why) => { ends.push(why); take.end(why); });
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
    gates(tag).take((why) => take.end(why));
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
  gates(tag).take((why) => take.end(why));
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
  gates(tag).take((why) => { ends.push(why); take.end(why); });
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
  gates(tag).take((why) => take.end(why));
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
  gates(tag).take((why) => { ends.push(why); take.end(why); });
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
