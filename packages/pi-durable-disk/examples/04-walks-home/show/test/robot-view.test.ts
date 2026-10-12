import assert from "node:assert/strict";
import { test } from "node:test";
import { checkinFromData, homecomingFromData, netFromData, routingFromData } from "../robot-events.ts";
import { changeCardHtml, checkinLine, checkinNote, fileChanges, homecomingLine, homecomingNote, netBadge, netNote, routingCardHtml, toolStripHtml, toolSummary } from "../robot-view.ts";
import type { ToolRow } from "../types.ts";

// What the stage says about the tab's own events: only the events' fields. Nothing here is a number the event did not carry.
const JEV = routingFromData({ brain: "tab-local", answering: "the model in this tab", reason: "a simple task the model in this tab handles", confidence: 0.99, decidedBy: "jev", ms: 412, probabilities: { local: 0.99, cloud: 0.01 } })!;
const RULE_OFFLINE = routingFromData({ brain: "tab-local", answering: "the model in this tab", reason: "offline: the model in this tab is the only brain", confidence: null, decidedBy: "rule", ms: 0 })!;
const CLOUD = routingFromData({ brain: "cloud", answering: "the cloud model", reason: "this needs the cloud: it trains a model on a GPU", confidence: 0.93, decidedBy: "jev", ms: 380, probabilities: { local: 0.07, cloud: 0.93 } })!;

test("the net badge says ONLINE or OFFLINE from the tab's own signal, with its reason as the hover; nothing before the tab has said", () => {
  assert.equal(netBadge(null), null);
  assert.deepEqual(netBadge(netFromData({ online: false, reason: "no network and the ping failed" })!), { label: "OFFLINE", online: false, title: "no network and the ping failed" });
  assert.deepEqual(netBadge(netFromData({ online: true })!), { label: "ONLINE", online: true, title: "" });
});

test("the decision card: who answers, why, and how it was decided (Jev's probability and time, or a rule), from the decision's fields", () => {
  const html = routingCardHtml(JEV);
  assert.match(html, /Last message went to/, "a decision is made per message: the card says whose it was, not that it is current");
  assert.doesNotMatch(html, /Answering now/);
  assert.match(html, /the model in this tab/);
  assert.match(html, /a simple task the model in this tab handles/);
  assert.match(html, /decided by Jev, 99% sure, in 412 ms/);
  assert.match(html, /data-brain="tab-local"/);
  assert.match(routingCardHtml(RULE_OFFLINE), /decided by a rule/);
  assert.doesNotMatch(routingCardHtml(RULE_OFFLINE), /%|\bms\b/, "a rule has no probability, and says no time it did not measure");
  assert.match(routingCardHtml(CLOUD), /data-brain="cloud"/);
  assert.match(routingCardHtml(CLOUD), /93% sure/);
  // A reason with markup is text.
  assert.doesNotMatch(routingCardHtml({ ...JEV, reason: "<img src=x onerror=alert(1)>" }), /<img/);
  // No name for the answering brain: the card says which of the two it is, from the brain field.
  assert.match(routingCardHtml({ ...JEV, answering: null }), /the model in this tab|the trained model in this tab/);
  assert.match(routingCardHtml({ ...CLOUD, answering: null }), /the cloud model/);
});

test("the check-in line follows the check-in's phase and says only the numbers it carried", () => {
  assert.equal(checkinLine(null), null);
  assert.equal(checkinLine(checkinFromData({ phase: "start", head: "h-12" })!), "Checking in: sending this browser's copy of the run to the server");
  assert.equal(checkinLine(checkinFromData({ phase: "start", head: "h-12", resumed: true })!), "Checking in again: the earlier attempt was cut off, so the saved copy is sent as it was");
  assert.equal(checkinLine(checkinFromData({ phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204 })!), "Checked in: 3 files written offline came home, 5 changes, in 1.2 s");
  assert.equal(checkinLine(checkinFromData({ phase: "done", head: "h-14", files: 1 })!), "Checked in: 1 file written offline came home");
  assert.equal(checkinLine(checkinFromData({ phase: "done" })!), "Checked in");
  assert.equal(checkinLine(checkinFromData({ phase: "failed", message: "the store does not extend the head", code: "CHECKIN_DIVERGED" })!), "The check-in did not go through: the store does not extend the head. This browser keeps its copy");
  assert.equal(checkinLine(checkinFromData({ phase: "failed" })!), "The check-in did not go through. This browser keeps its copy");
});

