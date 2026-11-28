import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Race } from "./Race";
import { LANE_WAIT_MS } from "@/lib/race";
import type { Run, TimelinePage, TimelineRow } from "@/lib/v2";
import { expectPinnedBar } from "@/test/pageFrame";

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
    listRuns: async (...args: unknown[]): Promise<{ runs: Run[]; next_cursor: string | null }> => { listed.push(args); return { runs, next_cursor: null }; },
    getRun: async (id: string) => runs.find((r) => r.run_id === id) ?? run(id, { race: "bench" }),
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
  it("a lane reads its run again when its approval rows change, though its state does not: the agent's next approval gets its own card", async () => {
    const ask = (id: string, call: string, title: string) => ({ kind: "approval", id, tool: "acp_execute", call_id: call, args_preview: JSON.stringify({ title, kind: "execute", input: null }), requested_at: "2026-11-23T10:00:02Z" });
    const waitingOn = (pending: ReturnType<typeof ask>) => ({ ...run("r1", { race: "bench", lane: "1", harness: "cursor" }), status: "input_required", state: "waiting", ended_at: null, pending } as Run);
    const asked = (id: string, call: string, said: string, seq: number) => row({ id, seq, kind: "tool_approval_requested", tool_name: "acp_execute", tool_use_id: call, summary: said });
    const waitingPage = (rows: TimelineRow[], next: number) => ({ ...page("r1", rows, false, 0.1), status: "input_required", state: "waiting", next_after: next } as TimelinePage);
    let answered = false, nextServed = false;
    const v2 = {
      listRuns: async () => ({ runs: [waitingOn(ask("ap1", "c1", "python3 fib.py"))], next_cursor: null }),
      // The answer is queued: the run reads its first call as pending until the agent has asked its next.
      getRun: async () => waitingOn(nextServed ? ask("ap2", "c2", "python3 test.py") : ask("ap1", "c1", "python3 fib.py")),
      getTimeline: async (_id: string, opts: { after?: number } = {}) => {
        if (opts.after === undefined) return waitingPage([asked("u1", "c1", "Waiting for your approval: acp_execute python3 fib.py", 1)], 1);
        if (answered && !nextServed) {
          nextServed = true;
          return waitingPage([asked("u1", "c1", "Asked your approval: acp_execute python3 fib.py", 1), asked("u2", "c2", "Waiting for your approval: acp_execute python3 test.py", 2)], 2);
        }
        return { ...waitingPage([], nextServed ? 2 : 1), unchanged: true } as TimelinePage;
      },
      answerApproval: async () => { answered = true; },
    };
    const host = await render(v2);
    const lane = () => host.querySelector("[data-race-lane='r1']")!;
    const allow = () => [...lane().querySelectorAll("button")].find((b) => b.textContent === "Allow once");
    await act(async () => { allow()!.click(); await new Promise((r) => setTimeout(r, 5)); });
    for (let i = 0; i < 100 && !lane().querySelector("pre[title*='test.py']"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(lane().querySelector("pre[title*='test.py']"), "the next call's card").toBeTruthy();
    expect(allow(), "its Allow once").toBeTruthy();
  });
  it("a lane waiting on an approval offers the compact approval card and says it waits, with no Working spinner; Allow once answers it", async () => {
    const pending = { kind: "approval", id: "ap1", tool: "acp_execute", call_id: "c1", args_preview: JSON.stringify({ title: "python3 fib.py", kind: "execute", input: null }), requested_at: "2026-11-23T10:00:02Z" };
    const waiting = { ...run("r1", { race: "bench", lane: "1", harness: "cursor" }), status: "input_required", state: "waiting", ended_at: null, pending } as Run;
    const rows = [row({ id: "u1", seq: 1, kind: "tool_approval_requested", tool_name: "acp_execute", tool_use_id: "c1", summary: "Waiting for your approval: acp_execute python3 fib.py" })];
    const { v2 } = server([waiting], () => rows);
    const answered: unknown[] = [];
    Object.assign(v2, { answerApproval: async (...args: unknown[]) => { answered.push(args); } });
    const host = await render(v2);
    const lane = host.querySelector("[data-race-lane='r1']")!;
    expect(lane.querySelector("section[aria-label='Approval required']")).toBeTruthy();
    expect(lane.textContent).toContain("Waiting for your approval");
    expect(lane.textContent).not.toContain("Steps appear as the agent takes them");
    const allow = [...lane.querySelectorAll("button")].find((b) => b.textContent === "Allow once")!;
    await act(async () => { allow.click(); await new Promise((r) => setTimeout(r, 5)); });
    expect(answered).toEqual([["r1", "ap1", "allow", undefined, undefined]]);
  });
  it("keeps the Race bar in view, with lanes or none yet: the lanes scroll in the one box under it", async () => {
    const { v2 } = server([run("r1", { race: "bench", lane: "1", harness: "pi", model: "anthropic/claude-sonnet-5-5" })]);
    expect(expectPinnedBar(await render(v2)).querySelector("[data-race-lane='r1']")).toBeTruthy();
    act(() => root!.unmount());
    expect(expectPinnedBar(await render(server([]).v2, "empty")).textContent).toContain("No run carries the label");
  });
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

  it("reads every page of the race before it picks the lanes, and says at least that many more when it stops with pages left", async () => {
    const { v2 } = server([]);
    const asked: unknown[] = [];
    // Newest first, as GET /runs lists: lane 1 is on the last page read, and a cursor is still left after it.
    v2.listRuns = async (...args: unknown[]) => {
      asked.push(args[1]);
      const at = Number(args[1] ?? 0);
      return { runs: Array.from({ length: 50 }, (_, i) => run(`r${200 - at - i}`, { race: "bench", lane: String(200 - at - i) })), next_cursor: String(at + 50) };
    };
    v2.getRun = async (id: string) => run(id, { race: "bench", lane: id.slice(1) });
    const host = await render(v2);
    expect(asked.slice(0, 4)).toEqual([null, "50", "100", "150"]);
    expect([...host.querySelectorAll("[data-race-lane]")].map((l) => l.getAttribute("data-race-lane"))).toEqual(["r1", "r2", "r3", "r4"]);
    expect(host.textContent).toContain("At least 196 more runs");
  });

  it("a lane keeps the newest read of its run: an older read that answers last never puts a finished run back to Working", async () => {
    const working = run("r1", { race: "bench", lane: "1" }), done = run("r1", { race: "bench", lane: "1" }, "completed");
    const { v2 } = server([working]);
    let calls = 0;
    // The first read (the run working) answers after the second (the run completed).
    v2.getRun = async () => (++calls === 1 ? new Promise((r) => setTimeout(() => r(working), 600)) : done);
    const host = await render(v2);
    for (let i = 0; i < 100 && calls < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls).toBe(2);
    expect(host.querySelector("[data-race-lane='r1'] header")?.textContent).toContain("Completed");
  });

  it("a lane whose run fails to read after three tries says so, and reads again when asked", async () => {
    const done = run("r1", { race: "bench", lane: "1" }, "completed");
    const { v2 } = server([run("r1", { race: "bench", lane: "1" })]);
    let fail = true, calls = 0;
    v2.getRun = async () => { calls++; if (fail) throw new Error("503"); return done; };
    const host = await render(v2);
    const note = () => host.querySelector("[data-race-lane='r1'] [data-lane-read-failed]");
    for (let i = 0; i < 150 && !note(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(note()?.textContent).toContain("did not read");
    // The newest read was tried three times (an older read, begun on an earlier page, stops once a newer one begins).
    expect(calls).toBeGreaterThanOrEqual(3);
    fail = false;
    await act(async () => { note()!.querySelector("button")!.click(); });
    for (let i = 0; i < 20 && note(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(note()).toBeNull();
    expect(host.querySelector("[data-race-lane='r1'] header")?.textContent).toContain("Completed");
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

  it("starts no read while one waits, so an older answer never puts back the lanes a newer one showed", async () => {
    const { v2 } = server([]);
    const before = [run("r1", { race: "bench", lane: "1" })], after = [...before, run("r2", { race: "bench", lane: "2" })];
    let calls = 0, waiting = 0, most = 0;
    // The first read answers at once; the second waits 300 ms and answers with the older lane set; every later one has r2.
    v2.listRuns = async () => {
      const n = ++calls;
      waiting++; most = Math.max(most, waiting);
      if (n === 2) await new Promise((r) => setTimeout(r, 300));
      waiting--;
      return { runs: n <= 2 ? before : after, next_cursor: null };
    };
    const host = await render(v2, "bench", 40);
    const shown: number[] = [];
    const watch = new MutationObserver(() => shown.push(host.querySelectorAll("[data-race-lane]").length));
    watch.observe(host, { childList: true, subtree: true });
    for (let i = 0; i < 80 && !(calls > 3 && host.querySelector("[data-race-lane='r2']")); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    watch.disconnect();
    expect(most).toBe(1);
    expect(host.querySelector("[data-race-lane='r2']")).toBeTruthy();
    // Once r2 showed, the lanes never went back to one.
    expect(shown.slice(shown.indexOf(2))).not.toContain(1);
  });

  it("a race whose first read failed shows its lanes once a later read answers", async () => {
    const { v2 } = server([]);
    let calls = 0;
    v2.listRuns = async () => { if (++calls === 1) throw new Error("503"); return { runs: [run("r1", { race: "bench", lane: "1" })], next_cursor: null }; };
    const host = await render(v2, "bench", 40);
    for (let i = 0; i < 50 && !host.querySelector("[data-race-lane='r1']"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(calls).toBeGreaterThan(1);
    expect(host.querySelector("[data-race-lane='r1']")).toBeTruthy();
  });

  it("a later read that fails keeps the lanes shown", async () => {
    const { v2 } = server([]);
    let calls = 0;
    v2.listRuns = async () => { if (++calls > 1) throw new Error("503"); return { runs: [run("r1", { race: "bench", lane: "1" })], next_cursor: null }; };
    const host = await render(v2, "bench", 20);
    for (let i = 0; i < 50 && calls < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(host.querySelector("[data-race-lane='r1']")).toBeTruthy();
  });
});
