import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptionDesk, captionFor, captionsFor, claimsZeroLoss } from "../page/caption.ts";
import { fold } from "../reduce.ts";
import type { NoteKind, ShowEvent } from "../types.ts";

const run = (source?: "live" | "scripted"): ShowEvent => ({ t: "run", at: 0, run: "r", origin: 0, environments: [], ...(source ? { source } : {}) });
const note = (at: number, kind: NoteKind, text: string, measured?: boolean): ShowEvent => ({ t: "note", at, kind, text, ...(measured === undefined ? {} : { measured }) });

test("a scripted feed's numbers are tagged scripted, never measured, even if the text says measured", () => {
  const s = fold([run("scripted"), note(1000, "takeover", "spare took over in 2.0 s (measured)")]);
  assert.deepEqual(captionFor(s, 2000), { text: "spare took over in 2.0 s", tag: "scripted", at: 1000 });
});

test("a live feed's number is measured only when the driver flagged it or said so", () => {
  const flagged = fold([run("live"), note(1000, "takeover", "took over in 1267 ms", true)]);
  assert.equal(captionFor(flagged, 1500)?.tag, "measured");
  const said = fold([run(), note(1000, "takeover", "took over: run open 1267 ms after the kill (measured).")]);
  assert.equal(captionFor(said, 1500)?.tag, "measured");
  assert.doesNotMatch(captionFor(said, 1500)!.text, /measured/);
  const bare = fold([run("live"), note(1000, "takeover", "took over in about two seconds, 2 s")]);
  assert.equal(captionFor(bare, 1500)?.tag, "unmeasured");
});

test("a line with no number needs no tag, and a feed with no source is live", () => {
  const s = fold([run(), note(1000, "kill", "Modal GPU 6 was killed.")]);
  assert.equal(captionFor(s, 1200)?.tag, null);
});

test("the newest key moment wins, plain story lines are skipped, and a caption expires", () => {
  const s = fold([run("live"), note(1000, "kill", "A was killed."), note(2000, "story", "Forking the agent."), note(3000, "takeover", "B took over", true)]);
  assert.equal(captionFor(s, 3500)?.text, "B took over");
  const onlyStory = fold([run("live"), note(1000, "story", "Forking the agent.")]);
  assert.equal(captionFor(onlyStory, 1500), null);
  assert.equal(captionFor(s, 3000 + 7001), null);
});

test("a measured story line (a fan-out time) is captioned too", () => {
  const s = fold([run("live"), note(1000, "story", "Eight machines running 14.2 s after fan-out", true)]);
  assert.deepEqual(captionFor(s, 1100), { text: "Eight machines running 14.2 s after fan-out", tag: "measured", at: 1000 });
});

test("the agent's words are quoted and tagged agent, never measured, and a long one is cut", () => {
  const long = `The agent says: ${"x".repeat(400)} 8 GB`;
  const s = fold([run("live"), note(1000, "agent", long)]);
  const c = captionFor(s, 1500)!;
  assert.equal(c.tag, "agent");
  assert.ok(c.text.length <= 220 && c.text.endsWith("…"));
  const scripted = fold([run("scripted"), note(1000, "agent", "The agent says: I am on a second machine, 4 vCPU, 8 GB")]);
  assert.equal(captionFor(scripted, 1500)?.tag, "agent", "a scripted feed has no agent, but a note of the agent's words is still quoted speech");
});

test("captions stack: the measured switch time stays up when the agent's notice and answer arrive, and each expires on its own", () => {
  const s = fold([run("live"), note(1000, "switch", "Switched to Second host in 710 ms (timed by the server).", true), note(1400, "agent", "The agent was told: you are now running in a second host."), note(4500, "agent", "The agent says: Linux, 48 CPUs.")]);
  assert.deepEqual(captionsFor(s, 4600).map((c) => c.tag), ["measured", "agent", "agent"]);
  assert.deepEqual(captionsFor(s, 8100).map((c) => c.tag), ["agent", "agent"], "the measured one expired 7 s after it appeared; the others are still up");
  assert.deepEqual(captionsFor(s, 12_000).map((c) => c.tag), []);
  assert.equal(captionsFor(s, 4600, 2).length, 2, "at most max are shown, the newest ones");
  assert.equal(captionFor(s, 4600)?.text, "The agent says: Linux, 48 CPUs.");
});

