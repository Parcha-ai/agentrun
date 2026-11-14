// The computer viewer's keyboard (computer-viewer.ts), run in a VM against a fake page: a soft keyboard's typing, which
// comes as keydown keyCode 229 and then the sink's beforeinput, reaches the computer once; a desktop's typed key, whose
// keydown is cancelled, never also comes as a beforeinput's text. The fake dispatch fires the beforeinput only when the
// keydown was not cancelled, as a browser does.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { computerViewerAssets } from "../dist/computer-viewer.js";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.width = 0;
    this.height = 0;
    this.classList = { toggle() {} };
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, fields) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return event;
  }
  focus() {}
  getContext() { return { drawImage() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}

/** The viewer's script on a fake page, its WebSocket open and ready for `input` with the person holding the computer. */
function viewer(input, hash = "#t=token") {
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); };
  const sent = [];
  let socket;
  class FakeWebSocket {
    constructor() { this.readyState = 1; socket = this; }
    send(data) { sent.push(JSON.parse(data)); }
  }
  const window = { addEventListener() {} };
  const context = vm.createContext({
    location: { hash, pathname: "/v2/runs/r/computer/live/v/x", search: "", protocol: "http:", host: "h" },
    history: { replaceState() {} },
    document: { getElementById: el, body: new FakeElement("body") },
    URLSearchParams,
    WebSocket: FakeWebSocket,
    ResizeObserver: class { observe() {} },
    window,
    JSON,
    Object,
    Math,
    Number,
    String,
    Date,
  });
  vm.runInContext(computerViewerAssets.js, context);
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: "ready", kind: input === "desktop" ? "desktop" : "phone", input, held: true, drive: "person" }) });
  sent.length = 0;
  const sink = el("sink");
  /** A key as a browser delivers it to the focused sink: keydown, then (unless it was cancelled) beforeinput. */
  const press = (keydown, beforeinput) => {
    const down = sink.dispatch("keydown", { key: "Unidentified", code: "", keyCode: 0, isComposing: false, ...keydown });
    const before = !down.defaultPrevented && beforeinput ? sink.dispatch("beforeinput", { isComposing: false, data: null, ...beforeinput }) : undefined;
    if (before && !before.defaultPrevented) sink.dispatch("input", { isComposing: false });
    return { down, before };
  };
  return { sent, sink, press, socket, notice: el("notice"), drive: el("drive"), hands: el("hands"), bar: el("bar"), phone: el("phone") };
}

test("a soft keyboard's typing (keydown 229, then beforeinput) reaches the phone once, and its deletes and Enter as keys", () => {
  const { sent, sink, press } = viewer("android");
  const typed = press({ keyCode: 229 }, { inputType: "insertText", data: "h" });
  press({ keyCode: 229 }, { inputType: "insertText", data: "i" });
  assert.equal(typed.before.defaultPrevented, true, "the sink keeps nothing the keyboard typed");
  press({ keyCode: 229 }, { inputType: "deleteContentBackward" });
  press({ keyCode: 229 }, { inputType: "insertLineBreak" });
  press({ keyCode: 229 }, { inputType: "deleteContentForward" });
  assert.deepEqual(sent, [
    { type: "text", text: "h" },
    { type: "text", text: "i" },
    { type: "key", action: "down", key: "Backspace", code: "", modifiers: 0 },
    { type: "key", action: "down", key: "Enter", code: "", modifiers: 0 },
    { type: "key", action: "down", key: "Delete", code: "", modifiers: 0 },
  ]);
  assert.equal(sink.value, "");
});

test("an autocorrect replacement deletes the replaced range, then types the new word", () => {
  const { sent, sink } = viewer("android");
  const node = {};
  sink.dispatch("beforeinput", {
    inputType: "insertReplacementText",
    isComposing: false,
    data: null,
    dataTransfer: { getData: (type) => (type === "text/plain" ? "the" : "") },
    getTargetRanges: () => [{ startContainer: node, endContainer: node, startOffset: 0, endOffset: 3 }],
  });
  assert.deepEqual(sent, [
    { type: "key", action: "down", key: "Backspace", code: "", modifiers: 0 },
    { type: "key", action: "down", key: "Backspace", code: "", modifiers: 0 },
    { type: "key", action: "down", key: "Backspace", code: "", modifiers: 0 },
    { type: "text", text: "the" },
  ]);
});

test("a composition's steps are left to compositionend: the word goes once", () => {
  const { sent, sink } = viewer("android");
  const step = sink.dispatch("beforeinput", { inputType: "insertCompositionText", isComposing: true, data: "wor" });
  assert.equal(step.defaultPrevented, false);
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: true, data: "word" });
  sink.dispatch("compositionend", { data: "word" });
  assert.deepEqual(sent, [{ type: "text", text: "word" }]);
});

test("an insertText that repeats the composition just ended sends nothing; a different one still sends", () => {
  const { sent, sink } = viewer("android");
  sink.dispatch("compositionend", { data: "word" });
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: false, data: "word" });
  assert.deepEqual(sent, [{ type: "text", text: "word" }]);
  sink.dispatch("compositionend", { data: "word" });
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: false, data: "other" });
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: false, data: "word" });
  assert.deepEqual(sent.map((m) => m.text), ["word", "word", "other", "word"]);
});

