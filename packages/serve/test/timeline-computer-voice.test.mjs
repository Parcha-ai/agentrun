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
import { callWords, labelOf, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result } from "./timeline-lib-support.mjs";

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
  // A scripted demo captions its own raw calls (method, params, answer): serve records each as it records an agent's,
  // its chords kept as the record keeps them, each ref by the name an earlier look gave it.
  const target = { app: "com.apple.Notes" };
  const look = { ok: true, value: { app: { id: "com.apple.Notes" }, nodes: [{ ref: "@e3", role: "button", name: " New\n Note " }] } };
  const act = (steps) => ({ method: "ui.act", params: { target, steps }, answer: { ok: true, value: { steps: steps.map(() => ({ route: "semantic" })) } } });
  assert.deepEqual(captions([act([{ key: "x" }, { key: "super+n" }]), { method: "ui.observe", params: { target }, answer: look }, act([{ press: "@e3" }])]), [
    "Pressed a key, pressed ⌘N",
    "Looked at Notes",
    "Pressed “New Note”",
  ]);
});

test("a started program reads as words in its call list and its caption, never as the wire method", () => {
  const params = { argv: ["sleep", "9"] };
  const answer = { ok: true, value: { pid: 41 } };
  assert.equal(callWords(callRecordOf("process.start", params, answer, 5, Date.parse(at))), "Started a process");
  assert.equal(callWords(callRecordOf("process.start", params, { ok: false, error: { code: "denied" } }, 5, Date.parse(at))), "Could not start a process");
  assert.deepEqual(captions([{ method: "process.start", params, answer }]), ["Started a process"]);
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

test("a failed computer step's row reads in the one voice, \"Could not …\", with why after it, never \"… failed: …\"", () => {
  const rows = timelineOf([
    assistant([
      call("a", "computer_script", { code: "await computer.processes.start(['sleep', '2'])" }),
      call("b", "computer_script", { code: "1", title: "Open Settings" }),
      call("c", "computer_screenshot", {}),
      call("d", "computer_act", { app: "org.xfce.mousepad", steps: [{ press: "@e3" }] }),
      call("e", "computer_observe", {}),
      call("f", "computer_script", { code: "return 1" }),
    ], 0),
    result("a", "computer_script", "could not start a program on the desktop: Permission denied", 1, { isError: true }),
    result("b", "computer_script", "the daemon's stream ended", 1, { isError: true }),
    result("c", "computer_screenshot", "the daemon's stream ended", 1, { isError: true }),
    result("d", "computer_act", "the computer went away", 1, { isError: true }),
    result("e", "computer_observe", "the computer went away", 1, { isError: true }),
    result("f", "computer_script", "1", 1),
  ]);
  const summary = (id) => rows.find((row) => row.tool_use_id === id && row.kind === "tool_result").summary;
  assert.equal(summary("a"), "Could not run a script on the computer: could not start a program on the desktop: Permission denied");
  assert.equal(summary("b"), "Could not run the script “Open Settings”: the daemon's stream ended");
  assert.equal(summary("c"), "Could not take a screenshot: the daemon's stream ended");
  assert.equal(summary("d"), "Could not act on Mousepad: the computer went away");
  assert.equal(summary("e"), "Could not look at the window: the computer went away");
  assert.equal(summary("f"), "Ran a script on the computer: ok", "a script that ran keeps its words");
});

test("an app whose id is not its name reads by the name a person knows: firefox-esr is Firefox, google-chrome Chrome", () => {
  assert.equal(callWords({ method: "apps.launch", started_at: at, app: "firefox-esr", ok: true, ms: 9 }), "Opened Firefox");
  assert.equal(callWords({ method: "apps.launch", started_at: at, app: "google-chrome", ok: true, ms: 9 }), "Opened Chrome");
  assert.equal(labelOf("computer_observe", { app: "firefox-esr" }), "Looked at Firefox");
});

test("a look on a computer with no ui group names every call it made, as its call list does: the app opened, the screenshot, the apps listed", () => {
  const front = (app) => `screen 1280×800 px · ${app} in front · this computer has no ui group: no elements; act at points of this image`;
  const record = (method, app) => ({ method, started_at: at, ok: true, ms: 9, ...(app ? { app } : {}) });
  const said = (records) => records.map(callWords).map((words, index) => (index === 0 ? words : words[0].toLowerCase() + words.slice(1))).join(", ");
  const seen = [record("screen.shot"), record("apps.list")];
  assert.equal(labelOf("computer_observe", {}, view(front("org.xfce.mousepad"))), said(seen));
  assert.equal(labelOf("computer_observe", {}, view(front("org.xfce.mousepad"))), "Took a screenshot, listed the apps");
  const opened = [record("apps.launch", "org.xfce.mousepad"), ...seen];
  assert.equal(labelOf("computer_observe", { app: "org.xfce.mousepad" }, view(front("org.xfce.mousepad"))), said(opened));
  assert.equal(labelOf("computer_observe", { app: "org.xfce.mousepad" }, view(front("org.xfce.mousepad"))), "Opened Mousepad, took a screenshot, listed the apps");
  // Nothing in front: the apps were listed all the same.
  assert.equal(labelOf("computer_observe", {}, view("screen 1280×800 px · no app in front; name one as app to open it: org.xfce.mousepad · this computer has no ui group: no elements; act at points of this image")), "Took a screenshot, listed the apps");
  // A computer with no apps group: the screenshot alone.
  assert.equal(labelOf("computer_observe", {}, view("screen 1080×2400 px · this computer has no ui group: no elements; act at points of this image")), "Took a screenshot");
});
