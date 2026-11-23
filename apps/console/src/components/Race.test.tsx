import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Race } from "./Race";
import { LANE_WAIT_MS } from "@/lib/race";
import type { Run, TimelinePage, TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const run = (id: string, labels: Record<string, string>, status: Run["status"] = "working"): Run => ({
  sha: null, updated_at: "2026-11-23T10:00:00Z", poll_after_ms: 0, place: { mode: "runner" }, run_id: id, agent_id: `a-${id}`, agent_version: 1, revision: `rv-${id}`,
  kind: "agentic", status, state: status === "working" ? "working" : "idle", title: "Fix the failing test", created_at: "2026-11-23T10:00:00Z",
  ended_at: status === "working" ? null : "2026-11-23T10:00:40Z", result: null, error: null, cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 1 }, archived_at: null, labels,
} as Run);
const row = (over: Partial<TimelineRow> & Pick<TimelineRow, "id" | "seq" | "kind">): TimelineRow => ({ timestamp: "2026-11-23T10:00:01Z", summary: "", ...over } as TimelineRow);
const page = (runId: string, rows: TimelineRow[], final: boolean, usd: number): TimelinePage => ({
  run_id: runId, status: final ? "completed" : "working", state: final ? "idle" : "working", rows, drop: [], reset: false, unchanged: false, final, has_more: false, next_after: rows.length,
  cost: { usd, basis: "estimate", charge_state: null, cap_usd: 1 },
} as TimelinePage);

/** A fake server: the race's runs, and each run's timeline (its first page, then a final one). Records every read. */
function server(runs: Run[], rowsOf: (id: string) => TimelineRow[] = () => []) {
  const reads: { id: string; after?: number; waitMs?: number }[] = [];
  const listed: unknown[] = [];
  const v2 = {
    listRuns: async (...args: unknown[]) => { listed.push(args); return { runs, next_cursor: null }; },
    getRun: async (id: string) => runs.find((r) => r.run_id === id)!,
    getTimeline: async (id: string, opts: { after?: number; waitMs?: number } = {}) => {
      reads.push({ id, after: opts.after, waitMs: opts.waitMs });
      const first = opts.after === undefined;
      return page(id, first ? rowsOf(id) : [], !first, first ? 0.1 : 0.25);
    },
  };
  return { v2, reads, listed };
}

async function render(v2: unknown, label = "bench", rereadMs?: number) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Race, { v2: v2 as never, label, ...(rereadMs ? { rereadMs } : {}) })));
  for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return host;
}

describe("Race: the runs one race:<label> label groups, side by side", () => {
  it("shows its lanes in lane order, each named by its harness and model, linking to its run", async () => {
    const { v2, listed } = server([run("r2", { race: "bench", lane: "2", harness: "codex", model: "openai/gpt-6.1-sol" }), run("r1", { race: "bench", lane: "1", harness: "pi", model: "anthropic/claude-sonnet-5-5" })]);
    const host = await render(v2);
    expect(listed).toEqual([[50, null, { label: "race:bench" }]]);
    const lanes = [...host.querySelectorAll("[data-race-lane]")];
    expect(lanes.map((l) => l.getAttribute("data-race-lane"))).toEqual(["r1", "r2"]);
    expect(lanes[0]!.textContent).toContain("pi");
    expect(lanes[0]!.textContent).toContain("anthropic/claude-sonnet-5-5");
    expect(lanes[1]!.textContent).toContain("codex");
    expect(lanes[0]!.querySelector("a[href='#/runs/r1']")).toBeTruthy();
    expect(host.textContent).toContain("Fix the failing test");
  });

  it("follows each lane's timeline with the short wait, and its header counts the tool calls, the failed ones and the newest cost", async () => {
    const rows = [
      row({ id: "u1", seq: 1, kind: "tool_use", tool_name: "bash", tool_use_id: "t1", summary: "bash: npm test" }),
      row({ id: "x1", seq: 2, kind: "tool_result", tool_name: "bash", tool_use_id: "t1", tool_status: "failed", summary: "bash: 1 failing" }),
      row({ id: "u2", seq: 3, kind: "tool_use", tool_name: "edit", tool_use_id: "t2", summary: "edit: src/sum.ts" }),
      row({ id: "x2", seq: 4, kind: "tool_result", tool_name: "edit", tool_use_id: "t2", tool_status: "success", summary: "edit: ok" }),
    ];
    const { v2, reads } = server([run("r1", { race: "bench", lane: "1" })], () => rows);
    const host = await render(v2);
    // follow() waits at least 250 ms between reads: the second read, and the final page it brings.
    for (let i = 0; i < 100 && !host.querySelector("[data-race-lane='r1']")?.textContent?.includes("$0.25"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const later = reads.filter((r) => r.after !== undefined);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((r) => r.waitMs === LANE_WAIT_MS)).toBe(true);
    const lane = host.querySelector("[data-race-lane='r1']")!;
    expect(lane.querySelector("[data-lane-tools]")?.textContent).toBe("2 tool calls · 1 failed");
    expect(lane.textContent).toContain("$0.25");
  });

  it("an empty race says no run carries its label, and how a run joins it", async () => {
    const { v2 } = server([]);
    const host = await render(v2, "nobody");
    expect(host.querySelector("[data-race-lane]")).toBeNull();
    expect(host.textContent).toContain("race:nobody");
  });

  it("past four lanes, it says how many runs it leaves out", async () => {
    const { v2 } = server(["1", "2", "3", "4", "5", "6"].map((n) => run(`r${n}`, { race: "bench", lane: n })));
    const host = await render(v2);
    expect(host.querySelectorAll("[data-race-lane]").length).toBe(4);
    expect(host.textContent).toContain("2 more runs");
    expect(host.textContent).not.toContain("At least");
  });

  it("a full read says at least that many more runs, since there may be more than it counted", async () => {
    const { v2 } = server(Array.from({ length: 50 }, (_, i) => run(`r${i + 1}`, { race: "bench", lane: String(i + 1) })));
    const host = await render(v2);
    expect(host.textContent).toContain("At least 46 more runs");
  });

  it("a lane's cost shows against its cap", async () => {
    const { v2 } = server([run("r1", { race: "bench", lane: "1" }, "completed")]);
    const host = await render(v2);
    expect(host.querySelector("[data-race-lane='r1'] [data-lane-cost]")?.textContent).toMatch(/ of \$1\.00$/);
  });

  it("a run with no lane, harness or model label is headed by its run id, never a bare \"Lane\"", async () => {
    const { v2 } = server([run("r1", { race: "bench", lane: "1", harness: "pi" }), run("by-hand", { race: "bench" })]);
    const host = await render(v2);
    const lanes = [...host.querySelectorAll("[data-race-lane]")];
    expect(lanes.map((l) => l.getAttribute("data-race-lane"))).toEqual(["r1", "by-hand"]);
    expect(lanes[1]!.querySelector("a")?.textContent).toBe("by-hand");
  });

  it("reads the race again, so a lane that starts after the page opened joins it", async () => {
    const runs = [run("r1", { race: "bench", lane: "1" })];
    const { v2, listed } = server(runs);
    const host = await render(v2, "bench", 40);
    expect(host.querySelectorAll("[data-race-lane]").length).toBe(1);
    runs.push(run("r2", { race: "bench", lane: "2" }));
    for (let i = 0; i < 50 && host.querySelectorAll("[data-race-lane]").length < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect([...host.querySelectorAll("[data-race-lane]")].map((l) => l.getAttribute("data-race-lane"))).toEqual(["r1", "r2"]);
    expect(listed.length).toBeGreaterThan(1);
  });
});
