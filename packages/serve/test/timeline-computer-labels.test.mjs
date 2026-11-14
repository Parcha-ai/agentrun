// A desktop's or a phone's tool calls read on the timeline as what the agent did, in a person's words and in the words of
// the call's own record (timeline-computer-voice.test.mjs): "Pressed “Display”", "Typed into the text box “Search”",
// "Went back", "Looked at Settings", never "Using tool: computer_act". The element is the act's own answer's (its step
// line names the element as the outline does); no typed or set text shows, as the record keeps none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callFailed, labelOf, nameOf, timelineOf } from "../dist/timeline/index.js";
import { outcomeOf } from "../dist/timeline/labels.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

const view = (text, isError = false) => ({ text, details: undefined, isError });

test("an act names each step by its element, from its answer's step lines", () => {
  const steps = [{ press: "@e31" }, { type: "dark", into: "@e40" }, { nav: "back" }];
  const answer = ['1. press @e31 generic "Search settings": semantic, verified', '2. type into @e40 textbox "Search": semantic, verified', "3. nav: semantic, verified", "changed · state s4"].join("\n");
  assert.equal(labelOf("computer_act", { steps }, view(answer)), "Pressed “Search settings”, typed into the text box “Search”, went back");
  assert.equal(labelOf("computer_act", { steps }), "Pressed an element, typed text, went back", "before its answer, no element has a name and no text shows");
});

test("each kind of step in words; past three steps, the rest are counted", () => {
  const label = (step) => labelOf("computer_act", { steps: [step] });
  assert.equal(label({ key: "enter" }), "Pressed Return");
  assert.equal(label({ key: "ctrl+shift+t" }), "Pressed ⌃⇧T");
  assert.equal(label({ key: "super+z" }), "Undid (⌘Z)");
  assert.equal(label({ key: "x" }), "Pressed a key", "a lone character is typing: never said");
  assert.equal(label({ nav: "home" }), "Went home");
  assert.equal(label({ nav: "app_switch" }), "Opened the recent apps");
  assert.equal(label({ scroll: "@e3", dy: 400 }), "Scrolled");
  assert.equal(labelOf("computer_act", { steps: [{ scroll: "@e3", dy: 400 }] }, view("1. scroll @e3 list: semantic")), "Scrolled the list");
  assert.equal(label({ click: [120, 300] }), "Clicked at a point");
  assert.equal(label({ drag: [[0, 0], [9, 9]] }), "Dragged across the screen");
  assert.equal(label({ set: "@e2", value: "on" }), "Set an element");
  assert.equal(labelOf("computer_act", { steps: [{ set: "@e2", value: "on" }] }, view('1. set @e2 switch "Dark theme": semantic, verified')), "Set the switch “Dark theme”");
  assert.equal(label({ perform: "@e2", action: "ACTION_LONG_CLICK" }), "Acted on an element");
  assert.equal(labelOf("computer_act", { steps: [{ nav: "back" }, { nav: "back" }, { nav: "back" }, { nav: "home" }, { key: "enter" }] }), "Went back, went back, went back, +2 more");
  assert.equal(labelOf("computer_act", { app: "com.apple.Notes", steps: [], expect: { text: "Saved" } }), "Waited for Notes");
  assert.equal(labelOf("computer_act", {}), "Waited for the window");
});

test("no typed or set text shows, a secure field's or any other", () => {
  const steps = [{ type: "1234", into: "@e6" }, { set: "@e7", value: "hunter2" }, { type: "5678" }, { type: "dark", into: "@e2" }];
  const answer = ['1. type into @e6 textbox "PIN" [secure]: semantic, verified', '2. set @e7 textbox "Password" [secure]: semantic, verified', "3. type: semantic, verified", '4. type into @e2 textbox "Notes": semantic, verified'].join("\n");
  const label = labelOf("computer_act", { steps }, view(answer));
  assert.equal(label, "Typed into the text box “PIN”, set the text box “Password”, typed text, +1 more");
  for (const text of ["1234", "hunter2", "5678", "dark"]) assert.ok(!label.includes(text));
});

test("a finished act says the steps that ran: a refused one as tried, the ones after it not at all", () => {
  const steps = [{ press: "@e9" }, { nav: "home" }, { type: "never ran" }];
  assert.equal(labelOf("computer_act", { steps }, view('1. press @e9 button "Save": refused (stale): gone\n2 later steps did not run')), "Could not press “Save”");
  const later = view(['1. nav: semantic, verified', '2. press @e9 button "Save": refused (stale): gone', "1 later steps did not run"].join("\n"));
  assert.equal(labelOf("computer_act", { steps: [{ nav: "back" }, ...steps] }, later), "Went back, could not press “Save”");
  const five = Array.from({ length: 5 }, (_, i) => `${i + 1}. nav: semantic, verified`).join("\n");
  assert.equal(labelOf("computer_act", { steps: [...Array(5).fill({ nav: "back" }), { nav: "home" }] }, view(`${five}\n1 steps did not run`)), "Went back, went back, went back, +2 more", "the count is of the steps that ran");
  assert.equal(labelOf("computer_act", { app: "com.android.settings", steps }, view("the computer went away", true)), "Could not act on Settings", "an answer with no step lines: nothing is known to have run");
});

test("a refused step makes the act's outcome failed, saying which step and why", () => {
  const answer = ['1. press @e31 generic "Search settings": semantic, verified', "2. type: refused (denied): type with no text field focused", "changed · state s3"].join("\n");
  assert.deepEqual(outcomeOf("computer_act", view(answer)), { failed: true, text: "step 2 refused: type with no text field focused" });
  assert.equal(callFailed("computer_act", view(answer)), true);
  assert.equal(outcomeOf("computer_act", view("1. press: semantic, verified\nchanged · state s2")), undefined);
});

test("observe names the app; with no ui group it was a screenshot; a script's title when it gives one", () => {
  assert.equal(labelOf("computer_observe", {}, view('state s8 · com.android.settings "Settings" · window "Display" 360×640 pt\n@e1 generic')), "Looked at Settings");
  assert.equal(labelOf("computer_observe", { app: "com.apple.TextEdit" }), "Looked at TextEdit");
  assert.equal(labelOf("computer_observe", {}, view("screen 1080×2400 px · com.android.settings in front · this computer has no ui group")), "Took a screenshot");
  assert.equal(labelOf("computer_observe", {}), "Looked at the window");
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
