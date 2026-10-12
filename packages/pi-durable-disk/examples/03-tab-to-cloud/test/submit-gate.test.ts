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
