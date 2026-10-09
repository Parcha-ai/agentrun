import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

const run = (source?: "live" | "scripted"): ShowEvent => ({ t: "run", at: 0, run: "r", origin: 0, environments: [], ...(source ? { source } : {}) });
const note = (at: number, kind: "kill" | "takeover" | "story" | "switch", text: string, measured?: boolean): ShowEvent => ({ t: "note", at, kind, text, ...(measured === undefined ? {} : { measured }) });

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