test("the homecoming line: the bytes on the wire as the page counted them; 'base 0 bytes' only when the plan said the base was already here", () => {
  assert.equal(homecomingLine(null), null);
  const adapters = homecomingFromData({ phase: "fetched", plan: { base: false, adapters: ["gg-lora.gguf"], bytes: 18_400_000 }, fetched_bytes: 18_400_000, fetch_ms: 1380 })!;
  assert.equal(homecomingLine(adapters), "Came home: 18.4 MB on the wire in 1.4 s. The base model was already in this browser: base 0 bytes");
  assert.equal(homecomingLine({ ...adapters, loadMs: 7771 }), "Came home: 18.4 MB on the wire in 1.4 s. The base model was already in this browser: base 0 bytes. Loaded in 7.8 s");
  const whole = homecomingFromData({ phase: "fetched", plan: { base: true, adapters: [], bytes: 806_000_000 }, fetched_bytes: 806_000_000, fetch_ms: 41_000 })!;
  assert.equal(homecomingLine(whole), "Came home: 806 MB on the wire in 41 s, the whole model");
  const pre = homecomingFromData({ phase: "fetched", prefetch: true, plan: { base: true, adapters: [], bytes: 806_000_000 }, fetched_bytes: 806_000_000, fetch_ms: 41_000 })!;
  assert.equal(homecomingLine(pre), "The base model came home while the agent trained: 806 MB in 41 s");
  assert.equal(homecomingLine({ ...adapters, fetchedBytes: null, fetchMs: null }), "Came home. The base model was already in this browser: base 0 bytes");
  assert.equal(homecomingLine({ ...adapters, baseFetched: false, adapters: [], plannedBytes: 0, fetchedBytes: 0, fetchMs: 12 }), "Came home: 0 bytes on the wire in 12 ms. The base model was already in this browser: base 0 bytes");
});

const row = (name: string, args: unknown, over: Partial<ToolRow> = {}): ToolRow => ({ id: name, name, args: typeof args === "string" ? args : JSON.stringify(args), output: "", status: "done", ...over });

test("a tool row is its name and the argument that says what it did, short; a call with arguments the stage cannot read shows the name only", () => {
  assert.equal(toolSummary(row("write", { path: "hello.js", content: "console.log(1)" })), "write hello.js");
  assert.equal(toolSummary(row("read", { path: "src/a.ts" })), "read src/a.ts");
  assert.equal(toolSummary(row("edit", { path: "hello.js", oldText: "1", newText: "2" })), "edit hello.js");
  assert.equal(toolSummary(row("bash", { command: "node hello.js" })), "bash node hello.js");
  assert.equal(toolSummary(row("bash", { command: "x".repeat(200) })).length <= 64, true);
  assert.equal(toolSummary(row("bash", "not json")), "bash");
  assert.equal(toolSummary(row("switch_environment", {})), "switch_environment");
});

test("the tool strip: a row per call in order with its status and the first line of its output; the newest rows when there are many; nothing for no calls", () => {
  assert.equal(toolStripHtml([]), "");
  const html = toolStripHtml([row("write", { path: "hello.js" }, { output: "wrote 14 bytes\nmore" }), row("bash", { command: "node hello.js" }, { status: "running" }), row("bash", { command: "boom" }, { status: "error", output: "exit 1" })]);
  assert.match(html, /data-status="done"[^>]*>.*write hello\.js/s);
  assert.match(html, /wrote 14 bytes/);
  assert.doesNotMatch(html, /more/, "the first line of the output only");
  assert.match(html, /data-status="running"/);
  assert.match(html, /data-status="error"/);
  const many = Array.from({ length: 12 }, (_, i) => row(`t${i}`, {}));
  const shown = toolStripHtml(many);
  assert.match(shown, /t11/);
  assert.doesNotMatch(shown, /t0\b/);
  assert.match(shown, /6 earlier/);
  assert.doesNotMatch(toolStripHtml([row("bash", { command: "<b>x</b>" })]), /<b>x/);
});

