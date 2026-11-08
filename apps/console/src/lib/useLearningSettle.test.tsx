import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLearningSettle } from "./useLearningSettle";
import type { Run } from "./v2";

// An ended run whose learning is still deciding is read again, on one timer that backs off, never while the page is
// hidden, and only until it settles, the page goes, or about two minutes of waiting have passed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type R = Pick<Run, "status" | "learning">;
const deciding: R = { status: "completed", learning: { detail: null, at: "2026-11-03T16:52:09Z", state: "reflecting", reason: null } };
const merged: R = { status: "completed", learning: { detail: null, at: "2026-11-03T16:52:09Z", state: "merged", reason: null } };

let root: ReturnType<typeof createRoot> | undefined;
let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); document.body.innerHTML = ""; });

function Probe({ run, reread, moved }: { run: R | null; reread: () => void; moved: () => void }) { useLearningSettle(run, reread, moved); return null; }
function mount(run: R | null) {
  const reads: number[] = [];
  const moves: (string | undefined)[] = [];
  const reread = () => { reads.push(Date.now()); };
  let shown = run;
  const moved = () => { moves.push(shown?.learning?.state); };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (r: R | null) => { shown = r; act(() => root!.render(createElement(Probe, { run: r, reread, moved }))); };
  render(run);
  const start = Date.now();
  return { reads, moves, render, at: () => reads.map((t) => (t - start) / 1000) };
}
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const setHidden = (h: boolean) => act(() => { hidden = h; document.dispatchEvent(new Event("visibilitychange")); });

describe("useLearningSettle", () => {
  it("backs off: reads at 2 s, then 4 s, 8 s and 16 s later, then every 16 s", () => {
    const m = mount(deciding);
    wait(1_999);
    expect(m.reads).toHaveLength(0);
    wait(62_001);
    expect(m.at()).toEqual([2, 6, 14, 30, 46, 62]);
  });
  it("stops after about two minutes of waiting in all", () => {
    const m = mount(deciding);
    wait(10 * 60_000);
    expect(m.at()).toEqual([2, 6, 14, 30, 46, 62, 78, 94, 110]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops once the run it is handed has settled", () => {
    const m = mount(deciding);
    wait(6_000);
    expect(m.reads).toHaveLength(2);
    m.render(merged);
    wait(60_000);
    expect(m.reads).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops when the page goes", () => {
    const m = mount(deciding);
    wait(2_000);
    act(() => root!.unmount()); root = undefined;
    wait(60_000);
    expect(m.reads).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never reads while the page is hidden, and reads when it is shown again; time hidden does not count", () => {
    const m = mount(deciding);
    wait(2_000);
    setHidden(true);
    wait(10 * 60_000);
    expect(m.reads).toHaveLength(1);
    setHidden(false);
    expect(m.reads).toHaveLength(2);
    wait(8_000);
    expect(m.reads).toHaveLength(3);
  });
  it("keeps one timer: each new record of the same run, still deciding, neither adds one nor starts the waits again", () => {
    const m = mount(deciding);
    wait(1_000);
    for (let i = 0; i < 5; i++) m.render({ ...deciding });
    expect(vi.getTimerCount()).toBe(1);
    wait(1_000);
    expect(m.at()).toEqual([2]);
  });
  it("says when an ended run's learning moves, so the page reads its timeline again; not on the first read, nor while it works", () => {
    const m = mount({ status: "working", learning: { detail: null, at: "2026-11-03T16:52:09Z", state: "seeded", reason: null } });
    m.render({ status: "working", learning: { detail: null, at: "2026-11-03T16:52:09Z", state: "seeded", reason: null } });
    expect(m.moves).toEqual([]);
    m.render(deciding);
    m.render({ ...deciding });
    expect(m.moves).toEqual(["reflecting"]);
    m.render({ status: "completed", learning: { detail: null, at: "2026-11-03T16:52:09Z", state: "proposed", reason: null } });
    m.render(merged);
    m.render({ ...merged });
    expect(m.moves).toEqual(["reflecting", "proposed", "merged"]);
    // A page opened on a run that has settled reads nothing again.
    act(() => root!.unmount()); root = undefined;
    const settled = mount(merged);
    settled.render({ ...merged });
    expect(settled.moves).toEqual([]);
  });
  it("does nothing for a run still working, one that does not learn, or one whose learning has settled", () => {
    for (const run of [{ status: "working" as const, learning: { state: "seeded" as const, reason: null, detail: null, at: "2026-11-03T16:52:09Z" } }, { status: "completed" as const, learning: null }, merged, null]) {
      const m = mount(run);
      wait(60_000);
      expect(m.reads).toHaveLength(0);
      act(() => root!.unmount()); root = undefined;
    }
  });
});
