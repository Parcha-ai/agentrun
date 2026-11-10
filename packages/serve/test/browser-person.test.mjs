// The person's turns with a run's browser, in the run's process and in the server (browser-person.ts), without a run: the
// ask's record and its answer, and the person's time held under the cap. The cap, the gates and the clock are fakes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerAsk, askShown, openAsk, pendingOfWaiting, personHands } from "../dist/browser-person.js";
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

/** The run's process on the runner's path: its hand-over entries are the run's journal (`journal`, the hand-over
 *  entries' data in order, shared by every process of the run): an ask is its waiting entry, read through `asked`, and
 *  its answer the first answered entry, read through `answered`. No file is read or written. Its other rows are `rows`. */
function journalHands(root, journal, { gates = () => ({ give: () => false }) } = {}) {
  const rows = [];
  /** Every note, in order, as the run's root entries the timeline reads. */
  const entries = [];
  const person = personHands({
    root, gates, pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => {
      entries.push({ kind, id: 100 + entries.length, conversationId: 1, data });
      if (kind === "agent.handover") journal.push(data);
      else rows.push(data.summary);
    },
    answered: async (id) => {
      const first = journal.find((data) => data.id === id && ["done", "cancelled", "expired"].includes(data.state));
      return first && { outcome: first.state, at: first.at, ...(first.reason ? { reason: first.reason } : {}) };
    },
    asked: async (id) => askedIn(journal, id),
  });
  return { person, rows, entries };
}
/** Ask `id` as `journal`'s waiting entry holds it. */
const askedIn = (journal, id) => {
  for (const data of journal) {
    const found = pendingOfWaiting(data, id);
    if (found) return found;
  }
  return undefined;
};
/** Ask `id`, asked long ago: its waiting entry in `journal` expired at T0 (as a later process finds it). */
const lapse = (journal, id) => void (journal.find((data) => data.id === id && data.state === "waiting").expires_at = T0);
const answers = (journal) => journal.filter((data) => data.state !== "waiting");
const T0 = "2001-02-03T04:05:06.007Z";

test("on the runner's path a journal answer resolves the agent's wait with that outcome, the first for the ask: an answer file is not read", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const { person, rows } = journalHands(root, journal);
  t.after(() => person.close());
  const { interactionId: id } = await person.handoff.request(ask(71, "ar-run-71-1"));
  // An answer on disk where the per-run process kept them, planted: not this path's.
  plant(root, id, { id, tag: "ar-run-71-1", instruction: "x", completion_condition: "y", asked_at: T0, expires_at: "2999-01-01T00:00:00.000Z" }, { outcome: "done", at: T0 });
  assert.equal(await person.handoff.outcome(id), "pending", "the answer file is not read");
  journal.push({ state: "cancelled", id, session: "ar-run-71-1", at: T0 }, { state: "done", id, session: "ar-run-71-1", at: "2001-02-03T04:06:00.000Z" });
  assert.equal(await person.handoff.outcome(id), "cancelled", "the journal's first answer");
  assert.equal(await person.handoff.outcome(id), "cancelled");
  assert.deepEqual(rows, ["You cancelled the agent's hand-over"], "its one row");
  assert.equal(answers(journal).length, 2, "nothing more written");
});

/** Files planted where the per-run process kept an ask's record and answer (`<root>/browser-ask`, 0600 in 0700, as it
 *  wrote them): what a run's agent could write into its own folder. */
function plant(root, id, record, answer) {
  const dir = join(root, "browser-ask");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
  if (answer) writeFileSync(join(dir, `${id}.answer.json`), JSON.stringify(answer), { mode: 0o600 });
}

