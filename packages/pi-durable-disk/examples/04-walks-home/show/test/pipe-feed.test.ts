import assert from "node:assert/strict";
import { test } from "node:test";
import { tag, type PipeFrame } from "../../../03-tab-to-cloud/wire.ts";
import { captionFor } from "../page/caption.ts";
import { PipeFeed, PipeTranslator, WHERE_ARE_YOU } from "../pipe-feed.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

const ENVS = [
  { id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" as const },
  { id: "second-host", label: "Second host", phrase: "a second machine", kind: "remote" as const },
  { id: "gpu-box", label: "GPU box", phrase: "a GPU sandbox", kind: "remote" as const },
];
const viewing = (placement: Extract<PipeFrame, { t: "viewing" }>["placement"], events: unknown[] = []): PipeFrame => ({ t: "viewing", placement, files: [], events: events as never, environments: ENVS });
const inTab: Extract<PipeFrame, { t: "viewing" }>["placement"] = { where: "tab", tab: "t1", epoch: 1, generation: 1, env: "tab" };
const moving = (to: string, label: string, switchId: string): PipeFrame => ({ t: "placement", placement: { where: "moving", to: label, env: to, switchId, since: 0, detail: "starting the host" } });
const atRemote = (env: string): PipeFrame => ({ t: "placement", placement: { where: "tab", tab: `remote-${env}`, epoch: 2, generation: 2, env } });
const entry = (id: string, kind: string, model: unknown[], data?: unknown) => ({ id, kind, model, ...(data ? { data } : {}) });
const batch = (...events: unknown[]): PipeFrame => ({ t: "event", event: tag({ kind: "events", events }) });
const appended = (e: unknown) => ({ type: "entry_appended", entry: e });

function translator(start = 1_000) {
  let now = start;
  const tr = new PipeTranslator({ run: "r1", origin: start, clock: () => now });
  return { tr, tick: (ms: number) => (now += ms) };
}

test("a first viewing frame starts the run as live, lists the environments by kind, and begins the tab's stay", () => {
  const { tr } = translator();
  const events = tr.frame(viewing(inTab));
  const s = fold(events);
  assert.equal(s.source, "live");
  assert.equal(s.scoreUnit, "");
  assert.deepEqual(s.environments.map((e) => [e.id, e.kind]), [["tab", "tab"], ["second-host", "sandbox"], ["gpu-box", "gpu"]]);
  assert.deepEqual(s.place, { where: "tab", host: "Your browser tab" });
  assert.equal(s.currentEnv, "tab");
  assert.deepEqual(s.stays.map((x) => [x.host, x.hostKind, x.to]), [["Your browser tab", "tab", null]]);
});

test("history in the first frame is remembered, not announced", () => {
  const { tr } = translator();
  const history = [{ kind: "snapshot", event: { type: "snapshot", entries: [entry("u1", "pi.user", [{ role: "user", content: "hello" }]), entry("a1", "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" }])], tools: [] } }];
  const events = tr.frame(viewing(inTab, history.map((h) => tag(h))));
  assert.equal(events.filter((e) => e.t === "note").length, 0);
});

test("a planned switch: the stay waits for the pipe's switched frame and carries the SERVER's milliseconds, tagged measured", () => {
  const { tr, tick } = translator();
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  tick(100);
  events.push(...tr.frame(moving("second-host", "Second host", "sw1")));
  assert.equal(fold(events).place.where, "moving");
  tick(900);
  events.push(...tr.frame(atRemote("second-host")));
  let s = fold(events);
  assert.deepEqual(s.place, { where: "cloud", host: "Second host" });
  assert.equal(s.stays.filter((x) => x.to === null).length, 1, "the tab's stay is still the open one: the new stay waits for the measured time");
  tick(300);
  events.push(...tr.frame({ t: "switched", switchId: "sw1", to: "second-host", ms: 1234.4 }));
  s = fold(events);
  const open = s.stays.filter((x) => x.to === null);
  assert.equal(open.length, 1);
  assert.equal(open[0].host, "Second host");
  assert.equal(open[0].hostKind, "sandbox");
  assert.deepEqual(open[0].handover, { fromHost: "Your browser tab", ms: 1234, planned: true });
  assert.equal(s.stays[0].endedBy, "switch");
  const note = s.notes.at(-1)!;
  assert.equal(note.measured, true);
  assert.match(note.text, /Switched to Second host in 1234 ms \(timed by the server\)/);
  // The same note, as a live feed, is captioned MEASURED.
  assert.equal(captionFor(s, s.now + 10)?.tag, "measured");
});

