import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning, LearningNote } from "@/lib/learning";

// The agent page's Learning tab carries a count when learned items wait for the owner's OK (a risky note, a held skill or
// workflow draft), so the wait is seen without opening the tab or finding the run that kept it. The count is the agent's
// own `learning.pending` (GET /v2/agents/{id}): no read of what it learned for it. Absent (an agent that doesn't learn, a
// server with learning off or an older one, a count that could not be read) or 0: no count, never "0".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentWith = (learning?: { pending: number }): Agent => ({ agent_id: "qa-learn", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "QA learn", instructions: "Answer.", harness: "pi", skills: [], tools: [], learning: true }, ...(learning ? { learning } : {}) } as Agent);
const TRUST = "trust-acme.md";
const waiting: LearningNote = { file: TRUST, name: "Trust acme.com", description: "d", type: "feedback", status: "pending", superseded_by: null, text: "---\nname: Trust acme.com\ndescription: d\ntype: feedback\n---\nTrust it.\n", etag: '"card-trust"' } as LearningNote;
const view = (notes: LearningNote[]): AgentLearning => ({
  agent: "qa-learn", main: "c1", index: "", notes: { items: notes, total: notes.length, next_cursor: null }, skills: [], workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 },
} as AgentLearning);

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** The page over a fake server: `agents` are what each GET /v2/agents/{id} answers, in turn (the last one stays). */
async function open(agents: Agent[], opened = "runs") {
  const asked: string[] = [];
  let approved = false;
  const v2 = {
    getAgent: async () => { asked.push("agent"); return { agent: agents.length > 1 ? agents.shift()! : agents[0], etag: null }; },
    listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    statsOver: async () => ({}),
    capabilities: async () => ({ learning: { pending: true, approve: true } }),
    agentLearning: async () => { asked.push("learning"); return view(approved ? [] : [waiting]); },
    approveNote: async () => { asked.push("approve"); approved = true; return { note: "", etag: '"v2"' }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: "qa-learn", go: () => {}, tab: opened, learning: "on" } as never)));
  await settle();
  const tab = () => [...host.querySelectorAll('[role="tab"]')].find((t) => /learning/i.test(t.textContent ?? "")) as HTMLElement;
  const badge = () => tab().querySelector("[aria-label$='wait for your OK'], [aria-label$='waits for your OK']");
  const click = async (label: string) => { const b = host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null; expect(b, label).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  return { asked, tab, badge, click };
}

describe("AgentPage, learned items waiting for the owner's OK", () => {
  it("counts them on the Learning tab from the agent's own learning.pending, with no read of what it learned", async () => {
    const p = await open([agentWith({ pending: 3 })]);
    expect(p.badge()?.textContent).toBe("3");
    expect(p.badge()?.getAttribute("aria-label")).toBe("3 learned items wait for your OK");
    expect(p.asked).toEqual(["agent"]);
  });

  it("says one item in the singular", async () => {
    const p = await open([agentWith({ pending: 1 })]);
    expect(p.badge()?.getAttribute("aria-label")).toBe("1 learned item waits for your OK");
  });

  it("shows no count at 0, nor when the server leaves the field out", async () => {
    for (const a of [agentWith({ pending: 0 }), agentWith()]) {
      const p = await open([a]);
      expect(p.badge()).toBeNull();
      expect(p.tab().textContent).toBe("Learning");
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("on the Learning tab, an approve reads the agent again, and the count goes with what it says", async () => {
    const p = await open([agentWith({ pending: 1 }), agentWith({ pending: 0 })], "learning");
    expect(p.badge()?.textContent).toBe("1");
    await p.click("Approve Trust acme.com");
    expect(p.asked.filter((x) => x === "agent")).toHaveLength(2);
    expect(p.asked.indexOf("approve")).toBeLessThan(p.asked.lastIndexOf("agent"));
    expect(p.badge()).toBeNull();
  });
});
