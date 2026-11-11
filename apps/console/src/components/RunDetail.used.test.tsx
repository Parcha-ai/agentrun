import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { messageFeatures } from "@/fixtures";
import type { LearnedUse, Run, RunLearningRead } from "@/lib/v2";

// A run's page, what its job did with what its agent learned (GET /v2/runs/{id}/learning `used`): the learned skills it
// was given, read or not, and the learned workflows it called, how many times and how many failed. Nothing when both are
// empty.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const run = (learning: Run["learning"]): Run => ({ sha: null, updated_at: "2026-11-11T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-u", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "allbirds.com",
  created_at: "2026-11-11T10:00:00Z", ended_at: "2026-11-11T10:00:09Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning,
});
const LEARNS: Run["learning"] = { detail: null, at: "2026-11-11T10:00:09Z", state: "dropped", reason: "empty" };
const answer = (used: LearnedUse): RunLearningRead => ({
  run: "run-u", state: "dropped", reason: "empty", detail: null, at: "2026-11-11T10:00:09Z", seed: "c1", merged: null, pending: [], verdict: null, problems: [],
  cost_usd: { grade: null }, tokens: { grade: null }, used,
});
const USED: LearnedUse = {
  skills: [{ name: "find-policies", read: true }, { name: "answer-shape", read: false }],
  workflows: [{ name: "check-refunds", calls: 3, failed: 1 }],
};

async function open(r: Run, read?: () => Promise<RunLearningRead>, tab: "report" | "timeline" = "report") {
  const reads: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunDetail, { run: r, agentName: "Refund policy finder", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab,
    ...(read ? { readLearning: () => { reads.push(r.run_id); return read(); } } : {}) })));
  await settle();
  const section = () => host.querySelector('section[aria-label="What it used of what it learned"]') as HTMLElement | null;
  return { host, reads, section };
}

describe("a run's page, the learned skills and workflows it used", () => {
  it("lists each skill it was given, read or not, and each learned workflow it called, how many times and how many failed", async () => {
    const t = await open(run(LEARNS), async () => answer(USED));
    expect(t.reads).toEqual(["run-u"]);
    const section = t.section()!;
    expect(section).not.toBeNull();
    const items = [...section.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("find-policies");
    expect(items[0]).toContain("Skill");
    expect(items[0]).toContain("Read");
    expect(items[1]).toContain("answer-shape");
    expect(items[1]).toContain("Given, not read");
    expect(items[2]).toContain("check-refunds");
    expect(items[2]).toContain("Workflow");
    expect(items[2]).toContain("Called 3 times");
    expect(items[2]).toContain("1 failed");
    // The agent's Learning tab is a click away.
    expect(section.querySelector('a[href="#/agents/refunds/learning"]')).not.toBeNull();
  });
  it("shows on the timeline tab too", async () => {
    expect((await open(run(LEARNS), async () => answer(USED), "timeline")).section()).not.toBeNull();
  });
  it("one workflow call that did not fail says so without a failed count", async () => {
    const t = await open(run(LEARNS), async () => answer({ skills: [], workflows: [{ name: "check-refunds", calls: 1, failed: 0 }] }));
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Called once");
    expect(text).not.toContain("failed");
  });
  it("is hidden when both lists are empty", async () => {
    const t = await open(run(LEARNS), async () => answer({ skills: [], workflows: [] }));
    expect(t.reads).toEqual(["run-u"]);
    expect(t.section()).toBeNull();
  });
  it("is never read for a run that does not learn, and a read that fails shows nothing", async () => {
    const off = await open(run(null), async () => answer(USED));
    expect(off.reads).toEqual([]);
    expect(off.section()).toBeNull();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    const down = await open(run(LEARNS), async () => { throw new Error("down"); });
    expect(down.reads).toEqual(["run-u"]);
    expect(down.section()).toBeNull();
  });
});
