import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const agent: Agent = { ...SERVED_AGENT, agent_id: "hello", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
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

  it("draws its harness as the icon alone, named on hover and for a screen reader, with no chip in words beside it", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentsList, { agents: [agent] })));
    const icon = host.querySelector<HTMLElement>('[data-agent-card-icon] [role="img"]')!;
    expect([icon.getAttribute("aria-label"), icon.getAttribute("title")]).toEqual(["Pi", "Pi"]);
    expect(icon.querySelector("svg.lucide-pi")).not.toBeNull();
    const row = [...host.querySelectorAll<HTMLElement>("span")].find((s) => s.firstElementChild?.textContent === "Hello, AgentRun" && s.children.length > 1)!;
    expect([...row.children].slice(1).map((c) => c.textContent)).toEqual(["agentic"]);
  });
});

describe("the agents page's search", () => {
  it("finds an agent by each word typed, in any order, as the console's other filters do", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentsList, { agents: [{ ...agent, agent_id: "a1" }, { ...agent, agent_id: "other", definition: { ...agent.definition, name: "Other", description: "Reads mail." } }] })));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "agentrun hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Hello, AgentRun");
    expect(host.textContent).not.toContain("Reads mail.");
  });
});
