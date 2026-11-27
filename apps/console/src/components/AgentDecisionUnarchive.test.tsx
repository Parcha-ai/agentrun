import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";
import { AgentsPage, AgentEditPage } from "./AgentsPage";
import type { Agent } from "@/lib/agentForm";
import type { Client } from "@/lib/client";
import { DECISION_STARTER } from "@/lib/decisionStarter";
import { WORKFLOW_STARTER } from "@/lib/workflowStarter";
import { SERVED_AGENT } from "@/test/agent";
import { pick, picker } from "@/test/picker";

// An agent made with New agent's Decision is a workflow revision on the server (kind "workflow"); the console says Decision
// wherever its workflow is one (isDecisionWorkflow: it decides and runs no agent or code), read from the definition, no
// field stored. An archived agent has a labeled Unarchive on its card in the Archived list and on its page.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const ARCHIVED_AT = "2026-11-26T04:00:00Z";
const agentOf = (id: string, name: string, workflow: object, archived = false): Agent => ({
  ...SERVED_AGENT, agent_id: id, kind: "workflow", revision: "r1", revisions: 1, archived_at: archived ? ARCHIVED_AT : null,
  definition: { version: 1, name, workflow: workflow as Record<string, unknown>, skills: [], tools: [] },
});
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async (element: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  await settle();
  return host;
};
const groupNames = (host: HTMLElement) => [...host.querySelectorAll('[role="group"][aria-labelledby]')].map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent?.trim());
const chips = (el: Element) => [...el.querySelectorAll("span, div")].filter((e) => e.children.length === 0).map((e) => e.textContent?.trim());
const kindOnPage = (host: HTMLElement) => [...host.querySelectorAll("dt")].find((dt) => dt.textContent === "Kind")?.nextElementSibling?.textContent;
const pageV2 = (agent: Agent, extra: Record<string, unknown> = {}) => ({
  getAgent: async () => ({ agent, etag: "r1" }),
  listAgentRuns: async () => ({ runs: [], next_cursor: null }),
  listRevisions: async () => ({ revisions: [], next_cursor: null }),
  validateWorkflow: async () => ({ ok: true, issues: [], warnings: [] }),
  statsOver: async () => ({}),
  ...extra,
});

describe("a decision agent says Decision", () => {
  it("on its page: Kind reads decision for a decision workflow, workflow for another", async () => {
    let host = await mount(createElement(AgentPage, { v2: pageV2(agentOf("gambling-check", "Gambling check", DECISION_STARTER)) as never, agentId: "gambling-check", go: () => {} }));
    expect(kindOnPage(host)).toBe("decision");
    act(() => root?.unmount()); document.body.innerHTML = "";
    host = await mount(createElement(AgentPage, { v2: pageV2(agentOf("steps", "Steps", WORKFLOW_STARTER)) as never, agentId: "steps", go: () => {} }));
    expect(kindOnPage(host)).toBe("workflow");
  });

  it("on its card in the agent list", async () => {
    const v2 = { listAgents: async () => ({ agents: [agentOf("gambling-check", "Gambling check", DECISION_STARTER), agentOf("steps", "Steps", WORKFLOW_STARTER)], next_cursor: null }) };
    const host = await mount(createElement(AgentsPage, { v2: v2 as never, archived: false, go: () => {} }));
    const card = (name: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(name))!;
    expect(chips(card("Gambling check"))).toContain("decision");
    expect(chips(card("Gambling check"))).not.toContain("workflow");
    expect(chips(card("Steps"))).toContain("workflow");
  });

  it("in New agent once Decision is picked: the panel is titled Decision, not Workflow", async () => {
    const host = await mount(createElement(AgentEditPage, {
      v2: { createAgent: vi.fn(), computers: async () => ({ kinds: [] }), toolSettings: async () => ({}) } as unknown as Client, agentId: null, go: vi.fn(),
      caps: { harnesses: [{ id: "pi", available: true }], tools: [], thinking: [], decisionProvider: "jev" },
    }));
    await pick(picker(host, "Agent type")!, "starter:decision");
    expect(groupNames(host)).toContain("Decision");
    expect(groupNames(host)).not.toContain("Workflow");
    await pick(picker(host, "Agent type")!, "starter:workflow");
    expect(groupNames(host)).toContain("Workflow");
  });
});

describe("an archived agent offers Unarchive by name", () => {
  it("on its card in the Archived list, which unarchives it and drops it from the list", async () => {
    const calls: string[] = [];
    let archived = true;
    const one = agentOf("gambling-check", "Gambling check", DECISION_STARTER, true);
    const v2 = {
      listAgents: async ({ archived: wants }: { archived?: boolean }) => ({ agents: wants && archived ? [one] : [], next_cursor: null }),
      unarchiveAgent: async (id: string) => { calls.push(id); archived = false; return { ...one, archived_at: null }; },
    };
    const host = await mount(createElement(AgentsPage, { v2: v2 as never, archived: true, go: () => {} }));
    const button = [...host.querySelectorAll("li button")].find((b) => b.textContent?.trim() === "Unarchive") as HTMLButtonElement | undefined;
    expect(button, "a labeled Unarchive on the archived card").toBeDefined();
    await act(async () => { button!.click(); });
    await settle();
    expect(calls).toEqual(["gambling-check"]);
    expect(host.textContent).not.toContain("Gambling check");
  });

  it("not on an active agent's card", async () => {
    const v2 = { listAgents: async () => ({ agents: [agentOf("steps", "Steps", WORKFLOW_STARTER)], next_cursor: null }) };
    const host = await mount(createElement(AgentsPage, { v2: v2 as never, archived: false, go: () => {} }));
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Unarchive")).toHaveLength(0);
  });

  it("on its page, beside Status: Archived, which unarchives it there", async () => {
    const calls: string[] = [];
    let one = agentOf("gambling-check", "Gambling check", DECISION_STARTER, true);
    const host = await mount(createElement(AgentPage, { v2: pageV2(one, { getAgent: async () => ({ agent: one, etag: "r1" }), unarchiveAgent: async (id: string) => { calls.push(id); one = { ...one, archived_at: null }; return one; } }) as never, agentId: "gambling-check", go: () => {} }));
    const status = () => [...host.querySelectorAll("dt")].find((dt) => dt.textContent === "Status")?.nextElementSibling?.textContent;
    expect(status()).toBe("Archived");
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Unarchive") as HTMLButtonElement | undefined;
    expect(button, "a labeled Unarchive on the archived agent's page").toBeDefined();
    await act(async () => { button!.click(); });
    await settle();
    expect(calls).toEqual(["gambling-check"]);
    expect(status()).toBe("Active");
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Unarchive")).toHaveLength(0);
  });
});
