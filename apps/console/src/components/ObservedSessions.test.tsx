import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservedSessionPage, ObservedSessions } from "./ObservedSessions";
import { NativeConnections } from "./NativeConnections";
import { AgentsList } from "./AgentsList";
import { RunsList } from "./RunsList";
import { MissionControl } from "./MissionControl";
import { createClient } from "@/lib/client";
import { observedState, useObservations, type Observations, type ObservedSession } from "@/lib/observations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((r) => r.unmount())); document.body.innerHTML = ""; vi.useRealTimers(); });
const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 10, total_tokens: 120, cache_hit_rate: .6, status: "reported" as const };
const session: ObservedSession = { id: "session-a", connector_id: "connector-a", source_id: "source-a", external_session_id: "hashed-session", harness: "claude", activity: "working", reported_activity: "working", connection_state: "online", selection_active: true, occurred_at: "2026-11-12T12:00:00Z", received_at: "2026-11-12T12:00:01Z", created_at: "2026-11-12T11:00:00Z", updated_at: "2026-11-12T12:00:01Z", sequence: 2, display_name: "Existing backend", models: ["test-model"], usage, observation_only: true };
const data: Observations = { connectors: [], sessions: [session], usage: { ...usage, models: [{ model: "test-model", ...usage }], daily: [{ date: "2026-11-12", total_tokens: 120 }], status: "partial" } };
const read = { data, error: null, loading: false, refresh: vi.fn() };
const render = async (element: React.ReactElement) => { const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root); await act(async () => { root.render(element); }); return host; };

