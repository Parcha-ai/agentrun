// computer_screenshot's save_as: the screen the model sees, saved as a PNG into the run's files through the run's hands
// (Hands.write), whatever disk the computer itself has. The answer is the image as always, and says where it was saved.
// The path is one in the run's folder: relative, inside it, ending .png; any other is refused in words before the
// computer is asked, and nothing is written.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createRegistry } from "@parcha/agentrun-kernel/kernel";
import { fakeComputerPort, PNG } from "./registry-ports.mjs";
import { localHands } from "./registry-support.mjs";

const injected = { read: async () => ({ text: "read" }), write: async () => ({ text: "write" }), edit: async () => ({ text: "edit" }) };
const DESKTOP = ["ui", "screen", "input.pointer", "input.keys", "apps", "files"];
const image = { type: "image", mimeType: "image/png", data: PNG, width: 1, height: 1 };
const screen = () => fakeComputerPort({ groups: DESKTOP, answers: { screenshot: () => ({ value: image, text: "screenshot 1×1 px", images: [image] }) } });
const registryOf = () => createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop"], groups: DESKTOP, executors: injected });

test("computer_screenshot's parameters offer save_as, a path in the run's files", () => {
  const def = registryOf().list().find((one) => one.name === "computer_screenshot");
  assert.equal(def.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ["region", "save_as"]);
  assert.equal(def.parameters.properties.save_as.type, "string");
  assert.match(def.parameters.properties.save_as.description, /run's files/);
});

test("computer_screenshot with save_as writes the PNG into the run's folder and says where, the image still answered", async () => {
  const { hands, root } = localHands();
  const computer = screen();
  const answer = await registryOf().invoke("computer_screenshot", { save_as: "shots/desktop.png", region: [0, 0, 1, 1] }, { hands: { ...hands, computer } });
  assert.equal(answer.error, undefined, answer.error);
  assert.deepEqual(readFileSync(join(root, "shots/desktop.png")), Buffer.from(PNG, "base64"), "the PNG's bytes, in the run's folder");
  assert.deepEqual(answer.images, [image], "the model still sees the screen");
  assert.match(answer.text, /^screenshot 1×1 px\n/);
  assert.match(answer.text, /saved as shots\/desktop\.png in the run's files/);
  assert.equal(answer.structured.saved, "shots/desktop.png");
  assert.deepEqual(computer.calls, [["screenshot", { region: [0, 0, 1, 1] }]], "the computer is asked for the screen alone: save_as is the run's, never the computer's");
});

test("save_as outside the run's folder, absolute, or not a .png is refused in words, before the computer, and nothing is written", async () => {
  for (const [shape, words] of [
    [(name) => `../${name}`, /inside the run's folder/],
    [(name) => `shots/../../${name}`, /inside the run's folder/],
    [(name) => `/tmp/${name}`, /relative/],
    [() => "desktop.jpg", /\.png/],
    [() => "", /relative/],
    [() => 7, /relative/],
  ]) {
    const { hands, root } = localHands();
    // A name of this folder's own, so a write that escaped it would be this call's.
    const name = `${basename(root)}.png`;
    const given = shape(name);
    const computer = screen();
    const answer = await registryOf().invoke("computer_screenshot", { save_as: given }, { hands: { ...hands, computer } });
    assert.match(answer.error ?? "", words, `${JSON.stringify(given)}: ${answer.error}`);
    assert.match(answer.error, /save_as/);
    assert.deepEqual(computer.calls, [], `${JSON.stringify(given)}: the computer is not asked`);
    assert.deepEqual(readdirSync(root), [], `${JSON.stringify(given)}: nothing written`);
    assert.ok(!existsSync(join(root, "..", name)), `${JSON.stringify(given)}: nothing beside the folder`);
  }
});

test("a screenshot with no save_as writes nothing", async () => {
  const { hands, root } = localHands();
  const answer = await registryOf().invoke("computer_screenshot", {}, { hands: { ...hands, computer: screen() } });
  assert.equal(answer.text, "screenshot 1×1 px");
  assert.equal(answer.structured.saved, undefined);
  assert.deepEqual(readdirSync(root), []);
});
