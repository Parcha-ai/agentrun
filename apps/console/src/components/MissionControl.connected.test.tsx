import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MissionControl } from "./MissionControl";
import { ANALYTICS } from "./AgentAnalytics.sample";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { MissionView } from "@/lib/mission";
import type { ObservedSession } from "@/lib/observations";

const agent: Agent = { ...SERVED_AGENT, agent_id: "managed", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Managed agent", instructions: "Help", tools: [], skills: [] } };
const cli: Agent = { ...agent, agent_id: "cli-project", definition: { ...agent.definition, name: "Project learning", cli_learning: { runtime: "codex", project: "/workspace/project", connection_id: "connection" } } };
const session: ObservedSession = { id: "os_source", connector_id: "connector", source_id: "source", external_session_id: "session", harness: "codex", display_name: "My coding agent", activity: "working", reported_activity: "working", connection_state: "online", selection_active: true, occurred_at: "2026-11-20T00:00:00Z", received_at: "2026-11-20T00:00:00Z", created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", sequence: 1, models: [], observation_only: true, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 120, cache_hit_rate: 0 }, learning: { state: "on", agent_id: cli.agent_id } };
const observed = { data: { sessions: [session], connectors: [], usage: { ...session.usage, models: [], daily: [], status: "partial" as const } }, loading: false, error: null, refresh: vi.fn() };
const view: MissionView = { agents: 2, perAgent: [{ agentId: "managed", name: "Managed agent", runs: 3 }, { agentId: cli.agent_id, name: "Project learning", runs: 2 }], runs: { total: 5, active: 0, needsInput: 0, failed: 0, statusUnknown: 0, needsReview: 0 }, cost: { usd: null, basis: null, unknownRuns: 5 }, recent: [], analytics: ANALYTICS };

describe("one connected-agent dashboard", () => {
  it("uses the same inventory as Agents and never creates an observed section", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(MissionControl, { view, agents: [agent, cli], observed }));
    expect(host.querySelector('a[href="#/agents"] .text-display')?.textContent).toBe("2");
    const inventory = host.querySelector('section[aria-label="Connected agents"]');
    expect(inventory?.textContent).toContain("Managed agent");
    expect(inventory?.textContent).toContain("My coding agent");
    expect(inventory?.textContent).not.toContain("Project learning");
    expect(host.textContent).not.toMatch(/Observed sessions|registered/);
    expect(host.querySelector('section[aria-label="Observed sessions"]')).toBeNull();
  });

  it("keeps connected agents visible when run statistics fail", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { view: null, agents: [agent, cli], observed, error: { title: "Statistics unavailable", why: "Read failed", next: "Try again" } }));
    expect(html).toContain("My coding agent");
    expect(html).toContain("Managed agent");
    expect(html).toContain("Statistics unavailable");
  });

  it("labels retained statistics with the returned agent while another selection loads", () => {
    const host = document.createElement("div");
    const first = { ...view, analytics: { ...view.analytics, filter: { from: null, to: null, agent: "managed" } } };
    host.innerHTML = renderToStaticMarkup(createElement(MissionControl, { view: first, agents: [agent, cli], observed,
      scope: { agent: session.id, range: "all", onRange: vi.fn(), refreshing: true } }));
    expect(host.querySelector('section[aria-label="Analytics"]')?.textContent).toContain("All recorded activity, of Managed agent");
  });
});