test("on the runner's path an ask writes no file under the run's folder: its waiting entry in the journal is its one record; a record or answer planted there changes nothing", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const { person, rows } = journalHands(root, journal);
  t.after(() => person.close());
  const tag = "ar-run-79-1";
  const { interactionId: id } = await person.handoff.request(ask(79, tag));
  assert.deepEqual(readdirSync(root), [], "nothing under the run's folder: the agent's file tools and its file list find no ask");
  assert.equal(askedIn(journal, id)?.tag, tag, "the waiting entry is the ask");
  // Planted as the agent could: its own record, lapsed, and an answer, for this ask and for one never asked.
  const ghost = "G".repeat(32);
  plant(root, id, { id, tag, instruction: "planted", completion_condition: "planted", asked_at: T0, expires_at: T0 }, { outcome: "cancelled", at: T0 });
  plant(root, ghost, { id: ghost, tag, instruction: "a ghost", completion_condition: "planted", asked_at: T0, expires_at: "2999-01-01T00:00:00.000Z" }, { outcome: "done", at: T0 });
  assert.equal(await person.handoff.outcome(id), "pending", "neither the planted answer nor the planted expiry ends the wait");
  assert.equal(await person.handoff.outcome(ghost), "pending", "a planted ask is no ask: nothing taken up, nothing answered");
  assert.deepEqual(answers(journal), [], "nothing written for either");
  // The person's hand-back from the live view answers the real ask, never the planted one.
  const taken = await person.take(tag);
  taken.started();
  taken.end("given");
  assert.equal(await person.handoff.outcome(id), "done");
  assert.deepEqual(answers(journal).map((data) => [data.state, data.id]), [["done", id]], "one answer, the real ask's");
  assert.equal(existsSync(join(root, "browser-ask", `${id}.answer.json`)), true, "the planted file is left as it was, unread");
  assert.deepEqual(rows, ["You took over the browser", "You handed the browser back"]);
});

