// The port of a computer that replaced an earlier claim's (serve/src/workspace/computer-ports.ts portOf with replaced):
// the model's context still holds the old computer's refs and states, and the new one gives the same names to other
// things, so an act that names a ref or a state this computer never gave is refused in words, and so is a step at a
// point before anything of this computer was looked at (the host's default state would be the old one's). Nothing so
// refused reaches the computer. Once the model looks again, what that look gave acts as before. A computer that
// replaced nothing passes every act through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { portOf } from "../dist/workspace/computer-ports.js";

/** The words computer_act answers with (the tool's error text is the refusal's message). */
const REF = "that ref is from the replaced computer; observe again";
const STATE = "that state is from the replaced computer; observe again";

/** A surface stand-in: each call recorded; observe answers state s1 with @e1 and @e2, an act answers state s2. */
function surface() {
  const calls = [];
  return {
    calls,
    card: { groups: ["screen", "input.pointer", "input.keys", "ui"] },
    async call(op, args) {
      calls.push([op, args]);
      if (op === "observe") return { value: { id: "s1", elements: [{ ref: "@e1", role: "button" }, { ref: "@e2", role: "textbox" }], outline: "" }, text: "", images: [] };
      if (op === "act") return { value: { steps: [{ route: "ax", verified: true }], state: "s2" }, text: "", images: [] };
      return { value: { done: true }, text: "", images: [] };
    },
  };
}

const refused = async (port, op, args) => {
  const error = await port.call(op, args).then(() => undefined, (thrown) => thrown);
  assert.ok(error, `${op} ${JSON.stringify(args)} is refused`);
  assert.equal(error.kind ?? error.code, "stale");
  return error.message;
};

test("on a replaced computer, an act with a ref or a state from the old one is refused in words, and nothing reaches the computer", async () => {
  const one = surface();
  const port = portOf(one, { replaced: true });
  assert.equal(await refused(port, "act", { steps: [{ press: "@e3" }] }), REF);
  assert.equal(await refused(port, "act", { steps: [{ type: "hi", into: "@e4" }] }), REF);
  assert.equal(await refused(port, "act", { state: "s9", steps: [{ click: [10, 20] }] }), STATE);
  assert.equal(await refused(port, "act", { steps: [{ key: "enter" }], expect: { ref: "@e5" } }), REF);
  assert.deepEqual(one.calls, [], "no act reached the computer");
});

test("on a replaced computer, a step at a point with no state, before any look, is refused: the default state would be the old one's", async () => {
  const one = surface();
  const port = portOf(one, { replaced: true });
  assert.equal(await refused(port, "act", { steps: [{ click: [10, 20] }] }), STATE);
  assert.equal(await refused(port, "act", { steps: [{ drag: [[1, 1], [5, 5]] }] }), STATE);
  assert.equal(await refused(port, "input.act", { actions: [{ type: "click", at: [10, 20] }] }), STATE);
  assert.deepEqual(one.calls, [], "no act reached the computer");
  // A key or typing where the focus is names nothing of the old computer: it goes through.
  await port.call("act", { steps: [{ key: "ctrl+l" }] });
  assert.deepEqual(one.calls.map(([op]) => op), ["act"]);
});

test("once the model looks again, the refs and states that look gave act as before; a point step goes through after a screenshot", async () => {
  const one = surface();
  const port = portOf(one, { replaced: true });
  await port.call("observe", {});
  await port.call("act", { state: "s1", steps: [{ press: "@e1" }, { set: "@e2", value: "x" }], expect: { ref: "@e1" } });
  await port.call("act", { state: "s2", steps: [{ click: [3, 4] }] });
  await port.call("act", { steps: [{ scroll: [3, 4], dy: 10 }] });
  assert.equal(await refused(port, "act", { steps: [{ press: "@e7" }] }), REF, "a ref no look gave is still refused");
  assert.deepEqual(one.calls.map(([op]) => op), ["observe", "act", "act", "act"]);

  const raw = surface();
  const rawPort = portOf(raw, { replaced: true });
  await rawPort.call("screenshot", {});
  await rawPort.call("input.act", { actions: [{ type: "click", at: [10, 20] }] });
  assert.deepEqual(raw.calls.map(([op]) => op), ["screenshot", "input.act"]);
});

test("a computer that replaced nothing passes every act through", async () => {
  const one = surface();
  const port = portOf(one);
  await port.call("act", { steps: [{ press: "@e3" }] });
  await port.call("act", { state: "s9", steps: [{ click: [10, 20] }] });
  await port.call("input.act", { actions: [{ type: "click", at: [10, 20] }] });
  assert.deepEqual(one.calls.map(([op]) => op), ["act", "act", "input.act"]);
});
