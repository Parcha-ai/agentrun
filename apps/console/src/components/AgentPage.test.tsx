import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPage, agentHash } from "./AgentPage";
import { agentFixture, archivedAgents, editorCaps, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";
import { ANALYTICS, statsWith } from "./AgentAnalytics.sample";
import type { Run } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const runsOf = (slug: string) => recorded<{ runs: Run[] }>(`agent.${slug}.runs`).body.runs;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.innerHTML = ""; localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
type Page = { runs: Run[]; next_cursor: string | null };
type Opts = {
  runs?: Run[]; next?: string | null; read?: (cursor: string | null) => Promise<Page>; agentRead?: () => Promise<Agent>;
  tab?: string; stats?: () => Promise<unknown>; models?: { default: string; source: string; route_prefix?: string | null };
  harnesses?: { id: string; default_model?: string | null; available?: boolean; reason?: string }[];
  learning?: "on" | "off" | null; strict?: boolean; agentError?: unknown;
};
async function open(agent: Agent, { runs = runsOf("invoice-checker"), next = null, read, agentRead, tab, stats = async () => statsWith(ANALYTICS), models, harnesses, learning, strict, agentError }: Opts = {}) {
  const went: string[] = [];
  const asked: string[] = [];
  const starts = vi.fn(); const timelines = vi.fn();
  const statsAsked: string[] = [];
  const v2 = {
    statsOver: async ({ from, agent: of }: { from?: string; agent?: string }) => { statsAsked.push(`stats ${of} from ${from}`); return stats(); },
    getAgent: async (id: string) => { asked.push(`agent ${id}`); if (agentError) throw agentError; return { agent: agentRead ? await agentRead() : agent, etag: null }; },
    listAgentRuns: async (id: string, _limit: number, cursor: string | null, archived: boolean) => {
      asked.push(`runs ${id}${cursor ? ` after ${cursor}` : ""}${archived ? " archived" : ""}`);
      return read ? read(cursor) : { runs, next_cursor: next };
    },
    startRun: starts, getTimeline: timelines,
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const props = { v2: v2 as never, agentId: agent.agent_id, defaultModel: models?.default ?? editorCaps.defaultModel, modelSource: models?.source, routePrefix: models?.route_prefix, harnesses, go: (h: string) => went.push(h), tab, learning };
  act(() => root.render(strict ? createElement(StrictMode, null, createElement(AgentPage, props)) : createElement(AgentPage, props)));
  await settle();
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); await settle(); };
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((t) => t.textContent === name)?.nextElementSibling as HTMLElement | undefined;
  const rows = () => [...host.querySelectorAll('table[aria-label="Runs"] tbody tr')];
  const focus = async () => { await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); };
  return { host, went, asked, starts, timelines, statsAsked, button, click, tabs, fact, rows, focus };
}

