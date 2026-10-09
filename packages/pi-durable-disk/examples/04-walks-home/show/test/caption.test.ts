import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor, captionsFor } from "../page/caption.ts";
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
