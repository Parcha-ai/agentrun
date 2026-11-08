import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, toolOffers } from "@/lib/agentForm";

// The Tools step comes before Harness: a tool the form's harness doesn't run here says which harnesses do (the server's
// `capabilities.tools[].harnesses`, by the names the Harness step shows), and its tick is disabled with that reason, so
// Save never refuses it later. On a harness that runs it, it is tickable.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const caps = {
  harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }],
  thinking: [],
  tools: toolOffers([
    { name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] },
    { name: "browser", available: true, harnesses: ["pi"] },
    { name: "web_search", available: true, harnesses: ["pi", "codex"] },
  ]),
};
const agentOn = (harness: string): Agent => ({ agent_id: "a1", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "A", instructions: "x", harness, skills: [], tools: ["read"] } });

function open(harness: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent: agentOn(harness), caps, step: "tools", onSave: async () => null })));
  const box = (name: string) => host.querySelector<HTMLInputElement>(`input[type=checkbox][value="${name}"]`)!;
  const row = (name: string) => box(name).closest("label")!;
  return { box, row };
}

describe("AgentEditor's Tools step, a tool by the harnesses that run it", () => {
  it("on Claude: a pi-only tool says it runs on Pi, and its tick is disabled with that reason", () => {
    const t = open("claude-agent");
    expect(t.box("browser").disabled).toBe(true);
    expect(t.row("browser").textContent).toContain("Runs on Pi here, not on Claude");
    expect(t.row("browser").getAttribute("title")).toBe("Runs on Pi here, not on Claude");
    expect(t.row("web_search").textContent).toContain("Runs on Pi and Codex here, not on Claude");
    expect(t.box("web_search").disabled).toBe(true);
    expect(t.box("read").disabled).toBe(false);
  });
  it("on Pi: the same tool is tickable, with no reason", () => {
    const t = open("pi");
    expect(t.box("browser").disabled).toBe(false);
    expect(t.row("browser").textContent).not.toContain("Runs on");
    expect(t.box("web_search").disabled).toBe(false);
  });
});
