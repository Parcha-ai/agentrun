import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import { ClientError, createClient } from "@/lib/client";
import type { Run } from "@/lib/v2";
import type { RunLearningResultData } from "@/lib/learning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEPT = { file: "workflows/check-totals/workflow.json", name: "check-totals" };
const run: Run = {
  sha: null, place: { mode: "runner" }, updated_at: "2026-11-01T12:01:00Z", poll_after_ms: 0,
  run_id: "run-review", agent_id: "invoice-checker", agent_version: 2, revision: "rev-2", kind: "agentic", status: "completed", state: "idle", title: "Check invoice",
  created_at: "2026-11-01T12:00:00Z", ended_at: "2026-11-01T12:01:00Z", result: null, error: null, cost: { usd: null, basis: "estimate" }, archived_at: null,
  learning: { state: "merged", reason: null, detail: "Learned 1 workflow: check-totals", at: "2026-11-01T12:01:02Z", workflows: [KEPT] },
};
const RESULT: RunLearningResultData = {
  run: run.run_id, state: "merged", reason: null, detail: "Learned 1 workflow: check-totals", at: "2026-11-01T12:01:02Z", seed: "a".repeat(40), merged: "b".repeat(40),
  workflows: [KEPT, { file: "workflows/trusted-send/workflow.json", name: "trusted-send", pending: true }],
  corrections: 1, problems: [],
};
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
async function open(read = vi.fn(async () => RESULT as unknown), initialRun = run) {
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const diff = vi.fn(async () => ({ base: RESULT.seed, head: RESULT.merged, files: [{ path: "workflows/check-totals/workflow.json", status: "added" as const, patch: "@@ -0,0 +1 @@\n+{}" }] }));
  const render = async (nextRun = initialRun) => { await act(async () => root!.render(createElement(RunDetail, {
    run: nextRun, agentName: "Invoice checker", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report", readLearningDiff: diff,
    readLearningResult: read as () => Promise<RunLearningResultData | null>,
  }))); await settle(); };
  await render();
  const click = async (text: string) => { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); await settle(); };
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((dt) => dt.textContent === name)?.nextElementSibling?.textContent;
  const kept = () => host.querySelector('section[aria-label="What it kept"]')?.textContent ?? "";
  return { host, read, diff, render, click, fact, kept };
}

