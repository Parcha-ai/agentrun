import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, editorCaps, recorded, runFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import type { Run } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Recorded agents have a live run. Successful, quiet examples must explicitly reflect that it has ended.
const quietAgent = (slug = "invoice-checker"): Agent => {
  const agent = agentFixture(slug);
  return { ...agent, runs: { ...agent.runs!, live: 0 } };
};
const success = (agentId = "invoice-checker"): Run => ({ ...runFixture("run.completed.idle.1").run, agent_id: agentId, run_id: "private-run-id", title: "Private customer task" });
type Page = { runs: Run[]; next_cursor: string | null };
type Options = {
  runs?: Run[]; next?: string | null; read?: (cursor: string | null) => Promise<Page>;
  agentRead?: () => Promise<Agent>; fullRead?: (id: string) => Promise<Run>;
};
async function open(agent: Agent, { runs = [success(agent.agent_id)], next = null, read, agentRead, fullRead }: Options = {}) {
  const went: string[] = [];
  const starts = vi.fn();
  const getRun = vi.fn(async (id: string) => fullRead ? fullRead(id) : runs.find((run) => run.run_id === id)!);
  const listAgentRuns = vi.fn(async (_id: string, _limit: number, cursor: string | null) => read ? read(cursor) : { runs, next_cursor: next });
  const v2 = {
    getAgent: async () => ({ agent: agentRead ? await agentRead() : agent, etag: null }),
    statsOver: async () => { throw new Error("Analytics unavailable"); },
    listAgentRuns, getRun, startRun: starts,
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  let props = { v2: v2 as never, agentId: agent.agent_id, harnesses: editorCaps.harnesses, go: (hash: string) => went.push(hash) };
  act(() => root.render(createElement(AgentPage, props)));
  await settle();
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); await settle(); };
  const focus = async () => { await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); };
  const rerender = async (nextProps: Partial<Parameters<typeof AgentPage>[0]>) => {
    props = { ...props, ...nextProps } as typeof props;
    act(() => root.render(createElement(AgentPage, props)));
    await settle();
  };
  const onboarding = () => host.querySelector('section[aria-label="Production onboarding"]');
  return { host, v2, went, starts, getRun, listAgentRuns, button, click, focus, rerender, onboarding };
}

