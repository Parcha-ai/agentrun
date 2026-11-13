import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AnalyticsFilter } from "./MissionAnalytics";
import { Playground } from "./Playground";
import { SchedulesPage } from "./Schedules";
import { agentFixture, recorded } from "@/fixtures";
import { createClient } from "@/lib/client";
import { missionFrom, type Stats } from "@/lib/mission";
import { optionsOf, picker } from "@/test/picker";

// Every agent picker lists the agents by name, A to Z, ignoring case and accents: never in the order the server lists
// them (newest first), which a person scanning many agents cannot read. The agents here come newest first.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  // The picker's positioning watches its field's size; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const NEWEST_FIRST = [{ id: "z", name: "zeta" }, { id: "a", name: "Alpha" }, { id: "e", name: "Éclair" }, { id: "b", name: "beta" }];
const BY_NAME = ["Alpha", "beta", "Éclair", "zeta"];
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  return host;
}

describe("the agent pickers list agents by name", () => {
  it("Playground's Agent picker", async () => {
    const base = agentFixture("invoice-checker");
    const agents = NEWEST_FIRST.map(({ id, name }) => ({ ...base, agent_id: id, definition: { ...base.definition, name } }));
    const host = mount();
    act(() => root!.render(createElement(Playground, { agents, revisions: [], efforts: [], origin: "http://serve.test" })));
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-label="Agent"]')!.click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]')!;
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(BY_NAME);
  });

  it("Mission Control's Agent picker", async () => {
    const stats = recorded<Stats>("learning.stats").body;
    const view = missionFrom({ ...stats, per_agent: NEWEST_FIRST.map(({ id, name }) => ({ agent_id: id, name, runs: 1 })) }, []);
    const host = mount();
    act(() => root!.render(createElement(AnalyticsFilter, { range: "30d", onRange: () => {}, agent: null, agents: view.perAgent, onAgent: () => {} })));
    expect((await optionsOf(picker(host, "Agent")!)).map((o) => o.text).slice(1)).toEqual(BY_NAME);
  });

  it("a schedule's Agent", async () => {
    const agents = NEWEST_FIRST.map(({ id, name }) => ({ agent_id: id, kind: "agentic", definition: { name }, archived_at: null }));
    const fetch = (async (url: string) => {
      const path = new URL(String(url), "http://serve.test").pathname;
      const body = path === "/v2/agents" ? { agents, next_cursor: null } : path === "/v2/triggers" ? { triggers: [] } : null;
      return new Response(JSON.stringify(body ?? { error: { code: "not_found", message: path, retryable: false } }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const host = mount();
    act(() => root!.render(createElement(SchedulesPage, { v2: createClient({ fetch }), view: { trigger: null }, go: () => {}, agentName: (id: string) => id })));
    await settle();
    expect((await optionsOf(picker(host, "Agent")!)).map((o) => o.text).slice(1)).toEqual(BY_NAME);
  });
});
