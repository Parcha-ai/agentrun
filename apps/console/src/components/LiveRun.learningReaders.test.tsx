import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRun } from "./LiveRun";
import type { Run, RunLearningRead, TimelinePage } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };

const RUN: Run = {
  sha: null, updated_at: "2026-11-11T10:00:09Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-usage", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Find the refund policy",
  created_at: "2026-11-11T10:00:00Z", ended_at: "2026-11-11T10:00:09Z", result: null, error: null,
  cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
  learning: { state: "dropped", reason: "empty", detail: null, at: "2026-11-11T10:00:09Z" },
};
const PAGE: TimelinePage = {
  run_id: RUN.run_id, status: "completed", state: "idle", cost: RUN.cost, rows: [], drop: [], reset: true,
  unchanged: false, final: true, has_more: false, next_after: 0,
};
const LEARNING: NonNullable<RunLearningRead> = {
  run: RUN.run_id, state: "dropped", reason: "empty", detail: null, at: "2026-11-11T10:00:09Z", seed: "a".repeat(40), merged: null, pending: [],
  verdict: { merge: false, reason: "The existing guidance covered this task.", items: [] }, problems: [],
  cost_usd: { grade: 0.008 }, tokens: { grade: { input: 1200, output: 100, cache_read: 600, cache_write: 50 } },
  used: { skills: [{ name: "find-policies", read: true }, { name: "answer-shape", read: false }], workflows: [{ name: "check-refunds", calls: 3, failed: 1 }] },
};

async function open({ readRun = () => RUN, readPage = async () => PAGE, learning = LEARNING }: {
  readRun?: () => Run; readPage?: () => Promise<TimelinePage>; learning?: NonNullable<RunLearningRead>;
} = {}) {
  const v2 = {
    getRun: vi.fn(async () => readRun()),
    listFiles: async () => ({ run_id: RUN.run_id, files: [], complete: true, truncated: false }),
    getTimeline: vi.fn(readPage), listRevisions: async () => ({ revisions: [], next_cursor: null }),
    runLearning: vi.fn(async (_id: string) => learning),
    runLearningResult: vi.fn(async (_id: string) => LEARNING),
  };
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(LiveRun, { v2: v2 as never, runId: RUN.run_id, caps: null, agentName: () => "Refund policy finder" })));
  await settle();
  const click = async (label: string) => {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === label)!;
    expect(tab).toBeTruthy(); await act(async () => tab.click()); await settle();
  };
  const usedRows = () => [...host.querySelectorAll('section[aria-label="What it used of what it learned"] li')].map((row) => row.textContent);
  return { host, v2, click, usedRows };
}

describe("LiveRun's learning readers", () => {
  it("shows learned skill and workflow usage on Report and Timeline while keeping the Learning result reader", async () => {
    const page = await open();
    const details = ["Skillfind-policiesRead", "Skillanswer-shapeGiven, not read", "Workflowcheck-refundsCalled 3 times1 failed"];
    expect(page.usedRows()).toEqual(details);
    expect(page.host.querySelector('section[aria-label="What it used of what it learned"] a')?.getAttribute("href")).toBe("#/agents/refunds/learning");
    expect(page.v2.runLearning.mock.calls).toEqual([[RUN.run_id]]);
    expect(page.v2.runLearningResult).not.toHaveBeenCalled();
    await page.click("Timeline");
    expect(page.usedRows()).toEqual(details);
    await page.click("Learning");
    expect(page.v2.runLearningResult.mock.calls).toEqual([[RUN.run_id]]);
    const result = page.host.querySelector('section[aria-label="Learning result"]')!;
    expect(result.textContent).toContain("The existing guidance covered this task.");
    const fact = (name: string) => [...result.querySelectorAll("dt")].find((term) => term.textContent === name)?.nextElementSibling?.textContent;
    expect(fact("Grading cost")).toBe("$0.0080 est.");
    expect(fact("Input")).toBe("1,200");
    await page.click("Report");
    expect(page.usedRows()).toEqual(details);
  });

  it("reads usage again when the live run ends so late skill reads and workflow calls appear", async () => {
    let current: Run = { ...RUN, status: "working", state: "working", ended_at: null };
    let end!: (page: TimelinePage) => void;
    const timeline = new Promise<TimelinePage>((resolve) => { end = resolve; });
    const page = await open({ readRun: () => current, readPage: () => timeline,
      learning: { ...LEARNING, used: { skills: [{ name: "find-policies", read: false }], workflows: [] } },
    });
    expect(page.usedRows()).toEqual(["Skillfind-policiesGiven, not read"]);
    page.v2.runLearning.mockResolvedValue(LEARNING);
    current = RUN;
    await act(async () => end(PAGE)); await settle();
    expect(page.v2.runLearning.mock.calls).toEqual([[RUN.run_id], [RUN.run_id]]);
    expect(page.usedRows()).toEqual(["Skillfind-policiesRead", "Skillanswer-shapeGiven, not read", "Workflowcheck-refundsCalled 3 times1 failed"]);
    expect(page.v2.runLearningResult).not.toHaveBeenCalled();
  });
});
