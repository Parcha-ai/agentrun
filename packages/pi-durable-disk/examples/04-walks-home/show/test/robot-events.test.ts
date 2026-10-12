import assert from "node:assert/strict";
import { test } from "node:test";
import { checkinFromData, homecomingFromData, homecomingLoadedFromData, netFromData, parseTabMessage, routingFromData, toolsFromItems } from "../robot-events.ts";
import { emptyState, fold, reduce } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

// The tab's own events for the robot demo beats (D3's d3/check-in): DOM events `walkshome:<type>` and the same as messages {source: "walks-home-tab", type, run, ...detail}. The shapes
// below are the ones its code builds (announce() in tab/main.ts, brainEvent() in brain-router.ts, planHomecoming in the 04 tab); a field a message did not carry is null here.
const DECISION = { event: "brain.decision", brain: "tab-local", answering: "the model in this tab", reason: "a simple task the model in this tab handles", confidence: 0.99, decidedBy: "jev", ms: 412, probabilities: { local: 0.99, cloud: 0.01 } };
const RULE = { event: "brain.decision", brain: "tab-local", answering: "the model in this tab", reason: "offline: the model in this tab is the only brain", confidence: null, decidedBy: "rule", ms: 0 };

test("a tab message is read only when it says it is the tab's, with a type; anything else is nothing", () => {
  assert.deepEqual(parseTabMessage({ source: "walks-home-tab", type: "net", run: "r1", online: false, reason: "ping failed" }), { type: "net", run: "r1", detail: { online: false, reason: "ping failed" } });
  assert.equal(parseTabMessage({ source: "someone-else", type: "net", online: true }), null);
  assert.equal(parseTabMessage({ source: "walks-home-tab" }), null);
  assert.equal(parseTabMessage("walks-home-tab"), null);
  assert.equal(parseTabMessage(null), null);
});

test("net: online or offline from the tab's own signal, with its reason; a field of the wrong type is null, never guessed", () => {
  assert.deepEqual(netFromData({ online: false, reason: "no network and the ping failed" }), { online: false, reason: "no network and the ping failed" });
  assert.deepEqual(netFromData({ online: true }), { online: true, reason: null });
  assert.equal(netFromData({ reason: "x" }), null, "no online flag: not a net event");
  assert.equal(netFromData({ online: "false" }), null);
});

test("check-in: the phase, and only the numbers the event carried", () => {
  assert.deepEqual(checkinFromData({ phase: "start", head: "h-12" }), { phase: "start", head: "h-12", files: null, changes: null, ms: null, message: null, code: null, resumed: false });
  assert.deepEqual(checkinFromData({ phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204, at: 1760000000000, offlineHead: "h-12" }), { phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204, message: null, code: null, resumed: false });
  assert.deepEqual(checkinFromData({ phase: "failed", message: "the store does not extend the head", code: "CHECKIN_DIVERGED" }), { phase: "failed", head: null, files: null, changes: null, ms: null, message: "the store does not extend the head", code: "CHECKIN_DIVERGED", resumed: false });
  assert.equal(checkinFromData({ phase: "start", head: "h", resumed: true })!.resumed, true);
  assert.equal(checkinFromData({ phase: "sending" }), null);
  assert.equal(checkinFromData({ head: "h" }), null);
});

test("routing: who answers and why, from the decision's own fields (as a message, and as the transcript entry's data)", () => {
  const r = routingFromData(DECISION)!;
  assert.deepEqual({ brain: r.brain, answering: r.answering, reason: r.reason, confidence: r.confidence, decidedBy: r.decidedBy, ms: r.ms, probabilities: r.probabilities }, { brain: "tab-local", answering: "the model in this tab", reason: "a simple task the model in this tab handles", confidence: 0.99, decidedBy: "jev", ms: 412, probabilities: { local: 0.99, cloud: 0.01 } });
  const rule = routingFromData(RULE)!;
  assert.equal(rule.confidence, null);
  assert.equal(rule.probabilities, null);
  assert.equal(rule.decidedBy, "rule");
  assert.equal(routingFromData({ brain: "tab-local" }), null, "no reason: nothing to put on a card");
  assert.equal(routingFromData({ ...DECISION, brain: "somewhere" }), null, "a brain the router does not have");
  assert.equal(routingFromData({ ...DECISION, confidence: 7 })!.confidence, null, "a probability outside 0..1 is not one");
});