describe("AgentPage overview and run workspace", () => {
  it("keeps the agent overview beside a scoped runs table, with no embedded execution composer or transcript", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect(page.host.querySelector('aside[aria-label="Agent overview"] h1')?.textContent).toBe("Invoice checker");
    expect(page.host.querySelector('[aria-label="Agent workspace"] table[aria-label="Runs"]')).toBeTruthy();
    expect(page.fact("Harness")?.textContent).toBe("pi");
    expect(page.fact("Thinking")?.textContent).toBe("high");
    expect(page.fact("Revision")?.textContent).toBe("rev 3 of 3");
    expect(page.fact("Model")?.textContent).toBe(`${editorCaps.defaultModel} (default)`);
    expect(page.fact("Status")?.textContent).toBe("Active");
    expect(page.host.querySelector('section[aria-label="Start a run"]')).toBeNull();
    expect(page.host.querySelector('section[aria-label="Latest run"]')).toBeNull();
    expect(page.timelines).not.toHaveBeenCalled();
    expect(page.starts).not.toHaveBeenCalled();
    expect(page.tabs()).toEqual(["Runs", "Versions", "Analytics"]);
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker"]);
  });

  it("offers Edit and Run through the same coding menu, with operation-specific manual playground destinations", async () => {
    const page = await open(agentFixture("invoice-checker"));
    await page.click("Choose coding agent for Edit agent");
    expect(document.querySelector('a[role="menuitem"]')?.getAttribute("href")).toBe("#/playground?operation=edit-agent&agent=invoice-checker");
    await page.click("Choose coding agent for Edit agent");
    await page.click("Choose coding agent for Run agent");
    expect(document.querySelector('a[role="menuitem"]')?.getAttribute("href")).toBe("#/playground?agent=invoice-checker");
    expect(page.starts).not.toHaveBeenCalled();
    await page.click("Back to agents");
    expect(page.went).toEqual(["#/agents"]);
  });

  it("links each row to the existing full run page, retaining effort, timing and partial cost", async () => {
    const runs = runsOf("invoice-checker");
    const unknown = { usd: null, basis: "estimate", charge_state: null, cap_usd: null };
    const page = await open(agentFixture("invoice-checker"), { runs: [{ ...runs[0], effort: "high", cost: { ...unknown, so_far_usd: 0.07, unpriced: 1 } }, { ...runs[1], cost: unknown }] });
    expect(page.rows().map((r) => r.querySelector("a")?.getAttribute("href"))).toEqual(runs.slice(0, 2).map((r) => `#/runs/${encodeURIComponent(r.run_id)}`));
    expect(page.rows()[0].textContent).toContain("effort high");
    expect(page.rows()[0].textContent).toContain("so far $0.07 est. · 1 not priced");
    expect(page.rows()[1].textContent).not.toMatch(/\$|Unknown|so far/);
    expect(page.rows()[0].querySelector('[title="How long it ran"]')).toBeTruthy();
  });

  it("shows configuration without turning the overview into an edit form", async () => {
    const agent = agentFixture("invoice-checker");
    const page = await open(agent);
    expect(page.host.querySelector('[aria-label="Agent configuration"]')?.textContent).toContain(agent.definition.tools[0]);
    expect(page.host.querySelector("details pre")?.textContent).toBe(agent.definition.instructions);
    expect(page.host.querySelector("textarea")).toBeNull();
  });

  it("uses server live counts and links loaded live runs, excluding imported history", async () => {
    const base = runsOf("invoice-checker")[0];
    const live = { ...base, run_id: "live-session", status: "working" as const, ended_at: null, imported_from: null };
    const imported = { ...live, run_id: "imported-session", imported_from: { source: "codex", session: "source-session" } };
    const page = await open({ ...agentFixture("invoice-checker"), runs: { count: 3, live: 1 } }, { runs: [live, imported] });
    expect(page.fact("Live jobs")?.textContent).toBe("1");
    expect([...page.host.querySelectorAll('[aria-label="Live jobs"] a')].map((a) => a.getAttribute("href"))).toEqual(["#/runs/live-session"]);
    expect(page.rows()[1].textContent).toContain("Imported history · codex");
  });

  it("does not claim zero live jobs when they are outside the loaded history", async () => {
    const page = await open({ ...agentFixture("invoice-checker"), runs: { count: 100, live: 2 } }, { runs: [], next: "older" });
    expect(page.fact("Live jobs")?.textContent).toBe("2");
    expect(page.host.querySelector('[aria-label="Live jobs"]')?.textContent).toContain("outside the loaded history");
  });

  it("shows an empty state that points to both run destinations", async () => {
    const page = await open({ ...agentFixture("invoice-checker"), runs: { count: 0, live: 0 } }, { runs: [] });
    expect(page.host.textContent).toContain("No runs of this agent yet.");
    expect(page.host.textContent).toContain("coding agent or the API playground");
    expect(page.fact("Live jobs")?.textContent).toBe("0");
  });

  it("searches loaded agent runs without sending another request", async () => {
    const base = runsOf("invoice-checker")[0];
    const page = await open(agentFixture("invoice-checker"), { runs: [{ ...base, title: "Invoice one" }, { ...base, run_id: "two", title: "Customer two" }] });
    const input = page.host.querySelector('input[aria-label="Search this agent\'s runs"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "customer");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(page.rows()).toHaveLength(1);
    expect(page.rows()[0].textContent).toContain("Customer two");
    expect(page.asked).toHaveLength(2);
  });

  it("preserves archival scope and makes no Run action for archived agents", async () => {
    const page = await open(archivedAgents()[0], { runs: [] });
    expect(page.fact("Status")?.textContent).toBe("Archived");
    expect(page.button("Choose coding agent for Run agent")).toBeUndefined();
    expect(page.asked[1]).toMatch(/ archived$/);
    await page.click("Back to agents");
    expect(page.went).toEqual(["#/agents?archived=true"]);
  });
});

