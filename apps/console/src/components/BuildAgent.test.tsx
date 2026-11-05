import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildAgent } from "./BuildAgent";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { parseAgentDraft, templateAgentDraft } from "@/lib/agentDraft";
import { TEMPLATES } from "@/lib/templates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const copied = vi.fn(async (_text: string) => {});
const mount = () => {
  localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(BuildAgent, { origin: "https://console.example.test" })));
};
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const typeBrief = (value: string) => act(() => {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[placeholder]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const playgroundDraft = async (label: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Choose coding agent for ${label}"]`)!.click());
  const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
  return parseAgentDraft(new URLSearchParams(href.split("?")[1]).get("draft"));
};
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); copied.mockClear(); vi.unstubAllGlobals(); });

describe("Build agent page", () => {
  it("starts with the composer and real local templates, with card actions tucked away", () => {
    mount();
    expect(host.querySelector("h1")?.textContent).toBe("What do you want to build?");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder]')?.value).toBe("");
    expect(button("Build an agent")).toBeDefined();
    for (const template of TEMPLATES) expect(host.querySelector(`[aria-label="Start with ${template.name}"]`)).not.toBeNull();
    expect(button("Use this template")).toBeUndefined();
    expect(host.querySelector("details")?.open).toBe(false);
  });
  it("hands the brief to the chosen coding agent and the same instructions to the playground", async () => {
    mount();
    typeBrief("Compare product releases and flag regressions.");
    await act(async () => button("Build an agent").click());
    const prompt = copied.mock.calls[0][0];
    expect(prompt).toContain("Compare product releases and flag regressions.");
    expect(prompt).toContain("Ask only the missing questions");
    expect(prompt).toContain("https://console.example.test/v2");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toBe(prompt);
    expect((await playgroundDraft("Build an agent"))?.definition.instructions).toBe("Compare product releases and flag regressions.");
  });
  it("reveals template options without creating anything and hands off the complete definition", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mount();
    typeBrief("Keep the summary under 200 words.");
    const template = TEMPLATES.find((x) => x.id === "web")!;
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Start with ${template.name}"]`)!.click());
    expect(fetch).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
    const expected = templateAgentDraft(template, "Keep the summary under 200 words.");
    await act(async () => button("Use this template").click());
    expect(copied.mock.calls[0][0]).toContain(JSON.stringify(expected, null, 2));
    expect(await playgroundDraft("Use this template")).toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("opens a blank create request without running or creating an agent", () => {
    mount();
    const href = [...host.querySelectorAll("a")].find((a) => a.textContent === "start from a blank agent")!.getAttribute("href")!;
    expect(parseAgentDraft(new URLSearchParams(href.split("?")[1]).get("draft"))?.definition.instructions).toBe("");
    expect(href).toContain("operation=create-agent");
  });
});
