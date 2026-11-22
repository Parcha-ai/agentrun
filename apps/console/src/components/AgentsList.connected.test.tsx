import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsList } from "./AgentsList";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { ObservationRead, ObservedSession } from "@/lib/observations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const registered: Agent = { ...SERVED_AGENT, agent_id: "reports", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Release reports", description: "Summarize changes", instructions: "Write a report.", harness: "pi", tools: [], skills: [] } };
const usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, cache_hit_rate: null };
const session: ObservedSession = { id: "os_record-abcdefgh", external_session_id: "native-12345678", source_id: "source-project-a", connector_id: "connector-machine-a",
  harness: "codex", display_name: "Review the checkout flow", project_name: "shop", models: ["coding-model"], activity: "working", reported_activity: "working", connection_state: "online", selection_active: true,
  occurred_at: "2026-11-18T10:00:00Z", received_at: "2026-11-18T10:00:01Z", created_at: "2026-11-18T09:00:00Z", updated_at: "2026-11-18T10:00:01Z", sequence: 1, usage, observation_only: true };
const read = (over: Partial<ObservationRead> = {}): ObservationRead => ({ data: { sessions: [session], connectors: [], usage: { ...usage, models: [], daily: [], status: "unavailable" } }, error: null, loading: false, refresh: vi.fn(), ...over });
type Props = Parameters<typeof AgentsList>[0];
function render(props: Props) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(createElement(AgentsList, props)));
  return {
    host,
    update: (next: Props) => act(() => root.render(createElement(AgentsList, next))),
    search: (value: string) => act(() => {
      const input = host.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
    cards: () => [...host.querySelectorAll('ul[aria-label="Agents"] > li')],
    count: () => host.querySelector('[aria-label="Agent count"]')?.textContent,
  };
}

describe("Connected agents is one inventory", () => {
  it("finds an external agent by its platform label", () => {
    const external: Agent = { ...registered, definition: { ...registered.definition, sdk: { runtime: "external", platform: "OpenClaw" } } };
    const t = render({ agents: [external] });
    t.search("openclaw");
    expect(t.cards()).toHaveLength(1);
    expect(t.cards()[0].textContent).toContain("Release reports");
  });

  it("uses the server learning capability for registered agents rather than claiming their configured setting is active", () => {
    const agent = { ...registered, definition: { ...registered.definition, learning: true as const } };
    const t = render({ agents: [agent] });
    expect(t.cards()[0].textContent).toContain("Learning unknown");
    t.update({ agents: [agent], learning: "on" });
    expect(t.cards()[0].textContent).toContain("Learning on");
    t.update({ agents: [agent], learning: "off" });
    expect(t.cards()[0].textContent).toContain("Learning off");
    expect(t.cards()[0].textContent).not.toContain("Enable learning");
    expect(t.cards()[0].querySelector('a[href="#/agents/reports/learning"]')).toBeNull();
    t.update({ agents: [agent], learning: null });
    expect(t.cards()[0].textContent).toContain("Learning unavailable");
    expect(t.cards()[0].querySelector('a[href="#/agents/reports/learning"]')).toBeNull();
    t.update({ agents: [{ ...agent, definition: { ...agent.definition, learning: false } }], learning: "on" });
    expect(t.cards()[0].textContent).toContain("Learning off");
    expect(t.cards()[0].textContent).not.toContain("Enable learning");
  });

  it("shows registered and independently running agents in one grid and count, with useful identity and supported actions", () => {
    const t = render({ agents: [registered], observations: read() });
    expect(t.count()).toBe("2 agents");
    expect(t.host.querySelectorAll('ul[aria-label="Agents"]')).toHaveLength(1);
    expect(t.cards()).toHaveLength(2);
    expect(t.host.querySelector('section[aria-label="Observed sessions"]')).toBeNull();
    expect(t.host.textContent).not.toContain("Observed");
    const card = t.cards()[1];
    expect(card.textContent).toContain("Review the checkout flow");
    for (const value of ["Codex", "Running", "coding-model", "Project · shop", "Session 12345678", "— tokens reported"]) expect(card.textContent).toContain(value);
    expect(card.querySelector('a[href="#/observations/os_record-abcdefgh"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Run Review the checkout flow options"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Edit Review the checkout flow options"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Archive Review the checkout flow"]')).toBeNull();
    expect(card.textContent).not.toContain("Source");
    expect(t.cards()[0].querySelector('[aria-label="Run Release reports options"]')).not.toBeNull();
  });

  it("collapses a CLI learning profile into its linked session while preserving archived access", () => {
    const profile: Agent = { ...registered, agent_id: "learning-profile", definition: { ...registered.definition, name: "Project Codex learning", cli_learning: { runtime: "codex", connection_id: "connection-a", project: "/workspace/shop" } } };
    const observations = read(); observations.data!.sessions[0] = { ...session, learning: { state: "on", agent_id: profile.agent_id } };
    const t = render({ agents: [registered, profile], observations });
    expect(t.count()).toBe("2 agents");
    expect(t.cards()).toHaveLength(2);
    expect(t.host.textContent).not.toContain("Project Codex learning");
    expect(t.cards()[1].textContent).toContain("Learning on");
    expect(t.host.querySelector('a[href="#/agents/learning-profile/learning"]')).toBeNull();
    t.update({ agents: [{ ...profile, archived_at: "2026-11-19T10:00:00Z" }], archived: true, observations });
    expect(t.count()).toBe("1 agent");
    expect(t.host.textContent).toContain("Project Codex learning");
  });

  it("keeps a CLI learning profile visible when no retained session represents it", () => {
    const profile: Agent = { ...registered, agent_id: "learning-profile", definition: { ...registered.definition, name: "Project Codex learning", cli_learning: { runtime: "codex", connection_id: "connection-a", project: "/workspace/shop" } } };
    const t = render({ agents: [profile], observations: read() });
    expect(t.count()).toBe("2 agents");
    expect(t.cards()).toHaveLength(2);
    expect(t.cards()[0].textContent).toContain("Project Codex learning");
    expect(t.cards()[0].querySelector('[aria-label="Run Project Codex learning options"]')).not.toBeNull();
    t.update({ agents: [profile], observations: read({ data: null, error: "Connection unavailable" }) });
    expect(t.count()).toBe("1 agent shown");
    expect(t.cards()[0].textContent).toContain("Project Codex learning");
  });

  it("finds a linked session through its learning profile's identity without showing the profile twice", () => {
    const profile: Agent = { ...registered, agent_id: "learning-profile", definition: { ...registered.definition, name: "Project Codex learning", cli_learning: { runtime: "codex", connection_id: "connection-a", project: "/workspace/shop" } } };
    const observations = read();
    observations.data!.sessions = [{ ...session, learning: { state: "on", agent_id: profile.agent_id } }];
    const t = render({ agents: [profile], observations });
    t.search("project codex learning");
    expect(t.count()).toBe("1 agent");
    expect(t.cards()[0].textContent).toContain("Review the checkout flow");
    t.search("/workspace/shop");
    expect(t.count()).toBe("1 agent");
    expect(t.cards()[0].textContent).toContain("Review the checkout flow");
  });

  it("uses each session's latest report once, retaining other agents with the same name", () => {
    const observations = read();
    observations.data!.sessions = [
      { ...session, activity: "finished", reported_activity: "finished", sequence: 2, received_at: "2026-11-18T10:01:00Z" },
      session,
      { ...session, id: "another-session", external_session_id: "native-87654321" },
    ];
    const t = render({ agents: [], observations });
    expect(t.count()).toBe("2 agents");
    expect(t.cards()).toHaveLength(2);
    expect(t.cards()[0].textContent).toContain("Session ended");
    expect(t.cards()[1].textContent).toContain("Running");
  });

  it("preserves distinct sessions sharing a learning profile and never collapses a server agent", () => {
    const profile: Agent = { ...registered, agent_id: "learning-profile", definition: { ...registered.definition, cli_learning: { runtime: "codex", connection_id: "connection-a", project: "/workspace/shop" } } };
    const observations = read();
    observations.data!.sessions = [
      { ...session, learning: { state: "on", agent_id: profile.agent_id } },
      { ...session, id: "another-session", learning: { state: "on", agent_id: profile.agent_id } },
      { ...session, id: "server-linked-session", learning: { state: "on", agent_id: registered.agent_id } },
    ];
    const t = render({ agents: [registered, profile], observations });
    expect(t.count()).toBe("4 agents");
    expect(t.cards()).toHaveLength(4);
    expect(t.cards()[0].querySelector('[aria-label="Archive Release reports"]')).not.toBeNull();
  });

  it.each(["review", " SHOP ", "coding-model", "12345678", "source-project-a", "connector-machine-a"])("filters both sources and counts the matching agent for %s", (query) => {
    const t = render({ agents: [registered], observations: read() });
    t.search(query);
    expect(t.count()).toBe("1 agent");
    expect(t.cards()).toHaveLength(1);
    expect(t.cards()[0].textContent).toContain("Review the checkout flow");
    t.search("summarize");
    expect(t.count()).toBe("1 agent");
    expect(t.cards()[0].textContent).toContain("Release reports");
    t.search("does not match either source");
    expect(t.cards()).toHaveLength(0);
    expect(t.host.textContent).toContain("No agent matches.");
    expect(t.host.textContent).not.toContain("No agents yet.");
  });

  it("keeps loaded coding agents visible while registered agents load or fail, without claiming a complete count", () => {
    const t = render({ agents: null, observations: read() });
    expect(t.count()).toBe("1 agent shown");
    expect(t.cards()).toHaveLength(1);
    expect(t.host.textContent).toContain("Loading more agents");
    t.update({ agents: null, error: "Store busy", observations: read() });
    expect(t.count()).toBe("1 agent shown");
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Store busy");
    expect(t.cards()).toHaveLength(1);
    expect(t.host.textContent).not.toContain("No agents yet");
    t.update({ agents: [registered], observations: read() });
    expect(t.count()).toBe("2 agents");
  });

  it("keeps registered agents and stale coding-agent cards when a refresh fails, with a retry", () => {
    const observations = read({ error: "Connection unavailable" });
    const t = render({ agents: [registered], error: "Store refresh failed", observations });
    expect(t.count()).toBe("2 agents shown");
    expect(t.cards()).toHaveLength(2);
    expect(t.host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    act(() => [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    expect(observations.refresh).toHaveBeenCalledOnce();
    t.update({ agents: [registered], observations: read({ data: null, loading: true }) });
    expect(t.count()).toBe("1 agent shown");
    expect(t.host.textContent).toContain("Loading more agents");
    t.update({ agents: [registered], observations: read() });
    expect(t.count()).toBe("2 agents");
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("waits for both initial reads before saying the list is empty, and never calls a failed read empty", () => {
    const t = render({ agents: [], observations: read({ data: null, loading: true }) });
    expect(t.host.textContent).not.toContain("No agents yet");
    t.update({ agents: [], observations: read({ data: null, error: "Timed out" }) });
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Timed out");
    expect(t.host.textContent).not.toContain("No agents yet");
    t.update({ agents: [], observations: read({ data: null }) });
    expect(t.host.textContent).toContain("No agents yet");
  });

  it("excludes nonarchivable coding agents, their errors and pending reads from the archived view", () => {
    const t = render({ agents: [], archived: true, observations: read({ error: "Old error", loading: true }) });
    expect(t.cards()).toHaveLength(0);
    expect(t.host.textContent).toContain("No archived agents.");
    expect(t.host.textContent).not.toContain("Review the checkout flow");
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
    t.update({ agents: [{ ...registered, archived_at: "2026-11-18T11:00:00Z" }], archived: true, observations: read() });
    expect(t.count()).toBe("1 agent");
    expect(t.cards()).toHaveLength(1);
    expect(t.cards()[0].querySelector('[aria-label="Unarchive Release reports"]')).not.toBeNull();
  });

  it("keeps distinct retained sessions, including ended and offline agents, with their real states", () => {
    const observations = read();
    observations.data!.sessions = [session, { ...session, id: "ended", external_session_id: "native-87654321", activity: "finished", reported_activity: "finished" }, { ...session, id: "offline", connection_state: "offline" }];
    const t = render({ agents: [], observations });
    expect(t.count()).toBe("3 agents");
    expect(t.cards()).toHaveLength(3);
    expect(t.host.textContent).toContain("Session 87654321");
    expect(t.host.textContent).toContain("Session ended");
    expect(t.host.textContent).toContain("Disconnected");
  });
});
