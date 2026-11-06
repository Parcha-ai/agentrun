import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
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
  it("a workflow has no Tools fact", async () => {
    const { dd } = await open({ ...agentFixture("lead-scorer"), tools: [] });
    expect(dd).toBeNull();
  });
});
