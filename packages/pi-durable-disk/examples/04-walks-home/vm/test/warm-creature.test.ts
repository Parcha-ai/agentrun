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

test("a newer drawing cancels the warm-up in flight before its own starts; the first one's failure is reported and ignored", async () => {
  const order: string[] = [];
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const w = creatureWarmer({
    delayMs: 30,
    warm: async (c) => {
      order.push(`warm ${new TextDecoder().decode(c.xml)}`);
      if (new TextDecoder().decode(c.xml) === "x1") {
        await gate;
        throw new Error("killed");
      }
    },
    cancel: async () => {
      order.push("cancel");
      release();
    },
    log: (e) => void events.push(e),
  });
  w.write("creature/creature.xml", bytes("x1"));
  w.write("creature/body.json", bytes("b1"));
  await sleep(120);
  assert.deepEqual(order, ["warm x1"], "the first drawing is warming");
  w.write("creature/creature.xml", bytes("x2"));
  w.write("creature/body.json", bytes("b2"));
  await sleep(200);
  assert.deepEqual(order, ["warm x1", "cancel", "warm x2"], "the second cancels the first, then warms");
  assert.ok(events.includes("warm.failed"), "the killed warm-up is reported");
  w.close();
});
