import { describe, expect, it } from "vitest";
import { toolOffers } from "./agentForm";
import type { Places } from "./place";
import { LANE_WAIT_MS, laneKit, laneStart, lanesOf, laneStats, MAX_LANES, newRaceLabel, RACE_PAGES, raceFilter, readRace } from "./race";
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
    expect(read.atLeast).toBe(false);
  });

  it("reads the next pages before it picks the lanes: an older run with a lower lane still makes the first four", async () => {
    const asked: unknown[] = [];
    // 51 runs, newest first: lane 1 is the oldest, alone on the second page.
    const pages: Record<string, { runs: Run[]; next_cursor: string | null }> = {
      first: { runs: Array.from({ length: 50 }, (_, i) => run(`r${51 - i}`, { race: "x", lane: String(51 - i) })), next_cursor: "p2" },
      p2: { runs: [run("r1", { race: "x", lane: "1" })], next_cursor: null },
    };
    const v2 = { listRuns: async (...args: unknown[]) => { asked.push(args[1]); return pages[(args[1] as string | null) ?? "first"]!; } };
    const read = await readRace(v2 as never, "x");
    expect(asked).toEqual([null, "p2"]);
    expect(read.lanes.map((r) => r.run_id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(read.more).toBe(47);
    expect(read.atLeast).toBe(false);
  });

  it("counts a run once when a run started between page reads shifts the next page onto one already read", async () => {
    // Pages by offset, newest first: a run started after the first read pushes r3 onto the second page too.
    const pages: Record<string, { runs: Run[]; next_cursor: string | null }> = {
      first: { runs: Array.from({ length: 50 }, (_, i) => run(`r${52 - i}`, { race: "x", lane: String(52 - i) })), next_cursor: "p2" },
      p2: { runs: [run("r3", { race: "x", lane: "3" }), run("r2", { race: "x", lane: "2" }), run("r1", { race: "x", lane: "1" })], next_cursor: null },
    };
    const v2 = { listRuns: async (...args: unknown[]) => pages[(args[1] as string | null) ?? "first"]! };
    const read = await readRace(v2 as never, "x");
    expect(read.lanes.map((r) => r.run_id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(read.more).toBe(52 - 4);
  });

  it("stops after RACE_PAGES pages, and then says there may be more than it counted", async () => {
    let reads = 0;
    const v2 = { listRuns: async () => { reads++; return { runs: Array.from({ length: 50 }, (_, i) => run(`p${reads}-${i}`, { race: "x", lane: String(i + 1) })), next_cursor: "more" }; } };
    const read = await readRace(v2 as never, "x");
    expect(reads).toBe(RACE_PAGES);
    expect(read.more).toBe(RACE_PAGES * 50 - 4);
    expect(read.atLeast).toBe(true);
  });

  it("a run with no lane label comes after every numbered lane", () => {
    const runs = [run("a-hand", { race: "x" }), run("r2", { race: "x", lane: "2" }), run("r1", { race: "x", lane: "1" })];
    expect(lanesOf(runs).map((r) => r.run_id)).toEqual(["r1", "r2", "a-hand"]);
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

describe("starting a race: one inline run per lane", () => {
  it("a lane's start is its own agent (external race-<label>-<n>, one revision per harness and model), the race's task and cap, and the labels the race view reads", () => {
    const kit = { tools: ["read", "write", "bash"], computer: { kind: "sandbox", provider: "local" } } as const;
    const body = laneStart("bench-1", 2, { harness: "codex", model: "openai/gpt-6.1-sol" }, "Fix the failing test", 1.5, { ...kit, tools: [...kit.tools] });
    expect(body).toEqual({
      external: { source: "console", kind: "race", id: "race-bench-1-2", version: "codex openai/gpt-6.1-sol" },
      // POST /v2/runs takes a definition with instructions or a workflow (packages/serve's inline-run test sends this
      // same body to a server). The inline route gives no tools and no place of its own: the lane names both.
      definition: { name: "Race bench-1, lane 2", instructions: "Do the task you are given.", harness: "codex", model: "openai/gpt-6.1-sol", tools: ["read", "write", "bash"], computer: { kind: "sandbox", provider: "local" } },
      input: { content: "Fix the failing test" },
      max_cost_usd: 1.5,
      labels: { race: "bench-1", lane: "2", harness: "codex", model: "openai/gpt-6.1-sol" },
    });
    // On a server with no box, no computer: the lane runs where a new agent would, on the runner.
    expect(laneStart("bench-1", 1, { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, "x", 1, { tools: ["read"] }).definition).not.toHaveProperty("computer");
    // The race view orders and names it from those labels.
    expect(lanesOf([run("r2", body.labels!), run("r1", laneStart("bench-1", 1, { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, "x", 1, { tools: [] }).labels!)]).map((r) => r.run_id)).toEqual(["r1", "r2"]);
  });

  it("a lane's tools and place are a new agent's on this server: every tool its harness runs here, and the box when there is one", () => {
    const offers = toolOffers([
      { name: "read", available: true, harnesses: ["pi", "codex"] },
      { name: "write", available: true, harnesses: ["pi"] },
      { name: "web_search", available: false, reason: "No key.", harnesses: ["pi"] },
      { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] },
      { name: "browser", available: true, harnesses: ["pi"] },
    ]);
    // No box: the runner's tools (no shell), and no computer named.
    expect(laneKit("pi", offers, null)).toEqual({ tools: ["read", "write", "browser"] });
    const runnerOnly: Places = { modes: ["runner"], boxes: [], defaultPlace: { mode: "runner" } };
    expect(laneKit("pi", offers, runnerOnly)).toEqual({ tools: ["read", "write", "browser"] });
    // A box: the shell too (no browser, which runs on the runner only), in that box.
    const boxed: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "local", available: true }], defaultPlace: { mode: "sandbox", box: "local" } };
    expect(laneKit("pi", offers, boxed)).toEqual({ tools: ["read", "write", "bash"], computer: { kind: "sandbox", provider: "local" } });
    // Each harness its own: codex runs read alone here.
    expect(laneKit("codex", offers, boxed)).toEqual({ tools: ["read"], computer: { kind: "sandbox", provider: "local" } });
  });

  it("a new race's label is a label value the server takes, and two races get two labels", () => {
    const a = newRaceLabel(new Date("2026-11-23T10:04:00Z"), () => "1f2e3d4c-0000-4000-8000-000000000000");
    expect(a).toBe("20261123-1004-1f2e");
    expect(a).toMatch(/^[A-Za-z0-9-]{1,256}$/);
    expect(newRaceLabel()).not.toBe(newRaceLabel());
  });
});
