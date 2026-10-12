import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalEvents } from "../page/local-events.ts";
import { Feed } from "../page/feed.ts";
import { TabLink, tabUrlFor, tabEventsFrom } from "../page/tab-link.ts";
import { emptyState, reduce } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

// The stage opens the agent's tab with window.open and keeps the handle; the tab posts its events to its opener with an explicit targetOrigin; the stage checks origin and source.
// All of it is in-browser, so it keeps working when the network is off. After a stage reload the handle is gone: window.open("", name) re-attaches to the same tab without reloading it
// (window.open(url, name) would navigate it and lose its state). This is the logic, over a fake window; the real two-origin behaviour is the spike's and the real-Chrome check's.
const TAB = "http://127.0.0.1:4100";
const STAGE = "http://127.0.0.1:4000";

class FakeTab {
  closed = false;
  navigations: string[] = [];
  get location(): never { throw new DOMException("cross-origin", "SecurityError"); }
  close() { this.closed = true; }
}
class FakeBlank {
  closed = false;
  location = { href: "about:blank" };
  close() { this.closed = true; }
}
function fakeWindow(opened: Record<string, unknown> = {}) {
  const calls: [string, string][] = [];
  return {
    origin: STAGE,
    calls,
    open(url: string, name: string) {
      calls.push([url, name]);
      return (opened[name] ?? (opened[name] = url === "" ? new FakeBlank() : new FakeTab())) as unknown as Window;
    },
  };
}

test("the tab's URL gets the stage's own origin as ?stage=, so the page posts to its opener with that origin and never '*'", () => {
  assert.equal(tabUrlFor(`${TAB}/run/r1#secret`, STAGE), `${TAB}/run/r1?stage=${encodeURIComponent(STAGE)}#secret`);
  assert.equal(tabUrlFor(`${TAB}/run/r1?golive=1#secret`, STAGE), `${TAB}/run/r1?golive=1&stage=${encodeURIComponent(STAGE)}#secret`);
  assert.equal(tabUrlFor(`${TAB}/run/r1?stage=http%3A%2F%2Felsewhere`, STAGE), `${TAB}/run/r1?stage=${encodeURIComponent(STAGE)}`, "a stage param that is not ours is replaced");
  assert.equal(tabUrlFor("not a url", STAGE), null);
  assert.equal(tabUrlFor("javascript:alert(1)", STAGE), null, "only http and https");
});

test("open: window.open(url, name) once, and the handle is kept; a second open does not navigate the tab again", () => {
  const win = fakeWindow();
  const link = new TabLink({ win: win as never, tabUrl: `${TAB}/run/r1`, name: "agent-tab" });
  assert.equal(link.open(), true);
  assert.deepEqual(win.calls, [[`${TAB}/run/r1?stage=${encodeURIComponent(STAGE)}`, "agent-tab"]]);
  assert.equal(link.open(), true);
  assert.equal(win.calls.length, 1, "already open: nothing is navigated");
  assert.equal(link.attached, true);
});

test("re-attach after a stage reload is window.open('', name): the tab keeps running; a window that is not the tab (a fresh blank one) is closed and is not attached", () => {
  const tab = new FakeTab();
  const win = fakeWindow({ "agent-tab": tab });
  const link = new TabLink({ win: win as never, tabUrl: `${TAB}/run/r1`, name: "agent-tab" });
  assert.equal(link.reattach(), true);
  assert.deepEqual(win.calls, [["", "agent-tab"]], "an empty URL: the named window is returned, not navigated");
  assert.equal(link.attached, true);
  const blank = new FakeBlank();
  const win2 = fakeWindow({ "agent-tab": blank });
  const link2 = new TabLink({ win: win2 as never, tabUrl: `${TAB}/run/r1`, name: "agent-tab" });
  assert.equal(link2.reattach(), false);
  assert.equal(blank.closed, true, "there was no tab by that name: the blank window the browser made is closed");
  assert.equal(link2.attached, false);
});

test("a message is accepted only from the tab's origin AND the window the stage holds; with no handle nothing is accepted", () => {
  const tab = new FakeTab();
  const win = fakeWindow({ "agent-tab": tab });
  const got: unknown[] = [];
  const link = new TabLink({ win: win as never, tabUrl: `${TAB}/run/r1`, name: "agent-tab", onEvent: (e) => got.push(e) });
  const msg = (over: Record<string, unknown>) => ({ origin: TAB, source: tab, data: { source: "walks-home-tab", type: "net", run: "r1", online: false, reason: "ping failed" }, ...over }) as unknown as MessageEvent;
  link.handle(msg({}));
  assert.equal(got.length, 0, "not attached yet");
  link.open();
  link.handle(msg({}));
  assert.deepEqual(got, [{ type: "net", run: "r1", detail: { online: false, reason: "ping failed" } }]);
  link.handle(msg({ origin: "http://evil.example" }));
  link.handle(msg({ source: new FakeTab() }));
  link.handle(msg({ data: { source: "walks-home-tab" } }));
  link.handle(msg({ data: { type: "net", online: true } }));
  assert.equal(got.length, 1, "a wrong origin, a wrong window, no type, no source: nothing");
});

