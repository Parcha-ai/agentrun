import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./AgentsPage";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("Coding-agent handoffs in the console", () => {
  it("keeps creation and connection links direct, without sending a request or opening a coding-agent menu", async () => {
    const listAgents = vi.fn(async () => ({ agents: [], next_cursor: null }));
    const go = vi.fn();
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    await act(async () => root!.render(createElement(AgentsPage, { v2: { listAgents } as never, archived: false, go })));
    expect([...host.querySelectorAll("header a")].map(a => a.getAttribute("href"))).toEqual(["#/agents/connect", "#/agents/new?editor=true"]);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });

  it("hands the edited playground request to the coding agent without sending it", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("agentrun.coding-agent.v1", "other");
    const onSend = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const agent = agentFixture("invoice-checker");
    await act(async () => { root!.render(createElement(Playground, { agents: [agent], efforts: ["low", "high"], origin: "http://localhost:7340", onSend })); });
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Summarize the product feedback.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(button("Use your agent")).toBeDefined();
    await act(async () => { button("Use your agent")!.click(); });
    expect(onSend).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledOnce();
    const prompt = writeText.mock.calls[0]![0];
    expect(prompt).toContain("Summarize the product feedback.");
    expect(prompt).toContain(agent.agent_id);
    expect(prompt).toContain("http://localhost:7340/v2");
  });
});
