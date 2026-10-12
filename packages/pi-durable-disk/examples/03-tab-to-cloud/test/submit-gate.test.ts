// The lines the server sends while the page is taking a run over: kept until the page is the writer, in order; dropped only when the page is not taking a run over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmitGate } from "../tab/submit-gate.ts";

test("a frame that arrives while the page is starting is held and runs, in order, when the page is ready", () => {
  const ran: string[] = [];
  const gate = new SubmitGate<string>((f) => void ran.push(f));
  assert.equal(gate.offer("server-home", "starting"), "held");
  assert.equal(gate.offer("ui-1", "starting"), "held");
  assert.deepEqual(ran, [], "nothing runs before the page is ready");
  assert.equal(gate.open(), 2);
  assert.deepEqual(ran, ["server-home", "ui-1"]);
  assert.equal(gate.offer("ui-2", "ready"), "ran", "once ready a frame runs at once");
  assert.deepEqual(ran, ["server-home", "ui-1", "ui-2"]);
  assert.equal(gate.open(), 0, "nothing is run twice");
});

test("a frame for a page that is not taking a run over is dropped, and what was held is not run when the page gives up", () => {
  const ran: string[] = [];
  const gate = new SubmitGate<string>((f) => void ran.push(f));
  assert.equal(gate.offer("a", "gone"), "dropped");
  gate.offer("b", "starting");
  assert.equal(gate.discard(), 1);
  assert.equal(gate.open(), 0);
  assert.deepEqual(ran, []);
});

test("a frame that arrives once the page's mode reads writer, before the page has opened the gate, runs after the ones held during boot, not ahead of them", () => {
  const ran: string[] = [];
  const gate = new SubmitGate<string>((f) => void ran.push(f));
  gate.begin(); // the page starts taking the run over
  gate.offer("server-home", "starting"); // the server's home turn, while booting
  assert.equal(gate.offer("ui-1", "ready"), "held", "the mode already reads writer (the brain check is still reading), but the gate is not open: it waits behind the home turn");
  assert.deepEqual(ran, []);
  gate.open();
  assert.deepEqual(ran, ["server-home", "ui-1"], "in the order they came");
  assert.equal(gate.offer("ui-2", "ready"), "ran", "open: a frame runs at once");
});

test("a frame is never run ahead of one that is held, even with no begin", () => {
  const ran: string[] = [];
  const gate = new SubmitGate<string>((f) => void ran.push(f));
  gate.offer("a", "starting");
  assert.equal(gate.offer("b", "ready"), "held");
  gate.open();
  assert.deepEqual(ran, ["a", "b"]);
});

test("a gate begun for a run that was never taken over (lost, a new connect) does not stay closed", () => {
  const ran: string[] = [];
  const gate = new SubmitGate<string>((f) => void ran.push(f));
  gate.begin();
  gate.discard();
  assert.equal(gate.offer("x", "ready"), "ran");
});