// The evidence rule: a claim that nothing was lost is measured only on an independent read-back.
const zl = (text: string, extra: Record<string, unknown> = {}): ShowEvent => ({ t: "note", at: 1000, kind: "switch", text, ...extra }) as ShowEvent;
const tagOf = (e: ShowEvent, source: "live" | "scripted" = "live") => captionFor(fold([run(source), e]), 1100)?.tag;

test("a zero-loss claim flagged measured with no evidence, or on the pipe's own digest, is shown unmeasured, never measured", () => {
  const claim = "Moved to the second process: 0 acknowledged writes lost.";
  assert.equal(tagOf(zl(claim, { measured: true })), "unmeasured", "flagged, no evidence");
  assert.equal(tagOf(zl(claim, { measured: true, evidence: "pipe-released" })), "unmeasured", "the pipe's own release digest is not a read-back");
  assert.equal(tagOf(zl("Nothing was lost in the move.", { measured: true, evidence: "pipe-released" })), "unmeasured", "a claim with no number is held to the same rule");
  assert.equal(tagOf(zl(`${claim} (measured)`)), "unmeasured", "the words (measured) are not evidence either");
});

test("a zero-loss claim is measured on an independent read-back or on the chaos harness, and only then", () => {
  const claim = "Work read back after the move: 0 writes lost.";
  assert.equal(tagOf(zl(claim, { measured: true, evidence: "independent-readback" })), "measured");
  assert.equal(tagOf(zl("20 host kills, 0 acknowledged writes lost.", { measured: true, evidence: "chaos-harness" })), "measured");
  assert.equal(tagOf(zl(claim, { evidence: "independent-readback" })), "unmeasured", "evidence without the measured flag is still not a measurement claim");
});

test("every way of saying nothing was lost is held to the rule", () => {
  for (const text of ["0 acknowledged writes lost", "zero loss", "Zero-loss takeover", "no commits lost", "0 files lost", "nothing was lost", "moved without losing a write", "no data was lost", "no writes were lost", "0 commits was lost"]) {
    assert.ok(claimsZeroLoss(text), text);
    assert.equal(tagOf(zl(text, { measured: true })), "unmeasured", text);
  }
  for (const text of ["Switched in 700 ms.", "42 ms", "1 write was lost", "lost 3 writes"]) assert.ok(!claimsZeroLoss(text), text);
});

test("the rule does not touch other measured claims, and a scripted feed's zero-loss line stays scripted", () => {
  assert.equal(tagOf(zl("Switched in 700 ms (timed by the server).", { measured: true })), "measured");
  assert.equal(tagOf(zl("0 acknowledged writes lost.", { measured: true, evidence: "independent-readback" }), "scripted"), "scripted");
});

test("a duration beside a singular or plural loss claim is not measured without evidence", () => {
  const text = "Switched in 700 ms; no data was lost";
  assert.equal(tagOf(zl(text, { measured: true })), "unmeasured");
  assert.equal(tagOf(zl(text, { measured: true, evidence: "pipe-released" })), "unmeasured");
  assert.equal(tagOf(zl(text, { measured: true, evidence: "independent-readback" })), "measured");
  assert.equal(tagOf(zl("Switched in 700 ms; no writes were lost", { measured: true })), "unmeasured");
});

// v2: one caption at a time, held long enough to read.
const desk = (events: ShowEvent[]) => fold([run("live"), ...events]);

test("the desk shows one caption, holds it at least 4 s, then moves to the next moment in order", () => {
  const d = new CaptionDesk();
  const s = desk([note(1000, "switch", "Switched to H100 GPU in 822 ms (timed by the server).", true), note(1500, "home", "Checkpoint 1 arrived from the GPU.")]);
  assert.equal(d.update(s, 1000)?.text, "Switched to H100 GPU in 822 ms (timed by the server).");
  assert.equal(d.update(s, 1600)?.text, "Switched to H100 GPU in 822 ms (timed by the server).", "the second moment waits");
  assert.equal(d.update(s, 4900)?.text, "Switched to H100 GPU in 822 ms (timed by the server).", "still inside the hold");
  assert.equal(d.update(s, 5000)?.text, "Checkpoint 1 arrived from the GPU.");
});

