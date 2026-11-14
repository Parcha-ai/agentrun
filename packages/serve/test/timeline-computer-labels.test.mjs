// A desktop's or a phone's tool calls read on the timeline as what the agent did, in a person's words: "Pressed
// “Display”", "Typed “dark”", "Went back", "Looked at Display in Settings", never "Using tool: computer_act". The
// element's name is the act's own answer's (its step line names the element as the outline does); a typed or set text
// shows whole or not at all, and never for a secure field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callFailed, labelOf, nameOf, timelineOf } from "../dist/timeline/index.js";
import { outcomeOf } from "../dist/timeline/labels.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

const view = (text, isError = false) => ({ text, details: undefined, isError });

test("an act names each step by its element, from its answer's step lines", () => {
  const steps = [{ press: "@e31" }, { type: "dark", into: "@e40" }, { nav: "back" }];
  const answer = ['1. press @e31 generic "Search settings": semantic, verified', '2. type into @e40 textbox "Search": semantic, verified', "3. nav: semantic, verified", "changed · state s4"].join("\n");
  assert.equal(labelOf("computer_act", { steps }, view(answer)), "Pressed “Search settings”, typed “dark” into “Search”, went back");
  assert.equal(labelOf("computer_act", { steps }), "Pressed an element, typed into an element, went back", "before its answer, no element has a name and no text shows");
});

test("each kind of step in words; past three steps, the rest are counted", () => {
  const label = (step) => labelOf("computer_act", { steps: [step] });
  assert.equal(label({ key: "enter" }), "Pressed Enter");
  assert.equal(label({ key: "ctrl+shift+t" }), "Pressed Ctrl+Shift+T");
  assert.equal(label({ nav: "home" }), "Went home");
  assert.equal(label({ nav: "app_switch" }), "Opened the recent apps");
  assert.equal(label({ scroll: "@e3", dy: 400 }), "Scrolled down");
  assert.equal(label({ scroll: [100, 200], dy: -400 }), "Scrolled up");
  assert.equal(label({ click: [120, 300] }), "Clicked at 120, 300");
  assert.equal(label({ click: "@e3", button: "right" }), "Right-clicked an element");
  assert.equal(label({ drag: [[0, 0], [9, 9]] }), "Dragged across the screen");
  assert.equal(label({ set: "@e2", value: "on" }), "Set an element");
  assert.equal(labelOf("computer_act", { steps: [{ set: "@e2", value: "on" }] }, view('1. set @e2 switch "Dark theme": semantic, verified')), "Set “Dark theme” to “on”");
  assert.equal(label({ perform: "@e2", action: "ACTION_LONG_CLICK" }), "Did ACTION_LONG_CLICK on an element");
  assert.equal(labelOf("computer_act", { steps: [{ nav: "back" }, { nav: "back" }, { nav: "back" }, { nav: "home" }, { key: "enter" }] }), "Went back, went back, went back, +2 more");
  assert.equal(labelOf("computer_act", { steps: [], expect: { text: "Saved" } }), "Waited for “Saved”");
  assert.equal(labelOf("computer_act", {}), "Acted on the computer");
});

test("a typed or set text shows whole or not at all, and never for a secure field", () => {
  const long = "x".repeat(41);
  const notes = '1. type into @e2 textbox "Notes": semantic, verified';
  assert.equal(labelOf("computer_act", { steps: [{ type: long, into: "@e2" }] }, view(notes)), "Typed 41 characters into “Notes”");
  assert.equal(labelOf("computer_act", { steps: [{ type: "dark", into: "@e2" }] }, view(notes)), "Typed “dark” into “Notes”");
  assert.equal(labelOf("computer_act", { steps: [{ type: "dark" }] }, view("1. type: semantic, verified")), "Typed text", "a type with no element: where the text went is unknown, so it may be a secure field, and no text shows");
  const steps = [{ type: "1234", into: "@e6" }, { set: "@e7", value: "hunter2" }, { type: "5678" }];
  const answer = ['1. type into @e6 textbox "PIN" [secure]: semantic, verified', '2. set @e7 textbox "Password" [secure]: semantic, verified', "3. type: semantic, verified"].join("\n");
  assert.equal(labelOf("computer_act", { steps }, view(answer)), "Typed into “PIN”, set “Password”, typed text");
  for (const text of ["1234", "hunter2", "5678"]) assert.ok(!labelOf("computer_act", { steps }, view(answer)).includes(text));
});

test("a finished act says the steps that ran: a refused one as tried, the ones after it not at all", () => {
  const steps = [{ press: "@e9" }, { nav: "home" }, { type: "never ran" }];
  assert.equal(labelOf("computer_act", { steps }, view('1. press @e9 button "Save": refused (stale): gone\n2 later steps did not run')), "Could not press “Save”");
  const later = view(['1. nav: semantic, verified', '2. press @e9 button "Save": refused (stale): gone', "1 later steps did not run"].join("\n"));
  assert.equal(labelOf("computer_act", { steps: [{ nav: "back" }, ...steps] }, later), "Went back, could not press “Save”");
  const five = Array.from({ length: 5 }, (_, i) => `${i + 1}. nav: semantic, verified`).join("\n");
  assert.equal(labelOf("computer_act", { steps: [...Array(5).fill({ nav: "back" }), { nav: "home" }] }, view(`${five}\n1 steps did not run`)), "Went back, went back, went back, +2 more", "the count is of the steps that ran");
  assert.equal(labelOf("computer_act", { steps }, view("the computer went away", true)), "Could not press an element", "an answer with no step lines: nothing is known to have run");
});

test("a refused step makes the act's outcome failed, saying which step and why", () => {
  const answer = ['1. press @e31 generic "Search settings": semantic, verified', "2. type: refused (denied): type with no text field focused", "changed · state s3"].join("\n");
  assert.deepEqual(outcomeOf("computer_act", view(answer)), { failed: true, text: "step 2 refused: type with no text field focused" });
  assert.equal(callFailed("computer_act", view(answer)), true);
  assert.equal(outcomeOf("computer_act", view("1. press: semantic, verified\nchanged · state s2")), undefined);
});

test("observe names the window and its app; a screenshot and a script read as such; a script's title when it gives one", () => {
  assert.equal(labelOf("computer_observe", {}, view('state s8 · com.android.settings "Settings" · window "Display" 360×640 pt\n@e1 generic')), "Looked at Display in Settings");
  assert.equal(labelOf("computer_observe", {}, view('state s1 · com.android.settings "Settings" · window "Settings" 360×640 pt\n@e1 generic')), "Looked at Settings");
  assert.equal(labelOf("computer_observe", {}, view("screen 1080×2400 px · com.android.settings in front · this computer has no ui group")), "Looked at the screen");
  assert.equal(labelOf("computer_observe", {}), "Looked at the screen");
  assert.equal(labelOf("computer_screenshot", {}), "Took a screenshot");
  assert.equal(labelOf("computer_script", { code: "await computer.app().observe()" }), "Ran a script on the computer");
  assert.equal(labelOf("computer_script", { code: "1", title: "Open Settings and find Display" }), "Open Settings and find Display");
  assert.equal(nameOf("computer_act"), "Act on the computer");
});

test("on the timeline the call's row says it, once its answer is in", () => {
  const steps = [{ press: "@e31" }];
  const rows = timelineOf(
    [user("Turn on dark mode."), assistant([call("c1", "computer_act", { steps })]), result("c1", "computer_act", '1. press @e31 generic "Display": semantic, verified\nchanged · state s2')],
    { settled: true },
  );
  assert.equal(rows.find((row) => row.kind === "tool_result")?.summary, "Pressed “Display”: ok");
});
