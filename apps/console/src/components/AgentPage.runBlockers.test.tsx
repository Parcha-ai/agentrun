import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";

// An agent's page says before Run what the run's own check would refuse now (GET /v2/agents/{id}'s run_blockers): an
// imported agent with no instructions and a model no key here runs, for one, read 409 only once Run was pressed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(agent: Agent) {
  const v2 = {
    getAgent: async () => ({ agent, etag: null }),
    listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    statsOver: async () => { throw new Error("no stats here"); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, go: () => {} })));
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host.querySelector('[aria-label="Runs refused"]');
}

const IMPORTED: NonNullable<Agent["run_blockers"]> = {
  message: "definition.instructions is empty: an agentic revision needs instructions. On codex, a model is <provider>/<model id>, like openrouter/openai/gpt-6.1-sol: openai/gpt-6.1-codex is not a model codex runs here.",
  fields: [
    { field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions." },
    { field: "definition.model", reason: "not_an_option", message: "On codex, a model is <provider>/<model id>, like openrouter/openai/gpt-6.1-sol: openai/gpt-6.1-codex is not a model codex runs here." },
  ],
};

describe("AgentPage, a run refused before Run", () => {
  it("lists each blocker the run's check names, as a warning", async () => {
    const banner = await open({ ...agentFixture("invoice-checker"), run_blockers: IMPORTED });
    expect(banner).not.toBeNull();
    expect(banner!.querySelector("p")!.textContent).toBe("A run of this agent is refused until this is fixed:");
    expect([...banner!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(IMPORTED.fields.map((f) => f.message));
  });
  it("a refusal with no fields shows its message", async () => {
    const banner = await open({ ...agentFixture("invoice-checker"), run_blockers: { message: "The agent's disk is being removed.", fields: [] } });
    expect([...banner!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["The agent's disk is being removed."]);
  });
  it("none when the agent runs, when the read carries none, and on an archived agent", async () => {
    expect(await open({ ...agentFixture("invoice-checker"), run_blockers: null })).toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(await open(agentFixture("invoice-checker"))).toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(await open({ ...agentFixture("invoice-checker"), archived_at: "2026-11-18T00:00:00Z", run_blockers: IMPORTED })).toBeNull();
  });
});
