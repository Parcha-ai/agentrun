import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDojo } from "./AgentDojo";
import { createClient } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { AgentLearning, LearnedItem, LearningModelAccess } from "@/lib/learning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const agent = (id: string, learning: Agent["definition"]["learning"] = true): Agent => ({ ...SERVED_AGENT, agent_id: id, kind: "agentic", revision: "v1", revisions: 1, archived_at: null, definition: { version: 1, name: id, learning, harness: "pi", instructions: "Research a topic.", tools: [], skills: [] } });
/** corrections.md with n lines under # Learned. */
const lines = (n: number) => ["# Learned", ...Array.from({ length: n }, (_, i) => `- Correction ${i + 1}.`)].join("\n");
const draft = (name: string, status: LearnedItem["status"] = "serving", run = "run-one"): LearnedItem => ({ name, file: `workflows/${name}/workflow.json`, readme: `workflows/${name}/README.md`, description: name, status, run, bytes: 1, etag: "one" });
const view = (id: string, fields: Partial<AgentLearning> = {}): AgentLearning => ({ agent: id, main: null, corrections: "", workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null, ...fields });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { path: string; query: URLSearchParams; method: string };
async function mount(answer: (call: Call) => Response | Promise<Response>, server: "on" | "off" | null | undefined = "on", modelAccess?: LearningModelAccess) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => { const u = new URL(url, "https://console.example.test"); const call = { path: u.pathname, query: u.searchParams, method: init?.method ?? "GET" }; calls.push(call); return answer(call); }) as typeof globalThis.fetch;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const v2 = createClient({ fetch });
  await act(async () => root!.render(createElement(AgentDojo, { v2, server, modelAccess })));
  return { calls, v2 };
}
const metric = (name: string) => host.querySelector(`[aria-label="${name}"]`)?.textContent;
const refresh = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh Learning Dojo"]')!;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Learning Dojo", () => {
  it("explains missing default model access in an empty Dojo and links to Model keys", async () => {
    const missing: LearningModelAccess = { location: "server", ready: false, model: "provider/learning-model", needs: "key", reason: "No model credential is configured." };
    await mount(() => json({ agents: [], next_cursor: null }), "on", missing);
    expect(host.textContent).toContain("This is the server default");
    expect(host.textContent).toContain("No model credential is configured.");
    expect(host.textContent).toContain("Settings → API Keys → Model keys");
    expect(host.querySelector('a[href="#/settings/keys"]')?.textContent).toBe("Set up model access");
    expect(host.textContent).toContain("No agents yet");
  });

  it("uses each agent's actual model access instead of blocking native and custom routes on a missing default", async () => {
    const missing: LearningModelAccess = { location: "server", ready: false, model: "provider/default", needs: "key", reason: "No credential for this model." };
    const access: Record<string, LearningModelAccess> = {
      blocked: missing,
      custom: { ...missing, ready: true, model: "provider/custom", needs: null, reason: null },
      native: { location: "native", ready: true, model: null, needs: null, reason: null },
    };
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: Object.keys(access).map(id => agent(id)), next_cursor: null }
      : view(path.split("/")[3], { learning_model: access[path.split("/")[3]] })), "on", missing);
    const cards = [...host.querySelectorAll("article")];
    const blocked = cards.find(card => card.querySelector("h3")?.textContent === "blocked")!;
    expect(blocked.textContent).toContain("Needs model access");
    expect(blocked.textContent).toContain("provider/default");
    expect(blocked.querySelector('a[href="#/settings/keys"]')).not.toBeNull();
    for (const name of ["custom", "native"]) {
      const card = cards.find(one => one.querySelector("h3")?.textContent === name)!;
      expect(card.textContent).toContain("Learning on");
      expect(card.querySelector('a[href="#/settings/keys"]')).toBeNull();
    }
    expect(host.textContent).toContain("1 agent needs model access");
    expect(host.textContent).not.toContain("This is the server default");
  });

  it("does not infer a per-agent model failure when its learning response has no access status", async () => {
    const missing: LearningModelAccess = { location: "server", ready: false, model: null, needs: "model", reason: "No default model." };
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: [agent("older-server")], next_cursor: null } : view("older-server")), "on", missing);
    expect(host.querySelector("article")?.textContent).toContain("Learning on");
    expect(host.textContent).not.toContain("needs model access");
    expect(host.querySelector('a[href="#/settings/keys"]')).toBeNull();
  });

  it("clears missing-model setup after refreshing with configured access, even when the default is still missing", async () => {
    let saved = false;
    const missing: LearningModelAccess = { location: "server", ready: false, model: null, needs: "model", reason: "Choose a learning model." };
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: [agent("alpha")], next_cursor: null }
      : view("alpha", { learning_model: saved ? { ...missing, ready: true, model: "provider/selected", needs: null, reason: null } : missing })), "on", missing);
    expect(host.querySelector("article")?.textContent).toContain("Choose a model for learning");
    expect(host.querySelector('article a[href="#/settings/keys"]')).not.toBeNull();
    saved = true;
    await act(async () => refresh().click());
    expect(host.querySelector("article")?.textContent).toContain("Learning on");
    expect(host.textContent).not.toContain("needs model access");
    expect(host.querySelector('a[href="#/settings/keys"]')).toBeNull();
  });

  it("reads all agent pages, aggregates actual learning, and links changes to their runs", async () => {
    const alpha = view("alpha", { corrections: lines(2),
      workflows: [draft("draft", "pending"), draft("review"), draft("old", "retired")],
      counts: { merged: 2, dropped: { empty: 1 }, in_progress: 1 },
      log: { items: [{ by: { run: "run one" }, commit: "change1", at: "2026-11-05T10:00:00Z", reason: "Kept a reusable check", files: ["corrections.md"] }], total: 1, next_cursor: null } });
    const { calls } = await mount(({ path, query }) => {
      if (path === "/v2/agents") return json(query.has("cursor") ? { agents: [agent("beta", false)], next_cursor: null } : { agents: [agent("alpha")], next_cursor: "agents-two" });
      if (path === "/v2/agents/alpha/learning") return json(alpha);
      return json(view("beta"));
    });
    expect(metric("Corrections")).toContain("2");
    expect(metric("Workflow drafts")).toContain("1");
    expect(metric("Pending review")).toContain("1");
    expect(metric("In progress")).toContain("1");
    expect(host.querySelector('a[href="#/agents/alpha/learning"]')).not.toBeNull();
    expect(host.querySelector('a[href="#/agents/beta/learning"]')).not.toBeNull();
    expect(host.querySelector('a[href="#/runs/run%20one"]')?.textContent).toContain("Kept a reusable check");
    expect(host.textContent).toContain("Learning off");
    expect(host.textContent).toContain("Imported sessions are history");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    // One read per agent: its learning view holds all of corrections.md and every draft.
    expect(calls.filter((c) => c.path.startsWith("/v2/agents/alpha"))).toHaveLength(1);
  });

  it.each(["new", "connect"])("opens the workflow named %s through its reserved-ID-safe agent route", async (id) => {
    const { calls } = await mount(({ path }) => json(path === "/v2/agents" ? { agents: [{ ...agent(id), kind: "workflow" }], next_cursor: null } : view(id)));
    const card = host.querySelector("article")!;
    const link = [...card.querySelectorAll("a")].find((a) => a.textContent?.includes("View agent"))!;
    expect(link.getAttribute("href")).toBe(`#/agents/${id}/runs`);
    expect(host.querySelector(`a[href="#/agents/${id}"]`)).toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/learning"))).toBe(false);
  });

  it("keeps saved learning visible while the server has learning turned off", async () => {
    await mount(({ path }) => json(path === "/v2/agents" ? { agents: [agent("alpha")], next_cursor: null } : view("alpha", { corrections: lines(1) })), "off");
    expect(host.textContent).toContain("This server has learning turned off");
    expect(host.textContent).toContain("Paused by server");
    expect(metric("Corrections")).toContain("1");
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
      return json(view("good", { workflows: [draft("wait", "pending")] }));
    });
    expect(metric("Pending review")).toContain("1+");
    expect(host.textContent).toContain("Learning could not be read");
    expect(host.textContent).toContain("1 of 2 agent histories");
    expect(host.querySelector('a[href="#/agents/broken/learning"]')).not.toBeNull();
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

  it("refreshes a learning run when it settles", async () => {
    vi.useFakeTimers();
    let settled = false;
    await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: [agent("alpha")], next_cursor: null });
      return json(view("alpha", { corrections: lines(settled ? 2 : 1), counts: { merged: settled ? 1 : 0, dropped: {}, in_progress: settled ? 0 : 1 } }));
    });
    expect(metric("Corrections")).toBe("Corrections1");
    expect(metric("In progress")).toBe("In progress1");
    settled = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(metric("Corrections")).toBe("Corrections2");
    expect(metric("In progress")).toBe("In progress0");
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
      return json(view("alpha", { corrections: lines(reads > 2 ? 1 : 0) }));
    });
    expect(metric("Corrections")).toBe("Corrections0");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads).toBe(2);
    expect(host.textContent).toContain("Learning could not be read");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads).toBe(3);
    expect(metric("Corrections")).toBe("Corrections1");
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

  it("retains populated learning and current agent metadata through a failed automatic refresh, then replaces lower counts on retry", async () => {
    vi.useFakeTimers();
    let lists = 0, reads = 0;
    let finishList!: (response: Response) => void, finishRead!: (response: Response) => void;
    const saved = view("alpha", { corrections: lines(2),
      workflows: [draft("review", "serving", "before"), draft("pending", "pending", "before")],
      counts: { merged: 3, dropped: { empty: 1 }, in_progress: 2 },
      log: { items: [{ by: { run: "before" }, commit: "old", at: "2026-11-05T10:00:00Z", reason: "Saved learning", files: ["corrections.md"] }], total: 1, next_cursor: null } });
    const renamed = { ...agent("alpha"), revision: "v2", definition: { ...agent("alpha").definition, name: "Renamed alpha", learning: false } };
    const { calls } = await mount(({ path }) => {
      if (path === "/v2/agents") {
        lists++;
        return lists === 2 ? new Promise((resolve) => { finishList = resolve; }) : json({ agents: [lists > 1 ? renamed : agent("alpha")], next_cursor: null });
      }
      return ++reads === 1 ? json(saved) : new Promise((resolve) => { finishRead = resolve; });
    });
    expect(metric("Corrections")).toBe("Corrections2");
    expect(host.querySelector('a[href="#/runs/before"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(lists).toBe(2); expect(reads).toBe(1); expect(refresh().disabled).toBe(true);
    expect(metric("Corrections")).toContain("2");
    expect(host.querySelector('a[href="#/runs/before"]')).not.toBeNull();
    await act(async () => finishList(json({ agents: [renamed], next_cursor: null })));
    expect(reads).toBe(2);
    expect(metric("Corrections")).toBe("Corrections2 (last read)");
    expect(metric("Workflow drafts")).toBe("Workflow drafts1 (last read)");
    expect(host.querySelector("article h3")?.textContent).toBe("Renamed alpha");
    expect(host.querySelector("article")?.textContent).toContain("Learning off");
    expect(host.querySelector('a[href="#/runs/before"]')).not.toBeNull();
    await act(async () => finishRead(json({ error: { code: "busy", message: "Refresh unavailable", retryable: true } }, 503)));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Refresh unavailable");
    expect(metric("Corrections")).toBe("Corrections2 (last read)");
    expect(host.querySelector("article")?.textContent).toContain("3 runs kept learning");
    expect(host.textContent).not.toContain("Updated ");
    expect(refresh().disabled).toBe(false);
    await act(async () => refresh().click());
    expect(reads).toBe(3); expect(refresh().disabled).toBe(true);
    expect(metric("Corrections")).toBe("Corrections2 (last read)");
    const fresh = view("alpha", { log: { items: [{ by: { run: "after" }, commit: "new", at: "2026-11-05T11:00:00Z", reason: "Retired old learning", files: ["corrections.md"] }], total: 1, next_cursor: null } });
    await act(async () => finishRead(json(fresh)));
    expect(metric("Corrections")).toBe("Corrections0");
    expect(metric("Workflow drafts")).toBe("Workflow drafts0");
    expect(host.querySelector('a[href="#/runs/before"]')).toBeNull();
    expect(host.querySelector('a[href="#/runs/after"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("(last read)");
    expect(refresh().disabled).toBe(false);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("marks cached totals as last read before the agent list settles and after a list failure, then clears removed agents", async () => {
    let lists = 0, finishList!: (response: Response) => void;
    const { calls } = await mount(({ path }) => {
      if (path === "/v2/agents") return ++lists === 1 ? json({ agents: [agent("alpha")], next_cursor: null }) : new Promise((resolve) => { finishList = resolve; });
      return json(view("alpha", { corrections: lines(1) }));
    });
    expect(metric("Corrections")).toBe("Corrections1");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refresh().disabled).toBe(true);
    expect(metric("Corrections")).toBe("Corrections1 (last read)");
    await act(async () => finishList(json({ error: { code: "busy", message: "List unavailable", retryable: true } }, 503)));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("List unavailable");
    expect(metric("Corrections")).toBe("Corrections1 (last read)");
    expect(host.querySelector('a[href="#/agents/alpha/learning"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Updated ");
    await act(async () => refresh().click());
    await act(async () => finishList(json({ agents: [], next_cursor: null })));
    expect(metric("Corrections")).toBe("Corrections0");
    expect(host.textContent).toContain("No agents yet");
    expect(host.querySelector("article")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("discards removed or changed-kind snapshots and clears cached learning on a definitive missing-agent response", async () => {
    let lists = 0, finishRead!: (response: Response) => void;
    const { calls } = await mount(({ path }) => {
      if (path === "/v2/agents") return json({ agents: ++lists === 1 ? [agent("removed"), agent("flow"), agent("missing")] : [{ ...agent("flow"), kind: "workflow" }, agent("missing")], next_cursor: null });
      if (lists > 1) return new Promise((resolve) => { finishRead = resolve; });
      const id = path.split("/")[3];
      return json(view(id, { corrections: lines(1), log: { items: [{ by: { run: id }, commit: id, at: "2026-11-05T10:00:00Z", reason: id, files: ["corrections.md"] }], total: 1, next_cursor: null } }));
    });
    expect(metric("Corrections")).toBe("Corrections3");
    await act(async () => refresh().click());
    expect(host.querySelector('a[href="#/agents/removed/learning"]')).toBeNull();
    expect(host.querySelector('a[href="#/runs/removed"]')).toBeNull();
    expect(host.querySelector('a[href="#/runs/flow"]')).toBeNull();
    expect(host.textContent).toContain("Workflow runs do not learn");
    expect(calls.filter((call) => call.path === "/v2/agents/flow/learning")).toHaveLength(1);
    await act(async () => finishRead(json({ error: { code: "not_found", message: "No longer available", retryable: false } }, 404)));
    expect(metric("Corrections")).toBe("Corrections—");
    expect(host.querySelector('a[href="#/runs/missing"]')).toBeNull();
    expect(host.textContent).toContain("Learning unavailable for this agent");
    expect(host.querySelector('a[href="#/agents/missing/learning"]')).not.toBeNull();
  });

  it("clears populated snapshots on client replacement and ignores a late failure from the previous client", async () => {
    let reads = 0, oldReply!: (response: Response) => void, newReply!: (response: Response) => void;
    await mount(({ path }) => path === "/v2/agents" ? json({ agents: [agent("alpha")], next_cursor: null }) : ++reads === 1
      ? json(view("alpha", { corrections: lines(1), log: { items: [{ by: { run: "old-client" }, commit: "old", at: "2026-11-05T10:00:00Z", reason: "Old client", files: [] }], total: 1, next_cursor: null } }))
      : new Promise((resolve) => { oldReply = resolve; }));
    expect(metric("Corrections")).toBe("Corrections1");
    await act(async () => refresh().click());
    const next = createClient({ fetch: (async (url: string) => new URL(url, "https://console.example.test").pathname === "/v2/agents"
      ? json({ agents: [agent("alpha")], next_cursor: null }) : new Promise<Response>((resolve) => { newReply = resolve; })) as typeof globalThis.fetch });
    await act(async () => root!.render(createElement(AgentDojo, { v2: next, server: "on" })));
    expect(metric("Corrections")).toBe("Corrections—");
    expect(host.querySelector('a[href="#/runs/old-client"]')).toBeNull();
    await act(async () => oldReply(json({ error: { code: "busy", message: "Old client failed", retryable: true } }, 503)));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(metric("Corrections")).toBe("Corrections—");
    expect(refresh().disabled).toBe(true);
    await act(async () => newReply(json(view("alpha"))));
    expect(metric("Corrections")).toBe("Corrections0");
    expect(refresh().disabled).toBe(false);
    expect(host.textContent).not.toContain("Old client failed");
  });
});