test("a caption the desk has shown is not shown again, and it clears after the longest hold", () => {
  const d = new CaptionDesk();
  const s = desk([note(1000, "home", "It walks.")]);
  assert.equal(d.update(s, 1000)?.text, "It walks.");
  assert.equal(d.update(s, 5000)?.text, "It walks.", "kept until something replaces it, or the longest hold");
  assert.equal(d.update(s, 11_100), null);
  assert.equal(d.update(s, 11_200), null, "not shown again");
});

test("the agent's own lines are the chat's job, plain story lines are skipped, and history from before the page looked is not replayed", () => {
  const d = new CaptionDesk();
  const s = desk([note(100, "home", "Old news."), note(30_000, "agent", "The agent says: hello"), note(30_100, "story", "A log line."), note(30_200, "kill", "Something happened.")]);
  assert.equal(d.update(s, 30_300)?.text, "Something happened.");
});

test("the desk keeps each caption's tag: a scripted feed's number stays scripted, and the zero-loss rule still applies", () => {
  const d = new CaptionDesk();
  const s = fold([run("scripted"), note(1000, "switch", "Moved in 0.8 s.")]);
  assert.equal(d.update(s, 1000)?.tag, "scripted");
  const d2 = new CaptionDesk();
  assert.equal(d2.update(desk([zl("No data was lost in 700 ms", { measured: true })]), 1100)?.tag, "unmeasured");
});

test("when the feed's clock goes backwards (a reset, a retake, a seek) the desk starts over instead of holding an old caption", () => {
  const d = new CaptionDesk();
  assert.equal(d.update(desk([note(26_000, "home", "Checkpoint 1 arrived from the GPU.")]), 26_000)?.text, "Checkpoint 1 arrived from the GPU.");
  assert.equal(d.update(desk([]), 13_000), null, "the new timeline has not got there yet");
  const again = desk([note(26_000, "home", "Checkpoint 1 arrived from the GPU.")]);
  assert.equal(d.update(again, 26_000)?.text, "Checkpoint 1 arrived from the GPU.", "and when it does, the moment is news again");
});

test("a reset after the last caption has expired still makes the same moments news again", () => {
  const d = new CaptionDesk();
  const s = desk([note(26_000, "home", "Checkpoint 1 arrived from the GPU.")]);
  assert.equal(d.update(s, 26_000)?.text, "Checkpoint 1 arrived from the GPU.");
  assert.equal(d.update(s, 40_000), null, "expired");
  assert.equal(d.update(desk([]), 5_000), null, "the clock went back");
  assert.equal(d.update(s, 26_500)?.text, "Checkpoint 1 arrived from the GPU.");
});

test("when moments pile up the desk catches up: the ones already old are skipped, so the news is not stuck behind a backlog", () => {
  const d = new CaptionDesk();
  const s = desk([note(1000, "home", "one"), note(2000, "home", "two"), note(3000, "home", "three"), note(10_000, "home", "Wi-Fi is off.")]);
  assert.equal(d.update(s, 10_500)?.text, "three", "the two that are over 8 s old are skipped; the oldest still fresh is shown");
  assert.equal(d.update(s, 14_600)?.text, "Wi-Fi is off.", "and the next one follows when the hold is over");
  const lone = new CaptionDesk();
  assert.equal(lone.update(desk([note(1000, "home", "only news")]), 12_000)?.text, "only news", "a single late moment is still shown");
});

test("a caption a viewer needs outranks tab chatter that arrived in the same burst", () => {
  const d = new CaptionDesk();
  const burst = fold([
    run("live"),
    note(9_000, "home", "The trained brain was installed in your browser in 15 ms (timed in the tab)."),
    note(9_010, "home", "It trained for 668 s before coming home."),
    { t: "note", at: 9_050, kind: "home", text: "Done training. The agent came back to your browser, and so did what it learned.", rank: 2 } as ShowEvent,
    note(9_100, "home", "Knocked over. It learned to get back up."),
  ]);
  assert.equal(d.update(burst, 9_200)?.text, "Done training. The agent came back to your browser, and so did what it learned.");
  assert.equal(d.update(burst, 13_300)?.text, "The trained brain was installed in your browser in 15 ms (timed in the tab).", "then the rest in order, while they are still news");
});

