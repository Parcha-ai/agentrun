import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptionDesk, captionFor, captionsFor, claimsZeroLoss } from "../page/caption.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

const run = (source?: "live" | "scripted"): ShowEvent => ({ t: "run", at: 0, run: "r", origin: 0, environments: [], ...(source ? { source } : {}) });
const note = (at: number, kind: "kill" | "takeover" | "story" | "switch" | "agent", text: string, measured?: boolean): ShowEvent => ({ t: "note", at, kind, text, ...(measured === undefined ? {} : { measured }) });

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
