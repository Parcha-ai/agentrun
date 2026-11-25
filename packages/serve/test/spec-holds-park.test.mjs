// A park keeps the run's desktop, phone or sandbox for its resume (SpecHolds.release `parked`), except one this claim's
// gate turned off for the rest of the run (RunGate.computerOff): no later claim of the run attaches it, so a keep would
// only bill it for KEEP_MS. It is let go at the park as at the run's end, its Archil mount credential revoked. Each part
// is a fake the test reads, so there is no sleep.
import assert from "node:assert/strict";
import test from "node:test";
import { SpecHolds } from "../dist/runner/spec-holds.js";

/** The parts a claim with a desktop holds, each recording what was asked of it. */
function held(off) {
  const asked = [];
  const holds = new SpecHolds();
  holds.hold({
    tools: { end: async () => void asked.push("tools") },
    computer: { keeps: "desktop", park: async (cause) => (asked.push(`park ${cause}`), true), release: async () => void asked.push("release") },
    archil: { revoke: async () => void asked.push("revoke") },
    computerOff: () => off.now,
  });
  return { holds, asked };
}

test("a park of a claim whose gate turned the desktop off lets it go, its mount credential revoked, and keeps nothing", async () => {
  const off = { now: false };
  const { holds, asked } = held(off);
  // The gate turns the desktop off mid-claim (a deny of its tools); the run then parks on another tool's approval.
  off.now = true;
  await holds.release({ parked: "approval" });
  assert.deepEqual(asked, ["tools", "release", "revoke"], "no keep: the tools ended, the desktop let go, its credential revoked");
});

test("a park of a claim whose desktop is on keeps it, as before: no tools' end, no revoke", async () => {
  const { holds, asked } = held({ now: false });
  await holds.release({ parked: "approval" });
  assert.deepEqual(asked, ["park approval", "release"]);
});