test("a desktop's typed key goes once, as its char: its keydown is cancelled, so no beforeinput types it again", () => {
  const { sent, press } = viewer("desktop");
  const typed = press({ key: "a", code: "KeyA", keyCode: 65 }, { inputType: "insertText", data: "a" });
  assert.equal(typed.down.defaultPrevented, true);
  assert.equal(typed.before, undefined);
  const backspace = press({ key: "Backspace", code: "Backspace", keyCode: 8 }, { inputType: "deleteContentBackward" });
  assert.equal(backspace.before, undefined);
  assert.deepEqual(sent, [
    { type: "key", action: "char", key: "a", code: "KeyA", text: "a", modifiers: 0 },
    { type: "key", action: "down", key: "Backspace", code: "Backspace", modifiers: 0 },
  ]);
});

test("AltGr's character (reported with Ctrl and Alt held) goes as text, while Ctrl+Alt on a letter stays a shortcut", () => {
  const { sent, press } = viewer("desktop");
  const altGraph = (on) => ({ getModifierState: (name) => name === "AltGraph" && on });
  press({ key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true, ...altGraph(true) });
  press({ key: "t", code: "KeyT", keyCode: 84, ctrlKey: true, altKey: true, ...altGraph(false) });
  assert.deepEqual(sent, [
    { type: "key", action: "char", key: "@", code: "KeyQ", text: "@", modifiers: 0 },
    { type: "key", action: "down", key: "t", code: "KeyT", modifiers: 3 },
  ]);
});

test("a dead key sends nothing itself: the character it makes goes once, by its composition or its input", () => {
  const { sent, sink, press } = viewer("desktop");
  const dead = press({ key: "Dead", code: "Quote", keyCode: 222 });
  assert.equal(dead.down.defaultPrevented, false, "left to the browser to compose");
  sink.dispatch("beforeinput", { inputType: "insertCompositionText", isComposing: true, data: "´" });
  sink.dispatch("compositionend", { data: "é" });
  press({ key: "Dead", code: "Quote", keyCode: 222 });
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: false, data: "é" });
  assert.deepEqual(sent, [{ type: "text", text: "é" }, { type: "text", text: "é" }]);
});

test("a paste goes once, through the paste handler, not as a beforeinput", () => {
  const { sent, sink } = viewer("desktop");
  const pasted = sink.dispatch("beforeinput", { inputType: "insertFromPaste", isComposing: false, data: null });
  assert.equal(pasted.defaultPrevented, false);
  sink.dispatch("paste", { clipboardData: { getData: () => "pasted" } });
  assert.deepEqual(sent, [{ type: "text", text: "pasted" }]);
});

test("a hand-back is said once, in the server's words for its kind; who drives names the phone", () => {
  const { socket, notice, drive } = viewer("android");
  assert.equal(drive.textContent, "you have the phone");
  socket.onmessage({ data: JSON.stringify({ type: "hold", held: false, reason: "given", message: "You handed the phone back" }) });
  assert.equal(notice.textContent, "You handed the phone back.");
  assert.equal(drive.textContent, "the agent has the phone");
  socket.onmessage({ data: JSON.stringify({ type: "hold", held: true }) });
  socket.onmessage({ data: JSON.stringify({ type: "hold", held: false, reason: "away" }) });
  assert.equal(notice.textContent, "The phone went back to the agent: the live view was closed.", "with no words of the server's, the viewer's own, for its kind");
});

test("a soft keyboard's typing while the agent has the computer sends nothing and says Take over", () => {
  const { sent, sink, socket, notice } = viewer("android");
  socket.onmessage({ data: JSON.stringify({ type: "hold", held: false, reason: "given" }) });
  sink.dispatch("beforeinput", { inputType: "insertText", isComposing: false, data: "x" });
  assert.deepEqual(sent, []);
  assert.equal(notice.textContent, "Take over to drive.");
});

test("framed by a page with its own Take over and Hand back (hands=page), the viewer shows neither, nor who drives; a desktop's bar goes, a phone's keeps its buttons", () => {
  for (const input of ["desktop", "android"]) {
    const { socket, hands, drive, bar, phone, notice } = viewer(input, "#t=token&hands=page");
    assert.equal(hands.hidden, true, `${input}: no second Take over`);
    assert.equal(drive.hidden, true, `${input}: the page says who drives`);
    assert.equal(bar.hidden, input === "desktop", `${input}: the bar stays only for a phone's back, home and recents`);
    assert.equal(phone.hidden, input === "desktop");
    socket.onmessage({ data: JSON.stringify({ type: "hold", held: false, reason: "given" }) });
    assert.equal(hands.hidden, true, "still none after a hold changes");
    assert.match(notice.textContent, /back to the agent/, "how a hold ended is still said");
  }
  const own = viewer("desktop");
  assert.equal(own.hands.hidden, false, "opened on its own, the viewer has its Take over");
  assert.equal(own.bar.hidden, false);
});
