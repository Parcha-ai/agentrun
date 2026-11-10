import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import { ClientError, createClient } from "@/lib/client";
import type { Run } from "@/lib/v2";
import type { RunLearningResultData } from "@/lib/learning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const run: Run = {
  sha: null, updated_at: "2026-11-01T12:01:00Z", poll_after_ms: 0,
  run_id: "run-review", agent_id: "invoice-checker", agent_version: 2, revision: "rev-2", kind: "agentic", status: "completed", state: "idle", title: "Check invoice",
  created_at: "2026-11-01T12:00:00Z", ended_at: "2026-11-01T12:01:00Z", result: null, error: null, cost: { usd: null, basis: "estimate" }, archived_at: null,
  learning: { state: "merged", reason: null, detail: "Learned to check totals.", at: "2026-11-01T12:01:02Z", learned: [{ file: "invoice.md", name: "Check totals", supersedes: [] }] },
};
const RESULT: RunLearningResultData = {
  run: run.run_id, state: "merged", reason: null, detail: "Learned to check totals.", at: "2026-11-01T12:01:02Z", seed: "a".repeat(40), merged: "b".repeat(40),
  pending: [{ file: "trusted.md", name: "Trusted destinations" }],
  verdict: { merge: true, reason: "Useful for later invoice checks.", items: [
    { file: "invoice.md", keep: true, why: "Reusable arithmetic check." },
    { file: "trusted.md", keep: true, pending: true, origin: "you", question: "Should this destination be trusted?", why: "Needs the owner's approval." },
  ] },
  problems: [], cost_usd: { grade: 0.008 }, tokens: { grade: { input: 1200, output: 100, cache_read: 600, cache_write: 50 } },
};
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
async function open(read = vi.fn(async () => RESULT as unknown), initialRun = run) {
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const diff = vi.fn(async () => ({ base: RESULT.seed, head: RESULT.merged, files: [{ path: "invoice.md", status: "added" as const, patch: "@@ -0,0 +1 @@\n+Check totals." }] }));
  const render = async (nextRun = initialRun) => { await act(async () => root!.render(createElement(RunDetail, {
    run: nextRun, agentName: "Invoice checker", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report", readLearningDiff: diff,
    readLearningResult: read as () => Promise<RunLearningResultData | null>,
  }))); await settle(); };
  await render();
  const click = async (text: string) => { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); await settle(); };
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((dt) => dt.textContent === name)?.nextElementSibling?.textContent;
  return { host, read, diff, render, click, fact };
}

