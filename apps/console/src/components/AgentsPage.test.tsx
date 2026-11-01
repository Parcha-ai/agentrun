import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditPage } from "./AgentsPage";
import { ClientError } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";

// The agent page keeps what it shows true to the server: an action's committed write is never reported as failed, a
// revision another tab saved is never hidden under an old form, and a failed reload never takes the editor away.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentAt = (revision: string, instructions: string, archived = false): Agent => ({
  agent_id: "calc", kind: "agentic", revision, revisions: revision === "r1" ? 1 : 2, archived_at: archived ? "2026-10-30T05:00:00Z" : null,
  definition: { version: revision === "r1" ? 1 : 2, name: "Calc", instructions, harness: "pi", skills: [], tools: [] },
});
const caps = { harnesses: [{ id: "pi", available: true }], tools: [], thinking: ["low"] };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: Record<string, unknown>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditPage, { v2: v2 as never, caps: caps as never, agentId: "calc", go: () => {} })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  return { host, click, button, settle };
}

describe("AgentEditPage", () => {
  it("an archive whose page refresh fails still reads as done, from the write's own answer", async () => {
    const v2 = {
      getAgent: (() => { let n = 0; return async () => { if (++n > 1) throw new ClientError(503, "store_busy", "the store is busy", true); return { agent: agentAt("r1", "Answer."), etag: "r1" }; }; })(),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      archiveAgent: async () => agentAt("r1", "Answer.", true),
    };
    const page = await open(v2);
    await page.click(/^Archive$/);
    expect(page.button(/^Unarchive$/)).toBeTruthy();
    expect(page.host.textContent).not.toContain("did not finish");
    expect(page.host.textContent).toContain("Archive done");
  });

  it("a revision saved elsewhere since the form opened replaces the form, and says so, never hides under it", async () => {
    let reads = 0;
    const v2 = {
      getAgent: async () => (++reads === 1 ? { agent: agentAt("r1", "Answer."), etag: "r1" } : { agent: agentAt("r2", "Answer in one word."), etag: "r2" }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      archiveAgent: async () => agentAt("r2", "Answer in one word.", true),
    };
    const page = await open(v2);
    await page.click(/^Archive$/);
    expect((page.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Answer in one word.");
    expect(page.host.textContent).toContain("changed since you opened it");
  });

  it("a reload that fails keeps the editor, its form and a way to try again", async () => {
    let reads = 0;
    const v2 = {
      getAgent: async () => { if (++reads > 1) throw new ClientError(503, "store_busy", "the store is busy", true); return { agent: agentAt("r1", "Answer."), etag: "r1" }; },
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      updateDefinition: async () => { throw new ClientError(412, "precondition_failed", "the agent changed"); },
    };
    const page = await open(v2);
    const box = page.host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Answer twice."); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.click(/Save revision/i);
    await page.click(/^Reload$/);
    expect(page.host.querySelector("textarea")).toBeTruthy();
    expect(page.button(/^Reload$/)).toBeTruthy();
    expect(page.host.textContent).toContain("could not be reloaded");
  });
});

describe("AgentEditPage, a new decision agent", () => {
  /** Create a decision agent named "Gambling check" on a server whose decision provider is `provider`: what was sent,
   *  where the page went, and the page and host to look at after. */
  async function createDecision(provider: string) {
    const { DECISION_STARTER } = await import("@/lib/decisionStarter");
    const made: Agent = { agent_id: "gambling-check", kind: "workflow", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Gambling check", workflow: DECISION_STARTER, skills: [], tools: [] } };
    let sent: { definition: Record<string, unknown> } | undefined;
    let went: string | undefined;
    const v2 = {
      createAgent: async (body: { definition: Record<string, unknown> }) => { sent = body; return made; },
      getAgent: async () => ({ agent: made, etag: "r1" }),
      listRevisions: async () => ({ revisions: [{ revision: "r1", version: 1, current: true, note: null, created_at: "2026-11-01T00:00:00Z" }], next_cursor: null }),
      validateWorkflow: async () => ({ ok: true, issues: [], warnings: [] }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const page = (agentId: string | null) => createElement(AgentEditPage, { v2: v2 as never, caps: { ...caps, decisionProvider: provider } as never, agentId, go: (hash: string) => { went = hash; } });
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
    act(() => root!.render(page(null)));
    await act(async () => { button(/Settings/)!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=radio][value="decision"]')!.click(); });
    await act(async () => { button(/Context/)!.click(); });
    await act(async () => {
      const name = host.querySelector<HTMLInputElement>('input[placeholder="e.g., Invoice checker"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Gambling check");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button(/^Create$/)!.click(); });
    await settle();
    return { DECISION_STARTER, sent, went, host, page, settle };
  }

  it("creates a workflow agent from the starter decision workflow, with no harness, and opens it on its Workflow step", async () => {
    const { DECISION_STARTER, sent, went, host, page, settle } = await createDecision("jev");
    expect(sent?.definition).toEqual({ version: 1, name: "Gambling check", workflow: DECISION_STARTER, skills: [], tools: [] });
    expect(went).toBe("#/agents/gambling-check");
    // The page the create went to: the new workflow agent, opened on its Workflow step.
    act(() => root!.render(page("gambling-check")));
    await settle();
    expect(host.querySelector('button[aria-current="step"]')?.textContent).toMatch(/Workflow/);
  });

  it("on a server whose decision provider is Parallel, sends a starter whose judge names parallel", async () => {
    const { sent } = await createDecision("parallel");
    expect((sent?.definition.workflow as { root: { steps: Record<string, unknown>[] } }).root.steps[0]).toMatchObject({ node: "judge", provider: "parallel" });
  });
});