test("on the runner's path an ask that lapsed is answered by its expiry in the journal, at the expiry's time, and the wait hears expired", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const before = journalHands(root, journal);
  const { interactionId: id } = await before.person.handoff.request(ask(72, "ar-run-72-1"));
  before.person.close();
  // Past its expiry when the next process takes it up.
  lapse(journal, id);
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

test("on the runner's path a person's answer that lands as this process writes the ask's expiry stands alone: one answered entry, and the wait hears the person's", async (t) => {
  const root = await scratch(t);
  const journal = [];
  const firstOf = (id) => journal.find((data) => data.id === id && ["done", "cancelled", "expired"].includes(data.state));
  const toAnswer = (data) => ({ outcome: data.state, at: data.at, ...(data.reason ? { reason: data.reason } : {}) });
  let lands = () => {};
  /** The process on `root`, its journal's writes as the run's commits make them: the person's answer (`lands`) is
   *  committed just before this process's own answer, after every read it made. `answer` reads and writes in one commit. */
  const hands = () => personHands({
    root, gates: () => ({ give: () => false }), pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => {
      if (kind === "agent.handover" && data.state !== "waiting") lands();
      if (kind === "agent.handover") journal.push(data);
    },
    answered: async (id) => (firstOf(id) ? toAnswer(firstOf(id)) : undefined),
    asked: async (id) => askedIn(journal, id),
    answer: async (id, data) => {
      lands();
      const found = firstOf(id);
      if (found) return toAnswer(found);
      journal.push(data);
      return toAnswer(data);
    },
  });
  const before = hands();
  const { interactionId: id } = await before.handoff.request(ask(76, "ar-run-76-1"));
  before.close();
  lapse(journal, id);
  let landed = false;
  lands = () => {
    if (landed) return;
    landed = true;
    journal.push({ state: "cancelled", id, session: "ar-run-76-1", at: "2001-02-03T04:05:00.000Z" });
  };
  const after = hands();
  t.after(() => after.close());
  assert.equal(await after.handoff.outcome(id), "cancelled", "the person's answer, committed first, is the ask's");
  assert.deepEqual(answers(journal), [{ state: "cancelled", id, session: "ar-run-76-1", at: "2001-02-03T04:05:00.000Z" }], "exactly one answered entry");
});

test("on the runner's path the row an answer writes shows at the answered entry's time on the timeline: the person's, or the expiry's when the ask lapsed", async (t) => {
  const { timelineOf } = await import("@parcha/pi-durable-agent/timeline");
  /** The timeline row that says `summary`, over a run's entries: its kind and time. */
  const rowSaying = (entries, summary) => {
    const row = timelineOf(entries).find((each) => each.summary === summary);
    return row && { kind: row.kind, timestamp: row.timestamp };
  };
  const root = await scratch(t);
  const journal = [];
  const answeredHands = journalHands(root, journal);
  t.after(() => answeredHands.person.close());
  const { interactionId: id } = await answeredHands.person.handoff.request(ask(74, "ar-run-74-1"));
  journal.push({ state: "cancelled", id, session: "ar-run-74-1", at: T0 });
  assert.equal(await answeredHands.person.handoff.outcome(id), "cancelled");
  assert.deepEqual(rowSaying(answeredHands.entries, "You cancelled the agent's hand-over"), { kind: "phase", timestamp: T0 }, "the person's answer's time, on its row");

  const lapsedRoot = await scratch(t);
  const lapsedJournal = [];
  const before = journalHands(lapsedRoot, lapsedJournal);
  const { interactionId: lapsed } = await before.person.handoff.request(ask(75, "ar-run-75-1"));
  before.person.close();
  lapse(lapsedJournal, lapsed);
  const after = journalHands(lapsedRoot, lapsedJournal);
  t.after(() => after.person.close());
  assert.equal(await after.person.handoff.outcome(lapsed), "expired");
  assert.deepEqual(rowSaying([...before.entries, ...after.entries], "The agent's hand-over expired before you answered it"), { kind: "phase", timestamp: T0 }, "the expiry's time, on its row");
});

test("a take-over in the run's timeline reads as it happened (Manuel's walk of #1703): the take and the hand-back at their own times, the agent's call parked behind the hold between them, saying it waited for the person and how long", async (t) => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const { HOST_PHASE, timelineOf } = await import("@parcha/pi-durable-agent/timeline");
  const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
  const clock = fakeClock(T0);
  const tag = "ar-run-61-1";
  const gates = createDrivingGates({ timers: clock.timers });
  // The run's log, as its store keeps it: the server's notes in the order they are committed, the agent's own entries
  // as pi writes them (a model message at its request's start, a tool's result at its end).
  let id = 1;
  const log = [];
  const entry = (kind, model, data) => log.push({ kind, id: id++, conversationId: 1, ...(model ? { model: [model] } : {}), ...(data ? { data } : {}) });
  const person = personHands({
    root: await scratch(t), gates, timers: clock.timers, now: clock.now, pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => void entry(kind, undefined, data),
  });
  t.after(() => person.close());
  const page = "https://www.bundesarchiv.de/DE/Navigation/Finden/finden.html";

  // 0 s: the agent's snapshot returns, and its next request starts. 1 s: the person takes the browser (the live view's
  // take, its hold started on the session's gate as the viewer's server starts it).
  entry("pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "snapshot", arguments: {} }], stopReason: "toolUse", timestamp: T0 - 3_000 });
  entry("pi.tool-result", { role: "toolResult", toolCallId: "c0", toolName: "snapshot", content: [{ type: "text", text: "[1] the page" }], isError: false, timestamp: T0 });
  const requested = T0 + 200;
  await clock.tick(1_000);
  const take = await person.take(tag);
  assert.ok(gates(tag).take((why) => take.end(why), () => take.started()));
  // The request's answer asks to open a page: the call parks behind the hold.
  entry("pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "run", arguments: { code: `await page.goto("${page}")` } }], stopReason: "toolUse", timestamp: requested });
  const parkedAt = clock.now();
  const parked = gates(tag).untilFree().then(() => clock.now() - parkedAt);
  // 12 s: the person hands back (the viewer's give); the call goes on, opens the page, and returns at 14.4 s with the wait
  // in its details, as pi-browser's driving guard writes it.
  await clock.tick(11_000);
  gates(tag).give("given");
  const waited = await parked;
  await clock.tick(2_400);
  entry("pi.tool-result", { role: "toolResult", toolCallId: "c1", toolName: "run", content: [{ type: "text", text: "{\"ok\":true}" }], isError: false, details: { waited_for_person_ms: waited }, timestamp: clock.now() });
  await sleep(5);

  const rows = timelineOf(log, { settled: true });
  const told = rows.filter((row) => ["You took over the browser", "You handed the browser back"].includes(row.summary) || (row.kind === "tool_use" && row.tool_name === "run"));
  const at = (s) => new Date(T0 + s * 1000).toISOString();
  assert.deepEqual(told.map((row) => row.summary.replace(/ www\..*$/, "")), ["You took over the browser", "Waited for you 11 s, then opened", "You handed the browser back"], "in the order it happened, the call saying it waited");
  assert.deepEqual([told[0].timestamp, told[2].timestamp], [at(1), at(12)], "the take and the hand-back each at its own time: the hold reads 11 s, as long as it was");
  assert.ok(log.filter((e) => e.kind === HOST_PHASE).every((e) => typeof e.data.at === "number"), "each phase note carries its time");
});

test("the hand-back row of a give that answers the session's open ask is at the hand-back's time; one the console's Done answers, at the answer's", async (t) => {
  const clock = fakeClock(Date.UTC(2026, 10, 3, 9, 0, 0));
  const notes = [];
  const root = await scratch(t);
  const person = personHands({
    root, gates: () => ({ give: () => false }), timers: clock.timers, now: clock.now, pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => void notes.push({ kind, ...data }),
  });
  t.after(() => person.close());
  const asked = await person.handoff.request(ask(62, "ar-run-62-1"));
  const take = await person.take("ar-run-62-1");
  await clock.tick(1_000);
  take.started();
  await clock.tick(9_000);
  take.end("given");
  assert.equal(await person.handoff.outcome(asked.interactionId), "done");
  const phases = notes.filter((note) => note.kind === "agentrun.phase").map((note) => [note.summary, note.at - clock.now()]);
  assert.deepEqual(phases, [["You took over the browser", -9_000], ["You handed the browser back", 0]]);

  // The console's Done, answered at its own time: this process reads it a minute later and writes the row at the answer's.
  notes.length = 0;
  const other = await person.handoff.request(ask(63, "ar-run-63-1"));
  const doneAt = clock.now() + 5_000;
  assert.deepEqual(answerAsk(root, "done", doneAt), { outcome: "done", first: true });
  await clock.tick(60_000);
  assert.equal(await person.handoff.outcome(other.interactionId), "done");
  assert.deepEqual(notes.filter((note) => note.kind === "agentrun.phase").map((note) => [note.summary, note.at]), [["You handed the browser back", doneAt]]);
});

/** A run's process side on `root` that records every person-time hold it asks for (`what`, `seconds`, `from`), and can
 *  refuse while `refuse` is set: the clock, timers and gates are the caller's. */
function recordingHands(root, { timers, now, holdMs }) {
  const calls = [];
  const state = { refuse: null };
  const person = personHands({
    root, gates: () => ({ give: () => false }), timers, now, holdMs, pollMs: 60_000,
    personTime: async (what, seconds, options = {}) => {
      calls.push({ what, seconds, from: options.from });
      if (state.refuse) return { refused: state.refuse };
      return { drop() {} };
    },
    note: async () => {},
  });
  return { person, calls, state };
}

test("a re-hold after the cap refused starts from max(where coverage ends, now): the idle gap since it lapsed is not held again", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const { person, calls, state } = recordingHands(root, { timers: clock.timers, now: clock.now, holdMs });
  t.after(() => person.close());
  const tag = "ar-run-rehold-1";
  // The take holds the first stretch from t=0; its coverage reaches holdMs.
  const take = await person.take(tag);
  assert.ok("end" in take);
  assert.equal(calls.at(-1).from, 0, "the first hold is from now");
  // At holdMs the re-hold is refused: the ledger is marked refused, its coverage still ending at holdMs.
  state.refuse = "spend_cap_reached: no room";
  await clock.tick(holdMs);
  assert.equal(calls.at(-1).from, holdMs, "again() re-holds from where coverage ends (equal to now here), not from the past");
  // 100 s pass past the lapse; a newcomer (an ask) joins with room again and re-holds the refused ledger. The gap
  // [until, now] is idle time with no users, already covered by the reserve and calls, so it is not held again: the
  // re-hold is a bare holdMs from now. Holding from `until` (the earlier bug) would hold that idle gap twice and could
  // falsely refuse a person returning long after a refusal.
  state.refuse = null;
  await clock.tick(100_000);
  await person.handoff.request(ask(1, tag));
  const rehold = calls.at(-1);
  assert.equal(rehold.from, clock.now(), `the re-hold starts from now, not the lapsed coverage end: ${JSON.stringify(rehold)}`);
  assert.equal(rehold.seconds, holdMs / 1000, "a bare window from now");
});

test("a person returning long after a refusal is held, not refused, when the cap has room for exactly one window", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const calls = [];
  // The cap has room for exactly one window (holdMs of seconds): a hold is granted only when it asks for no more.
  let refuseAll = false;
  const window = holdMs / 1000;
  const person = personHands({
    root, gates: () => ({ give: () => false }), timers: clock.timers, now: clock.now, holdMs, pollMs: 60_000,
    personTime: async (what, seconds, options = {}) => {
      calls.push({ what, seconds, from: options.from });
      if (refuseAll || seconds > window + 1e-9) return { refused: "spend_cap_reached: no room" };
      return { drop() {} };
    },
    note: async () => {},
  });
  t.after(() => person.close());
  const tag = "ar-run-rehold-3";
  await person.take(tag);
  // The re-hold at holdMs is refused: the ledger is marked refused.
  refuseAll = true;
  await clock.tick(holdMs);
  // Thirty minutes later, with room again for exactly one window, a person comes back. Held from now (one window);
  // starting from the lapsed coverage end would ask for the window plus the 30 idle minutes and be refused.
  refuseAll = false;
  await clock.tick(30 * 60_000);
  const asked = await person.handoff.request(ask(3, tag));
  assert.ok("interactionId" in asked, `held, not refused: ${JSON.stringify(asked)}`);
});

