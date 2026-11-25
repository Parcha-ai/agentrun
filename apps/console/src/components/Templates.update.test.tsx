import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./Templates";
import { agentHash } from "./AgentPage";
import type { TemplateView, Trigger } from "@/lib/v2";

// A template that already made an agent here offers "Update <agent>" beside Apply: it applies the template onto that
// agent (agent_id), a new revision of it with its runs, notes and triggers kept, in place of a second agent.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
const base: TemplateView = {
  workflow: null,
  id: "notes/daily", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "notes/daily", display_name: "Daily notes", version: "1.1.0", description: "Writes the day's notes.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, needs: null, computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  mcp: [],
  parameters: { type: "object", additionalProperties: false, properties: { topic: { type: "string", description: "Topic" } } },
};
const agentOf = (id: string, name: string, template: string | null) => ({ agent_id: id, definition: { name }, template: template ? { id: template, version: "1.0.0", sha: null } : null });

/** What the server answers an apply of `body` about its agent: an Update (agent_id) wrote revision `rev` of it, an Apply
 *  made one (rev 1). */
const answerOf = (body: { agent_id?: string }, rev = 2) => body.agent_id ? { agent_id: body.agent_id, revision_version: rev, agent_change: "updated" } : { agent_id: "made-1", revision_version: 1, agent_change: "made" };
const applyTemplate = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ ...answerOf(body), triggers: [], warnings: [] }));
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

  // An apply with warnings shows its result. The words say what it did, as its answer says it (agent_change and
  // revision_version): an Update updated the agent to the revision it wrote, never "made"; only an Apply, which made a
  // new agent, says made. Nothing is read back for them.
  const warned = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ ...answerOf(body), triggers: [], warnings: [{ field: "computer", message: "No shell here." }] }));
  const result = (host: HTMLElement) => host.querySelector('section[aria-label="Applied"]')?.textContent ?? "";
  it("an Update with warnings says it updated the agent and the revision it wrote, from its answer, never that the agent is made", async () => {
    const getAgent = vi.fn();
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: warned, getAgent } as never);
    await act(async () => button(host, "Update Morning notes")!.click());
    expect(host.querySelector("h1")?.textContent).toContain("Daily notes updated");
    expect(result(host)).toContain("rev 2");
    expect(result(host)).not.toContain("made");
    expect(result(host)).not.toContain("applied");
    expect(getAgent).not.toHaveBeenCalled();
  });
  it("an Update with no warnings but a schedule to show says Updated with its revision above the schedule", async () => {
    const schedule: Trigger = {
      id: "trg_d", name: "daily", enabled: true, source: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      target: { kind: "start_run", agent_id: "notes-1", input: { content: "Write the notes." }, max_cost_usd: 1 },
      catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
      created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", next_at: "2026-11-12T09:00:00Z", last_firing: null,
    };
    const scheduled = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ ...answerOf(body, 3), triggers: [{ trigger_id: "trg_d", name: "daily", kind: "schedule", enabled: true }], warnings: [] }));
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: scheduled, getTrigger: async () => schedule } as never);
    await act(async () => button(host, "Update Morning notes")!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(go).not.toHaveBeenCalled();
    expect(host.querySelector("h1")?.textContent).toContain("Daily notes updated");
    expect(result(host)).toContain("Updated: rev 3.");
    expect(host.querySelector('[aria-label="Triggers"] [data-trigger="trg_d"]')).not.toBeNull();
    expect(result(host)).not.toContain("made");
  });
  it("an Update lists every trigger it kept or made, an email trigger beside its schedule, each by name and kind, on or off", async () => {
    const schedule: Trigger = {
      id: "trg_d", name: "evening-digest", enabled: true, source: { kind: "schedule", cron: "0 18 * * *", timezone: "UTC" },
      target: { kind: "start_run", agent_id: "notes-1", input: { content: "Write the digest." }, max_cost_usd: 1 },
      catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
      created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", next_at: "2026-11-12T18:00:00Z", last_firing: null,
    };
    const triggers = [{ trigger_id: "trg_mail", name: "new-mail", kind: "email", enabled: true }, { trigger_id: "trg_d", name: "evening-digest", kind: "schedule", enabled: true }, { trigger_id: "trg_w", name: "monday-brief", kind: "schedule", enabled: false }];
    const kept = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ ...answerOf(body, 4), triggers, warnings: [] }));
    const getTrigger = vi.fn(async (id: string) => { if (id === "trg_d") return schedule; throw new Error("down"); });
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: kept, getTrigger } as never);
    await act(async () => button(host, "Update Morning notes")!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(go).not.toHaveBeenCalled();
    const rows = [...host.querySelectorAll('[aria-label="Triggers"] [data-trigger]')];
    expect(rows.map((r) => r.getAttribute("data-trigger"))).toEqual(["trg_mail", "trg_d", "trg_w"]);
    expect(rows[0]!.textContent).toContain("new-mail");
    expect(rows[0]!.textContent).toContain("Email · On each new message in a mailbox");
    expect(rows[1]!.textContent).toContain("next ");
    expect(rows[2]!.textContent).toMatch(/It is off/);
    expect(getTrigger).not.toHaveBeenCalledWith("trg_mail");
  });
  it("an Apply with warnings made a new agent, and says so", async () => {
    const getAgent = vi.fn();
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: warned, getAgent } as never);
    await act(async () => button(host, "Apply")!.click());
    expect(host.querySelector("h1")?.textContent).toContain("Daily notes applied");
    expect(result(host)).toContain("The agent is made. The server says:");
    expect(result(host)).not.toContain("Updated");
    expect(getAgent).not.toHaveBeenCalled();
  });

  // An Update that changes nothing: the server wrote no revision (agent_change unchanged) and names the current one.
  const same = vi.fn(async (_name: string, body: { agent_id?: string }) => ({ agent_id: body.agent_id ?? "notes-1", revision_version: 2, agent_change: "unchanged", triggers: [], warnings: [{ field: "computer", message: "No shell here." }] }));
  it("an Update that changes nothing says so, at the revision that stays current, never that the agent is made or applied", async () => {
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: same, getAgent: vi.fn() } as never);
    await act(async () => button(host, "Update Morning notes")!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector("h1")?.textContent).toContain("Daily notes unchanged");
    expect(result(host)).toContain("Nothing to update: rev 2 is current. The server says:");
    expect(result(host)).not.toMatch(/made|applied|Updated/);
  });
  it("the words come from the answer, not the button: an apply the server answers unchanged says so, and is shown even with nothing more to say", async () => {
    const quiet = vi.fn(async () => ({ agent_id: "notes-1", revision_version: 2, agent_change: "unchanged", triggers: [], warnings: [] }));
    const host = await mount({ ...client([agentOf("notes-1", "Morning notes", base.id)]), applyTemplate: quiet } as never);
    await act(async () => button(host, "Apply")!.click());
    expect(go).not.toHaveBeenCalled();
    expect(result(host)).toContain("Nothing to update: rev 2 is current.");
    expect(result(host)).not.toMatch(/made|applied/);
  });

  it("offers no Update when no agent here was made from it, and Apply sends no agent_id", async () => {
    const host = await mount(client([agentOf("plain", "Plain", null)]));
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim().startsWith("Update "))).toBe(false);
    await act(async () => button(host, "Apply")!.click());
    expect(applyTemplate.mock.calls[0]?.[1]).toEqual({ parameters: {}, overrides: { approvals: "ask" } });
  });
});