test("the captions: a net change (kept: it is the whole point of the beat), a finished or failed check-in, and a homecoming's bytes; a check-in that is only starting says nothing (the line does)", () => {
  assert.deepEqual(netNote(netFromData({ online: false, reason: "no network and the ping failed" })!, 100), { at: 100, kind: "home", text: "The agent's tab is offline: no network and the ping failed", rank: 5, urgent: true, keep: true });
  assert.equal(netNote(netFromData({ online: false })!, 1)!.text, "The agent's tab is offline");
  assert.equal(netNote(netFromData({ online: true })!, 1)!.text, "The agent's tab is back online");
  assert.equal(checkinNote(checkinFromData({ phase: "start", head: "h" })!, 1), null);
  assert.deepEqual(checkinNote(checkinFromData({ phase: "done", files: 3, changes: 5, ms: 1204 })!, 2), { at: 2, kind: "home", text: "Checked in: 3 files written offline came home, 5 changes, in 1.2 s", rank: 4, urgent: true });
  assert.deepEqual(checkinNote(checkinFromData({ phase: "failed", message: "refused" })!, 3), { at: 3, kind: "home", text: "The check-in did not go through: refused. This browser keeps its copy", rank: 5, urgent: true });
  const h = homecomingFromData({ phase: "fetched", plan: { base: false, adapters: ["a"], bytes: 18_400_000 }, fetched_bytes: 18_400_000, fetch_ms: 1380 })!;
  assert.deepEqual(homecomingNote(h, 4, true), { at: 4, kind: "home", text: "Came home: 18.4 MB on the wire in 1.4 s. The base model was already in this browser: base 0 bytes", rank: 3, measured: true });
  assert.equal(homecomingNote({ ...h, fetchedBytes: null, fetchMs: null }, 4, true)!.measured, undefined, "no bytes in the event: nothing is claimed as measured");
  assert.equal(homecomingNote(h, 4, false)!.measured, undefined, "a scripted feed never claims a measurement");
});

// ---- The robot-change card: what the local model changed, read from its own tool calls (the world is files the creature page watches).
test("file changes: an edit is from -> to; a write of a JSON object lists its values; other writes say they wrote; running and failed calls are not changes", () => {
  const edit = row("edit", { path: "world.json", oldText: "\"color\": \"blue\"", newText: "\"color\": \"red\"" }, { output: "Successfully replaced text in world.json" });
  assert.deepEqual(fileChanges([edit]), [{ path: "world.json", what: "\"color\": \"blue\" -> \"color\": \"red\"" }]);
  const write = row("write", { path: "robot.json", content: JSON.stringify({ legs: 8, color: "red", body: { size: 2 }, name: "spider" }) });
  assert.deepEqual(fileChanges([write]), [{ path: "robot.json", what: "legs: 8, color: red, name: spider" }], "top-level scalars only, in order");
  assert.deepEqual(fileChanges([row("write", { path: "notes.txt", content: "hello world\nsecond line" })]), [{ path: "notes.txt", what: "hello world" }]);
  assert.deepEqual(fileChanges([row("write", { path: "empty.txt", content: "" })]), [{ path: "empty.txt", what: "written" }]);
  assert.deepEqual(fileChanges([row("write", { path: "a.json", content: "{}" }, { status: "running" }), row("write", { path: "b.json", content: "{}" }, { status: "error" }), row("bash", { command: "ls" }), row("read", { path: "a.json" })]), [], "only finished writes and edits");
  assert.deepEqual(fileChanges([row("edit", { path: "w.json", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] })]), [{ path: "w.json", what: "a -> b; c -> d" }]);
  assert.equal(fileChanges([row("write", { path: "x", content: "y".repeat(500) })])[0]!.what.length <= 80, true);
  assert.deepEqual(fileChanges([row("write", "not json")]), []);
});

