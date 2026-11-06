import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning } from "@/lib/learning";
import type { AgentTool } from "@/lib/v2";

// An agent's page lists the tools its current revision grants, among its facts, each as GET /v2/agents/{id} serves it
// (serve's agentTools: the provider and permission in force, the agent's own setting over the server's): its name, then
// its provider where it has a choice of one, then its permission. An agentic agent with none says so; a workflow's tools
// are its call nodes', which its editor shows, so it has no Tools fact.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const WEB_FETCH: AgentTool = { name: "web_fetch", blurb: "Read a public web page", permission: "ask", permission_from: "agent", default_permission: "allow", permissions: ["allow", "ask", "deny"], provider: "parallel", provider_from: "agent", default_provider: "kernel", resolved: "parallel" };
const BASH: AgentTool = { name: "bash", blurb: "Run shell commands", permission: "allow", permission_from: "default", default_permission: "allow", permissions: ["allow", "ask", "deny"] };

async function open(agent: Agent) {
  const v2 = {
    getAgent: async () => ({ agent, etag: null }),
    listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    statsOver: async () => { throw new Error("no stats here"); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, go: () => {} })));
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const facts = host.querySelector('dl[aria-label="Current revision"]')!;
  const dd = [...facts.querySelectorAll("dt")].find((t) => t.textContent === "Tools")?.nextElementSibling ?? null;
  return { dd };
}

const EMPTY: AgentLearning = { agent: "invoice-checker", main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 } };

describe("AgentPage, the agent's tools", () => {
  it("lists each granted tool with its provider (where it has one) and its permission", async () => {
    const { dd } = await open({ ...agentFixture("invoice-checker"), tools: [WEB_FETCH, BASH] });
    expect(dd).not.toBeNull();
    const items = [...dd!.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["web_fetch · Parallel · ask", "bash · allow"]);
    // The tool's line for people is its name's title.
    expect([...dd!.querySelectorAll("li")][0]!.querySelector("[title]")!.getAttribute("title")).toBe("Read a public web page");
  });
  it("an agentic agent with none says so", async () => {
    const { dd } = await open({ ...agentFixture("meeting-notes"), tools: [] });
    expect(dd?.textContent).toBe("none");
  });
  it("after a save on the page (the Learning switch), still lists them: the agent is read again, never taken from the save's answer", async () => {
    // The definition save (PUT) answers the agent without `tools`, which only GET /v2/agents/{id} serves.
    let current: Agent = { ...agentFixture("invoice-checker"), tools: [WEB_FETCH, BASH] };
    const reads: string[] = [];
    const v2 = {
      getAgent: async () => { reads.push("agent"); return { agent: current, etag: '"r1"' }; },
      listAgentRuns: async () => ({ runs: [], next_cursor: null }),
      statsOver: async () => { throw new Error("no stats here"); },
      agentLearning: async () => EMPTY,
      updateDefinition: async (_id: string, body: { definition: Agent["definition"] }) => {
        const { tools: _served, ...saved } = { ...current, revision: "r2", revisions: current.revisions + 1, definition: body.definition };
        current = { ...saved, tools: [WEB_FETCH, BASH] };
        return { agent: saved, etag: '"r2"' };
      },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: current.agent_id, go: () => {}, tab: "learning", learning: "on" })));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const facts = host.querySelector('dl[aria-label="Current revision"]')!;
    const dd = [...facts.querySelectorAll("dt")].find((t) => t.textContent === "Tools")!.nextElementSibling!;
    expect([...dd.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["web_fetch · Parallel · ask", "bash · allow"]);
    // The page's own read, the switch's read before its save, and the page's read again after it.
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it("a save whose re-read fails shows the saved setting at once, says the page couldn't refresh, and Retry reads it again", async () => {
    // The page's read and the switch's read before its save answer; the read after the save fails; Retry's answers.
    let current: Agent = { ...agentFixture("invoice-checker"), tools: [WEB_FETCH, BASH] };
    let reads = 0;
    const v2 = {
      getAgent: async () => { if (++reads === 3) throw new Error("the network went away"); return { agent: current, etag: '"r1"' }; },
      listAgentRuns: async () => ({ runs: [], next_cursor: null }),
      statsOver: async () => { throw new Error("no stats here"); },
      agentLearning: async () => EMPTY,
      updateDefinition: async (_id: string, body: { definition: Agent["definition"] }) => {
        const { tools: _served, ...saved } = { ...current, revision: "r2", revisions: current.revisions + 1, definition: body.definition };
        // What the server serves once the save is in: here its tools as Retry will read them.
        current = { ...saved, tools: [BASH] };
        return { agent: saved, etag: '"r2"' };
      },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: current.agent_id, go: () => {}, tab: "learning", learning: "on" })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    const toolsShown = () => {
      const facts = host.querySelector('dl[aria-label="Current revision"]')!;
      return [...[...facts.querySelectorAll("dt")].find((t) => t.textContent === "Tools")!.nextElementSibling!.querySelectorAll("li")].map((li) => li.textContent);
    };
    expect(host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    // The save went in: its setting shows, and the tools shown before stay until a read brings the server's.
    expect(host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(toolsShown()).toEqual(["web_fetch · Parallel · ask", "bash · allow"]);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't refresh this agent.");
    const retry = [...alert!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry")!;
    await act(async () => { retry.click(); });
    await settle();
    expect(toolsShown()).toEqual(["bash · allow"]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a workflow has no Tools fact", async () => {
    const { dd } = await open({ ...agentFixture("lead-scorer"), tools: [] });
    expect(dd).toBeNull();
  });
});