test("a closed tab is not attached any more", () => {
  const tab = new FakeTab();
  const link = new TabLink({ win: fakeWindow({ "agent-tab": tab }) as never, tabUrl: `${TAB}/run/r1`, name: "agent-tab" });
  link.open();
  tab.closed = true;
  assert.equal(link.attached, false);
});

test("the tab's messages become the stage's events by their types, and a type the stage does not use is nothing", () => {
  assert.deepEqual(tabEventsFrom({ type: "net", run: "r1", detail: { online: false, reason: "x" } }, 5), [{ t: "net", at: 5, net: { online: false, reason: "x" } }]);
  assert.deepEqual(tabEventsFrom({ type: "checkin", run: null, detail: { phase: "start", head: "h" } }, 6)!.map((e) => e.t), ["checkin"]);
  assert.deepEqual(tabEventsFrom({ type: "brain", run: null, detail: { event: "brain.decision", brain: "cloud", answering: "the cloud model", reason: "needs the cloud", confidence: null, decidedBy: "rule", ms: 0 } }, 7)!.map((e) => e.t), ["routing"]);
  assert.deepEqual(tabEventsFrom({ type: "homecoming", run: null, detail: { phase: "fetched", plan: { base: false, adapters: [], bytes: 1 }, fetched_bytes: 1, fetch_ms: 2 } }, 8)!.map((e) => e.t), ["homecoming"]);
  assert.deepEqual(tabEventsFrom({ type: "homecoming", run: null, detail: { phase: "loaded", load_ms: 9 } }, 9), [{ t: "homecoming.loaded", at: 9, loadMs: 9 }]);
  // Offline the pipe to the server is gone, so the transcript cannot reach the stage: the tab tells it the current task's tool calls itself.
  assert.deepEqual(tabEventsFrom({ type: "tools", run: null, detail: { tools: [{ id: "c1", name: "write", args: "{\"path\":\"hi.js\"}", output: "ok", status: "done" }, { name: "no id" }] } }, 10), [{ t: "tools", at: 10, tools: [{ id: "c1", name: "write", args: "{\"path\":\"hi.js\"}", output: "ok", status: "done" }] }]);
  assert.deepEqual(tabEventsFrom({ type: "tools", run: null, detail: { tools: [] } }, 11), [{ t: "tools", at: 11, tools: [] }]);
  assert.deepEqual(tabEventsFrom({ type: "tools", run: null, detail: {} }, 12), [], "no list: nothing");
  assert.deepEqual(tabEventsFrom({ type: "homecoming", run: null, detail: { phase: "swapped", result: "swapped", id: "ab", rehomes: 1 } }, 9), [], "the swap phase is the brain entries' to say, not the homecoming line's");
  assert.deepEqual(tabEventsFrom({ type: "something-else", run: null, detail: {} }, 1), []);
  assert.deepEqual(tabEventsFrom({ type: "net", run: null, detail: { reason: "no flag" } }, 1), []);
});

test("local events survive a new snapshot: the feed replays what the tab said after the server's state is replaced", () => {
  const local = new LocalEvents();
  const net: ShowEvent = { t: "net", at: 10, net: { online: false, reason: "x" } };
  let s = local.apply(emptyState(), net);
  assert.equal(s.net!.online, false);
  const replaced = emptyState(); // a reconnect: the server's snapshot knows nothing of the tab's own events
  s = local.replay(replaced);
  assert.equal(s.net!.online, false);
  assert.equal(reduce(replaced, net).net!.at, 10);
  const big = new LocalEvents(3);
  for (let i = 0; i < 6; i++) big.apply(emptyState(), { t: "net", at: i, net: { online: i % 2 === 0, reason: null } });
  assert.equal(big.size, 3, "bounded");
});

const memoryStore = () => {
  let v: string | null = null;
  return { get: () => v, set: (x: string) => void (v = x), peek: () => v };
};

test("the tab's events survive a reload of the stage: kept in the session, restored before any feed is reachable", () => {
  const store = memoryStore();
  const first = new Feed("http://stage.example/", store);
  first.inject({ t: "net", at: 100, net: { online: false, reason: "no network and the ping failed" } });
  first.inject({ t: "tools", at: 120, tools: [{ id: "c1", name: "write", args: "{}", output: "ok", status: "done" }] });
  const reloaded = new Feed("http://stage.example/", store);
  assert.equal(reloaded.state.net, null, "nothing until restored");
  reloaded.restore();
  assert.equal(reloaded.state.net!.online, false);
  assert.deepEqual(reloaded.state.tools.map((t) => t.id), ["c1"]);
});