test("homecoming: the plan, the bytes fetched and the time, as the page announces the fetch; the load is a second phase", () => {
  const h = homecomingFromData({ phase: "fetched", prefetch: false, plan: { base: false, adapters: ["gg-lora.gguf"], bytes: 18_400_000 }, fetched_bytes: 18_400_000, fetch_ms: 1380, active: { "gg-lora.gguf": 1 }, adapters: ["gg-lora.gguf"], name: "gemma-3-1b-it (Golden Gate Bridge)", bytes: 830_000_000 })!;
  assert.deepEqual(h, { baseFetched: false, adapters: ["gg-lora.gguf"], plannedBytes: 18_400_000, fetchedBytes: 18_400_000, fetchMs: 1380, loadMs: null, name: "gemma-3-1b-it (Golden Gate Bridge)", prefetch: false });
  const pre = homecomingFromData({ phase: "fetched", prefetch: true, plan: { base: true, adapters: [], bytes: 806_000_000 }, fetched_bytes: 806_000_000, fetch_ms: 41000, name: "gemma-3-1b-it" })!;
  assert.deepEqual({ baseFetched: pre.baseFetched, prefetch: pre.prefetch, fetchedBytes: pre.fetchedBytes }, { baseFetched: true, prefetch: true, fetchedBytes: 806_000_000 });
  assert.equal(homecomingFromData({ plan: { base: true, adapters: [], bytes: 5 }, fetched_bytes: 5, fetch_ms: 9 })!.baseFetched, true, "the model host's own model-homecoming has no phase: it is a fetch");
  assert.equal(homecomingFromData({ phase: "fetched", fetched_bytes: 5 }), null, "no plan: the stage does not guess whether the base was fetched");
  assert.equal(homecomingFromData({ phase: "loaded", load_ms: 7771 }), null, "the load is not a fetch");
  assert.deepEqual(homecomingLoadedFromData({ phase: "loaded", load_ms: 7771, sha256: "ab12", bytes: 830_000_000 }), { loadMs: 7771, bytes: 830_000_000 });
  assert.equal(homecomingLoadedFromData({ phase: "fetched", load_ms: 1 }), null);
  assert.equal(homecomingLoadedFromData({ phase: "loaded" }), null, "no load time: nothing to say");
});

test("tools: one row per call of the current task (after the viewer's last line), in order, with its status; nothing before the viewer has asked", () => {
  const items = [
    { kind: "user", id: "1", text: "Make it obsessed" },
    { kind: "tool", id: "c0", name: "switch_environment", args: "{}", output: "ok", status: "done" },
    { kind: "assistant", id: "2", text: "On it", thinking: "", streaming: false },
    { kind: "user", id: "3", text: "Let's write some basic code." },
    { kind: "assistant", id: "4", text: "", thinking: "a small script", streaming: false },
    { kind: "tool", id: "c1", name: "write", args: "{\"path\":\"hello.js\",\"content\":\"console.log(1)\"}", output: "wrote 14 bytes", status: "done" },
    { kind: "tool", id: "c2", name: "bash", args: "{\"command\":\"node hello.js\"}", output: "", status: "running" },
  ];
  const t = toolsFromItems(items, () => false);
  assert.deepEqual(t.map((x) => [x.id, x.name, x.status]), [["c1", "write", "done"], ["c2", "bash", "running"]]);
  assert.equal(t[0]!.args, "{\"path\":\"hello.js\",\"content\":\"console.log(1)\"}");
  assert.equal(t[0]!.output, "wrote 14 bytes");
  assert.deepEqual(toolsFromItems(items.slice(0, 1), () => false), []);
  // A server's own turn (the "you are now on ..." notice) is not the viewer's line.
  const withServer = [...items, { kind: "user", id: "9", text: "SERVER: something" }];
  assert.deepEqual(toolsFromItems(withServer, (text) => text.startsWith("SERVER:")).map((x) => x.id), ["c1", "c2"]);
  // A malformed item is nothing, a status the page does not know is an error row, never a guess of success.
  assert.deepEqual(toolsFromItems([{ kind: "user", id: "1", text: "x" }, { kind: "tool", id: "c", name: "bash", args: "", output: "", status: "weird" }, { kind: "tool" }, null], () => false).map((x) => x.status), ["error"]);
});