describe("run learning result", () => {
  it("opens a read-only result only when the Learning tab is requested", async () => {
    const page = await open();
    expect(page.read).not.toHaveBeenCalled();
    expect([...page.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain("Learning");
    await page.click("Learning");
    expect(page.read).toHaveBeenCalledTimes(1);
    expect(page.kept()).toContain("check-totals");
    expect(page.kept()).toContain("trusted-send");
    expect(page.kept()).toContain("Waits for your OK");
    expect(page.kept()).toContain("1 correction added to corrections.md");
    expect(page.host.querySelector('a[href="#/agents/invoice-checker/learning"]')).toBeTruthy();
    expect(page.host.querySelector('button[aria-label="Approve"]')).toBeNull();
    expect(page.host.textContent).toContain("a".repeat(40));
    expect(page.host.textContent).toContain("b".repeat(40));
  });

  it("shows what the checks refused, and that nothing was kept, with no merge commit", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, state: "dropped", merged: null, reason: "checker", workflows: [], corrections: 0,
      problems: [{ rule: "case_data", path: "workflows/check-totals/README.md", detail: "Contains case-specific content." }],
    })));
    await page.click("Learning");
    expect(page.kept()).toContain("Nothing was kept from this run.");
    expect(page.host.textContent).toContain("Contains case-specific content.");
    expect(page.host.textContent).toContain("case_data");
    expect(page.fact("Merge commit")).toBe("Not merged");
  });

  it("shows workflow draft problems even when there are no ordinary validation problems", async () => {
    const error = "workflow.json: the draft calls a tool this host did not declare.";
    const page = await open(vi.fn(async () => ({ ...RESULT, state: "dropped", reason: "checker", merged: null,
      workflows: [], corrections: 0, problems: [], draft_errors: [error],
    })));
    await page.click("Learning");
    const validation = page.host.querySelector('section[aria-label="Learning validation"]')!;
    expect(validation.textContent).toContain(error);
    expect(validation.textContent).not.toContain("No validation problems reported.");
    expect(page.fact("Merge commit")).toBe("Not merged");
  });

  it("shows workflow draft problems alongside ordinary validation problems without hiding what was kept", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT,
      problems: [{ rule: "case_data", path: "workflows/x/README.md", detail: "Contains case-specific content." }],
      draft_errors: ["workflow.json: root contains 129 nodes; at most 128 are supported."],
    })));
    await page.click("Learning");
    const validation = page.host.querySelector('section[aria-label="Learning validation"]')!;
    expect(validation.textContent).toContain("Contains case-specific content.");
    expect(validation.textContent).toContain("case_data · workflows/x/README.md");
    expect(validation.textContent).toContain("workflow.json: root contains 129 nodes; at most 128 are supported.");
    expect(validation.textContent).not.toContain("No validation problems reported.");
    expect(page.fact("Merge commit")).toBe(RESULT.merged);
    expect(page.kept()).toContain("check-totals");
  });

  it.each([undefined, []])("says no problems only when both validation streams are empty (%s)", async draft_errors => {
    const page = await open(vi.fn(async () => ({ ...RESULT, problems: [], draft_errors })));
    await page.click("Learning");
    expect(page.host.querySelector('section[aria-label="Learning validation"]')!.textContent).toContain("No validation problems reported.");
  });

  it("does not show a learning tab or request for a run without learning", async () => {
    const page = await open(undefined, { ...run, learning: null });
    expect([...page.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain("Learning");
    expect(page.read).not.toHaveBeenCalled();
  });

  it("shows missing and unreadable results plainly, with a retry for a failed read", async () => {
    const read = vi.fn(async () => null as unknown);
    const page = await open(read); await page.click("Learning");
    expect(page.host.textContent).toContain("No learning result was recorded for this run.");
    read.mockRejectedValueOnce(new ClientError(404, "not_found", "this server has no learning results route"));
    await page.click("Refresh learning result");
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("not_found");
    read.mockResolvedValue(RESULT);
    await page.click("Try again");
    expect(page.kept()).toContain("check-totals");
  });

  it("retains the previous result but marks it stale if a refresh fails", async () => {
    const page = await open(); await page.click("Learning");
    page.read.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await page.click("Refresh learning result");
    expect(page.host.textContent).toContain("Showing the last result read.");
    expect(page.kept()).toContain("check-totals");
    expect(page.host.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("links back to the existing changed-files view", async () => {
    const page = await open(); await page.click("Learning");
    await page.click("View changes");
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Report");
    expect(page.host.querySelector('[aria-label="What it changed"]')).toBeTruthy();
  });

  it("updates a pending result when the parent run's learning settles", async () => {
    const read = vi.fn(async () => ({ ...RESULT, state: "reflecting", workflows: [], corrections: 0, merged: null } as unknown));
    const page = await open(read, { ...run, learning: { state: "reflecting", reason: null, detail: null, at: "2026-11-01T12:01:00Z" } });
    await page.click("Learning");
    expect(page.kept()).toContain("Nothing kept yet.");
    read.mockResolvedValue(RESULT);
    await page.render(run);
    expect(page.kept()).toContain("check-totals");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a result for another run instead of attributing what it kept to this one", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, run: "another-run" })));
    await page.click("Learning");
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("different run");
    expect(page.host.textContent).not.toContain("trusted-send");
  });

  it("ignores an earlier unfinished read once a newer run state has loaded its result", async () => {
    let resolve!: (result: unknown) => void;
    const read = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const page = await open(read, { ...run, learning: { state: "reflecting", reason: null, detail: null, at: "2026-11-01T12:01:00Z" } });
    await page.click("Learning");
    expect(page.host.textContent).toContain("Reading learning result…");
    read.mockResolvedValue(RESULT);
    await page.render(run);
    expect(page.kept()).toContain("check-totals");
    await act(async () => resolve({ ...RESULT, state: "reflecting", detail: "Old unfinished reflection", workflows: [], corrections: 0 }));
    expect(page.host.textContent).not.toContain("Old unfinished reflection");
    expect(page.kept()).toContain("check-totals");
  });

  it("never renders server strings as markup", async () => {
    const page = await open(vi.fn(async () => ({ ...RESULT, detail: '<img src=x onerror="alert(1)">' })));
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
