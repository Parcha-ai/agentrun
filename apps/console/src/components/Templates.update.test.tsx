import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./Templates";
import { agentHash } from "./AgentPage";
import type { TemplateView } from "@/lib/v2";

// A template that already made an agent here offers "Update <agent>" beside Apply: it applies the template onto that
// agent (agent_id), a new revision of it with its runs, notes and triggers kept, in place of a second agent.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
const base: TemplateView = {
  id: "notes/daily", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "notes/daily", display_name: "Daily notes", version: "1.1.0", description: "Writes the day's notes.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  mcp: [],
  parameters: { type: "object", additionalProperties: false, properties: { topic: { type: "string", description: "Topic" } } },
};
const agentOf = (id: string, name: string, template: string | null) => ({ agent_id: id, definition: { name }, template: template ? { id: template, version: "1.0.0", sha: null } : null });

const applyTemplate = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ agent_id: body.agent_id ?? "made-1", trigger_ids: [], warnings: [] }));
const go = vi.fn();
const client = (agents: ReturnType<typeof agentOf>[]) =>
  ({ listTemplates: async () => ({ templates: [base] }), listMcpServers: async () => ({ servers: [] }), listAgents: async (_q?: { cursor?: string | null }) => ({ agents, next_cursor: null as string | null }), applyTemplate });
async function mount(v2: ReturnType<typeof client>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(TemplatesPage, { v2: v2 as never, name: base.id, go })));
  return host;
}
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; applyTemplate.mockClear(); go.mockClear(); });
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("a template that already made an agent here", () => {
  it("offers Update <agent> beside Apply, which applies onto that agent with its agent_id and opens it", async () => {
    const host = await mount(client([agentOf("notes-1", "Morning notes", base.id), agentOf("plain", "Plain", null), agentOf("else", "Else", "other/one")]));
    const update = button(host, "Update Morning notes");
    expect(update).toBeDefined();
    expect(button(host, "Apply")).toBeDefined();
    expect(button(host, "Update Plain")).toBeUndefined();
    expect(button(host, "Update Else")).toBeUndefined();
    await act(async () => update!.click());
    expect(applyTemplate).toHaveBeenCalledTimes(1);
    expect(applyTemplate.mock.calls[0]?.[0]).toBe(base.id);
    expect(applyTemplate.mock.calls[0]?.[1]).toEqual({ parameters: {}, overrides: { approvals: "ask" }, agent_id: "notes-1" });
    expect(go).toHaveBeenCalledWith(agentHash("notes-1"));
  });

  it("offers Update for an agent it made however far down the agent list it is, past twenty pages", async () => {
    const pages = 25;
    const listAgents = vi.fn(async ({ cursor }: { cursor?: string | null } = {}) => {
      const page = cursor ? Number(cursor) : 0;
      const agents = page === pages - 1 ? [agentOf("notes-old", "Old notes", base.id)] : [agentOf(`plain-${page}`, `Plain ${page}`, null)];
      return { agents, next_cursor: page < pages - 1 ? String(page + 1) : null };
    });
    const host = await mount({ ...client([]), listAgents });
    expect(button(host, "Update Old notes")).toBeDefined();
    expect(listAgents).toHaveBeenCalledTimes(pages);
  });

  it("offers no Update when no agent here was made from it, and Apply sends no agent_id", async () => {
    const host = await mount(client([agentOf("plain", "Plain", null)]));
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim().startsWith("Update "))).toBe(false);
    await act(async () => button(host, "Apply")!.click());
    expect(applyTemplate.mock.calls[0]?.[1]).toEqual({ parameters: {}, overrides: { approvals: "ask" } });
  });
});
