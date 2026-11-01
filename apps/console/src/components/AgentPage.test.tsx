import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, archivedAgents, editorCaps, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import type { Run } from "@/lib/v2";

// An agent's own page: its current revision's settings in the header, its runs, and a workflow agent's graph, read-only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runsOf = (slug: string) => recorded<{ runs: Run[] }>(`agent.${slug}.runs`).body.runs;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(agent: Agent, runs: Run[] = runsOf("invoice-checker"), next: string | null = null, more?: () => Promise<{ runs: Run[]; next_cursor: string | null }>) {
  const went: string[] = [];
  const asked: string[] = [];
  const v2 = {
    getAgent: async (id: string) => { asked.push(`agent ${id}`); return { agent, etag: null }; },
    listAgentRuns: async (id: string, _limit: number, cursor?: string | null) => { asked.push(`runs ${id}${cursor ? ` after ${cursor}` : ""}`); return cursor && more ? more() : { runs, next_cursor: next }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, defaultModel: editorCaps.defaultModel, go: (h: string) => went.push(h) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((t) => t.textContent === name)?.nextElementSibling?.textContent;
  return { host, went, asked, click, button, tabs, fact };
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
    const page = await open(agentFixture("invoice-checker"), [...runs.slice(0, -1), unknown]);
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
    const page = await open(agentFixture("invoice-checker"), []);
    expect(page.host.textContent).toContain("No runs of this agent yet.");
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
  });

  it("reads the next page with Load more, and a failed one keeps the runs already read", async () => {
    const runs = runsOf("invoice-checker");
    let fail = true;
    const page = await open(agentFixture("invoice-checker"), runs.slice(0, 5), "c2", async () => {
      if (fail) throw new Error("the network went away");
      return { runs: runs.slice(5), next_cursor: null };
    });
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

  it("has a Workflow tab only for a workflow agent, and draws its graph read-only with a way to the editor", async () => {
    const page = await open(agentFixture("support-triage"), runsOf("support-triage"));
    expect(page.tabs()).toEqual(["Runs", "Workflow"]);
    // A workflow revision has no harness, model or thinking of its own.
    expect(page.fact("Harness")).toBeUndefined();
    await page.click(/^Workflow$/);
    expect(page.host.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("The workflow's graph");
    expect(page.host.querySelectorAll("textarea, input, select, [contenteditable]").length).toBe(0);
    await page.click(/Edit the workflow/);
    expect(page.went).toEqual(["#/agents/support-triage/edit"]);
  });

  it("shows an archived agent as archived, and goes back to the archived agents", async () => {
    const page = await open(archivedAgents()[0], []);
    expect([...page.host.querySelectorAll("header span")].some((s) => s.textContent === "Archived")).toBe(true);
    await page.click(/^Agents$/);
    expect(page.went).toEqual(["#/agents?archived=true"]);
  });
});