describe("AgentPage production onboarding", () => {
  it("offers static, separate Cloud links below the runs table without sending local context or replacing Run and Edit", async () => {
    const agent = quietAgent();
    const before = structuredClone(agent);
    const fetch = vi.spyOn(globalThis, "fetch");
    const beacon = vi.fn();
    const originalBeacon = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    try {
      const page = await open(agent);
      const search = page.host.querySelector<HTMLInputElement>('input[aria-label="Search this agent\'s runs"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Private customer task");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const row = page.onboarding()!;
      expect(row.textContent).toContain("Cloud setup is separate from this server.");
      const history = page.host.querySelector('[aria-label="Agent run history"]')!;
      expect(history.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const links = [...row.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links.map((a) => a.href)).toEqual(["https://calendly.com/d/dtwn-dsp-nx5/agentrun", "https://console.agentrun.ai/"]);
      for (const link of links) {
        expect(new URL(link.href).search).toBe("");
        expect(new URL(link.href).hash).toBe("");
        expect(link.target).toBe("_blank");
        expect(link.relList.contains("noopener")).toBe(true);
        expect(link.relList.contains("noreferrer")).toBe(true);
        expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(link.textContent).toContain("opens in a new tab");
        link.addEventListener("click", (event) => event.preventDefault());
        await act(async () => link.click());
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
      expect(page.starts).not.toHaveBeenCalled();
      expect(page.went).toEqual([]);
      expect(agent).toEqual(before);
      expect(search.value).toBe("Private customer task");
      expect(page.host.querySelector('section[aria-label="Start a run"]')).toBeNull();
      await page.click("Choose coding agent for Run agent");
      expect(document.querySelector('a[role="menuitem"]')?.getAttribute("href")).toBe("#/playground?agent=invoice-checker");
      await page.click("Choose coding agent for Run agent");
      await page.click("Choose coding agent for Edit agent");
      expect(document.querySelector('a[role="menuitem"]')?.getAttribute("href")).toBe("#/playground?operation=edit-agent&agent=invoice-checker");
      await page.click("Choose coding agent for Edit agent");
      await page.click("Detailed editor");
      expect(page.went).toEqual(["#/agents/invoice-checker/edit"]);
      expect(page.starts).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      if (originalBeacon) Object.defineProperty(navigator, "sendBeacon", originalBeacon);
      else Reflect.deleteProperty(navigator, "sendBeacon");
    }
  });

  it.each(["queued", "working", "input_required", "paused", "failed", "cancelled"] as const)("does not interrupt a latest %s run", async (status) => {
    const page = await open(quietAgent(), { runs: [{ ...success(), status }] });
    expect(page.onboarding()).toBeNull();
    expect(page.getRun).not.toHaveBeenCalled();
  });

  it.each(["no-runs", "archived-agent", "archived-run", "review", "error", "invalid-output", "wrong-agent", "unloaded-live-run"] as const)("does not offer onboarding for %s", async (condition) => {
    const agent = quietAgent();
    const run = success();
    const page = await open({ ...agent,
      ...(condition === "archived-agent" ? { archived_at: "2026-11-01T00:00:00Z" } : {}),
      ...(condition === "unloaded-live-run" ? { runs: { count: 100, live: 1 } } : {}),
    }, { runs: condition === "no-runs" ? [] : [{ ...run,
      ...(condition === "archived-run" ? { archived_at: "2026-11-01T00:00:00Z" } : {}),
      ...(condition === "review" ? { review: { kind: "needs_evidence", node: "verify", reason: "Check this result", at: "2026-11-01T00:00:00Z" } } : {}),
      ...(condition === "error" ? { error: { code: "run_failed", message: "Needs investigation", retryable: false } } : {}),
      ...(condition === "invalid-output" ? { result: { output: null, final_answer: "Invalid answer", output_error: "Answer does not meet the schema" } } : {}),
      ...(condition === "wrong-agent" ? { agent_id: "another-agent" } : {}),
    }], next: condition === "unloaded-live-run" ? "older" : null });
    expect(page.onboarding()).toBeNull();
  });

  it.each(["queued", "working", "input_required", "paused", "review"] as const)("keeps onboarding hidden while an older loaded run is %s", async (state) => {
    const done = success();
    const older: Run = { ...done, run_id: "older-unfinished", status: state === "review" ? "completed" : state,
      review: state === "review" ? { kind: "needs_evidence", node: "verify", reason: "Check this result", at: "2026-11-01T00:00:00Z" } : null };
    const page = await open(quietAgent(), { runs: [done, older] });
    expect(page.onboarding()).toBeNull();
  });

  it("allows a new success despite a historical failed run", async () => {
    const done = success();
    const page = await open(quietAgent(), { runs: [done, { ...done, run_id: "older-failure", status: "failed", error: { code: "run_failed", message: "Previous failure", retryable: false } }] });
    expect(page.onboarding()).not.toBeNull();
  });

  it("confirms a newly completed run after a focus refresh reports no live jobs", async () => {
    const done = success();
    let runs: Run[] = [{ ...done, status: "working", state: "working", result: null, ended_at: null }];
    let agent: Agent = { ...quietAgent(), runs: { count: 1, live: 1 } };
    const page = await open(agent, { read: async () => ({ runs, next_cursor: null }), agentRead: async () => agent, fullRead: async () => done });
    expect(page.onboarding()).toBeNull();
    runs = [done]; agent = quietAgent();
    await page.focus();
    expect(page.onboarding()).not.toBeNull();
    expect(page.getRun).toHaveBeenCalledWith(done.run_id);
  });

  it.each([false, true])("waits for the full record and refuses an invalid result hidden by the real list summary: invalid=%s", async (invalid) => {
    const done = runFixture("run.completed.idle.4").run;
    const summary = recorded<{ runs: Run[] }>("agent.support-triage.runs").body.runs.find((r) => r.run_id === done.run_id)!;
    expect(summary).not.toHaveProperty("result");
    const pending = deferred<Run>();
    const page = await open(quietAgent("support-triage"), { runs: [summary], fullRead: () => pending.promise });
    expect(page.onboarding()).toBeNull();
    await act(async () => pending.resolve(invalid ? { ...done, result: { output: null, final_answer: "Invalid answer", output_error: "Answer does not meet the schema" } } : done));
    expect(!!page.onboarding()).toBe(!invalid);
    expect(page.getRun).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "review", "error", "archived", "wrong-agent", "wrong-run", "summary", "read-error"] as const)("keeps onboarding hidden when full confirmation returns %s", async (condition) => {
    const done = runFixture("run.completed.idle.4").run;
    const summary = recorded<{ runs: Run[] }>("agent.support-triage.runs").body.runs.find((r) => r.run_id === done.run_id)!;
    const full: Run = condition === "summary" ? summary : { ...done,
      ...(condition === "failed" ? { status: "failed" as const } : {}),
      ...(condition === "review" ? { review: { kind: "needs_evidence", node: "verify", reason: "Check this result", at: "2026-11-01T00:00:00Z" } } : {}),
      ...(condition === "error" ? { error: { code: "run_failed", message: "Needs investigation", retryable: false } } : {}),
      ...(condition === "archived" ? { archived_at: "2026-11-01T00:00:00Z" } : {}),
      ...(condition === "wrong-agent" ? { agent_id: "another-agent" } : {}),
      ...(condition === "wrong-run" ? { run_id: "another-run" } : {}),
    };
    const page = await open(quietAgent("support-triage"), { runs: [summary], fullRead: async () => { if (condition === "read-error") throw new Error("Run not available"); return full; } });
    expect(page.onboarding()).toBeNull();
    expect(page.button("Choose coding agent for Run agent")).toBeTruthy();
    expect(page.button("Choose coding agent for Edit agent")).toBeTruthy();
    expect(page.getRun).toHaveBeenCalledTimes(1);
  });

  it.each(["agent", "run", "client"] as const)("ignores stale full-run confirmation after changing %s", async (where) => {
    const done = success();
    const pending = deferred<Run>();
    let runs = [done];
    const page = await open(quietAgent(), { read: async () => ({ runs, next_cursor: null }), fullRead: () => pending.promise });
    expect(page.onboarding()).toBeNull();
    if (where === "run") {
      runs = [{ ...done, run_id: "newer-working-run", status: "working", state: "working" }];
      await page.focus();
    } else {
      const agent = quietAgent(where === "agent" ? "support-triage" : "invoice-checker");
      const next = { ...done, agent_id: agent.agent_id, ...(where === "agent" ? { run_id: "other-agent-run", status: "working" as const } : {}) };
      await page.rerender({ agentId: agent.agent_id, v2: { ...page.v2,
        getAgent: async () => ({ agent, etag: null }),
        listAgentRuns: async () => ({ runs: [next], next_cursor: null }),
        getRun: async () => { throw new Error("The current client cannot confirm this run"); },
      } as never });
    }
    await act(async () => pending.resolve(done));
    expect(page.onboarding()).toBeNull();
  });

  it("hides onboarding during pagination and a failed page, then requires fresh full confirmation after recovery", async () => {
    const done = success();
    const older = deferred<Page>();
    const confirmation = deferred<Run>();
    let confirmations = 0;
    const page = await open(quietAgent(), {
      read: async (cursor) => cursor ? older.promise : { runs: [done], next_cursor: "older" },
      fullRead: async () => ++confirmations === 1 ? done : confirmation.promise,
    });
    expect(page.onboarding()).not.toBeNull();
    await page.click("Load more");
    expect(page.onboarding()).toBeNull();
    await act(async () => older.reject(new Error("Older runs unavailable")));
    expect(page.onboarding()).toBeNull();
    await page.click("Refresh agent");
    expect(page.getRun).toHaveBeenCalledTimes(2);
    expect(page.onboarding()).toBeNull();
    await act(async () => confirmation.resolve(done));
    expect(page.onboarding()).not.toBeNull();
  });

  it.each(["success", "failure"] as const)("hides stale onboarding while a refresh is pending and after a refresh %s", async (outcome) => {
    const done = success();
    const pending = deferred<Page>();
    let reads = 0;
    const page = await open(quietAgent(), { read: async () => ++reads === 1 ? { runs: [done], next_cursor: null } : pending.promise });
    expect(page.onboarding()).not.toBeNull();
    await page.click("Refresh agent");
    expect(page.onboarding()).toBeNull();
    await act(async () => { if (outcome === "success") pending.resolve({ runs: [done], next_cursor: null }); else pending.reject(new Error("Refresh failed")); });
    await settle();
    expect(!!page.onboarding()).toBe(outcome === "success");
    expect(page.getRun).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1);
  });

  it("reconfirms the full result after an immediate refresh of the same run", async () => {
    const done = success();
    let confirmations = 0;
    const page = await open(quietAgent(), { fullRead: async () => ++confirmations === 1 ? done : {
      ...done, result: { output: null, final_answer: "Invalid answer", output_error: "Answer does not meet the schema" },
    } });
    expect(page.onboarding()).not.toBeNull();
    await page.focus();
    expect(page.getRun).toHaveBeenCalledTimes(2);
    expect(page.onboarding()).toBeNull();
  });

  it("reconfirms a changed full result when immediate reads batch the loading state", async () => {
    const agent = quietAgent();
    const done = success();
    let confirmations = 0;
    const getRun = vi.fn(async () => ++confirmations === 1 ? done : {
      ...done, result: { output: null, final_answer: "Invalid answer", output_error: "Answer does not meet the schema" },
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host); roots.push(root);
    const v2 = {
      getAgent: async () => ({ agent, etag: null }),
      statsOver: async () => ({}),
      listAgentRuns: async () => ({ runs: [done], next_cursor: null }),
      getRun,
    };
    act(() => root.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, go: () => {} })));
    await settle();
    expect(host.querySelector('[aria-label="Production onboarding"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[aria-label="Production onboarding"]')).toBeNull();
  });

  it("waits for refreshed agent metadata and respects a live job outside the loaded history", async () => {
    const done = success();
    const metadata = deferred<Agent>();
    let reads = 0;
    const agent = quietAgent();
    const page = await open(agent, { agentRead: async () => ++reads === 1 ? agent : metadata.promise, runs: [done], next: "older" });
    expect(page.onboarding()).not.toBeNull();
    await page.focus();
    expect(page.onboarding()).toBeNull();
    await act(async () => metadata.resolve({ ...agent, runs: { count: 100, live: 1 } }));
    expect(page.onboarding()).toBeNull();
    expect(page.host.querySelector('[aria-label="Live jobs"]')?.textContent).toContain("outside the loaded history");
  });

  it.each(["manual", "focus"] as const)("a %s refresh that cannot confirm agent metadata hides onboarding until metadata and the full run are freshly confirmed", async (trigger) => {
    const agent = quietAgent();
    const done = success();
    const confirmation = deferred<Run>();
    let metadataReads = 0, fullReads = 0;
    const page = await open(agent, {
      agentRead: async () => {
        if (++metadataReads === 2) throw new Error("Agent metadata unavailable");
        return agent;
      },
      fullRead: async () => ++fullReads === 1 || metadataReads === 2 ? done : confirmation.promise,
    });
    expect(page.onboarding()).not.toBeNull();
    const refresh = () => trigger === "manual" ? page.click("Refresh agent") : page.focus();
    await refresh();
    expect(page.onboarding()).toBeNull();
    expect(page.getRun).toHaveBeenCalledTimes(1);
    await refresh();
    expect(page.getRun).toHaveBeenCalledTimes(2);
    expect(page.onboarding()).toBeNull();
    await act(async () => confirmation.resolve(done));
    expect(page.onboarding()).not.toBeNull();
  });
});