test("two newcomers on a refused ledger in one tick re-hold the person's time once, not once each", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const { person, calls, state } = recordingHands(root, { timers: clock.timers, now: clock.now, holdMs });
  t.after(() => person.close());
  const tag = "ar-run-rehold-2";
  await person.take(tag);
  state.refuse = "spend_cap_reached: no room";
  await clock.tick(holdMs);
  state.refuse = null;
  const before = calls.length;
  // Two newcomers at once on the refused ledger: an ask and a second take-over, racing through the same turn.
  await Promise.all([person.handoff.request(ask(2, tag)), person.take(tag)]);
  const reholds = calls.slice(before).filter((call) => call.seconds > 0);
  assert.equal(reholds.length, 1, `the refused ledger is re-held once for both newcomers: ${JSON.stringify(calls.slice(before))}`);
});

test("a refusal-path re-hold while coverage still runs past now holds from where it ends, so [now, until] is not held twice", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const { person, calls, state } = recordingHands(root, { timers: clock.timers, now: clock.now, holdMs });
  t.after(() => person.close());
  const tag = "ar-run-rehold-4";
  // The take holds [0, holdMs]; its again() timer is set to fire at holdMs.
  await person.take(tag);
  // Five minutes in, an ask extends coverage to now + holdMs (1,200,000), past where the again() timer fires.
  await clock.tick(5 * 60_000); // now = 300,000
  await person.handoff.request(ask(4, tag)); // reach 1,200,000 > until 900,000: until becomes 1,200,000
  // The again() timer fires at 900,000 with coverage still reaching to 1,200,000; its re-hold of the tail is refused, so the
  // ledger is marked refused while until (1,200,000) is still ahead of now (900,000).
  state.refuse = "spend_cap_reached: no room";
  await clock.tick(10 * 60_000); // now = 900,000; again() fires and is refused
  state.refuse = null;
  const before = calls.length;
  // A newcomer joins the refused ledger while coverage still runs past now.
  await person.take(tag);
  const rehold = calls.slice(before).find((call) => call.seconds > 0);
  assert.ok(rehold, `a re-hold happened: ${JSON.stringify(calls.slice(before))}`);
  // Held from where coverage ends (until), not from now, for now + holdMs - until seconds: the already-covered gap
  // [now, until] is never held a second time.
  assert.equal(rehold.from, 1_200_000, "from where coverage ends (until), not from now");
  assert.equal(rehold.seconds, (clock.now() + holdMs - 1_200_000) / 1000, "for now + holdMs - until seconds");
});