describe("AgentPage freshness and pagination", () => {
  it("refreshes the revision and runs when returning from a coding agent, without executing anything", async () => {
    const original = agentFixture("invoice-checker");
    const base = runsOf("invoice-checker")[0];
    let returned = false;
    const page = await open(original, {
      agentRead: async () => returned ? { ...original, revisions: 4, definition: { ...original.definition, version: 4, model: "configured/model" }, runs: { count: 1, live: 1 } } : original,
      read: async () => ({ runs: returned ? [{ ...base, title: "New live job", status: "working", ended_at: null }] : [], next_cursor: null }),
    });
    returned = true; await page.focus();
    expect(page.fact("Revision")?.textContent).toBe("rev 4 of 4");
    expect(page.fact("Model")?.textContent).toBe("configured/model");
    expect(page.fact("Live jobs")?.textContent).toBe("1");
    expect(page.rows()[0].textContent).toContain("New live job");
    expect(page.starts).not.toHaveBeenCalled();
  });

  it("polls while visible and keeps every loaded page after refresh", async () => {
    vi.useFakeTimers();
    const runs = runsOf("invoice-checker");
    const page = await open(agentFixture("invoice-checker"), { read: async (cursor) => cursor ? { runs: runs.slice(1, 3), next_cursor: null } : { runs: runs.slice(0, 1), next_cursor: "older" } });
    await page.click("Load more");
    expect(page.rows()).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); await settle();
    expect(page.rows()).toHaveLength(3);
    expect(page.asked.slice(-3)).toEqual(["agent invoice-checker", "runs invoice-checker", "runs invoice-checker after older"]);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const readCount = page.asked.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(page.asked).toHaveLength(readCount);
  });

  it("retains loaded rows on a failed next page and allows retry", async () => {
    const runs = runsOf("invoice-checker"); let fails = true;
    const page = await open(agentFixture("invoice-checker"), { read: async (cursor) => {
      if (cursor && fails) throw new ClientError(400, "invalid_cursor", "cursor expired");
      return cursor ? { runs: runs.slice(1, 2), next_cursor: null } : { runs: runs.slice(0, 1), next_cursor: "older" };
    } });
    await page.click("Load more");
    expect(page.rows()).toHaveLength(1);
    expect(page.host.textContent).toContain("More runs could not be read.");
    fails = false; await page.click("Load more");
    expect(page.rows()).toHaveLength(2);
  });

  it("shows refreshed metadata errors without losing the loaded agent or runs", async () => {
    let fails = false; const agent = agentFixture("invoice-checker");
    const page = await open(agent, { agentRead: async () => { if (fails) throw new TypeError("Failed to fetch"); return agent; } });
    fails = true; await page.focus();
    expect(page.host.querySelector("h1")?.textContent).toBe("Invoice checker");
    expect(page.rows().length).toBeGreaterThan(0);
    expect(page.host.textContent).toContain("The agent could not be read.");
  });

  it("loads normally under StrictMode without a stale response hiding the table", async () => {
    const page = await open(agentFixture("invoice-checker"), { strict: true });
    expect(page.rows()).toHaveLength(runsOf("invoice-checker").length);
    expect(page.starts).not.toHaveBeenCalled();
  });
});

