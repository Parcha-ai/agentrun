import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsPage } from "./AgentsPage";
import type { Agent } from "@/lib/agentForm";
import { servedAgent } from "@/test/agent";

// An agent's card in the Agents list carries the same count as its page's Learning tab, from the list's own read
// (GET /v2/agents, each agent's `learning.pending`), and takes you to that tab. Absent or 0: nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, learning?: { pending: number }): Agent => servedAgent({ agent_id: id, kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name, instructions: "Answer.", harness: "pi", skills: [], tools: [], learning: true }, ...(learning ? { learning } : {}) });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(agents: Agent[]) {
  const went: string[] = [];
  const asked: string[] = [];
  const v2 = { listAgents: async () => { asked.push("agents"); return { agents, next_cursor: null }; } };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentsPage, { v2: v2 as never, archived: false, go: (h: string) => went.push(h) })));
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const card = (name: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(name)) as HTMLElement;
  const count = (name: string) => card(name).querySelector("[aria-label$='wait for your OK'], [aria-label$='waits for your OK']") as HTMLElement | null;
  return { went, asked, card, count };
}

describe("AgentsList, learned items waiting for the owner's OK", () => {
  it("counts them on the agent's card, in the list's own read, and the count opens its Learning tab", async () => {
    const p = await open([agent("qa-learn", "QA learn", { pending: 2 }), agent("calc", "Calc", { pending: 1 })]);
    expect(p.asked).toEqual(["agents"]);
    expect(p.count("QA learn")?.getAttribute("aria-label")).toBe("2 learned items wait for your OK");
    expect(p.count("QA learn")?.textContent).toContain("2");
    expect(p.count("Calc")?.getAttribute("aria-label")).toBe("1 learned item waits for your OK");
    await act(async () => { p.count("QA learn")!.click(); });
    expect(p.went).toEqual(["#/agents/qa-learn/learning"]);
  });

  it("shows nothing at 0, nor when the server leaves the field out", async () => {
    const p = await open([agent("zero", "Zero", { pending: 0 }), agent("off", "Learning off")]);
    expect(p.count("Zero")).toBeNull();
    expect(p.count("Learning off")).toBeNull();
    expect(p.card("Zero").textContent).not.toMatch(/\b0\b.*OK|Learning 0/);
  });
});