test("a switched frame that arrives before the settled placement still gives the stay its time", () => {
  const { tr, tick } = translator();
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  events.push(...tr.frame(moving("second-host", "Second host", "sw2")));
  tick(500);
  events.push(...tr.frame({ t: "switched", switchId: "sw2", to: "second-host", ms: 777 }));
  events.push(...tr.frame(atRemote("second-host")));
  const s = fold(events);
  assert.deepEqual(s.stays.at(-1)!.handover, { fromHost: "Your browser tab", ms: 777, planned: true });
  assert.equal(s.stays.filter((x) => x.to === null).length, 1);
});

test("a settled placement that never gets switched begins its stay with no time after the wait, never with a guessed one", () => {
  const { tr, tick } = translator();
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  events.push(...tr.frame(moving("second-host", "Second host", "sw3")));
  events.push(...tr.frame(atRemote("second-host")));
  tick(5_000);
  assert.deepEqual(tr.flush(), []);
  tick(11_000);
  events.push(...tr.flush());
  const open = fold(events).stays.filter((x) => x.to === null);
  assert.equal(open[0].host, "Second host");
  assert.equal(open[0].handover, undefined);
});

test("a refused switch is a note with the pipe's reason; a parked run ends the stay", () => {
  const { tr } = translator();
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  events.push(...tr.frame({ t: "switch-refused", to: "gpu-box", message: "a move is already in progress" }));
  assert.match(fold(events).notes.at(-1)!.text, /Switch to GPU box refused: a move is already in progress/);
  events.push(...tr.frame({ t: "placement", placement: { where: "parked", detail: "the tab is gone" } }));
  const s = fold(events);
  assert.equal(s.place.where, "parked");
  assert.equal(s.currentEnv, null);
  assert.equal(s.stays.filter((x) => x.to === null).length, 0);
});

test("the notice the agent was told becomes an agent note, once, and the agent's final answer another, once", () => {
  const { tr } = translator();
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  const notice = entry("n1", "env.switch", [{ role: "user", content: "System notice: you are now running in a second machine (far): 4 vCPU, 8 GB RAM, no GPU. Your user moved you here from your user's browser tab." }], { switchId: "sw1" });
  events.push(...tr.frame(batch(appended(notice))));
  events.push(...tr.frame(batch(appended(notice))));
  const q = entry("u2", "pi.user", [{ role: "user", content: WHERE_ARE_YOU }]);
  const a = entry("a2", "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "I am on a second machine.\nuname says Linux, 4 cores." }], stopReason: "stop" }]);
  events.push(...tr.frame(batch({ type: "run_start" }, appended(q))));
  assert.equal(fold(events).notes.filter((n) => n.text.startsWith("The agent says")).length, 0, "no answer while the run is busy");
  events.push(...tr.frame(batch(appended(a), { type: "run_end" })));
  events.push(...tr.frame(batch({ type: "run_end" })));
  const notes = fold(events).notes.filter((n) => n.kind === "agent");
  assert.deepEqual(notes.map((n) => n.text), [
    "The agent was told: you are now running in a second machine (far): 4 vCPU, 8 GB RAM, no GPU. Your user moved you here from your user's browser tab.",
    "The agent says: I am on a second machine. uname says Linux, 4 cores.",
  ]);
  assert.equal(captionFor(fold(events), fold(events).now + 5)?.tag, "agent");
});

// A socket the test drives: what the pipe sends goes in through `push`, what the feed sends is in `sent`.
function fakeSocket() {
  const handlers: Record<string, ((d?: unknown) => void)[]> = {};
  const sent: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1,
    send: (d: string) => void sent.push(JSON.parse(d)),
    close: () => undefined,
    on: (event: string, fn: (d?: unknown) => void) => void (handlers[event] ??= []).push(fn),
  };
  return { socket, sent, push: (frame: unknown) => handlers.message?.forEach((h) => h(JSON.stringify(frame))), open: () => handlers.open?.forEach((h) => h()) };
}