test("rank only orders what is waiting: a lower one is not shown ahead of a higher one, and equal ranks keep their order", () => {
  const d = new CaptionDesk();
  const s = fold([run("live"), note(1000, "home", "first"), note(1100, "home", "second"), { t: "note", at: 1200, kind: "home", text: "urgent", rank: 1 } as ShowEvent, { t: "note", at: 1300, kind: "home", text: "also urgent", rank: 1 } as ShowEvent]);
  assert.equal(d.update(s, 1400)?.text, "urgent");
  assert.equal(d.update(s, 5500)?.text, "also urgent");
  assert.equal(d.update(s, 9600)?.text, "second", "by now both plain ones are old: the desk catches up to the newest of them, not the oldest");
});

test("a running counter takes the slot once the last caption has had its time and nothing else is waiting; not before", () => {
  const d = new CaptionDesk();
  const s = desk([note(1000, "home", "Moved on.")]);
  assert.equal(d.update(s, 1000, { yieldSlot: true })?.text, "Moved on.");
  assert.equal(d.update(s, 4900, { yieldSlot: true })?.text, "Moved on.", "inside its 4 s");
  assert.equal(d.update(s, 5000, { yieldSlot: true }), null, "its time is up and nothing else is waiting: the slot is free for the counter");
  assert.equal(d.update(s, 5200), null, "and it does not come back");
  const waiting = new CaptionDesk();
  const two = desk([note(1000, "home", "Moved on."), note(1200, "home", "Next.")]);
  waiting.update(two, 1300, { yieldSlot: true });
  assert.equal(waiting.update(two, 5400, { yieldSlot: true })?.text, "Next.", "something is waiting: it goes first");
});

// Latest wins within a group (the version captions): a queue would put the screen versions behind the creature (the caption says version 4 while
// version 7 is walking). A newer version replaces the version caption at once; the sparkline is the record of every version.
const version = (at: number, n: number): ShowEvent => ({ t: "note", at, kind: "home", text: `Version ${n} - walking - ${n}.0 m in 10 s`, group: "version" }) as ShowEvent;

test("seven versions one second apart: each replaces the version caption at once, and the last one is the one showing", () => {
  const d = new CaptionDesk();
  const events: ShowEvent[] = [];
  const shown: string[] = [];
  for (let n = 1; n <= 7; n++) {
    events.push(version(n * 1000, n));
    shown.push(d.update(desk(events), n * 1000 + 100)!.text);
  }
  assert.deepEqual(shown.map((t) => /^Version (\d)/.exec(t)![1]), ["1", "2", "3", "4", "5", "6", "7"], "never a stale version, never a skipped one at the moment it arrives");
  assert.match(d.update(desk(events), 7300)!.text, /^Version 7 /, "and it is the one still up");
});

test("versions that arrive together collapse to the newest, and a version caption is replaced only by a version", () => {
  const d = new CaptionDesk();
  const burst = desk([note(1000, "home", "Wi-Fi back on.", false), version(1100, 3), version(1200, 4), version(1300, 5)]);
  assert.equal(d.update(burst, 1400)?.text, "Wi-Fi back on.", "an ordinary caption keeps its time");
  assert.match(d.update(burst, 5500)!.text, /^Version 5 /, "when its 4 s (from 1.4 s) are over only the newest version is left to show");
  const other = desk([version(1000, 6), note(1500, "home", "Something else.", false)]);
  const d2 = new CaptionDesk();
  assert.match(d2.update(other, 1100)!.text, /^Version 6 /);
  assert.match(d2.update(other, 3000)!.text, /^Version 6 /, "a caption of another kind does not push a version off before its time");
  assert.equal(d2.update(other, 5200)?.text, "Something else.", "the version had its 4 s (from 1.1 s)");
});