describe("run learning result", () => {
  it("opens a read-only result only when the Learning tab is requested", async () => {
    const page = await open();
    expect(page.read).not.toHaveBeenCalled();
    expect([...page.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain("Learning");
    await page.click("Learning");
    expect(page.read).toHaveBeenCalledTimes(1);
    expect(page.host.textContent).toContain("Useful for later invoice checks.");
    expect(page.host.textContent).toContain("Reusable arithmetic check.");
    expect(page.host.textContent).toContain("Needs approval");
    expect(page.host.textContent).toContain("Should this destination be trusted?");
    expect(page.host.querySelector('a[href="#/agents/invoice-checker/learning"]')).toBeTruthy();
    expect(page.host.querySelector('button[aria-label="Approve"]')).toBeNull();
    expect(page.host.textContent).toContain("a".repeat(40));
    expect(page.host.textContent).toContain("b".repeat(40));
  });

  it("separates the grading cost and all four token counters without double counting cached input", async () => {
    const page = await open(); await page.click("Learning");
    expect(page.fact("Grading cost")).toBe("$0.0080 est.");
    expect(page.fact("Input")).toBe("1,200");
    expect(page.fact("Output")).toBe("100");
    expect(page.fact("Cache reads")).toBe("600");
    expect(page.fact("Cache writes")).toBe("50");
    expect(page.host.textContent).toContain("Input excludes cache reads and writes.");
    expect(page.host.textContent).toContain("Reflection usage is included in the run's totals.");
  });

  it("keeps null usage unknown and reported zero as zero", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, cost_usd: { grade: null }, tokens: { grade: null } })));
    await page.click("Learning");
    expect(page.fact("Grading cost")).toBe("Not reported");
    expect(page.fact("Input")).toBe("Not reported");
    page.read.mockResolvedValue({ ...RESULT, cost_usd: { grade: 0 }, tokens: { grade: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } });
    await page.click("Refresh learning result");
    expect(page.fact("Input")).toBe("0");
    expect(page.fact("Grading cost")).toBe("$0.0000 est.");
  });

  it("shows actual rejection and validation problems without calling them a successful grade", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, state: "dropped", merged: null, reason: "checker", pending: [],
      verdict: { merge: false, reason: "Not general enough.", items: [{ file: "invoice.md", keep: false, why: "Repeats case details." }] },
      problems: [{ rule: "case_data", path: "invoice.md", detail: "Contains case-specific content." }],
    })));
    await page.click("Learning");
    expect(page.host.textContent).toContain("Do not keep");
    expect(page.host.textContent).toContain("Not general enough.");
    expect(page.host.textContent).toContain("Contains case-specific content.");
    expect(page.host.textContent).toContain("case_data");
    expect(page.fact("Merge commit")).toBe("Not merged");
  });

  it("shows a partial merge without implying that dropped or invalid items were kept", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT,
      detail: "Learned: Check totals. Not kept: One invoice is not a reusable rule.",
      verdict: { ...RESULT.verdict!, items: [...RESULT.verdict!.items, { file: "one-invoice.md", keep: false, question: "General", why: "One invoice is not a reusable rule." }] },
      problems: [{ rule: "note_description", path: "incomplete.md", detail: "The note has no description." }],
    })));
    await page.click("Learning");
    const grader = page.host.querySelector('section[aria-label="Grader decision"]')!;
    const decisions = [...grader.querySelectorAll("li")].map((item) => [item.querySelector("code")?.textContent, item.querySelector("span")?.textContent]);
    expect(decisions).toEqual([["invoice.md", "Keep"], ["trusted.md", "Needs approval"], ["one-invoice.md", "Do not keep"]]);
    expect(grader.textContent).toContain("Recommended keeping some changes.");
    expect(page.host.textContent).toContain("Not kept: One invoice is not a reusable rule.");
    expect(page.host.querySelector('section[aria-label="Learning validation"]')?.textContent).toContain("incomplete.md");
    expect(page.host.textContent).toContain("These changes required approval when recorded.");
    expect(page.fact("Merge commit")).toBe(RESULT.merged);
  });

  it("does not show a learning tab or request for a run without learning", async () => {
    const page = await open(undefined, { ...run, learning: null });
    expect([...page.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain("Learning");
    expect(page.read).not.toHaveBeenCalled();
  });

  it("shows missing and unreadable results honestly, with a retry for a failed read", async () => {
    const read = vi.fn(async () => null as unknown);
    const page = await open(read); await page.click("Learning");
    expect(page.host.textContent).toContain("No learning result was recorded for this run.");
    read.mockRejectedValueOnce(new ClientError(404, "not_found", "this server has no learning results route"));
    await page.click("Refresh learning result");
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("not_found");
    read.mockResolvedValue(RESULT);
    await page.click("Try again");
    expect(page.host.textContent).toContain("Reusable arithmetic check.");
  });

  it("retains the previous result but marks it stale if a refresh fails", async () => {
    const page = await open(); await page.click("Learning");
    page.read.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await page.click("Refresh learning result");
    expect(page.host.textContent).toContain("Showing the last result read.");
    expect(page.host.textContent).toContain("Reusable arithmetic check.");
    expect(page.host.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("links back to the existing changed-files view", async () => {
    const page = await open(); await page.click("Learning");
    await page.click("View changes");
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Report");
    expect(page.host.querySelector('[aria-label="What it changed"]')).toBeTruthy();
  });

  it("updates a pending result when the parent run's learning settles", async () => {
    const read = vi.fn(async () => ({ ...RESULT, state: "reflecting", verdict: null, merged: null } as unknown));
    const page = await open(read, { ...run, learning: { state: "reflecting", reason: null, detail: null, at: "2026-11-01T12:01:00Z" } });
    await page.click("Learning");
    expect(page.host.textContent).toContain("No grader decision recorded yet.");
    read.mockResolvedValue(RESULT);
    await page.render(run);
    expect(page.host.textContent).toContain("Useful for later invoice checks.");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a result for another run instead of attributing its decisions to this one", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, run: "another-run" })));
    await page.click("Learning");
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("different run");
    expect(page.host.textContent).not.toContain("Reusable arithmetic check.");
  });

  it("ignores an earlier unfinished read once a newer run state has loaded its result", async () => {
    let resolve!: (result: unknown) => void;
    const read = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const page = await open(read, { ...run, learning: { state: "reflecting", reason: null, detail: null, at: "2026-11-01T12:01:00Z" } });
    await page.click("Learning");
    expect(page.host.textContent).toContain("Reading learning result…");
    read.mockResolvedValue(RESULT);
    await page.render(run);
    expect(page.host.textContent).toContain("Useful for later invoice checks.");
    await act(async () => resolve({ ...RESULT, state: "reflecting", detail: "Old unfinished reflection", verdict: null }));
    expect(page.host.textContent).not.toContain("Old unfinished reflection");
    expect(page.host.textContent).toContain("Useful for later invoice checks.");
  });

  it("never renders server strings as markup", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, verdict: { ...RESULT.verdict, reason: '<img src=x onerror="alert(1)">' } })));
    await page.click("Learning");
    expect(page.host.querySelector('img[src="x"]')).toBeNull();
    expect(page.host.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

it("reads full run learning through the same-origin client with an encoded run id", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(RESULT), { headers: { "content-type": "application/json" } }));
  const client = createClient({ fetch: fetcher as typeof fetch });
  const answer = await client.runLearningResult("run/with spaces");
  expect(answer).toEqual(RESULT);
  expect(fetcher).toHaveBeenCalledWith("/v2/runs/run%2Fwith%20spaces/learning", expect.objectContaining({ method: "GET", credentials: "same-origin", body: undefined }));
});