const run: ShowEvent = { t: "run", at: 0, run: "demo-1", origin: 1000, environments: [] };

test("the fold: net, check-in, homecoming and tools replace what they held; a routing decision is kept in order and a repeat of the last one is not news", () => {
  const net = netFromData({ online: false, reason: "ping failed" })!;
  const s = fold([
    run,
    { t: "net", at: 10, net },
    { t: "net", at: 20, net: { online: true, reason: null } },
    { t: "checkin", at: 30, checkin: checkinFromData({ phase: "start", head: "h-12" })! },
    { t: "checkin", at: 40, checkin: checkinFromData({ phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204 })! },
    { t: "routing", at: 50, routing: routingFromData(RULE)! },
    { t: "routing", at: 51, routing: routingFromData(RULE)! },
    { t: "routing", at: 60, routing: routingFromData(DECISION)! },
    { t: "homecoming", at: 70, homecoming: homecomingFromData({ plan: { base: false, adapters: ["a"], bytes: 5 }, fetched_bytes: 5, fetch_ms: 9 })! },
    { t: "homecoming.loaded", at: 75, loadMs: 7771 },
    { t: "tools", at: 80, tools: [{ id: "c1", name: "bash", args: "{}", output: "", status: "running" }] },
    { t: "tools", at: 90, tools: [{ id: "c1", name: "bash", args: "{}", output: "1", status: "done" }] },
  ]);
  assert.deepEqual({ online: s.net!.online, at: s.net!.at }, { online: true, at: 20 });
  assert.deepEqual({ phase: s.checkin!.phase, files: s.checkin!.files, at: s.checkin!.at }, { phase: "done", files: 3, at: 40 });
  assert.deepEqual(s.routings.map((r) => [r.decidedBy, r.at]), [["rule", 50], ["jev", 60]], "the repeat at 51 is the same decision");
  assert.equal(s.routing!.decidedBy, "jev");
  assert.deepEqual({ fetched: s.homecoming!.fetchedBytes, load: s.homecoming!.loadMs }, { fetched: 5, load: 7771 }, "the load time joins the fetch it follows");
  assert.equal(reduce(emptyState(), { t: "homecoming.loaded", at: 1, loadMs: 5 }).homecoming, null, "a load with no fetch before it says nothing");
  assert.deepEqual(s.tools.map((t) => t.status), ["done"]);
  const empty = emptyState();
  assert.equal(empty.net, null);
  assert.deepEqual([empty.checkin, empty.routing, empty.homecoming], [null, null, null]);
  assert.deepEqual([empty.routings, empty.tools], [[], []]);
  assert.equal(reduce(empty, { t: "tools", at: 1, tools: [] }).tools.length, 0);
});

// ---- The transcript's side: D3's ChatView items for the decision (stage "decision"), the check-in (stage "home") and the tool calls reach the stage's state through the real pipe feed.
import { tag } from "../../../03-tab-to-cloud/wire.ts";
import { PipeTranslator } from "../pipe-feed.ts";
import { checkinFromItem, routingFromItem } from "../robot-events.ts";

