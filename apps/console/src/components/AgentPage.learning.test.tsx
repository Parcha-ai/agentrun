import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning } from "@/lib/learning";
import type { Run, TimelinePage } from "@/lib/v2";

// The agent page's Learning tab: shown for an agentic agent on a server with learning, at its own address; a run row
// says what the run read and kept.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (kind: Agent["kind"] = "agentic"): Agent => ({
  agent_id: "refunds", kind, revision: "r1", revisions: 1, archived_at: null,
  definition: kind === "agentic" ? { version: 1, name: "Refunds", instructions: "Find it.", harness: "pi", skills: [], tools: ["read", "write"] } : { version: 1, name: "Flow", skills: [], tools: [], workflow: { version: 1, root: { kind: "agent", id: "a", task: "t" } } },
});
const run: Run = {
  run_id: "run-b", agent_id: "refunds", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T16:52:00Z", ended_at: "2026-11-03T16:52:04Z", result: null, error: null, cost: null, archived_at: null,
  learning: { state: "merged", reason: null, used: [{ file: "a.md", name: "Shopify refund policy path" }], learned: [{ file: "b.md", name: "Try it first", supersedes: ["a.md"] }] },
};
const EMPTY: AgentLearning = { agent: "refunds", main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 } };
const ended: TimelinePage = { run_id: "run-b", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(a: Agent, props: { tab?: string; learning?: "on" | "off" | null; notes?: string[] } = {}, listed: Run = run, reread: () => Run = () => run) {
  let current = a;
  let reads = 0;
  const v2 = {
    getAgent: async () => ({ agent: current, etag: '"r1"' }),
    statsOver: async () => ({}),
    listAgentRuns: async () => ({ runs: [listed], next_cursor: null }),
    getTimeline: async () => ended,
    getRun: async () => { reads++; return reread(); },
    agentLearning: async () => EMPTY,
    updateDefinition: async (_id: string, body: { definition: Agent["definition"] }) => { current = { ...current, revision: "r2", revisions: 2, definition: body.definition }; return { agent: current, etag: '"r2"' }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = (p: typeof props) => act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: a.agent_id, go: () => {}, ...p })));
  render(props);
  await settle();
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  return { host, tabs, render, reads: () => reads, text: () => host.textContent ?? "" };
}

describe("AgentPage's Learning tab", () => {
  it("is a tab of an agentic agent on a server with learning, on or off", async () => {
    for (const learning of ["on", "off"] as const) {
      const p = await open(agent(), { learning });
      expect(p.tabs()).toEqual(["Runs", "Learning"]);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
  it("is not a tab on a server without learning, nor of a workflow agent", async () => {
    expect((await open(agent(), { learning: null })).tabs()).toEqual(["Runs"]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect((await open(agent("workflow"), { learning: "on" })).tabs()).toEqual(["Runs", "Workflow"]);
  });
  it("at its address, opens before the server's capabilities are read, and stays once they say it learns", async () => {
    const p = await open(agent(), { tab: "learning" });
    expect(p.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Learning");
    expect(p.text()).toContain("Let it learn from its runs");
    p.render({ tab: "learning", learning: "on" });
    await settle();
    expect(p.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Learning");
  });
  it("elsewhere, the tab waits for the capabilities: none before them, and none once they say the server has no learning", async () => {
    const p = await open(agent());
    expect(p.tabs()).toEqual(["Runs"]);
    p.render({ learning: null, tab: "learning" });
    await settle();
    expect(p.tabs()).toEqual(["Runs"]);
  });
  it("the switch on the tab makes a revision, and the page's header follows it", async () => {
    const p = await open(agent(), { tab: "learning", learning: "on" });
    expect(p.text()).toContain("rev 1 of 1");
    await act(async () => { (p.host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    expect(p.text()).toContain("rev 2 of 2");
    expect(p.host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(p.text()).toContain("Nothing learned yet");
  });
  it("on the Runs tab, a run's row says what it read and kept", async () => {
    const p = await open(agent(), { learning: "on" });
    const row = p.host.querySelector('ul[aria-label="Runs"] a')!;
    expect(row.textContent).toContain("Used 1 note");
    expect(row.textContent).toContain("Learned 1 note");
  });
  it("an ended latest run whose learning is still deciding is read again until it settles: its row then says what it kept", async () => {
    const deciding: Run = { ...run, learning: { state: "reflecting", reason: null } };
    let n = 0;
    // Each read is the server's answer, a new record every time, as the client parses it.
    const p = await open(agent(), { learning: "on" }, deciding, () => (++n < 2 ? { ...deciding } : { ...run }));
    const row = () => p.host.querySelector('ul[aria-label="Runs"] a')!.textContent ?? "";
    expect(row()).toContain("Looking back");
    for (let i = 0; i < 400 && !row().includes("Learned 1 note"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(row()).toContain("Learned 1 note");
    expect(p.host.querySelector('section[aria-label="Latest run"]')!.querySelector('a[href^="#/agents/refunds/learning?note="]')).not.toBeNull();
    const settled = p.reads();
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    expect(p.reads()).toBe(settled);
  }, 15_000);
});
