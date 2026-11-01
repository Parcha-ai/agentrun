import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, archivedAgents, editorCaps, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { ANALYTICS } from "@/lib/analytics.sample";
import type { Run } from "@/lib/v2";

// An agent's own page: its current revision's settings in the header, its runs, and a workflow agent's graph, read-only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runsOf = (slug: string) => recorded<{ runs: Run[] }>(`agent.${slug}.runs`).body.runs;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

type Opts = { runs?: Run[]; next?: string | null; more?: () => Promise<{ runs: Run[]; next_cursor: string | null }>; tab?: string; stats?: () => Promise<unknown> };
/** By default the server's stats carry no analytics, as an older server's. */
async function open(agent: Agent, { runs = runsOf("invoice-checker"), next = null, more, tab, stats = async () => ({}) }: Opts = {}) {
  const went: string[] = [];
  const asked: string[] = [];
  const statsAsked: string[] = [];
  const v2 = {
    agentStats: async (id: string, from?: string) => { statsAsked.push(`stats ${id}${from ? ` from ${from}` : ""}`); return stats(); },
    getAgent: async (id: string) => { asked.push(`agent ${id}`); return { agent, etag: null }; },
    listAgentRuns: async (id: string, _limit: number, cursor?: string | null, archived?: boolean) => {
      asked.push(`runs ${id}${cursor ? ` after ${cursor}` : ""}${archived ? " archived" : ""}`);
      return cursor && more ? more() : { runs, next_cursor: next };
    },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, defaultModel: editorCaps.defaultModel, go: (h: string) => went.push(h), tab })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((t) => t.textContent === name)?.nextElementSibling?.textContent;
  return { host, went, asked, statsAsked, click, button, tabs, fact };
}

