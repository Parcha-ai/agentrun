// One computer step reads in one voice wherever a person sees it: the Timeline row of a computer tool call (its label,
// from the call's input and answer), the step's expanded call list (serve's record of each computer call) and a movie's
// caption (call-words.mjs, the same record). The same step on a phone, a Linux desktop and a Mac reads the same, in the
// plain past tense: what happened.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callRecordOf } from "../dist/computer-calls.js";
import { callWords, labelOf } from "../dist/timeline/index.js";

const CAPTIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "computer", "daemon-macos", "scripts", "call-words.mjs");
const captions = (calls) => execFileSync(process.execPath, [CAPTIONS], { input: calls.map((call) => `${JSON.stringify(call)}\n`).join(""), encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line));
const view = (text, isError = false) => ({ text, details: undefined, isError });
const at = "2026-11-14T12:00:00.000Z";

/** One app each surface drives, by the id its computer names it with, and the name a person knows it by. */
const SURFACES = [
  { surface: "phone", app: "com.android.settings", name: "Settings" },
  { surface: "Linux desktop", app: "org.xfce.mousepad", name: "Mousepad" },
  { surface: "Mac", app: "com.apple.TextEdit", name: "TextEdit" },
];

/** A step as the model asks it, its line in the act's answer, the record serve keeps of it, and the words for it. */
const STEPS = [
  { asked: { press: "@e3" }, line: '1. press @e3 button "Save": semantic, verified', kept: { do: "press", on: { role: "button", name: "Save" }, route: "semantic", verified: true }, words: "Pressed “Save”" },
  { asked: { type: "41", into: "@e4" }, line: '1. type into @e4 textbox "Pears": semantic, verified', kept: { do: "type", on: { role: "textbox", name: "Pears" }, route: "semantic", verified: true }, words: "Typed into the text box “Pears”" },
  { asked: { type: "1234" }, line: "1. type: semantic, verified", kept: { do: "type", route: "semantic", verified: true }, words: "Typed text" },
  { asked: { key: "super+s" }, line: "1. key: background", kept: { do: "key", keys: "super+s", route: "background" }, words: "Saved (⌘S)" },
  { asked: { key: "a" }, line: "1. key: background", kept: { do: "key", route: "background" }, words: "Pressed a key" },
  { asked: { key: "enter" }, line: "1. key: background", kept: { do: "key", keys: "enter", route: "background" }, words: "Pressed Return" },
  { asked: { nav: "back" }, line: "1. nav: semantic, verified", kept: { do: "nav", nav: "back", route: "semantic", verified: true }, words: "Went back" },
  { asked: { click: "@e7" }, line: '1. click @e7 cell "draft.txt": semantic', kept: { do: "click", on: { role: "cell", name: "draft.txt" }, route: "semantic" }, words: "Clicked “draft.txt”" },
  { asked: { click: [120, 300] }, line: "1. click: input", kept: { do: "click", route: "input" }, words: "Clicked at a point" },
  { asked: { press: "@e3" }, line: '1. press @e3 button "Save": refused (stale): gone', kept: { do: "press", on: { role: "button", name: "Save" }, error: "stale" }, words: "Could not press “Save”" },
];

test("one step, one string: the Timeline row, the expanded call and the caption, on a phone, a Linux desktop and a Mac", () => {
  for (const { surface, app } of SURFACES) {
    const records = STEPS.map(({ kept }) => ({ method: "ui.act", started_at: at, app, ok: true, ms: 40, steps: [kept] }));
    const shown = captions(records);
    STEPS.forEach(({ asked, line, words }, index) => {
      assert.equal(labelOf("computer_act", { app, steps: [asked] }, view(line)), words, `${surface}: the Timeline row of ${JSON.stringify(asked)}`);
      assert.equal(callWords(records[index]), words, `${surface}: the expanded call of ${JSON.stringify(asked)}`);
      assert.equal(shown[index], words, `${surface}: the caption of ${JSON.stringify(asked)}`);
    });
  }
  // A scripted demo captions its own calls in the record's shape, its chords as asked: the caption keeps them as the
  // record would.
  assert.deepEqual(captions([{ method: "ui.act", app: "com.apple.Notes", ok: true, steps: [{ do: "key", keys: "x" }, { do: "key", keys: "super+n" }] }]), ["Pressed a key, pressed ⌘N"]);
});