test("the feed says hello as the configured role, sends a switch, and reports the pipe's refusal as the command's reason", async () => {
  const f = fakeSocket();
  const feed = new PipeFeed({ url: "ws://x/ws", run: "r1", token: "tok", role: "operator", askAfterSwitch: false, connect: () => f.socket });
  await feed.start();
  f.open();
  assert.deepEqual(f.sent[0], { t: "hello", run: "r1", token: "tok", mode: "operator", tab: f.sent[0].tab });
  f.push(viewing(inTab));
  const ok = feed.command({ t: "switch", to: "second-host" });
  assert.deepEqual(f.sent.at(-1), { t: "switch", to: "second-host" });
  f.push({ t: "switch-refused", to: "second-host", message: "no cloud host" });
  assert.deepEqual(await ok, { ok: false, message: "no cloud host" });
  assert.deepEqual(await feed.command({ t: "switch", to: "tab" }), { ok: false, message: "the run is already there" });
  assert.deepEqual(await feed.command({ t: "switch", to: "mars" }), { ok: false, message: "no environment mars" });
  assert.equal((await feed.command({ t: "kill", universe: "u1" })).ok, false);
  feed.stop();
});

test("the default role is view; a completed switch asks the agent where it is, once the run is settled", async () => {
  const f = fakeSocket();
  const feed = new PipeFeed({ url: "ws://x/ws", run: "r1", token: "tok", connect: () => f.socket });
  await feed.start();
  f.open();
  assert.equal(f.sent[0].mode, "view");
  f.push(viewing(inTab));
  const sw = feed.command({ t: "switch", to: "second-host" });
  f.push(moving("second-host", "Second host", "sw9"));
  f.push(atRemote("second-host"));
  f.push({ t: "switched", switchId: "sw9", to: "second-host", ms: 1500 });
  assert.deepEqual(await sw, { ok: true });
  await new Promise((r) => setTimeout(r, 600));
  const submit = f.sent.find((m) => m.t === "submit")!;
  assert.equal(submit.text, WHERE_ARE_YOU);
  assert.match(String(submit.requestId), /^stage-/);
  assert.equal(feed.state.stays.at(-1)!.handover?.ms, 1500);
  feed.stop();
});

test("ask is refused while the run is moving", async () => {
  const f = fakeSocket();
  const feed = new PipeFeed({ url: "ws://x/ws", run: "r1", token: "tok", askAfterSwitch: false, connect: () => f.socket });
  await feed.start();
  f.open();
  f.push(viewing(inTab));
  f.push(moving("second-host", "Second host", "sw1"));
  assert.deepEqual(await feed.command({ t: "ask" }), { ok: false, message: "the run is not settled on a host" });
  feed.stop();
});

test("with a tab control (rehearsal), a switch to the tab goes through it and sends no frame; other switches still go to the pipe", async () => {
  const f = fakeSocket();
  let asked = 0;
  const feed = new PipeFeed({ url: "ws://x/ws", run: "r1", token: "tok", askAfterSwitch: false, connect: () => f.socket, tabControl: { switchToTab: async () => (asked++, { ok: true }) } });
  await feed.start();
  f.open();
  f.push(viewing({ where: "tab", tab: "remote-second-host", epoch: 2, generation: 2, env: "second-host" }));
  const before = f.sent.length;
  assert.deepEqual(await feed.command({ t: "switch", to: "tab" }), { ok: true });
  assert.equal(asked, 1);
  assert.equal(f.sent.length, before, "no switch frame was sent for the tab");
  const other = feed.command({ t: "switch", to: "gpu-box" });
  f.push({ t: "switch-refused", to: "gpu-box", message: "no cloud host" });
  assert.equal((await other).ok, false);
  assert.deepEqual(f.sent.at(-1), { t: "switch", to: "gpu-box" });
  feed.stop();
});
