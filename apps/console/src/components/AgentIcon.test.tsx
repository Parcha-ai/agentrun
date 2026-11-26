import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { AgentCardFrame } from "./AgentCard";
import { agentHarness, HarnessIcon } from "./HarnessIcon";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";

// An agent's icon is its runtime's, the same on its card in the list and in its page's top bar: one rule, agentHarness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const mount = (el: React.ReactElement) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
const with_ = (agent: Agent, over: Partial<Agent["definition"]>, kind: Agent["kind"] = agent.kind): Agent => ({ ...agent, kind, definition: { ...agent.definition, ...over } });
// What an icon draws, as a comparable mark: its image's source, else its lucide class.
const mark = (el: Element | null) => el?.querySelector("img")?.getAttribute("src") ?? el?.querySelector("svg")?.getAttribute("class")?.split(" ").find((c) => c.startsWith("lucide-")) ?? null;

describe("an agent's icon", () => {
  const base = agentFixture("invoice-checker");
  it("is its workflow's, else its runtime's, else its harness's, else pi's", () => {
    expect(agentHarness(with_(base, {}, "workflow"))).toBe("workflow");
    expect(agentHarness(with_(base, { harness: "codex" }))).toBe("codex");
    expect(agentHarness(with_(base, { harness: undefined }))).toBe("pi");
    expect(agentHarness(with_(base, { harness: "pi", native: { ...(base.definition.native ?? {}), runtime: "claude-code" } as never }))).toBe("claude-code");
  });
  for (const harness of ["pi", "codex", "claude-code"]) {
    it(`is the same on the list's card and the page's top bar for a ${harness} agent`, async () => {
      const agent = with_(base, { harness });
      const card = mount(createElement("ul", null, createElement(AgentCardFrame, { name: agent.definition.name, icon: (() => null) as never, harness: agentHarness(agent) })));
      const onCard = mark(card.querySelector("[data-agent-card-icon]"));
      act(() => root?.unmount());
      const v2 = { getAgent: async () => ({ agent }), statsOver: async () => { throw new Error("no stats"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }) };
      const page = mount(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, efforts: ["low", "high"], go: () => {} }));
      for (let i = 0; i < 100 && !page.querySelector("[data-agent-icon]"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      const onPage = mark(page.querySelector("[data-agent-icon]"));
      expect(onCard, harness).not.toBeNull();
      expect(onPage, harness).toBe(onCard);
      expect(onPage, harness).toBe(mark(mount(createElement("span", null, createElement(HarnessIcon, { harness })))));
    });
  }
});