test("an act of several steps reads the same on its row and in its call: the first three, the rest counted", () => {
  const asked = [{ key: "super+a" }, { type: "42", into: "@e4" }, { key: "super+s" }, { nav: "back" }];
  const line = ["1. key: background", '2. type into @e4 textbox "Pears": semantic, verified', "3. key: background", "4. nav: semantic, verified"].join("\n");
  const kept = [{ do: "key", keys: "super+a" }, { do: "type", on: { role: "textbox", name: "Pears" } }, { do: "key", keys: "super+s" }, { do: "nav", nav: "back" }];
  const words = "Selected all (⌘A), typed into the text box “Pears”, saved (⌘S), +1 more";
  for (const { app } of SURFACES) {
    assert.equal(labelOf("computer_act", { app, steps: asked }, view(line)), words);
    assert.equal(callWords({ method: "ui.act", started_at: at, app, ok: true, ms: 9, steps: kept }), words);
  }
});

test("a step refused after the first three is still said, on the row and in the call: the ones before it are counted", () => {
  const asked = [{ key: "super+a" }, { type: "42", into: "@e4" }, { key: "super+s" }, { nav: "back" }, { press: "@e3" }];
  const line = ["1. key: background", '2. type into @e4 textbox "Pears": semantic, verified', "3. key: background", "4. nav: semantic, verified", '5. press @e3 button "Save": refused (stale): gone'].join("\n");
  const kept = [{ do: "key", keys: "super+a" }, { do: "type", on: { role: "textbox", name: "Pears" } }, { do: "key", keys: "super+s" }, { do: "nav", nav: "back" }, { do: "press", on: { role: "button", name: "Save" }, error: "stale" }];
  const words = "Selected all (⌘A), typed into the text box “Pears”, saved (⌘S), +1 more, could not press “Save”";
  assert.equal(labelOf("computer_act", { app: "com.apple.TextEdit", steps: asked }, view(line)), words);
  assert.equal(callWords({ method: "ui.act", started_at: at, app: "com.apple.TextEdit", ok: true, ms: 9, steps: kept }), words);
  // The fourth refused: nothing between to count.
  assert.equal(callWords({ method: "ui.act", started_at: at, ok: true, ms: 9, steps: kept.slice(0, 3).concat(kept[4]) }), "Selected all (⌘A), typed into the text box “Pears”, saved (⌘S), could not press “Save”");
});

test("a look that names no app reads the same on the row and in its record: the app the answer shows", () => {
  for (const { app, name } of SURFACES) {
    const answer = { ok: true, value: { state: "s8", app: { id: app, name }, window: { title: "Untitled" }, nodes: [] } };
    const record = callRecordOf("ui.observe", {}, answer, 30, Date.parse(at));
    const head = `state s8 · ${app} ${JSON.stringify(name)} · window "Untitled" 360×640 pt\n@e1 generic`;
    assert.equal(labelOf("computer_observe", {}, view(head)), `Looked at ${name}`);
    assert.equal(callWords(record), `Looked at ${name}`);
  }
});

test("a look, a wait and a failed act read the same on the row and in the call, each app by the name a person knows", () => {
  for (const { app, name } of SURFACES) {
    const call = (fields) => ({ method: "ui.act", started_at: at, app, ok: true, ms: 9, ...fields });
    const head = `state s8 · ${app} ${JSON.stringify(name)} · window "Untitled" 360×640 pt\n@e1 generic`;
    assert.equal(labelOf("computer_observe", { app }, view(head)), `Looked at ${name}`);
    assert.equal(callWords(call({ method: "ui.observe" })), `Looked at ${name}`);
    assert.equal(labelOf("computer_act", { app, steps: [], expect: { text: "Saved" } }, view("expect: met\nunchanged · state s9")), `Waited for ${name}`);
    assert.equal(callWords(call({ steps: [], expect: "met" })), `Waited for ${name}`);
    assert.equal(labelOf("computer_act", { app, steps: [], expect: { text: "Saved" } }, view("expect: unmet\nunchanged · state s9")), `Waited for ${name} (not seen)`);
    assert.equal(callWords(call({ steps: [], expect: "unmet" })), `Waited for ${name} (not seen)`);
    assert.equal(labelOf("computer_act", { app, steps: [{ press: "@e3" }] }, view("the computer went away", true)), `Could not act on ${name}`);
    assert.equal(callWords(call({ ok: false, code: "gone" })), `Could not act on ${name}`);
    assert.equal(callWords(call({ method: "apps.launch" })), `Opened ${name}`);
  }
});