// Greptile on #114: with versions arriving one second apart, every replacement restarted the hold and returned before anything else was considered,
// so a caption that was waiting (say "Wi-Fi back on.") never got a turn and expired. A replacement updates the text in place and the hold keeps
// running from when the caption first appeared; once it is over a waiting caption takes its turn.
test("with versions arriving every second, a caption that is waiting still gets its turn within its life", () => {
  const d = new CaptionDesk();
  const events: ShowEvent[] = [version(1000, 1), { t: "note", at: 2500, kind: "home", text: "Wi-Fi back on.", rank: 2 } as ShowEvent];
  const shown: string[] = [];
  for (let t = 1000; t <= 13_000; t += 250) {
    for (let n = 2; n <= 12; n++) if (n * 1000 === t) events.push(version(t, n));
    const c = d.update(desk(events), t);
    if (c && shown.at(-1) !== c.text) shown.push(c.text);
  }
  assert.ok(shown.includes("Wi-Fi back on."), `the waiting caption was never shown: ${JSON.stringify(shown)}`);
  const when = shown.indexOf("Wi-Fi back on.");
  assert.match(shown[when - 1]!, /^Version /, "it followed a version caption, after that one had its time");
  assert.match(shown.at(-1)!, /^Version 1[12] /, "and the versions went on afterwards: the newest is showing at the end");
});

test("a replacement does not restart the version caption's hold: the hold runs from when it first appeared", () => {
  const d = new CaptionDesk();
  const events: ShowEvent[] = [version(1000, 1)];
  assert.match(d.update(desk(events), 1000)!.text, /^Version 1 /);
  events.push(version(2000, 2), version(3000, 3), version(4000, 4), note(2000, "home", "Wi-Fi back on.", false));
  assert.match(d.update(desk(events), 3000)!.text, /^Version 3 /, "replaced in place inside the hold");
  assert.equal(d.update(desk(events), 5000)?.text, "Wi-Fi back on.", "4 s after the first version appeared (1 s), the waiting caption has its turn");
});

// Cold view 6.
test("an urgent moment takes the slot at once, inside the hold of the caption on screen; an ordinary one waits", () => {
  const d = new CaptionDesk();
  const urgent = { t: "note", at: 1500, kind: "home", text: "Knocked over. It learned to get back up.", urgent: true } as ShowEvent;
  const s = fold([run("live"), note(1000, "home", "Version 4: walking - 2.1 m in 10 s"), urgent]);
  assert.equal(d.update(fold([run("live"), note(1000, "home", "Version 4: walking - 2.1 m in 10 s")]), 1100)?.text, "Version 4: walking - 2.1 m in 10 s");
  assert.equal(d.update(s, 1600)?.text, "Knocked over. It learned to get back up.", "1.5 s into a 4 s hold");
  const plain = new CaptionDesk();
  plain.update(fold([run("live"), note(1000, "home", "one")]), 1100);
  assert.equal(plain.update(fold([run("live"), note(1000, "home", "one"), note(1500, "home", "two")]), 1600)?.text, "one");
  // and a second urgent one does not cut the first short
  const two = fold([run("live"), urgent, { ...urgent, at: 1800, text: "second" } as ShowEvent]);
  const e = new CaptionDesk();
  assert.equal(e.update(two, 1600)?.text, "Knocked over. It learned to get back up.");
  assert.equal(e.update(two, 1900)?.text, "Knocked over. It learned to get back up.", "an urgent caption keeps its hold");
});

// A newer caption of a group replaces the one on screen in place. When the line it replaces has already used up its time (the
// newer one arrived a few ms after the 10 s hold ran out, before the desk next looked), the replacement was shown for one frame and cleared at the next
// look: the viewer never saw the newer version. A replacement that finds the hold over is a fresh caption with its own hold.
test("a group's replacement that arrives after the caption's time is up is shown for its own hold, not for one frame", () => {
  const first = { t: "note", at: 1000, kind: "home", text: "Version 4: walking - 2.1 m in 10 s", group: "version", rank: 2 } as ShowEvent;
  const second = { t: "note", at: 11_010, kind: "home", text: "Version 5: walking - 3.0 m in 10 s", group: "version", rank: 2 } as ShowEvent;
  const d = new CaptionDesk();
  assert.equal(d.update(fold([run("live"), first]), 1000)?.text, "Version 4: walking - 2.1 m in 10 s");
  const both = fold([run("live"), first, second]);
  assert.equal(d.update(both, 11_020)?.text, "Version 5: walking - 3.0 m in 10 s", "the look after the 10 s: the number is shown");
  assert.equal(d.update(both, 11_600)?.text, "Version 5: walking - 3.0 m in 10 s", "and still there at the next look");
  assert.equal(d.update(both, 14_900)?.text, "Version 5: walking - 3.0 m in 10 s", "for at least its own hold");
  assert.equal(d.update(both, 21_100), null, "then it clears");
});