test("a wait in the claim on the person's answer (ask_person with the browser open) holds the person's time on each open session under the cap, never pausing the run; it shares a take-over's hold; drop lets it go once", async (t) => {
  const root = await scratch(t);
  const seen = [];
  const { person, held } = hands(root);
  const person2 = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, note: async () => {}, personTime: async (what, _seconds, options) => { seen.push([what, options?.pauses ?? true]); return { drop: () => {} }; } });
  t.after(() => { person.close(); person2.close(); });
  await person2.wait("call-1", ["ar-run-30-1"]);
  assert.deepEqual(seen, [["keeping the browser open while you answer", false]], "held in its own words, and a refusal pauses nothing");
  // Two sessions open: each held once; a take-over of one shares its hold.
  const waited = await person.wait("call-2", ["ar-run-31-1", "ar-run-31-2", "ar-run-31-1"]);
  assert.ok("lapsed" in waited);
  assert.equal(held.taken, 2, "one hold per open session");
  const take = await person.take("ar-run-31-1");
  assert.ok("end" in take);
  assert.equal(held.taken, 2, "the take-over shares the wait's hold");
  waited.drop();
  assert.equal(held.dropped, 1, "the session no one else needs is let go; the taken one stays held");
  waited.drop();
  assert.equal(held.dropped, 1, "drop lets go once");
  take.end("given");
  assert.equal(held.dropped, 2, "the last one out drops the shared hold");
});

