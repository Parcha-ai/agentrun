// The door of a run on a harness other than pi, over a session whose turns the test ends: a message while a turn runs
// waits for its end and is sent after it, in order; a reject while busy is refused; a stop interrupts the turn and sends
// nothing more; the turn's start and end go out on the door.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { adapterRun } from "../dist/harness-app.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** An adapter whose every turn waits for the test, and which records what it was asked. */
function heldAdapter() {
  const sent = [];
  const turns = [];
  let interrupts = 0;
  const adapter = {
    id: "held",
    version: "0",
    capabilities: () => ({ fork: false }),
    check: () => [],
    async open() {
      let current;
      return {
        state: "new",
        async send(text) {
          sent.push(text);
          current = deferred();
          turns.push(current);
        },
        async recover() {},
        turnEnd: () => current.promise,
        async interrupt() {
          interrupts += 1;
          current?.resolve({ status: "interrupted" });
        },
        async close() {},
      };
    },
  };
  return { adapter, sent, turns, interrupts: () => interrupts };
}

async function opened() {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
  const held = heldAdapter();
  const app = adapterRun(held.adapter, { key: "run:1", label: "a", system: ["Answer."], tools: [], context: "fresh" }, ctx);
  await app.onOpen({ harness });
  const events = [];
  const door = { run: { harness }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
  const submit = (text, whenBusy = "followUp") => app.door.submit({ requestId: text, content: text, whenBusy }, door);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { app, held, door, events, submit, settle };
}

test("a message while a turn runs waits for its end and is sent after it, in order; a reject while busy is refused", async () => {
  const { app, held, events, submit, settle } = await opened();
  assert.deepEqual(await submit("one"), { accepted: true });
  await settle();
  assert.equal(app.door.busy(), true);
  assert.deepEqual(await submit("two"), { accepted: true });
  assert.deepEqual(await submit("three", "steer"), { accepted: true });
  assert.deepEqual(await submit("no", "reject"), { accepted: false, reason: "busy" });
  assert.deepEqual(held.sent, ["one"], "nothing else goes in while the turn runs");
  held.turns[0].resolve({ status: "completed" });
  await settle();
  assert.deepEqual(held.sent, ["one", "two"]);
  held.turns[1].resolve({ status: "completed" });
  await settle();
  held.turns[2].resolve({ status: "completed" });
  await settle();
  assert.deepEqual(held.sent, ["one", "two", "three"]);
  assert.equal(app.door.busy(), false);
  assert.deepEqual(events, ["run_start", "run_end", "run_start", "run_end", "run_start", "run_end"]);
});

test("a stop interrupts the turn, drops what waited, and sends nothing more; idle, it says so", async () => {
  const { app, held, door, events, submit, settle } = await opened();
  assert.equal(await app.door.abort(door), "idle");
  await submit("one");
  await settle();
  await submit("waiting");
  assert.equal(await app.door.abort(door), "aborted");
  await settle();
  assert.equal(held.interrupts(), 1);
  assert.deepEqual(held.sent, ["one"], "no second send, and the waiting message is dropped");
  assert.equal(app.door.busy(), false);
  assert.deepEqual(events, ["run_start", "run_end"]);
});