test("a stored value that is not the tab's events (damaged, or from another version) is ignored, never trusted", () => {
  for (const junk of ["not json", "{}", "[1,2]", JSON.stringify([{ t: 5 }]), JSON.stringify([{ t: "net" }]), JSON.stringify([{ t: "rm -rf" , at: 1 }])]) {
    const store = memoryStore();
    store.set(junk);
    const feed = new Feed("http://stage.example/", store);
    feed.restore();
    assert.equal(feed.state.net, null, junk);
  }
  const big = new LocalEvents(3, memoryStore());
  for (let i = 0; i < 6; i++) big.apply(emptyState(), { t: "net", at: i, net: { online: i % 2 === 0, reason: null } });
  assert.equal(big.size, 3);
});

// ---- Scoped to the run: the stage followed to run B must not restore A's events or reattach A's window, and a message for another run is not believed.
import { stageKeys, runOf } from "../page/tab-link.ts";

test("the run is the tab link's /run/<id>; everything the stage keeps for a tab (events, the opened flag, the window's name) is scoped to it", () => {
  assert.equal(runOf("http://127.0.0.1:8790/run/rt?golive=1#secret"), "rt");
  assert.equal(runOf("http://h/run/walks-home-demo/"), "walks-home-demo");
  assert.equal(runOf("http://h/other"), null);
  assert.equal(runOf("not a url"), null);
  const a = stageKeys("http://h/run/a#s");
  const b = stageKeys("http://h/run/b#s");
  assert.notEqual(a.eventsKey, b.eventsKey);
  assert.notEqual(a.flagKey, b.flagKey);
  assert.notEqual(a.windowName, b.windowName);
  assert.equal(a.run, "a");
  assert.equal(stageKeys(null).run, null);
  assert.equal(stageKeys(null).eventsKey, stageKeys("http://h/nothing").eventsKey, "no run: one shared key, as before");
});

test("a message is accepted only for the run the stage follows: another run's, and one that does not say, are not believed", () => {
  const tab = new FakeTab();
  const got: unknown[] = [];
  const link = new TabLink({ win: fakeWindow({ "agent-tab-b": tab }) as never, tabUrl: `${TAB}/run/b`, name: "agent-tab-b", run: "b", onEvent: (e) => got.push(e) });
  link.open();
  const msg = (run: unknown) => ({ origin: TAB, source: tab, data: { source: "walks-home-tab", type: "net", ...(run === undefined ? {} : { run }), online: false }, }) as unknown as MessageEvent;
  link.handle(msg("a"));
  link.handle(msg(undefined));
  assert.equal(got.length, 0);
  link.handle(msg("b"));
  assert.equal(got.length, 1);
  // A link that names no run keeps the old behaviour: it cannot tell runs apart.
  const anon = new TabLink({ win: fakeWindow({ "agent-tab": tab }) as never, tabUrl: `${TAB}/`, name: "agent-tab", onEvent: (e) => got.push(e) });
  anon.open();
  anon.handle(msg("anything"));
  assert.equal(got.length, 2);
});

test("the pinned facts: the latest net, check-in and homecoming survive any number of later events, in memory and after a reload", () => {
  const store = memoryStore();
  const local = new LocalEvents(5, store);
  let s = emptyState();
  s = local.apply(s, { t: "net", at: 1, net: { online: false, reason: "x" } });
  s = local.apply(s, { t: "checkin", at: 2, checkin: { phase: "done", head: "7", files: 1, changes: 1, ms: 9, message: null, code: null, resumed: false } });
  for (let i = 0; i < 300; i++) s = local.apply(s, { t: "tools", at: 10 + i, tools: [{ id: `c${i}`, name: "bash", args: "{}", output: "", status: "done" }] });
  assert.equal(local.size <= 5 + 6, true, "the ring is bounded; only the pinned latest of each kind sit beside it");
  const replayed = local.replay(emptyState());
  assert.equal(replayed.net?.online, false, "the only net event was not evicted");
  assert.equal(replayed.checkin?.phase, "done");
  assert.equal(replayed.tools[0]!.id, "c299", "and the tools are the latest");
  const reloaded = new LocalEvents(5, store);
  reloaded.restore();
  const again = reloaded.replay(emptyState());
  assert.equal(again.net?.online, false);
  assert.equal(again.checkin?.phase, "done");
  assert.equal(again.tools[0]!.id, "c299");
});

test("a stumble outlives a reload and the ring, like the other tab facts", () => {
  const store = (() => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; } }; })();
  const local = new LocalEvents(3, store);
  let s = emptyState();
  s = local.apply(s, { t: "stumble", at: 1, stumble: { previousSha: "a", bodySha: "b", notFitting: ["walk"], fitting: [] } });
  for (let i = 0; i < 20; i++) s = local.apply(s, { t: "tools", at: 10 + i, tools: [] });
  const reloaded = new LocalEvents(3, store);
  reloaded.restore();
  assert.equal(reloaded.replay(emptyState()).stumble?.bodySha, "b");
});
