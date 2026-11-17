import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";
import type { Agent } from "@/lib/agentForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const agent: Agent = { agent_id: "hello", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Hello, AgentRun", instructions: "Write hello.md.", harness: "pi", tools: [], skills: [] }, runs: { count: 0, live: 0 } };

// jsdom lays nothing out, so this holds what the alignment comes from: the icon centred in a box as tall as the name's
// line (1.5rem), beside a row of that least height whose name and chips are centred too.
describe("an agent card's title row", () => {
  it("centres its icon on the line of the name and its chips", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentsList, { agents: [agent] })));
    const box = host.querySelector<HTMLElement>("[data-agent-card-icon]")!;
    expect(box.querySelector("svg")).not.toBeNull();
    for (const c of ["flex", "h-6", "items-center"]) expect(box.className.split(" ")).toContain(c);
    expect(box.querySelector("svg")!.getAttribute("class")).not.toContain("mt-");
    const row = [...host.querySelectorAll<HTMLElement>("span")].find((s) => s.firstElementChild?.textContent === "Hello, AgentRun" && s.children.length > 1)!;
    for (const c of ["min-h-6", "items-center"]) expect(row.className.split(" ")).toContain(c);
    expect(row.textContent).toContain("agentic");
  });
});
