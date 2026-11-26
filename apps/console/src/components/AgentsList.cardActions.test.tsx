import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";
import type { Agent } from "@/lib/agentForm";
import type { NativeBinding } from "@/lib/native";
import { SERVED_AGENT } from "@/test/agent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; history.replaceState(null, "", "#/agents"); });
const agent: Agent = { ...SERVED_AGENT, agent_id: "hello", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Hello", instructions: "Write hello.md.", harness: "pi", tools: [], skills: [] } };
const native: NativeBinding = { runtime: "claude-code", project: "/workspace/app", selector: { kind: "project" }, machine_id: "workstation", version: null, model: null, fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true, capabilities: { launch: true, learning: false, workflows: false, approval: "native", usage: true } };

function card(a: Agent, archived = false) {
  history.replaceState(null, "", "#/agents");
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentsList, { agents: [a], archived })));
  const actions = host.querySelector<HTMLElement>('[data-testid="agent-card-actions"]')!;
  return { host, actions, labelled: (label: string) => actions.querySelector<HTMLElement>(`[aria-label="${label}"]`) };
}

describe("an agent card's Run and Edit", () => {
  it("for an agent this server runs, Run opens its page, where the Run box is, with no coding-agent menu", () => {
    const c = card(agent);
    const run = c.labelled("Run Hello")!;
    expect(run.tagName).toBe("A");
    expect(run.querySelector("svg.lucide-play")).not.toBeNull();
    expect(c.labelled("Choose coding agent for Run Hello")).toBeNull();
    expect(c.labelled("Run Hello options")).toBeNull();
    act(() => run.click());
    expect(location.hash).toBe("#/agents/hello");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("for an agent this server runs, Edit opens its settings in the console, with no coding-agent menu", () => {
    const c = card(agent);
    const edit = c.labelled("Edit Hello")!;
    expect(edit.tagName).toBe("A");
    expect(edit.querySelector("svg.lucide-pencil")).not.toBeNull();
    expect(c.labelled("Choose coding agent for Edit Hello")).toBeNull();
    act(() => edit.click());
    expect(location.hash).toBe("#/agents/hello/settings");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it.each([
    ["native", { native }],
    ["SDK", { sdk: { runtime: "external", platform: "OpenClaw" } }],
    ["CLI learning", { cli_learning: { runtime: "codex", connection_id: "connection-a", project: "/workspace/shop" } }],
  ])("a %s agent keeps the coding-agent menu for Run and Edit", (_kind, binding) => {
    const c = card({ ...agent, definition: { ...agent.definition, ...binding } });
    for (const verb of ["Run", "Edit"]) {
      expect(c.labelled(`${verb} Hello options`), verb).not.toBeNull();
      const trigger = c.labelled(`Choose coding agent for ${verb} Hello`)!;
      expect(trigger.tagName, verb).toBe("BUTTON");
      act(() => trigger.click());
      expect(document.querySelector('[role="menu"]'), verb).not.toBeNull();
      act(() => trigger.click());
    }
    expect(location.hash).toBe("#/agents");
  });

  it("an archived agent has no Run, and keeps the coding-agent menu for Edit", () => {
    const c = card({ ...agent, archived_at: "2026-11-13T00:00:00Z" }, true);
    expect(c.labelled("Run Hello")).toBeNull();
    expect(c.labelled("Run Hello options")).toBeNull();
    expect(c.labelled("Edit Hello options")).not.toBeNull();
    expect(c.labelled("Choose coding agent for Edit Hello")).not.toBeNull();
  });
});
