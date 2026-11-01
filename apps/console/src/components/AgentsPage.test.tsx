import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditPage, AgentsPage } from "./AgentsPage";
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

describe("AgentsPage, where an agent's card goes", () => {
  it("opens the agent's page from its card and its History icon, and the editor from its Edit icon", async () => {
    const went: string[] = [];
    const v2 = { listAgents: async () => ({ agents: [agentAt("r1", "Answer.")], next_cursor: null }) };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentsPage, { v2: v2 as never, archived: false, go: (h: string) => went.push(h) })));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
    click([...host.querySelectorAll("li button")].find((b) => b.textContent?.includes("Calc") && !b.getAttribute("aria-label")));
    click(host.querySelector('[aria-label="Edit Calc"]'));
    click(host.querySelector('[aria-label="Runs of Calc"]'));
    expect(went).toEqual(["#/agents/calc", "#/agents/calc/edit", "#/agents/calc"]);
  });
});

describe("AgentEditPage, a new agent", () => {
  it("lands on the new agent's page once it is created", async () => {
    const went: string[] = [];
    const v2 = { createAgent: async () => agentAt("r1", "Answer.") };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: v2 as never, caps: caps as never, agentId: null, go: (h: string) => went.push(h) })));
    const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type(host.querySelector('input[placeholder="e.g., Invoice checker"]') as HTMLInputElement, "Calc");
    type(host.querySelector("textarea") as HTMLTextAreaElement, "Answer.");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Create")!.click(); });
    expect(went).toEqual(["#/agents/calc"]);
  });
});