test("the change card says who changed it and whether the tab was offline, then each file and what changed; nothing for no changes", () => {
  assert.equal(changeCardHtml([], null, null), "");
  const changes = [{ path: "robot.json", what: "legs: 8, color: red" }, { path: "world.json", what: "a -> b" }];
  const offline = changeCardHtml(changes, netFromData({ online: false, reason: "x" })!, JEV);
  assert.match(offline, /The robot was changed by/);
  assert.match(offline, /the model in this tab/);
  assert.match(offline, /offline/);
  assert.match(offline, /robot\.json/);
  assert.match(offline, /legs: 8, color: red/);
  const online = changeCardHtml(changes, netFromData({ online: true })!, CLOUD);
  assert.match(online, /the cloud model/);
  assert.doesNotMatch(online, /offline/);
  assert.match(changeCardHtml(changes, null, null), /the agent/, "no decision heard yet: the agent");
  assert.doesNotMatch(changeCardHtml([{ path: "a", what: "<img src=x onerror=1>" }], null, null), /<img/);
  assert.equal((changeCardHtml(Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, what: "w" })), null, null).match(/<li/g) ?? []).length, 5, "the newest five");
});

// ---- The robot's own tools (03-tab-to-cloud/robot-tools.ts): the demo changes the robot with set_color, set_shape, set_face, rename, resize, scale, set_legs, morph, reset, do and update_robot, not by
// writing files, so the change card reads those calls' arguments too.
test("robot tool calls are changes to the robot: each in a few plain words from its own arguments; running and failed calls are not", () => {
  const call = (name: string, args: unknown, over: Partial<ToolRow> = {}) => row(name, args, over);
  const what = (r: ToolRow) => fileChanges([r]);
  assert.deepEqual(what(call("set_color", { part: "torso", color: "green" })), [{ path: "robot", what: "colour: green (torso)" }]);
  assert.deepEqual(what(call("set_color", { part: "all", color: "red" })), [{ path: "robot", what: "colour: red (all)" }]);
  assert.deepEqual(what(call("set_shape", { part: "legs", shape: "round" })), [{ path: "robot", what: "shape: round (legs)" }]);
  assert.deepEqual(what(call("set_face", { face: "happy" })), [{ path: "robot", what: "face: happy" }]);
  assert.deepEqual(what(call("rename", { name: "Mossy" })), [{ path: "robot", what: "name: Mossy" }]);
  assert.deepEqual(what(call("resize", { part: "legs", factor: 1.5 })), [{ path: "robot", what: "legs x1.5" }]);
  assert.deepEqual(what(call("scale", { factor: 2 })), [{ path: "robot", what: "size x2" }]);
  assert.deepEqual(what(call("set_legs", { pairs: 2 })), [{ path: "robot", what: "4 legs" }]);
  assert.deepEqual(what(call("set_legs", { pairs: 3 })), [{ path: "robot", what: "6 legs" }]);
  assert.deepEqual(what(call("morph", { preset: "spider" })), [{ path: "robot", what: "now a spider" }]);
  assert.deepEqual(what(call("reset", {})), [{ path: "robot", what: "back to the default body" }]);
  assert.deepEqual(what(call("do", { skill: "spin" })), [{ path: "robot", what: "skill: spin" }]);
  assert.deepEqual(what(call("update_robot", { name: "Mossy", legs: 4, color: "green", face: "happy" })), [{ path: "robot", what: "name: Mossy, legs: 4, color: green, face: happy" }]);
  assert.deepEqual(what(call("set_color", { part: "all", color: "red" }, { status: "running" })), []);
  assert.deepEqual(what(call("set_color", { part: "all", color: "red" }, { status: "error" })), []);
  assert.deepEqual(what(call("set_color", "not json")), [], "arguments the stage cannot read: nothing is claimed");
  assert.deepEqual(what(call("set_legs", { pairs: 9 })), [{ path: "robot", what: "legs" }], "an argument it does not know is not turned into a claim");
  // In order, with file changes beside them; the card lists the robot's changes under its own name.
  const mixed = fileChanges([call("set_color", { part: "torso", color: "green" }), call("write", { path: "notes.txt", content: "hi" }), call("do", { skill: "spin" })]);
  assert.deepEqual(mixed.map((c) => c.path), ["robot", "notes.txt", "robot"]);
  assert.match(changeCardHtml([{ path: "robot", what: "colour: green (torso)" }], null, null), /colour: green \(torso\)/);
});
