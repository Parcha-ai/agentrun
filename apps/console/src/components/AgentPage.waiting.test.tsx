import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning, LearnedItem, LearningNote } from "@/lib/learning";

// The agent page's Learning tab carries a count when learned items wait for the owner's OK (a risky note, a held skill or
// workflow), so the wait is seen without opening the tab or finding the run that kept it. The page reads it with its
// agent: one read of GET .../learning (its notes' first page, and every skill and workflow), and only when the notes run
// past that page, GET .../learning/notes?status=pending for their total.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent: Agent = { agent_id: "qa-learn", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "QA learn", instructions: "Answer.", harness: "pi", skills: [], tools: [], learning: true } } as Agent;
const note = (file: string, status: LearningNote["status"]): LearningNote => ({ file, name: file, description: "d", type: "feedback", status, superseded_by: null, text: "" });
const item = (name: string, status: LearnedItem["status"]): LearnedItem => ({ name, file: `skills/${name}/SKILL.md`, description: "d", status, run: null, bytes: 1, etag: '"e"' });
const view = (notes: LearningNote[], skills: LearnedItem[] = [], workflows: LearnedItem[] = [], next: string | null = null): AgentLearning => ({
  agent: "qa-learn", main: "c1", index: "", notes: { items: notes, total: notes.length, next_cursor: next }, skills, workflows, log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 },
} as AgentLearning);

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(learning: AgentLearning, pendingTotal = 0) {
  const asked: string[] = [];
  const v2 = {
    getAgent: async () => ({ agent, etag: null }),
    listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    statsOver: async () => ({}),
    agentLearning: async () => { asked.push("learning"); return learning; },
    pendingNotes: async () => { asked.push("pending notes"); return { items: [], total: pendingTotal, next_cursor: null }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: "qa-learn", go: () => {}, tab: "runs", learning: "on" } as never)));
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const tab = () => [...host.querySelectorAll('[role="tab"]')].find((t) => /learning/i.test(t.textContent ?? "")) as HTMLElement;
  const badge = () => tab().querySelector("[aria-label$='wait for your OK'], [aria-label$='waits for your OK']");
  return { asked, tab, badge };
}

describe("AgentPage, learned items waiting for the owner's OK", () => {
  it("counts a pending note, a pending skill and a pending workflow on the Learning tab, in one read", async () => {
    const p = await open(view([note("a.md", "active"), note("b.md", "pending")], [item("find", "pending"), item("old", "active")], [item("flow", "pending")]));
    expect(p.badge()?.textContent).toBe("3");
    expect(p.badge()?.getAttribute("aria-label")).toBe("3 learned items wait for your OK");
    expect(p.asked).toEqual(["learning"]);
  });

  it("says one item in the singular", async () => {
    const p = await open(view([note("b.md", "pending")]));
    expect(p.badge()?.getAttribute("aria-label")).toBe("1 learned item waits for your OK");
  });

  it("shows no count when nothing waits", async () => {
    const p = await open(view([note("a.md", "active")], [item("find", "active")]));
    expect(p.badge()).toBeNull();
    expect(p.tab().textContent).toBe("Learning");
  });

  it("takes the notes' served total when the notes run past the first page", async () => {
    const p = await open(view([note("a.md", "active")], [item("find", "pending")], [], "c2"), 4);
    expect(p.asked).toEqual(["learning", "pending notes"]);
    expect(p.badge()?.textContent).toBe("5");
  });
});