describe("AgentPage model, capabilities and supported tabs", () => {
  it("keeps key-free observation available and gives setup guidance only for a known missing model default", async () => {
    const page = await open(agentFixture("invoice-checker"), { harnesses: [{ id: "pi", available: true, default_model: null }] });
    expect(page.host.querySelector('a[href="#/settings/keys"]')?.textContent).toContain("Set up models");
    expect(page.button("Choose coding agent for Edit agent").disabled).toBe(false);
    expect(page.button("Choose coding agent for Run agent").disabled).toBe(false);
    expect(page.rows().length).toBeGreaterThan(0);
    expect(page.starts).not.toHaveBeenCalled();
  });

  it("does not claim an explicit model needs setup just because the harness has no default", async () => {
    const base = agentFixture("invoice-checker");
    const page = await open({ ...base, definition: { ...base.definition, model: "anthropic/configured-model" } }, { harnesses: [{ id: "pi", available: true, default_model: null }] });
    expect(page.fact("Model")?.textContent).toBe("anthropic/configured-model");
    expect(page.host.querySelector('a[href="#/settings/keys"]')).toBeNull();
  });

  it("keeps the gateway's route prefix out of the displayed model, with the full id in its title", async () => {
    const page = await open(agentFixture("invoice-checker"), { models: { default: "agent-model/gpt-6-luna", source: "gateway", route_prefix: "agent-model" } });
    expect(page.fact("Model")?.textContent).toBe("gpt-6-luna (default)");
    expect(page.fact("Model")?.title).toBe("agent-model/gpt-6-luna");
  });

  it("uses the selected harness's default instead of the pi fallback", async () => {
    const base = agentFixture("invoice-checker");
    const page = await open({ ...base, definition: { ...base.definition, harness: "claude-agent" } }, { harnesses: [{ id: "pi", default_model: "pi-model" }, { id: "claude-agent", default_model: null }] });
    expect(page.fact("Model")?.textContent).toBe("none yet: add a model key in Settings → Model keys");
  });

  it("explains a disabled harness while keeping its definition and history readable", async () => {
    const base = agentFixture("invoice-checker");
    const page = await open({ ...base, definition: { ...base.definition, harness: "codex" } }, { harnesses: [{ id: "codex", available: false, reason: "codex is not installed." }] });
    expect(page.host.querySelector('[aria-label="Harness not available"]')?.textContent).toBe("codex doesn't run on this server: codex is not installed.");
    expect(page.rows().length).toBeGreaterThan(0);
  });

  it("shows a workflow's read-only graph and no fictional per-agent model", async () => {
    const page = await open(agentFixture("lead-scorer"), { tab: "workflow" });
    expect(page.tabs()).toEqual(["Runs", "Versions", "Workflow", "Analytics"]);
    expect(page.fact("Harness")).toBeUndefined();
    expect(page.fact("Model")).toBeUndefined();
    expect(page.host.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Workflow");
    expect(page.host.querySelector('[aria-label="The workflow\'s graph"]')).toBeTruthy();
    await page.click("Choose coding agent for Edit workflow");
    expect(document.querySelector('a[role="menuitem"]')?.getAttribute("href")).toBe("#/playground?operation=edit-agent&agent=lead-scorer");
  });

  it("only offers Learning when supported and never invents Files or telemetry tabs", async () => {
    const page = await open(agentFixture("invoice-checker"), { learning: "on" });
    expect(page.tabs()).toEqual(["Runs", "Versions", "Learning", "Analytics"]);
    expect(page.tabs()).not.toContain("Files");
    await page.click("Learning");
    expect(page.went).toEqual(["#/agents/invoice-checker/learning"]);
  });

  it("opens Analytics from the page's one scoped stats read", async () => {
    const page = await open(agentFixture("invoice-checker"), { tab: "analytics" });
    expect(page.host.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Analytics");
    expect(page.statsAsked).toHaveLength(1);
    expect(page.statsAsked[0]).toMatch(/^stats invoice-checker from \d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(page.host.textContent).toContain("Success by harness and effort");
  });

  it("falls back to Runs when the server cannot provide analytics", async () => {
    const page = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: async () => { throw new Error("unsupported"); } });
    expect(page.tabs()).toEqual(["Runs", "Versions"]);
    expect(page.rows().length).toBeGreaterThan(0);
  });

  it("uses the server's execution place", async () => {
    const base = agentFixture("invoice-checker");
    const page = await open({ ...base, definition: { ...base.definition, place: { mode: "sandbox", box: "docker" } } });
    expect(page.fact("Runs")?.textContent).toBe("In a docker box");
  });

  it("explains failed agent reads and links missing agents back to the list", async () => {
    const missing = await open(agentFixture("invoice-checker"), { agentError: new ClientError(404, "agent_not_found", "no agent invoice-checker") });
    expect(missing.host.querySelector('[role="alert"]')?.textContent).toContain("No agent with this id.");
    expect(missing.host.querySelector('a[href="#/agents"]')?.textContent).toBe("Open the agents list");
    const offline = await open(agentFixture("invoice-checker"), { agentError: new TypeError("Failed to fetch") });
    expect(offline.host.querySelector('[role="alert"]')?.textContent).toContain("Can't reach agentrun-serve.");
  });

  it("retains encoded agent routes, including the reserved new id", () => {
    expect(agentHash("folder/agent", "runs")).toBe("#/agents/folder%2Fagent/runs");
    expect(agentHash("new")).toBe("#/agents/new/runs");
  });
});
