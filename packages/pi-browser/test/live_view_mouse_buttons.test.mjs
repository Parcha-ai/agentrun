// The mouse's buttons through the live view: the viewer sends MouseEvent.buttons (CDP's bitmask: left 1, right 2, middle 4) on move, down and up; the host's parser keeps it when it is an integer 0..31 and
// refuses anything else; the stream hands it to Input.dispatchMouseEvent unchanged, so a plain hover reports no button held and a right-button drag reports the right button (not the left).
import assert from "node:assert/strict";
import test from "node:test";
import { parseClientMessage } from "../dist/live-view/protocol.js";
import { openStream, StreamRefusal } from "../dist/live-view/stream.js";
import { fakeCdp } from "./fixtures/fake-cdp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };
const mouse = (extra) => JSON.stringify({ type: "mouse", action: "move", x: 5, y: 6, ...extra });

test("the parser keeps buttons when it is an integer 0..31, leaves it out when absent, and refuses anything else", () => {
  for (const buttons of [0, 1, 2, 3, 4, 7, 31]) assert.equal(parseClientMessage(mouse({ buttons }))?.buttons, buttons, `buttons ${buttons}`);
  assert.equal("buttons" in parseClientMessage(mouse({})), false, "absent stays absent");
  for (const bad of [-1, 32, 1.5, "2", null, true, [], {}, 1e9]) assert.equal(parseClientMessage(mouse({ buttons: bad })), null, `buttons ${JSON.stringify(bad)} is refused`);
  for (const action of ["down", "up"]) assert.equal(parseClientMessage(JSON.stringify({ type: "mouse", action, x: 1, y: 2, button: "right", buttons: 2 }))?.buttons, 2, `${action} carries buttons`);
});

async function rig(t) {
  const fake = await fakeCdp();
  t.after(() => fake.close());
  const stream = openStream(fake.url, { frame: (_b, _s, ack) => ack(), page() {}, dialog() {}, closed() {} });
  t.after(() => stream.close());
  assert.ok(await until(() => fake.screencasts().length === 1), "the stream attached");
  return { fake, stream };
}
const dispatched = (fake) => fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);

test("a plain hover reports no button held; a drag reports the buttons the viewer says are held, and a right drag is not a left drag", async (t) => {
  const { fake, stream } = await rig(t);
  await stream.input({ type: "mouse", action: "move", x: 1, y: 1 });
  await stream.input({ type: "mouse", action: "move", x: 2, y: 2, buttons: 0 });
  await stream.input({ type: "mouse", action: "down", x: 3, y: 3, button: "right", buttons: 2 });
  await stream.input({ type: "mouse", action: "move", x: 4, y: 4, buttons: 2 });
  await stream.input({ type: "mouse", action: "up", x: 4, y: 4, button: "right", buttons: 0 });
  await stream.input({ type: "mouse", action: "down", x: 5, y: 5, button: "left", buttons: 1 });
  await stream.input({ type: "mouse", action: "move", x: 6, y: 6, buttons: 1 });
  await stream.input({ type: "mouse", action: "move", x: 7, y: 7, buttons: 5 });
  await stream.input({ type: "mouse", action: "up", x: 7, y: 7, button: "left" });
  assert.deepEqual(dispatched(fake).map((m) => [m.type, m.button, m.buttons]), [
    ["mouseMoved", "none", 0], ["mouseMoved", "none", 0],
    ["mousePressed", "right", 2], ["mouseMoved", "right", 2], ["mouseReleased", "right", 0],
    ["mousePressed", "left", 1], ["mouseMoved", "left", 1], ["mouseMoved", "left", 5], ["mouseReleased", "left", 0],
  ]);
});

test("a press without buttons reports its own button (a viewer that predates the field), a release reports none, and buttons that are not 0..31 never reach the browser", async (t) => {
  const { fake, stream } = await rig(t);
  await stream.input({ type: "mouse", action: "down", x: 1, y: 1, button: "middle" });
  await stream.input({ type: "mouse", action: "up", x: 1, y: 1, button: "middle" });
  assert.deepEqual(dispatched(fake).map((m) => [m.type, m.button, m.buttons]), [["mousePressed", "middle", 4], ["mouseReleased", "middle", 0]]);
  const before = dispatched(fake).length;
  for (const buttons of [-1, 32, 1.5, "1", null]) await assert.rejects(() => stream.input({ type: "mouse", action: "move", x: 1, y: 1, buttons }), (e) => e instanceof StreamRefusal && e.reason === "bad_message", `buttons ${JSON.stringify(buttons)}`);
  assert.equal(dispatched(fake).length, before, "nothing reached the browser");
});