describe("AgentPage", () => {
  it("heads the page with the current revision's harness, model and thinking, and Edit opens the editor", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect(page.host.querySelector("h1")?.textContent).toBe("Invoice checker");
    expect(page.fact("Harness")).toBe("pi");
    expect(page.fact("Thinking")).toBe("high");
    // No model of its own: the server's default, named as the default.
    expect(page.fact("Model")).toBe(`${editorCaps.defaultModel} (default)`);
    expect(page.fact("Revision")).toBe("rev 3 of 3");
    expect(page.host.textContent).not.toContain("Archived");
    await page.click(/^Edit$/);
    expect(page.went).toEqual(["#/agents/invoice-checker/edit"]);
  });

  it("names a model the revision sets as it is", async () => {
    const a = agentFixture("invoice-checker");
    const page = await open({ ...a, definition: { ...a.definition, model: "openrouter/some-model" } });
    expect(page.fact("Model")).toBe("openrouter/some-model");
  });

  it("opens on the Runs tab: the agent's runs, each a link to its run, with when, how long and a known cost", async () => {
    const runs = runsOf("invoice-checker");
    // A cost the server does not know is left out, never shown as $0.
    const unknown = { ...runs[runs.length - 1], cost: null };
    const page = await open(agentFixture("invoice-checker"), { runs: [...runs.slice(0, -1), unknown] });
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker"]);
    expect(page.tabs()).toEqual(["Runs"]);
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    const links = [...page.host.querySelectorAll<HTMLAnchorElement>('ul[aria-label="Runs"] a')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(runs.map((r) => `#/runs/${encodeURIComponent(r.run_id)}`));
    expect(links[0].textContent).toContain(runs[0].title);
    expect(page.host.textContent).toContain(`${runs.length} runs`);
    // An ended run says how long it ran; one still waiting on a person does not.
    const ended = runs.findIndex((r) => r.ended_at);
    const open_ = runs.findIndex((r) => !r.ended_at);
    expect(links[ended].querySelector('[title="How long it ran"]')).toBeTruthy();
    expect(links[open_].querySelector('[title="How long it ran"]')).toBeNull();
    expect(links[1].textContent).toContain("$0.0088 est.");
    expect(links[links.length - 1].textContent).not.toMatch(/\$|Unknown/);
  });

  it("says when the agent has no runs yet", async () => {
    const page = await open(agentFixture("invoice-checker"), { runs: [] });
    expect(page.host.textContent).toContain("No runs of this agent yet.");
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
  });

  it("reads the next page with Load more, and a failed one keeps the runs already read", async () => {
    const runs = runsOf("invoice-checker");
    let fail = true;
    const page = await open(agentFixture("invoice-checker"), { runs: runs.slice(0, 5), next: "c2", more: async () => {
      if (fail) throw new Error("the network went away");
      return { runs: runs.slice(5), next_cursor: null };
    } });
    const count = () => page.host.querySelectorAll('ul[aria-label="Runs"] a').length;
    expect(count()).toBe(5);
    await page.click(/^Load more$/);
    expect(count()).toBe(5);
    expect(page.host.textContent).toContain("More runs could not be read: the network went away");
    fail = false;
    await page.click(/^Load more$/);
    expect(count()).toBe(runs.length);
    expect(page.button(/^Load more$/)).toBeUndefined();
    expect(page.host.textContent).not.toContain("could not be read");
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker", "runs invoice-checker after c2", "runs invoice-checker after c2"]);
  });

  it("has a Workflow tab only for a workflow agent, at its own address", async () => {
    const page = await open(agentFixture("support-triage"), { runs: runsOf("support-triage") });
    expect(page.tabs()).toEqual(["Runs", "Workflow"]);
    // A workflow revision has no harness, model or thinking of its own.
    expect(page.fact("Harness")).toBeUndefined();
    await page.click(/^Workflow$/);
    expect(page.went).toEqual(["#/agents/support-triage/workflow"]);
  });

  it("draws a workflow agent's graph read-only on its Workflow tab, with a way to the editor", async () => {
    const page = await open(agentFixture("support-triage"), { tab: "workflow" });
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Workflow");
    expect(page.host.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("The workflow's graph");
    expect(page.host.querySelectorAll("textarea, input, select, [contenteditable]").length).toBe(0);
    await page.click(/Edit the workflow/);
    expect(page.went).toEqual(["#/agents/support-triage/edit"]);
  });

  it("opens an agentic agent on its Runs tab whatever tab the address names", async () => {
    const page = await open(agentFixture("invoice-checker"), { tab: "workflow" });
    expect(page.tabs()).toEqual(["Runs"]);
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeTruthy();
  });

  it("shows an archived agent as archived, with its runs, which are archived with it, and goes back to the archived agents", async () => {
    const agent = archivedAgents()[0];
    const runs = runsOf("invoice-checker").slice(0, 2).map((r) => ({ ...r, agent_id: agent.agent_id, archived_at: agent.archived_at }));
    const page = await open(agent, { runs });
    expect([...page.host.querySelectorAll("header span")].some((s) => s.textContent === "Archived")).toBe(true);
    expect(page.asked).toEqual([`agent ${agent.agent_id}`, `runs ${agent.agent_id} archived`]);
    expect(page.host.querySelectorAll('ul[aria-label="Runs"] a').length).toBe(2);
    await page.click(/^Agents$/);
    expect(page.went).toEqual(["#/agents?archived=true"]);
  });

  it("shows an Analytics tab only when the server's stats for this agent carry analytics", async () => {
    const page = await open(agentFixture("invoice-checker"), { stats: async () => ({ analytics: ANALYTICS }) });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    expect(page.statsAsked).toEqual(["stats invoice-checker"]);
    await page.click(/^Analytics$/);
    expect(page.went).toEqual(["#/agents/invoice-checker/analytics"]);
    act(() => root?.unmount());
    // An older server's stats have no analytics, and one without stats fails them: no tab, and nothing in its place.
    for (const stats of [async () => ({ agents: 1 }), async () => { throw new Error("no route GET /v2/stats"); }]) {
      const older = await open(agentFixture("invoice-checker"), { stats });
      expect(older.tabs()).toEqual(["Runs"]);
      expect(older.host.textContent).not.toMatch(/analytics/i);
      act(() => root?.unmount());
    }
  });

  it("opens the address's Analytics tab once the stats say it is there, and Runs on a server without it", async () => {
    let answer!: (v: unknown) => void;
    let calls = 0;
    // The page's read waits; the tab's own read, once it opens, answers at once.
    const page = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: () => (++calls === 1 ? new Promise((r) => (answer = r)) : Promise.resolve({ analytics: ANALYTICS })) });
    // Waiting for the stats: no other tab's content is read meanwhile.
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
    expect(page.asked).toEqual(["agent invoice-checker"]);
    await act(async () => { answer({ analytics: ANALYTICS }); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Analytics");
    expect(page.host.querySelector('ul[aria-label="Totals"]')).toBeTruthy();
    act(() => root?.unmount());
    const older = await open(agentFixture("invoice-checker"), { tab: "analytics" });
    expect(older.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    expect(older.host.querySelector('ul[aria-label="Runs"]')).toBeTruthy();
  });
});
