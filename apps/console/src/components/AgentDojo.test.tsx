import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDojo } from "./AgentDojo";
import { createClient } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";
import type { AgentLearning, LearningNote } from "@/lib/learning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const agent = (id: string, learning = true): Agent => ({ agent_id: id, kind: "agentic", revision: "v1", revisions: 1, archived_at: null, definition: { version: 1, name: id, learning, harness: "pi", instructions: "Research a topic.", tools: [], skills: [] } });
const note = (file: string, status: LearningNote["status"] = "active"): LearningNote => ({ file, status, name: file, description: "A useful note", type: "feedback", text: "A useful note", superseded_by: null });
const view = (id: string, fields: Partial<AgentLearning> = {}): AgentLearning => ({ agent: id, main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, skills: [], workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, ...fields });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { path: string; query: URLSearchParams; method: string };
async function mount(answer: (call: Call) => Response | Promise<Response>, server: "on" | "off" | null | undefined = "on") {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => { const u = new URL(url, "https://console.example.test"); const call = { path: u.pathname, query: u.searchParams, method: init?.method ?? "GET" }; calls.push(call); return answer(call); }) as typeof globalThis.fetch;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const v2 = createClient({ fetch });
  await act(async () => root!.render(createElement(AgentDojo, { v2, server })));
  return { calls, v2 };
}
const metric = (name: string) => host.querySelector(`[aria-label="${name}"]`)?.textContent;
const refresh = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh Learning Dojo"]')!;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Learning Dojo", () => {
  it("reads all agent and note pages, aggregates actual learning, and links changes to their runs", async () => {
    const alpha = view("alpha", { notes: { items: [note("first.md"), note("old.md", "retired")], total: 3, next_cursor: "notes-two" },
      skills: [{ name: "Review", file: "skills/review/SKILL.md", description: "Review", status: "active", run: "run-one", bytes: 1, etag: "one" }],
      workflows: [{ name: "Draft", file: "draft/workflow.json", description: "Draft", status: "pending", run: "run-one", bytes: 1, etag: "one" }],
      counts: { merged: 2, dropped: { empty: 1 }, in_progress: 1 },
      log: { items: [{ by: { run: "run one" }, commit: "change1", at: "2026-11-05T10:00:00Z", reason: "Kept a reusable check", files: ["first.md"] }], total: 1, next_cursor: null } });
    const { calls } = await mount(({ path, query }) => {
      if (path === "/v2/agents") return json(query.has("cursor") ? { agents: [agent("beta", false)], next_cursor: null } : { agents: [agent("alpha")], next_cursor: "agents-two" });
      if (path === "/v2/agents/alpha/learning") return json(alpha);
      if (path === "/v2/agents/alpha/learning/notes") return json({ items: [note("wait.md", "pending")], total: 3, next_cursor: null });
      return json(view("beta"));
    });
    expect(metric("Active notes")).toContain("1");
    expect(metric("Learned skills")).toContain("1");
    expect(metric("Workflow drafts")).toContain("0");
    expect(metric("Pending review")).toContain("2");
    expect(metric("In progress")).toContain("1");
    expect(host.querySelector('a[href="#/agents/alpha/learning"]')).not.toBeNull();
    expect(host.querySelector('a[href="#/agents/beta/learning"]')).not.toBeNull();
    expect(host.querySelector('a[href="#/runs/run%20one"]')?.textContent).toContain("Kept a reusable check");
    expect(host.textContent).toContain("Learning off");
    expect(host.textContent).toContain("Imported sessions are history");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.query.get("cursor") === "notes-two")).toBe(true);
  });

  it("keeps saved learning visible while the server has learning turned off", async () => {
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: [agent("alpha")], next_cursor: null } : view("alpha", { notes: { items: [note("kept.md")], total: 1, next_cursor: null } })), "off");
    expect(host.textContent).toContain("This server has learning turned off");
    expect(host.textContent).toContain("Paused by server");
    expect(metric("Active notes")).toContain("1");
    expect(host.querySelector('a[href="#/agents/alpha/learning"]')).not.toBeNull();
  });

  it("does not mistake capability loading or an unsupported server for learning off", async () => {
    const { calls, v2 } = await mount(() => json({ agents: [], next_cursor: null }), null);
    expect(host.textContent).toContain("This server does not expose learning");
    expect(calls).toEqual([]);
    await act(async () => root!.render(createElement(AgentDojo, { v2, server: undefined })));
    expect(host.textContent).toContain("Checking learning support");
    expect(host.textContent).not.toContain("Learning off");
    expect(calls).toEqual([]);
  });

  it("shows partial review counts and a read error instead of inventing zero for unavailable learning", async () => {
    await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("good"), agent("broken")], next_cursor: null });
      if (path.includes("broken")) return json({ error: { code: "store_busy", message: "Try later", retryable: true } }, 503);
      return json(view("good", { notes: { items: [note("wait.md", "pending")], total: 1, next_cursor: null } }));
    });
    expect(metric("Pending review")).toContain("1+");
    expect(host.textContent).toContain("Learning could not be read");
    expect(host.textContent).toContain("1 of 2 agent histories");
    expect(host.querySelector('a[href="#/agents/broken/learning"]')).not.toBeNull();
  });

  it("makes old-server missing file categories unknown and workflow learning unsupported", async () => {
    const old = view("old"); delete old.skills; delete old.workflows;
    const { calls } = await mount(({ path }) => json(path === "/v2/agents" ? { agents: [agent("old"), { ...agent("flow"), kind: "workflow" }], next_cursor: null } : old));
    expect(metric("Learned skills")).toContain("—");
    expect(metric("Workflow drafts")).toContain("—");
    expect(host.textContent).toContain("Workflow runs do not learn");
    expect(calls.some((c) => c.path.includes("/flow/learning"))).toBe(false);
  });

  it("shows a useful empty state and refreshes after agents are created", async () => {
    let added = false;
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: added ? [agent("new agent", false)] : [], next_cursor: null } : view("new agent")));
    expect(host.textContent).toContain("No agents yet");
    expect(host.querySelector('a[href="#/agents/new"]')).not.toBeNull();
    added = true;
    await act(async () => refresh().click());
    expect(host.querySelector('a[href="#/agents/new%20agent/learning"]')).not.toBeNull();
    expect(host.textContent).not.toContain("No agents yet");
  });

  it("bounds parallel reads and keeps unknown counts while agent histories are still loading", async () => {
    const resolvers: Array<() => void> = [];
    const { calls } = await mount(({ path }) => path === "/v2/agents" ? json({ agents: Array.from({ length: 7 }, (_, i) => agent(`agent-${i}`)), next_cursor: null }) : new Promise((resolve) => { resolvers.push(() => resolve(json(view(path.split("/")[3])))); }));
    expect(calls.filter((c) => c.path.endsWith("/learning"))).toHaveLength(4);
    expect(metric("Pending review")).toContain("—");
    expect(host.textContent).toContain("Loading learning");
    await act(async () => { resolvers.splice(0).forEach((resolve) => resolve()); });
    expect(calls.filter((c) => c.path.endsWith("/learning"))).toHaveLength(7);
    await act(async () => { resolvers.splice(0).forEach((resolve) => resolve()); });
    expect(metric("Pending review")).toContain("0");
  });

  it("caps long note histories and marks their review counts as a lower bound", async () => {
    let page = 0;
    const { calls } = await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("many-notes")], next_cursor: null });
      if (path.endsWith("/notes")) return json({ items: [note(`pending-${++page}.md`, "pending")], total: 100, next_cursor: `page-${page + 1}` });
      return json(view("many-notes", { notes: { items: [note("pending-0.md", "pending")], total: 100, next_cursor: "page-1" } }));
    });
    expect(calls.filter((c) => c.path.endsWith("/notes"))).toHaveLength(20);
    expect(metric("Pending review")).toContain("21+");
    expect(host.textContent).toContain("Some note counts are incomplete");
  });

  it("keeps readable items after a later note page fails and refreshes a learning run when it settles", async () => {
    vi.useFakeTimers();
    let settled = false;
    await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("alpha")], next_cursor: null });
      if (path.endsWith("/notes")) return json({ error: { code: "busy", message: "Please retry", retryable: true } }, 503);
      return json(view("alpha", { notes: { items: [note("kept.md")], total: settled ? 1 : 2, next_cursor: settled ? null : "next" }, counts: { merged: settled ? 1 : 0, dropped: {}, in_progress: settled ? 0 : 1 } }));
    });
    expect(metric("Active notes")).toContain("1+");
    expect(metric("In progress")).toContain("1");
    expect(host.textContent).toContain("Some note counts are incomplete");
    settled = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(metric("Active notes")).toBe("Active notes1");
    expect(metric("In progress")).toBe("In progress0");
    expect(host.textContent).not.toContain("Some note counts are incomplete");
  });

  it("pauses progress polling in a hidden tab and refreshes when it becomes visible", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let reads = 0;
    await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("alpha")], next_cursor: null });
      reads++;
      return json(view("alpha", { counts: { merged: 0, dropped: {}, in_progress: 1 } }));
    });
    expect(reads).toBe(1);
    hidden.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads).toBe(1);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(reads).toBe(2);
  });

  it("discovers new learning from an idle view and recovers automatically after a read error", async () => {
    vi.useFakeTimers();
    let reads = 0;
    await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("alpha")], next_cursor: null });
      reads++;
      if (reads === 2) return json({ error: { code: "busy", message: "Retry later", retryable: true } }, 503);
      return json(view("alpha", { notes: { items: reads > 2 ? [note("new.md")] : [], total: reads > 2 ? 1 : 0, next_cursor: null } }));
    });
    expect(metric("Active notes")).toBe("Active notes0");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads).toBe(2);
    expect(host.textContent).toContain("Learning could not be read");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads).toBe(3);
    expect(metric("Active notes")).toBe("Active notes1");
    expect(host.textContent).not.toContain("Learning could not be read");
  });

  it("does not overlap refreshes while an agent history is pending", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const { calls } = await mount(({ path }) => path === "/v2/agents" ? json({ agents: [agent("alpha")], next_cursor: null })
      : new Promise((resolve) => { finish = () => resolve(json(view("alpha"))); }));
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls.filter((c) => c.path === "/v2/agents")).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/learning"))).toHaveLength(1);
    await act(async () => finish());
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(calls.filter((c) => c.path.endsWith("/learning"))).toHaveLength(2);
    await act(async () => finish());
  });
});
