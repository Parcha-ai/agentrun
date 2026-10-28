import { describe, expect, it } from "vitest";
import { applyPage } from "./timeline";
import type { TimelinePage, TimelineRow } from "./v2";

const row = (id: string, seq: number, summary = id): TimelineRow =>
  ({ id, seq, kind: "thinking", summary, text: null, timestamp: "2026-10-28T19:33:16.118Z", tool_name: null });
const page = (rows: TimelineRow[], extra: Partial<TimelinePage> = {}): TimelinePage => ({
  run_id: "r", status: "working", state: "working", rows, drop: [], reset: false, unchanged: false, final: false,
  has_more: false, next_after: 1, ...extra,
});

describe("applyPage", () => {
  it("appends new rows in seq order", () => {
    expect(applyPage([row("a", 1)], page([row("c", 3), row("b", 2)])).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("never duplicates a row a reconnect sends again; the newer copy wins", () => {
    const out = applyPage([row("a", 1, "old"), row("b", 2)], page([row("a", 1, "new"), row("c", 3)]));
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out[0].summary).toBe("new");
  });

  it("a reset replaces everything held", () => {
    expect(applyPage([row("a", 1), row("b", 2)], page([row("x", 1)], { reset: true })).map((r) => r.id)).toEqual(["x"]);
  });

  it("drops the rows the server names", () => {
    expect(applyPage([row("a", 1), row("b", 2)], page([], { drop: ["a"] })).map((r) => r.id)).toEqual(["b"]);
  });

  it("an unchanged page changes nothing", () => {
    const held = [row("a", 1)];
    expect(applyPage(held, page([], { unchanged: true }))).toBe(held);
  });
});