test("a wait in the claim with no room under the cap is refused in the cap's words, holding nothing", async (t) => {
  const root = await scratch(t);
  const { person, held } = hands(root);
  t.after(() => person.close());
  held.refuse = "spend_cap_reached: no room for your time";
  assert.deepEqual(await person.wait("call-3", ["ar-run-32-1"]), { refused: held.refuse });
  assert.equal(held.taken, 0);
});

/** Whether `promise` has settled, without waiting on it. */
const settledNow = async (promise) => Promise.race([promise.then(() => true), sleep(0).then(() => false)]);

test("a wait in the claim is bounded as a hand-over's ask is: at holdMs it lapses, and the person's time to then is carried to the session's next charge", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const carried = [];
  let taken = 0;
  const person = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, note: async () => {}, timers: clock.timers, holdMs, now: clock.now, carry: (tag, seconds) => carried.push([tag, seconds]), personTime: async () => { taken += 1; return { drop: () => {} }; } });
  t.after(() => person.close());
  const waited = await person.wait("call-4", ["ar-run-33-1"]);
  await clock.tick(holdMs - 1);
  assert.equal(await settledNow(waited.lapsed), false, "still waiting just before the bound");
  await clock.tick(1);
  assert.equal(await waited.lapsed, "the person did not answer within 15 minutes, the bound a browser hand-over waits");
  waited.drop();
  assert.deepEqual(carried, [["ar-run-33-1", holdMs / 1000]], "the time the wait held the session to its bound is carried to the session's next charge");
  assert.ok(taken >= 1);
});

