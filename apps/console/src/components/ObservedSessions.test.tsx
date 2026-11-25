import claudeMark from "@/assets/coding-agents/claude-code-cli.svg";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservedSessionPage } from "./ObservedSessions";
import { Button } from "./ui";
import { NativeConnections } from "./NativeConnections";
import { AgentsList } from "./AgentsList";
import { RunsList } from "./RunsList";
import { MissionControl } from "./MissionControl";
import { ClientError, createClient } from "@/lib/client";
import type { MissionView } from "@/lib/mission";
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
  it("offers learning for existing CLI sessions without launching a replacement agent", async () => {
    const host = await render(createElement(NativeConnections, { v2: {} as never, go: vi.fn(), initialSource: "observe" }));
    const section = host.querySelector('section[aria-label="Learn from existing CLI sessions"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Keep starting Codex CLI and Claude Code normally");
    expect(section!.querySelector('[role="group"][aria-label="Enable learning options"]')).not.toBeNull();
    expect(section!.textContent).toContain("selected project");
    expect(section!.textContent).toContain("owner corrections");
    expect(section!.textContent).not.toMatch(/reflection|notes and skills|native sign-in/i);
  });
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
  it("finds a connected agent by each word typed, in any order, as the console's other filters do", async () => {
    const host = await render(createElement(AgentsList, { agents: [], observations: read }));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-model backend");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Existing backend");
  });
  it("shows the original harness and model with coding-agent handoffs on the existing agents page", async () => {
    const host = await render(createElement(AgentsList, { agents: [], observations: read }));
    expect(host.querySelector<HTMLImageElement>("li a img")?.getAttribute("src")).toBe(claudeMark);
    expect(host.textContent).toContain("Existing backend");
    expect(host.querySelector('li a [role="img"]')?.getAttribute("aria-label"), "the icon names its harness").toBe("Claude Code");
    expect(host.textContent).toContain("test-model");
    expect(host.textContent).not.toContain("No agents yet");
    const card = host.querySelector('a[href="#/observations/session-a"]')!.closest("li")!;
    expect(card.querySelector('a[href="#/observations/session-a"]')).toBeTruthy();
    expect(card.querySelector('[aria-label="Run Existing backend options"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Edit Existing backend options"]')).not.toBeNull();
    expect(card.querySelector('a[href*="playground"]')).toBeNull();
  });
  it("links Runs to the shared agent inventory without presenting sessions as task runs", async () => {
    const host = await render(createElement(RunsList, { runs: [], agentName: (id) => id, onOpen: vi.fn(), observations: read }));
    expect(host.textContent).toContain("No captured runs yet");
    expect(host.querySelector('a[href="#/agents"]')?.textContent).toBe("Connected agents");
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).not.toContain("Observed sessions");
    expect(host.textContent).not.toContain("Existing backend");
    expect(host.textContent).not.toContain("Start your first run");
  });
  it.each(["loading", "failed"])("does not mistake an unavailable agent inventory for an unused server while %s", async (state) => {
    const observations = { ...read, data: null, loading: state === "loading", error: state === "failed" ? "Connection unavailable" : null };
    const host = await render(createElement(RunsList, { runs: [], agentName: (id) => id, onOpen: vi.fn(), observations }));
    expect(host.textContent).toContain("No captured runs yet");
    expect(host.querySelector('a[href="#/agents"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Start your first run");
    if (state === "failed") expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection unavailable");
  });
  it.each([{ status: "failed" as const }, { archived: true }])("keeps run filters meaningful without putting source sessions in their results", async (filter) => {
    const host = await render(createElement(RunsList, { runs: [], agentName: (id) => id, onOpen: vi.fn(), observations: read, filter }));
    expect(host.textContent).toContain(filter.status ? "No run matches." : "No archived runs.");
    expect(host.textContent).not.toContain("No captured runs yet");
    expect(host.textContent).not.toContain("Existing backend");
  });
  it.each(["loading", "failed"])("keeps independently loaded observed sessions visible when registered-run data is %s", async (state) => {
    const retry = vi.fn();
    const host = await render(createElement(MissionControl, { view: null, observed: read,
      error: state === "failed" ? { title: "Registered runs could not be read.", why: "Store busy", next: "Try again." } : null,
      onRetry: retry }));
    expect(host.querySelector('section[aria-label="Connected agents"]')?.textContent).toContain("Existing backend");
    expect(host.querySelector('a[href="#/observations/session-a"]')).not.toBeNull();
    if (state === "failed") {
      expect(host.textContent).toContain("Registered runs could not be read.");
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Try again")!;
      await act(async () => button.click());
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it.each([true, false])("retains saved registered data through refresh failure and recovery with observations=%s", async (observed) => {
    const group = { runs: 7, completed: 7, failed: 0, needs_review: 0, runs_with_metrics: 7, tokens: 1234, cost_usd: null, unknown_cost_runs: 7 };
    const view: MissionView = {
      agents: 1, runs: { total: 7, active: 0, needsInput: 0, failed: 0, statusUnknown: 0, needsReview: 0 },
      perAgent: [{ agentId: "registered-agent", name: "Registered agent", runs: 7 }],
      cost: { usd: null, basis: null, unknownRuns: 7 },
      recent: [{ run_id: "registered-run", agent_id: "registered-agent", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: "Registered result", created_at: "2026-11-12T11:00:00Z", updated_at: "2026-11-12T11:01:00Z", ended_at: "2026-11-12T11:01:00Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, sha: null, poll_after_ms: 0, place: { mode: "runner" } }],
      analytics: { filter: { from: null, to: null, agent: null },
        totals: { ...group, input: 1000, cache_read: 0, cache_write: 0, output: 234, requests: 7, unmetered: 0 },
        time: { ended_runs: 7, wall_ms: 420000, active_runs: 0, active_ms: 0 },
        by_harness_effort: [], by_day: [], by_source: [{ source: "live", ...group }], tools: [] },
    };
    const retry = vi.fn();
    const props = { view, onRetry: retry, observed: observed ? read : undefined };
    const host = await render(createElement(MissionControl, props));
    const root = roots.at(-1)!;
    const saved = () => {
      expect(host.querySelector('a[href="#/runs"]')?.textContent).toBe("Runs7");
      expect(host.querySelector('section[aria-label="Analytics"]')?.textContent).toContain("1,234");
      expect(host.querySelector('a[href="#/agents/registered-agent/runs"]')?.textContent).toBe("Registered agent7 runs");
      expect(host.querySelector('a[href="#/runs/registered-run"]')?.textContent).toContain("Registered result");
      expect(!!host.querySelector('a[href="#/observations/session-a"]')).toBe(observed);
    };
    saved();
    const error = { title: "Registered refresh failed.", why: "Store busy", next: "Try again." };
    await act(async () => { root.render(createElement(MissionControl, { ...props, error })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(error.title);
    saved();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Try again")!.click(); });
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => { root.render(createElement(MissionControl, { ...props, scope: { range: "all", onRange: vi.fn(), agent: null, refreshing: true } })); });
    saved();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const recovered: MissionView = { ...view, runs: { ...view.runs, total: 8 }, recent: [{ ...view.recent[0], run_id: "new-registered-run", title: "New registered result" }] };
    await act(async () => { root.render(createElement(MissionControl, { ...props, view: recovered })); });
    expect(host.querySelector('a[href="#/runs"]')?.textContent).toBe("Runs8");
    expect(host.querySelector('a[href="#/runs/registered-run"]')).toBeNull();
    expect(host.querySelector('a[href="#/runs/new-registered-run"]')?.textContent).toContain("New registered result");
    expect(!!host.querySelector('a[href="#/observations/session-a"]')).toBe(observed);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("labels source detail tokens as retained session totals, preserving cache values", async () => {
    const retained = { ...data, sessions: [{ ...session, created_at: "2026-10-01T00:00:00Z", usage: { ...usage, total_tokens: 1200 } }] };
    const host = await render(createElement(ObservedSessionPage, { v2: { observations: async () => retained } as never, sessionId: session.id, go: vi.fn() }));
    const facts = host.querySelector('section[aria-label="Session token usage"]')!;
    expect(facts.textContent).toContain("Reported token usage · retained session");
    expect(facts.textContent).toContain("1,200");
    expect(facts.textContent).toContain("60.0%");
    expect(facts.textContent).toContain("Session totals cover retained reports");
    expect(facts.textContent).toContain("Activity signals do not establish a completed task or its outcome");
    expect(host.textContent).not.toContain("Observed token usage");
  });
  it("never presents unavailable source usage as zero in the shared inventory or detail", async () => {
    const unknown = { ...data, sessions: [{ ...session, usage: { ...usage, status: "unavailable" as const } }] };
    const list = await render(createElement(AgentsList, { agents: [], observations: { ...read, data: unknown } }));
    expect(list.textContent).toContain("— tokens reported");
    const detail = await render(createElement(ObservedSessionPage, { v2: { observations: async () => unknown } as never, sessionId: session.id, go: vi.fn() }));
    expect(detail.querySelector('section[aria-label="Session token usage"]')?.textContent).toContain("Token usage has not been reported");
  });
  it("keeps ingestion capacity visible in the shared inventory without discarding known source totals", async () => {
    const overflow: Observations = { ...data, connectors: [{ storage_full: true }], usage: { ...data.usage, status: "unavailable", overflow: true, total_tokens: null, input_tokens: null, output_tokens: null } };
    const host = await render(createElement(AgentsList, { agents: [], observations: { ...read, data: overflow } }));
    expect(host.textContent).toContain("Telemetry needs attention");
    expect(host.textContent).toContain("120 tokens reported");
    expect(host.textContent).not.toContain("Observed");
  });
  it("polls the agent detail and offers coding-agent run, edit and learning handoffs", async () => {
    vi.useFakeTimers();
    let answer = data;
    const observations = vi.fn(async () => answer);
    const host = await render(createElement(ObservedSessionPage, { v2: { observations } as never, sessionId: session.id, go: vi.fn() }));
    expect(observations).toHaveBeenCalledWith({ days: 30, sessionId: session.id }, expect.any(AbortSignal));
    expect(host.textContent).toContain("Running");
    expect(host.querySelector('[aria-label="Agent views"]')).toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Set up learning options"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Run agent options"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Edit agent options"]')).not.toBeNull();
    answer = { ...data, sessions: [{ ...session, connection_state: "offline" }] };
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(host.textContent).toContain("Disconnected");
    expect(host.textContent).toContain("Learning settings apply to the source project and coding runtime");
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
    await act(async () => { (host.querySelector('[aria-label="Refresh agent"]') as HTMLButtonElement).click(); });
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
    expect(host.textContent).toContain("test-model");
    expect(host.textContent).not.toContain("Loading connected agent");
    await act(async () => { fail(new Error("Store unavailable")); });
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Store unavailable");
    await act(async () => { (host.querySelector('[aria-label="Refresh agent"]') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("Idle");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("clears a previously running observation when the route becomes unavailable, preserving initial 404 compatibility and later recovery", async () => {
    const unsupported = new ClientError(404, "not_found", "This server does not expose observations.");
    const initialRead = vi.fn().mockRejectedValue(unsupported);
    const initial = await render(createElement(ObservedSessionPage, { v2: { observations: initialRead } as never, sessionId: session.id, go: vi.fn() }));
    expect(initialRead).toHaveBeenCalledOnce();
    expect(initial.textContent).toContain("Connected agent activity is unavailable on this server.");
    expect(initial.querySelector('[role="alert"]')).toBeNull();
    expect(initial.querySelector("h1")).toBeNull();

    const observations = vi.fn()
      .mockResolvedValueOnce(data)
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce({ ...data, sessions: [{ ...session, activity: "idle" }] });
    const host = await render(createElement(ObservedSessionPage, { v2: { observations } as never, sessionId: session.id, go: vi.fn() }));
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
    expect(host.textContent).toContain("Running");
    expect(host.textContent).toContain("test-model");
    expect(host.querySelector('section[aria-label="Session token usage"]')).not.toBeNull();
    const refresh = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Refresh agent"]')!.click(); }); };
    for (const calls of [2, 3]) {
      await refresh();
      expect(observations).toHaveBeenCalledTimes(calls);
      expect(host.textContent).toContain("Connected agent activity is unavailable on this server.");
      expect(host.querySelector("h1")).toBeNull();
      expect(host.textContent).not.toContain("Running");
      expect(host.textContent).not.toContain("Existing backend");
      expect(host.textContent).not.toContain("test-model");
      expect(host.querySelector('section[aria-label="Session token usage"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    }
    await refresh();
    expect(observations).toHaveBeenCalledTimes(4);
    expect(host.querySelector("h1")?.textContent).toBe("Existing backend");
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
    function Scope({ v2, ...options }: Props) {
      const current = useObservations(v2, options);
      return createElement("div", null, createElement(Button, { "aria-label": "Refresh agents", onClick: current.refresh }, "Refresh"), createElement(AgentsList, { agents: [], observations: current }));
    }
    const props: Props = { v2: { observations } as never, active: true, days: 30, sessionId: session.id };
    const host = await render(createElement(Scope, props));
    const root = roots.at(-1)!;
    await act(async () => { (host.querySelector('[aria-label="Refresh agents"]') as HTMLButtonElement).click(); });
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
  it("heads This server's section with its hand-off, under the tabs, as Another machine's is headed", async () => {
    const host = await render(createElement(NativeConnections, { v2: { discoverNative: vi.fn() } as never, go: vi.fn() }));
    const handoff = host.querySelector('[role="group"][aria-label="Connect your agents options"]')!;
    const section = host.querySelector('section[aria-label="Discover native setups"]')!;
    expect(section.contains(handoff)).toBe(true);
    expect(handoff.parentElement!.querySelector("h2")!.textContent).toBe("Discover on this server");
    // Never on the tabs' line: the tabs' radio group and the hand-off are not siblings.
    expect(host.querySelector('[role="radiogroup"][aria-label="Connection method"]')!.parentElement!.contains(handoff) && !section.contains(handoff)).toBe(false);
  });
  it("offers existing-application observation through the same coding-agent dropdown", async () => {
    const discoverNative = vi.fn();
    const host = await render(createElement(NativeConnections, { v2: { discoverNative } as never, go: vi.fn(), initialSource: "observe" }));
    expect(host.querySelector('section[aria-label="Observe an existing application"]')).toBeTruthy();
    expect(host.textContent).toContain("Connect Claude Code or Codex running locally, in Docker, or on another server");
    expect(host.textContent).toContain("Connect your agents");
    expect(host.querySelector('input[aria-label="Project on server host"]')).toBeNull();
    expect(discoverNative).not.toHaveBeenCalled();
  });
  it("requests session metadata with authenticated same-origin reads and encoded filters", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
    await createClient({ fetch: fetch as typeof globalThis.fetch }).observations({ days: 7, sessionId: "session/a?" });
    expect(fetch.mock.calls[0]).toEqual(["/v2/observations?days=7&session_id=session%2Fa%3F", expect.objectContaining({ method: "GET", credentials: "same-origin" })]);
  });
});
