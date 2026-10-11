import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalEvents } from "../page/local-events.ts";
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
