import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsList } from "./AgentsList";
import { ObservedSessionPage } from "./ObservedSessions";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import type { ObservedSession, Observations } from "@/lib/observations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, cache_hit_rate: null };
const session: ObservedSession = { id: "session-record", source_id: "opaque-project", connector_id: "opaque-connector", external_session_id: "opaque-session",
  harness: "codex", display_name: "Review changes", project_name: "shop", models: ["coding-model"], activity: "idle", reported_activity: "idle", connection_state: "online", selection_active: true,
  occurred_at: "2026-11-19T10:00:00Z", received_at: "2026-11-19T10:00:01Z", created_at: "2026-11-19T09:00:00Z", updated_at: "2026-11-19T10:00:01Z", sequence: 1, usage, observation_only: true };
const data = (learning?: ObservedSession["learning"]): Observations => ({ sessions: [{ ...session, learning }], connectors: [], usage: { ...usage, models: [], daily: [], status: "unavailable" } });
let root: ReturnType<typeof createRoot>;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const copied = vi.fn(async (_value: string) => {});
afterEach(() => {
  act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); copied.mockClear();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
});
async function mount(learning?: ObservedSession["learning"], detail = false) {
  localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const write = vi.fn(async () => { throw new Error("Handoffs must not mutate or execute"); });
  const answer = data(learning);
  const props = { agents: [], observations: { data: answer, error: null, loading: false, refresh: vi.fn() } };
  await act(async () => root.render(detail ? createElement(ObservedSessionPage, { v2: { observations: async () => answer, startRun: write, updateDefinition: write } as never, sessionId: session.id, go: vi.fn() }) : createElement(AgentsList, props)));
  return { host, write };
}

describe("connected agent learning and handoffs", () => {
  it.each(["on", "off", "setup_required", "unknown", "unsupported"] as const)("shows learning %s as card status, with controls only on the agent page", async (state) => {
    const { host, write } = await mount({ state, agent_id: "learning/profile" });
    expect(host.textContent).toContain("Learning ");
    expect(host.querySelector('a[href="#/agents/learning%2Fprofile/learning"]')).toBeNull();
    expect(host.querySelector('[aria-label="Set up learning options"]')).toBeNull();
    expect(host.querySelector('[aria-label="Enable learning options"]')).toBeNull();
    expect(host.textContent).not.toContain("Enable learning");
    expect(host.textContent).not.toContain("Learning settings");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "Learning unknown", "Set up learning"],
    [{ state: "unknown" }, "Learning unknown", "Set up learning"],
    [{ state: "setup_required" }, "Learning not set up", "Enable learning"],
    [{ state: "on" }, "Learning unknown", "Set up learning"],
    [{ state: "off" }, "Learning unknown", "Set up learning"],
  ] as const)("does not infer enablement from unverified state %j", async (learning, words, action) => {
    const { host, write } = await mount(learning, true);
    expect(host.textContent).toContain(words);
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${action} options"] button`)!;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(copied).toHaveBeenCalledOnce();
    expect(copied.mock.calls[0][0]).toContain(session.id);
    expect(host.textContent).not.toContain("Learning on");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not offer learning setup for a runtime reported unsupported", async () => {
    const { host } = await mount({ state: "unsupported" });
    expect(host.textContent).toContain("Learning unavailable");
    expect(host.querySelector('[aria-label="Set up learning options"]')).toBeNull();
    expect(host.querySelector('[aria-label="Enable learning options"]')).toBeNull();
  });

  it("keeps the verified project settings reachable while waiting for session-specific hook activation", async () => {
    const { host } = await mount({ state: "unknown", agent_id: "learning-profile", reason: "awaiting_activation" }, true);
    expect(host.textContent).toContain("Awaiting activation");
    expect(host.querySelector('a[href="#/agents/learning-profile/learning"]')?.textContent).toBe("Learning settings");
    expect(host.querySelector('[aria-label="Verify learning options"]')).not.toBeNull();
    expect(host.textContent).toContain("this session has not reported an activated hook yet");
    expect(host.textContent).not.toContain("Learning on");
  });

  it("explains a disabled server without suggesting the agent toggle can enable it", async () => {
    const { host } = await mount({ state: "off", agent_id: "learning-profile", reason: "server_disabled" }, true);
    expect(host.textContent).toContain("Learning is disabled on this server");
    expect(host.querySelector('a[href="#/agents/learning-profile/learning"]')?.textContent).toBe("Learning settings");
    expect(host.textContent).not.toContain("Enable learning");
  });

  it.each([false, true])("copies Run and Edit context from the %s detail view without invoking AgentRun execution", async (detail) => {
    const { host, write } = await mount({ state: "on", agent_id: "learning-profile" }, detail);
    const prompts: string[] = [];
    for (const intent of ["Run", "Edit"]) {
      const label = detail ? `${intent} agent` : `${intent} ${session.display_name}`;
      const group = host.querySelector<HTMLElement>(`[aria-label="${label} options"]`)!;
      expect(group).not.toBeNull();
      expect(group.querySelector('a[href*="playground"]')).toBeNull();
      await act(async () => group.querySelector<HTMLButtonElement>("button")!.click());
      prompts.push(copied.mock.calls.at(-1)![0]);
      expect(prompts.at(-1)).toContain(session.id);
    }
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(write).not.toHaveBeenCalled();
    if (detail) expect(host.textContent).toContain("Learning settings apply to the source project and coding runtime");
  });
});
