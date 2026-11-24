import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFactoryPage } from "./AgentFactoryPage";
import { Shell } from "./Shell";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { FactoryRunPage, Run } from "@/lib/v2";
import running from "../fixtures/run.working.working.1.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });
const at = "2026-11-21T10:00:00Z";
const makeRun = (id: string): Run => ({ ...running.body, run_id: id, title: `Task ${id}`, factory: {
  lifecycle_version: "10", source: "managed", runtime: "pi", control: "managed", controls: { stop: false, cancel: true, approve: false },
  observation: { basis: "runner", status: "current", last_seen_at: at }, last_activity_at: at, github: null, children: [],
} } as Run);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
function host() { const el = document.body.appendChild(document.createElement("div")); root = createRoot(el); return el; }
const agentName = () => "Implementation agent";

describe("Agent Factory page", () => {
  it("is a first-class console destination with navigation to its route", () => {
    expect(route("#/factory")).toEqual({ section: "factory" });
    const el = host(); const navigate = vi.fn();
    act(() => root!.render(createElement(Shell, { active: "factory", onNavigate: navigate, children: "board" })));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Agent Factory")!;
    act(() => button.click());
    expect(navigate).toHaveBeenCalledWith("factory");
  });

  it("reads scoped pages, follows their cursor and keeps ended review out of active counts", async () => {
    const urls: string[] = [];
    const v2 = createClient({ fetch: (async (url) => {
      urls.push(String(url));const q = new URL(String(url), "https://serve.example").searchParams;
      const scope = q.get("scope");
      if (scope === "review") return json({ scope, observed_at: at, runs: [{ ...makeRun("ended"), status: "completed", ended_at: "2026-11-21T10:00:00Z", review: { kind: null, node: null, reason: "Inspect result", at } }], next_cursor: null });
      return json({ scope, observed_at: at, runs: [makeRun(q.has("cursor") ? "older-active" : "new-active")], next_cursor: q.has("cursor") ? null : "after" });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    expect(urls).toContain("/v2/runs?scope=active&limit=50&cursor=after");
    expect(el.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("2 active sessions loaded");
    expect(el.textContent).toContain("Task older-active");
    expect(el.querySelector('[aria-label="Ended runs needing attention"]')?.textContent).toContain("Inspect result");
  });

  it("retains last-known cards on a failed refresh and labels the counts stale", async () => {
    let fail = false;
    const v2 = createClient({ fetch: (async (url) => {
      const scope = new URL(String(url), "https://serve.example").searchParams.get("scope");
      if (fail) return json({ error: { code: "unavailable", message: "Store temporarily unavailable", retryable: true } }, 503);
      return json({ scope, observed_at: at, runs: scope === "active" ? [makeRun("held")] : [], next_cursor: null });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    fail = true;
    const refresh = el.querySelector<HTMLButtonElement>('button[aria-label="Refresh Agent Factory"]')!;
    await act(async () => refresh.click());await settle();
    expect(el.textContent).toContain("Task held");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("counts may be stale");
    expect(el.textContent).toContain("Store temporarily unavailable");
  });

  it("does not drop a transitioning session when active succeeds but ended attention fails", async () => {
    let transition = false;
    const v2 = createClient({ fetch: (async (url) => {
      const scope = new URL(String(url), "https://serve.example").searchParams.get("scope");
      if (transition && scope === "review") return json({ error: { code: "unavailable", message: "Attention unavailable", retryable: true } }, 503);
      return json({ scope, observed_at: at, runs: scope === "active" && !transition ? [makeRun("moving")] : [], next_cursor: null });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    transition = true;
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Refresh Agent Factory"]')!.click());await settle();
    expect(el.textContent).toContain("Task moving");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("counts may be stale");
  });

  it("ignores an old client's late answer after the page changes client", async () => {
    const pending: ((page: FactoryRunPage) => void)[] = [];
    const old = { listFactoryRuns: vi.fn((_scope: "active" | "review", _cursor?: string | null, _signal?: AbortSignal) => new Promise<FactoryRunPage>((r) => { pending.push(r); })) };
    const fresh = { listFactoryRuns: vi.fn(async (scope: "active" | "review") => ({ scope, observed_at: at, runs: scope === "active" ? [makeRun("fresh")] : [], next_cursor: null } as FactoryRunPage)) };
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2: old, agentName })));
    await act(async () => root!.render(createElement(AgentFactoryPage, { v2: fresh, agentName })));await settle();
    await act(async () => { pending[0]({ scope: "active", observed_at: at, runs: [makeRun("late")], next_cursor: null } as FactoryRunPage); pending[1]({ scope: "review", observed_at: at, runs: [], next_cursor: null } as FactoryRunPage); });
    expect(el.textContent).toContain("Task fresh");expect(el.textContent).not.toContain("Task late");
    expect(old.listFactoryRuns.mock.calls[0]?.[2]?.aborted).toBe(true);
  });
});
