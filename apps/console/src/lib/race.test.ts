import { describe, expect, it } from "vitest";
import { LANE_WAIT_MS, lanesOf, laneStats, MAX_LANES, raceFilter, readRace } from "./race";
import type { Run, TimelineRow } from "./v2";

const run = (id: string, labels: Record<string, string>, created_at = "2026-11-23T10:00:00Z"): Run => ({
  sha: null, updated_at: created_at, poll_after_ms: 0, place: { mode: "runner" }, run_id: id, agent_id: `a-${id}`, agent_version: 1, revision: `rv-${id}`,
  kind: "agentic", status: "working", state: "working", title: "Fix the failing test", created_at, ended_at: null, result: null, error: null,
  cost: { usd: 0.01, basis: "estimate", charge_state: null, cap_usd: 1 }, archived_at: null, labels,
} as Run);
const row = (over: Partial<TimelineRow> & Pick<TimelineRow, "id" | "seq" | "kind">): TimelineRow => ({ timestamp: "2026-11-23T10:00:01Z", summary: "", ...over } as TimelineRow);

describe("a race: the runs one race:<label> label groups", () => {
  it("is filtered by its label, as GET /runs takes one", () => {
    expect(raceFilter("bench-1")).toBe("race:bench-1");
  });

  it("orders its lanes by their lane label (a number as a number), never by start order, and keeps at most four", () => {
    const runs = [run("r3", { race: "x", lane: "10" }, "2026-11-23T10:00:00Z"), run("r1", { race: "x", lane: "2" }, "2026-11-23T10:00:09Z"), run("r2", { race: "x", lane: "1" }, "2026-11-23T10:00:05Z"),
      run("r9", { race: "x", lane: "3" }), run("r7", { race: "x", lane: "4" })];
    expect(MAX_LANES).toBe(4);
    expect(lanesOf(runs).map((r) => r.run_id)).toEqual(["r2", "r1", "r9", "r7"]);
    // With no lane label, the run id breaks the tie: still never the start time.
    expect(lanesOf([run("b", { race: "x" }, "2026-11-23T09:00:00Z"), run("a", { race: "x" }, "2026-11-23T11:00:00Z")]).map((r) => r.run_id)).toEqual(["a", "b"]);
  });

  it("reads its runs with the label filter and says how many past four it leaves out", async () => {
    const asked: unknown[] = [];
    const runs = ["1", "2", "3", "4", "5"].map((n) => run(`r${n}`, { race: "x", lane: n }));
    const v2 = { listRuns: async (...args: unknown[]) => { asked.push(args); return { runs, next_cursor: null }; } };
    const read = await readRace(v2 as never, "x");
    expect(asked).toEqual([[50, null, { label: "race:x" }]]);
    expect(read.lanes.map((r) => r.run_id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(read.more).toBe(1);
  });

  it("follows each lane with a short wait, so four lanes leave the browser's six connections room", () => {
    expect(LANE_WAIT_MS).toBeGreaterThanOrEqual(2_000);
    expect(LANE_WAIT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("a lane's stats, from its run and its followed timeline", () => {
  it("counts each tool call once (call and result fold), its failures, the newest page's cost and tokens, and the wall clock", () => {
    const rows = [
      row({ id: "u1", seq: 1, kind: "tool_use", tool_name: "bash", tool_use_id: "t1" }),
      row({ id: "x1", seq: 2, kind: "tool_result", tool_name: "bash", tool_use_id: "t1", tool_status: "success" }),
      row({ id: "u2", seq: 3, kind: "tool_use", tool_name: "edit", tool_use_id: "t2" }),
      row({ id: "x2", seq: 4, kind: "tool_result", tool_name: "edit", tool_use_id: "t2", tool_status: "failed" }),
      row({ id: "t", seq: 5, kind: "text_block", text: "Done." }),
    ];
    const cost = { usd: 0.25, basis: "estimate", charge_state: null, cap_usd: 1, tokens: { input: 12_000, output: 800, cache_read: 9_000, cache_write: 0, requests: 3 } } as Run["cost"];
    const stats = laneStats(run("r1", { race: "x" }, "2026-11-23T10:00:00Z"), rows, cost, Date.parse("2026-11-23T10:01:05Z"));
    expect(stats.toolCalls).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.cost?.usd).toBe(0.25);
    expect(stats.tokens).toContain("cache read");
    expect(stats.seconds).toBe(65);
  });

  it("an ended run's clock stops at its end, and its own cost wins over a page's", () => {
    const ended = { ...run("r1", { race: "x" }, "2026-11-23T10:00:00Z"), status: "completed", state: "idle", ended_at: "2026-11-23T10:00:30Z", cost: { usd: 0.5, basis: "estimate", charge_state: null, cap_usd: 1 } } as Run;
    const stats = laneStats(ended, [], { usd: 0.2, basis: "estimate", charge_state: null, cap_usd: 1 } as Run["cost"], Date.parse("2026-11-23T12:00:00Z"));
    expect(stats.seconds).toBe(30);
    expect(stats.cost?.usd).toBe(0.5);
  });
});