const DECISION_ITEM = { kind: "brain", stage: "decision", id: "31", text: "the model in this tab answers this one: a simple task the model in this tab handles (Jev 99%).", data: DECISION };
const HOME_ITEM = { kind: "brain", stage: "home", id: "44", text: "Checked in: this run is back on the server, with 3 files written offline. The same conversation goes on, answered by the cloud model.", data: { head: "h-14", files: 3, changes: 5, ms: 1204 } };

test("a decision entry and a check-in entry of the transcript are read by their own fields; other brain entries are not theirs", () => {
  assert.equal(routingFromItem(DECISION_ITEM)!.routing.reason, "a simple task the model in this tab handles");
  assert.equal(routingFromItem(DECISION_ITEM)!.id, "31");
  assert.equal(routingFromItem(HOME_ITEM), null);
  assert.deepEqual(checkinFromItem(HOME_ITEM), { id: "44", checkin: { phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204, message: null, code: null, resumed: false } });
  assert.equal(checkinFromItem(DECISION_ITEM), null);
  assert.equal(routingFromItem({ kind: "brain", stage: "decision", id: "1", text: "x", data: {} }), null);
  assert.equal(checkinFromItem({ kind: "note", id: "1", text: "x" }), null);
});

test("the pipe feed says each decision and check-in once, and the current task's tool calls whenever they change", () => {
  let now = 1000;
  const tr = new PipeTranslator({ run: "r1", origin: 1000, clock: () => now });
  const items: unknown[] = [{ kind: "user", id: "1", text: "Let's write some basic code." }, DECISION_ITEM];
  (tr as unknown as { chat: { items: () => unknown[] } }).chat.items = () => items;
  const batch = (...events: unknown[]) => ({ t: "event", event: tag({ kind: "events", events }) }) as never;
  const events: ShowEvent[] = [...tr.frame({ t: "viewing", placement: { where: "tab", tab: "t1", epoch: 1, generation: 1, env: "tab" }, files: [], events: [], environments: [{ id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" }] } as never)];
  events.push(...tr.frame(batch({ type: "run_start" })));
  now += 1000;
  items.push({ kind: "tool", id: "c1", name: "write", args: "{}", output: "", status: "running" });
  events.push(...tr.frame(batch({ type: "run_end" })));
  now += 1000;
  items[2] = { kind: "tool", id: "c1", name: "write", args: "{}", output: "wrote 14 bytes", status: "done" };
  items.push(HOME_ITEM);
  events.push(...tr.frame(batch({ type: "run_end" })));
  events.push(...tr.frame(batch({ type: "run_end" })));
  assert.equal(events.filter((e) => e.t === "routing").length, 1, "the decision, once however often the transcript is read");
  assert.equal(events.filter((e) => e.t === "checkin").length, 1);
  assert.deepEqual(events.filter((e) => e.t === "tools").map((e) => (e.t === "tools" ? e.tools.map((t) => t.status) : null)), [["running"], ["done"]], "a change of the rows is news, a repeat is not");
  const s = fold(events);
  assert.equal(s.routing?.answering, "the model in this tab");
  assert.equal(s.checkin?.phase, "done");
  assert.deepEqual(s.tools.map((t) => t.output), ["wrote 14 bytes"]);
});

// ---- The rehearsal: SHOW_OBSESSION_ROBOT=1 plays the beats' events in the shapes the tab emits, so the pieces can be seen and checked without a tab. Its values are scripted.
import { ScenarioObsession } from "../obsession/scenario.ts";

test("the robot rehearsal plays: homecoming bytes, offline with a rule's decision and tool calls, back online with a check-in and a cloud decision; without the option none of it", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true, brain: "ready", robot: true });
  sc.begin();
  sc.advance(900_000);
  const e = sc.events;
  assert.deepEqual(e.filter((x) => x.t === "net").map((x) => (x.t === "net" ? x.net.online : null)), [true, false, true]);
  assert.deepEqual(e.filter((x) => x.t === "routing").map((x) => (x.t === "routing" ? [x.routing.brain, x.routing.decidedBy] : null)), [["tab-local", "rule"], ["cloud", "jev"]]);
  assert.deepEqual(e.filter((x) => x.t === "checkin").map((x) => (x.t === "checkin" ? x.checkin.phase : null)), ["start", "done"]);
  assert.deepEqual(e.filter((x) => x.t === "homecoming").map((x) => (x.t === "homecoming" ? [x.homecoming.baseFetched, x.homecoming.prefetch] : null)), [[false, false]]);
  assert.equal(e.filter((x) => x.t === "homecoming.loaded").length, 1);
  const rows = e.filter((x) => x.t === "tools");
  assert.ok(rows.length >= 3, "the strip grows: a call running, then done, then the next");
  assert.deepEqual((rows.at(-1) as { tools: { name: string; status: string }[] }).tools.map((t) => [t.name, t.status]), [["write", "done"], ["edit", "done"]]);
  const none = new ScenarioObsession({ origin: 0, think: true, brain: "ready" });
  none.begin();
  none.advance(900_000);
  assert.equal(none.events.some((x) => ["net", "routing", "checkin", "homecoming", "tools"].includes(x.t)), false);
  const s = fold(e);
  assert.equal(s.net!.online, true);
  assert.equal(s.checkin!.phase, "done");
});

// ---- Against the real thing: the events and items D3's page produced in a real run (route-check, the real 03 page in Chrome), not shapes written from its code. In that run the check-in's
// head is a NUMBER (the transcript's entry position), which the shapes written from the code had as a string.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/robot-real-run.json", import.meta.url)), "utf8")) as { events: { type: string; detail: Record<string, unknown> }[]; items: unknown[] };

test("every event of the real run is read: its decisions by their own fields, its check-in with the numeric head", () => {
  const decisions = REAL.events.filter((e) => e.type === "brain").map((e) => routingFromData(e.detail));
  assert.equal(decisions.length, 5);
  assert.ok(decisions.every((d) => d !== null));
  assert.deepEqual(decisions.map((d) => [d!.brain, d!.decidedBy, d!.confidence]), [["cloud", "rule", null], ["tab-local", "rule", null], ["tab-local", "jev", 0.95], ["tab-local", "jev", 0.95], ["cloud", "jev", 0.95]]);
  const checkins = REAL.events.filter((e) => e.type === "checkin").map((e) => checkinFromData(e.detail));
  assert.deepEqual(checkins.map((c) => [c!.phase, c!.head, c!.files, c!.changes, c!.ms]), [["start", "7", null, null, null], ["done", "26", 0, 0, 1857]]);
});

test("the real transcript's decision and check-in entries and tool calls reach the stage through the pipe feed", () => {
  const tr = new PipeTranslator({ run: "r1", origin: 1000, clock: () => 1000 });
  (tr as unknown as { chat: { items: () => unknown[] } }).chat.items = () => REAL.items;
  const events: ShowEvent[] = [...tr.frame({ t: "viewing", placement: { where: "tab", tab: "t1", epoch: 1, generation: 1, env: "tab" }, files: [], events: [], environments: [{ id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" }] } as never)];
  events.push(...tr.frame({ t: "event", event: tag({ kind: "events", events: [{ type: "run_end" }] }) } as never));
  const s = fold(events);
  assert.equal(events.filter((e) => e.t === "routing").length, 5, "each of the five decisions, once");
  assert.deepEqual(s.routings.map((r) => [r.brain, r.decidedBy]), [["cloud", "rule"], ["tab-local", "rule"], ["tab-local", "jev"], ["tab-local", "jev"], ["cloud", "jev"]]);
  assert.equal(s.checkin?.phase, "done");
  assert.equal(s.checkin?.head, "26");
  assert.equal(s.checkin?.ms, 1857);
  // The tools are the current task's: after the viewer's last line. In the real run that was the Golden Gate line, whose only call is the cloud's switch_environment, refused.
  assert.deepEqual(s.tools.map((t) => [t.name, t.status]), [["switch_environment", "error"]]);
  assert.match(s.tools[0]!.output, /You were not moved/);
});
