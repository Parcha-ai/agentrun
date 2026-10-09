// The creature warmer waits out the tab's writes, needs both files, and warms a drawing once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { creatureWarmer } from "../warm-creature.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytes = (s: string) => new TextEncoder().encode(s);

test("warms once, after both files stopped changing, and not for steps of the drawing", async () => {
  const warmed: string[] = [];
  const w = creatureWarmer({ delayMs: 60, warm: async (c) => void warmed.push(`${new TextDecoder().decode(c.xml)}|${new TextDecoder().decode(c.body)}`) });
  w.write("creature/creature.xml", bytes("x1"));
  await sleep(20);
  w.write("creature/body.json", bytes("b1"));
  w.write("creature/creature.xml", bytes("x2")); // the next design arrives before the delay ends
  w.write("creature/body.json", bytes("b2"));
  w.write("creature/designs.sqlite", bytes("not a creature file"));
  await sleep(200);
  assert.deepEqual(warmed, ["x2|b2"]);
  w.write("creature/creature.xml", bytes("x2")); // the same drawing saved again
  w.write("creature/body.json", bytes("b2"));
  await sleep(150);
  assert.equal(warmed.length, 1, "the same drawing is not warmed twice");
  w.close();
});

test("waits for the second file, reports a failed warm-up and keeps going, and stops on close", async () => {
  const events: string[] = [];
  let calls = 0;
  const w = creatureWarmer({ delayMs: 30, warm: async () => (calls++ === 0 ? Promise.reject(new Error("compile failed")) : undefined), log: (e) => void events.push(e) });
  w.write("creature/creature.xml", bytes("x"));
  await sleep(100);
  assert.equal(calls, 0, "one file is not a creature");
  w.write("creature/body.json", bytes("b"));
  await sleep(100);
  assert.equal(calls, 1);
  assert.ok(events.includes("warm.failed"));
  w.write("creature/creature.xml", bytes("y"));
  w.close();
  await sleep(100);
  assert.equal(calls, 1, "nothing starts after close");
});