describe("existing agent observation", () => {
  it("uses native connection and activity states without interpreting idle as a completed task", () => {
    expect(observedState(session)).toBe("Running");
    expect(observedState({ ...session, activity: "waiting_input" })).toBe("Needs input");
    expect(observedState({ ...session, activity: "idle" })).toBe("Idle");
    expect(observedState({ ...session, activity: "finished" })).toBe("Session ended");
    expect(observedState({ ...session, activity: "failed" })).toBe("Failed");
    expect(observedState({ ...session, connection_state: "offline" })).toBe("Disconnected");
    expect(observedState({ ...session, connection_state: "disconnected" })).toBe("Disconnected");
    expect(observedState({ ...session, selection_active: false })).toBe("Not selected");
  });
  it("shows the original harness and model on the existing agents page without executable-agent actions", async () => {
    const host = await render(createElement(AgentsList, { agents: [], observations: read }));
    expect(host.textContent).toContain("Existing backend");
    expect(host.textContent).toContain("Claude Code");
    expect(host.textContent).toContain("test-model");
    expect(host.textContent).not.toContain("No agents yet");
    const card = host.querySelector('section[aria-label="Observed sessions"]')!;
    expect(card.querySelector('a[href="#/observations/session-a"]')).toBeTruthy();
    expect(card.textContent).not.toMatch(/Run agent|Edit agent|Learning/);
  });
  it("shows observed sessions on Runs without claiming the server has no activity", async () => {
    const host = await render(createElement(RunsList, { runs: [], agentName: (id) => id, onOpen: vi.fn(), observations: read }));
    expect(host.querySelector('table[aria-label="Observed sessions"]')).toBeTruthy();
    expect(host.textContent).not.toContain("Start your first run");
  });
  it.each(["loading", "failed"])("keeps independently loaded observed sessions visible when registered-run data is %s", async (state) => {
    const retry = vi.fn();
    const host = await render(createElement(MissionControl, { view: null, hasObservedSessions: true,
      error: state === "failed" ? { title: "Registered runs could not be read.", why: "Store busy", next: "Try again." } : null,
      onRetry: retry, observations: createElement(ObservedSessions, { read, view: "summary" }) }));
    expect(host.querySelector('section[aria-label="Observed sessions"]')?.textContent).toContain("Existing backend");
    expect(host.querySelector('a[href="#/observations/session-a"]')).not.toBeNull();
    if (state === "failed") {
      expect(host.textContent).toContain("Registered runs could not be read.");
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Try again")!;
      await act(async () => button.click());
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it("labels retained session tokens separately from a seven-day aggregate", async () => {
    const retained = { ...data, sessions: [{ ...session, created_at: "2026-10-01T00:00:00Z", usage: { ...usage, total_tokens: 1200 } }] };
    const host = await render(createElement(ObservedSessions, { read: { ...read, data: retained }, view: "summary", days: 7 }));
    expect(host.textContent).toContain("Observed token usage · last 7 days");
    expect(host.querySelector('table[aria-label="Observed sessions"] thead')?.textContent).toContain("Tokens · retained");
    expect(host.querySelector('table[aria-label="Observed sessions"] tbody')?.textContent).toContain("1,200");
    expect(host.textContent).toContain("Session totals cover retained reports, independently of the aggregate range.");
  });
  it("keeps observed usage separate, preserves cache values and never treats unknown counters as zero", async () => {
    const host = await render(createElement(ObservedSessions, { read, view: "summary", days: 7 }));
    expect(host.textContent).toContain("Observed token usage · last 7 days");
    expect(host.textContent).toContain("60.0%");
    expect(host.textContent).toContain("Idle does not mean a task completed");
    const unknown = { ...data, sessions: [{ ...session, usage: { ...usage, status: "unavailable" as const } }] };
    const table = await render(createElement(ObservedSessions, { read: { ...read, data: unknown } }));
    expect(table.querySelector('tbody tr')!.textContent).toContain("—");
  });
  it("makes missing aggregate totals and ingestion capacity visible", async () => {
    const overflow: Observations = { ...data, connectors: [{ storage_full: true }], usage: { ...data.usage, status: "unavailable", overflow: true, total_tokens: null, input_tokens: null, output_tokens: null } };
    const host = await render(createElement(ObservedSessions, { read: { ...read, data: overflow }, view: "summary" }));
    expect(host.textContent).toContain("Combined token totals are too large to display reliably");
    expect(host.textContent).toContain("Telemetry needs attention");
    expect(host.querySelector('table[aria-label="Observed sessions"]')!.textContent).toContain("120");
  });
  it("polls the session detail and keeps launch, edit, and learning controls absent", async () => {
    vi.useFakeTimers();
    let answer = data;
    const observations = vi.fn(async () => answer);
    const host = await render(createElement(ObservedSessionPage, { v2: { observations } as never, sessionId: session.id, go: vi.fn() }));
    expect(observations).toHaveBeenCalledWith({ days: 30, sessionId: session.id }, expect.any(AbortSignal));
    expect(host.textContent).toContain("Running");
    expect(host.querySelector('[aria-label="Agent views"]')).toBeNull();
    expect([...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Back to agents", "Refresh session"]);
    answer = { ...data, sessions: [{ ...session, connection_state: "offline" }] };
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(host.textContent).toContain("Disconnected");
    expect(host.textContent).toContain("backend SDK integration adds self-improvement");
  });
  it("surfaces a failed observation read instead of claiming the agent is offline", async () => {
    const host = await render(createElement(ObservedSessionPage, { v2: { observations: async () => { throw new Error("Store unavailable"); } } as never, sessionId: session.id, go: vi.fn() }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Store unavailable");
    expect(host.textContent).not.toContain("Disconnected");
  });
  it("keeps the last observed session visible while a manual refresh is pending or fails, then recovers", async () => {
    let fail!: (error: Error) => void;
    const observations = vi.fn()
      .mockResolvedValueOnce(data)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce({ ...data, sessions: [{ ...session, activity: "idle" }] });
    const host = await render(createElement(ObservedSessionPage, { v2: { observations } as never, sessionId: session.id, go: vi.fn() }));
    await act(async () => { (host.querySelector('[aria-label="Refresh session"]') as HTMLButtonElement).click(); });
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
    expect(host.textContent).toContain("test-model");
    expect(host.textContent).not.toContain("Loading observed session");
    await act(async () => { fail(new Error("Store unavailable")); });
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Store unavailable");
    await act(async () => { (host.querySelector('[aria-label="Refresh session"]') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("Idle");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it.each(["client", "days", "session", "inactive"] as const)("clears observations after a %s change and ignores the previous refresh's late answer", async (change) => {
    let settleOld!: (answer: Observations) => void;
    let settleNew!: (answer: Observations) => void;
    const observations = vi.fn()
      .mockResolvedValueOnce(data)
      .mockImplementationOnce(() => new Promise<Observations>((resolve) => { settleOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Observations>((resolve) => { settleNew = resolve; }));
    type Props = Parameters<typeof useObservations>[1] & { v2: Parameters<typeof useObservations>[0] };
    function Scope({ v2, ...options }: Props) { return createElement(ObservedSessions, { read: useObservations(v2, options) }); }
    const props: Props = { v2: { observations } as never, active: true, days: 30, sessionId: session.id };
    const host = await render(createElement(Scope, props));
    const root = roots.at(-1)!;
    await act(async () => { (host.querySelector('[aria-label="Refresh observed sessions"]') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("Existing backend");
    const next = { ...props, ...(change === "client" ? { v2: { observations: () => new Promise<Observations>((resolve) => { settleNew = resolve; }) } as never } : change === "days" ? { days: 7 as const } : change === "session" ? { sessionId: "session-b" } : { active: false }) };
    await act(async () => { root.render(createElement(Scope, next)); });
    expect(host.textContent).not.toContain("Existing backend");
    await act(async () => { settleOld(data); });
    expect(host.textContent).not.toContain("Existing backend");
    if (change !== "inactive") {
      await act(async () => { settleNew({ ...data, sessions: [{ ...session, id: "session-b", display_name: "New scope" }] }); });
      expect(host.textContent).toContain("New scope");
      expect(host.textContent).not.toContain("Existing backend");
    }
  });
  it("offers existing-application observation through the same coding-agent dropdown", async () => {
    const discoverNative = vi.fn();
    const host = await render(createElement(NativeConnections, { v2: { discoverNative } as never, go: vi.fn(), initialSource: "observe" }));
    expect(host.querySelector('section[aria-label="Observe an existing application"]')).toBeTruthy();
    expect(host.textContent).toContain("Connect Claude Code or Codex running locally, in Docker, or on another server");
    expect(host.textContent).toContain("Connect agent");
    expect(host.querySelector('input[aria-label="Project on server host"]')).toBeNull();
    expect(discoverNative).not.toHaveBeenCalled();
  });
  it("requests session metadata with authenticated same-origin reads and encoded filters", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
    await createClient({ fetch: fetch as typeof globalThis.fetch }).observations({ days: 7, sessionId: "session/a?" });
    expect(fetch.mock.calls[0]).toEqual(["/v2/observations?days=7&session_id=session%2Fa%3F", expect.objectContaining({ method: "GET", credentials: "same-origin" })]);
  });
});