test("a wait in the claim that shares a take-over's session lapses in the cap's words when the take-over's re-hold is refused", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock();
  const holdMs = 15 * 60_000;
  const { person, held } = hands(root, { timers: clock.timers, holdMs, now: clock.now });
  t.after(() => person.close());
  const tag = "ar-run-35-1";
  const take = await person.take(tag);
  await clock.tick(10 * 60_000);
  const waited = await person.wait("call-6", [tag]);
  assert.equal(held.taken, 2, "the wait holds the stretch past the take-over's, through its own bound");
  held.refuse = "spend_cap_reached: no room for more of your time";
  await clock.tick(5 * 60_000);
  assert.equal(await waited.lapsed, held.refuse, "the refused re-hold ends the wait, in the cap's words");
  waited.drop();
  take.end("cap");
});

test("a wait in the claim lapses when a session it keeps is let go", async (t) => {
  const root = await scratch(t);
  const { person } = hands(root);
  t.after(() => person.close());
  const gone = await person.wait("call-5", ["ar-run-34-1", "ar-run-34-2"]);
  person.sessionEnded("ar-run-99-1");
  assert.equal(await settledNow(gone.lapsed), false, "another session's release is not this wait's");
  person.sessionEnded("ar-run-34-2");
  assert.match(await gone.lapsed, /browser session it kept open for the person was let go/);
  gone.drop();
});

test("a wait in the claim taken up again (a re-claim) keeps its first start: its bound is from then, and one past its bound is refused at once", async (t) => {
  const root = await scratch(t);
  const clock = fakeClock(100 * 60_000);
  const holdMs = 15 * 60_000;
  const { person, held } = hands(root, { timers: clock.timers, holdMs, now: clock.now });
  t.after(() => person.close());
  const since = clock.now() - 10 * 60_000;
  const waited = await person.wait("call-7", ["ar-run-36-1"], since);
  assert.ok("lapsed" in waited);
  await clock.tick(5 * 60_000 - 1);
  assert.equal(await settledNow(waited.lapsed), false, "still waiting just before its first start's bound");
  await clock.tick(1);
  assert.match(await waited.lapsed, /did not answer within 15 minutes/, "lapsed at its first start's bound, not 15 minutes after the re-claim");
  waited.drop();
  const taken = held.taken;
  assert.deepEqual(await person.wait("call-8", ["ar-run-36-2"], clock.now() - holdMs), { refused: "the person did not answer within 15 minutes, the bound a browser hand-over waits" }, "past its bound: refused, nothing held");
  assert.equal(held.taken, taken);
});

test("a session let go while a wait's hold is being admitted still ends the wait", async (t) => {
  const root = await scratch(t);
  let admit = () => {};
  const person = personHands({ root, gates: () => ({ give: () => false }), pollMs: 60_000, note: async () => {}, personTime: () => new Promise((resolve) => (admit = () => resolve({ drop: () => {} }))) });
  t.after(() => person.close());
  const waiting = person.wait("call-9", ["ar-run-37-1"]);
  await sleep(5);
  person.sessionEnded("ar-run-37-1");
  admit();
  const waited = await waiting;
  assert.ok("lapsed" in waited);
  assert.match(await Promise.race([waited.lapsed, sleep(200).then(() => "still waiting")]), /let go/, "the release that came during the admission ends the wait");
  waited.drop();
});
