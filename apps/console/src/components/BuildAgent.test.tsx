import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildAgent } from "./BuildAgent";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { parseAgentDraft } from "@/lib/agentDraft";
import type { TemplateView } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const copied = vi.fn(async (_text: string) => {});
const packageTemplate = (name: string): TemplateView => ({
  id: name, bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name, display_name: name, version: "2.1.0", description: `A complete ${name} agent package.`,
  license: "Apache-2.0", author: null, repository: null, output: null, input_schema: null,
  harness: ["claude-agent"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, mcp: [], parameters: { type: "object", additionalProperties: false, properties: {} }, secrets: [],
  budget: null, learning: false, approvals_default: "ask", triggers: [], skills: ["research"], evals: [],
});
const catalog = ["Code review", "Inbound lead", "KYB", "Market monitor", "Release notes", "My custom agent", "Another custom agent"].map(packageTemplate);
const listTemplates = vi.fn(async () => ({ templates: catalog }));
const mount = async () => {
  localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(BuildAgent, { origin: "https://console.example.test", v2: { listTemplates } })));
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
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); copied.mockClear(); listTemplates.mockReset().mockResolvedValue({ templates: catalog }); vi.unstubAllGlobals(); });

describe("Build agent page", () => {
  it("keeps same-name bundled and imported packages distinct in selection, prompt and playground, with current provenance", async () => {
    const bundled = packageTemplate("same-name");
    const imported: TemplateView = { ...bundled, id: "github:acme/agents/templates/same-name", bundled: false,
      source: "github:acme/agents/templates/same-name@main", publisher: "acme", sha: "0123456789abcdef0123456789abcdef01234567" };
    listTemplates.mockResolvedValue({ templates: [bundled, imported] });
    await mount();
    const cards = host.querySelectorAll("article");
    expect(cards).toHaveLength(2);
    await act(async () => cards[1].querySelector("button")!.click());
    expect(host.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
    expect(cards[0].querySelector('[aria-expanded="true"]')).toBeNull();
    expect(cards[1].querySelector("[data-provenance]")?.textContent).toContain(imported.sha!.slice(0, 12));
    await act(async () => button("Use this template").click());
    expect(copied.mock.calls[0][0]).toContain(JSON.stringify(imported.id));
    expect(copied.mock.calls[0][0]).toContain(imported.sha!);
    expect(copied.mock.calls[0][0]).toContain("/templates/" + encodeURIComponent(imported.id) + "/apply");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Use this template"]')!.click());
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    expect(new URLSearchParams(href.split("?")[1]).get("template")).toBe(imported.id);
    const changed = { ...imported, sha: "abcdef0123456789abcdef0123456789abcdef01" };
    listTemplates.mockResolvedValue({ templates: [bundled, changed] });
    await act(async () => root!.render(createElement(BuildAgent, { origin: "https://console.example.test", v2: { listTemplates } })));
    expect(host.querySelector("[data-provenance]")?.textContent).toContain(changed.sha!.slice(0, 12));
    expect(host.querySelector("[data-provenance]")?.textContent).not.toContain(imported.sha!.slice(0, 12));
  });
  it("starts with the composer and every server template, including custom packages", async () => {
    await mount();
    expect(host.querySelector("h1")?.textContent).toBe("What do you want to build?");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder]')?.value).toBe("");
    expect(button("Build an agent")).toBeDefined();
    for (const template of catalog) expect(host.querySelector(`[aria-label="Start with ${template.name}"]`)).not.toBeNull();
    expect(host.querySelectorAll("article")).toHaveLength(7);
    expect(button("Use this template")).toBeUndefined();
    expect(host.querySelector("details")?.open).toBe(false);
  });
  it("hands the brief to the chosen coding agent and the same instructions to the playground", async () => {
    await mount();
    typeBrief("Compare product releases and flag regressions.");
    await act(async () => button("Build an agent").click());
    const prompt = copied.mock.calls[0][0];
    expect(prompt).toContain("Compare product releases and flag regressions.");
    expect(prompt).toContain("Ask only the missing questions");
    expect(prompt).toContain("https://console.example.test/v2");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toBe(prompt);
    expect((await playgroundDraft("Build an agent"))?.definition.instructions).toBe("Compare product releases and flag regressions.");
  });
  it("opens a blank create request without running or creating an agent", async () => {
    await mount();
    const href = [...host.querySelectorAll("a")].find((a) => a.textContent === "start from a blank agent")!.getAttribute("href")!;
    expect(parseAgentDraft(new URLSearchParams(href.split("?")[1]).get("draft"))?.definition.instructions).toBe("");
    expect(href).toContain("operation=create-agent");
  });
  it("hands a server package to the agent and playground by its exact name instead of rebuilding a partial definition", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await mount();
    typeBrief("Keep the summary under 200 words.");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Start with My custom agent"]')!.click());
    expect(fetch).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
    await act(async () => button("Use this template").click());
    expect(copied.mock.calls[0][0]).toContain("/v2/templates/My%20custom%20agent/apply");
    expect(copied.mock.calls[0][0]).toContain("2.1.0");
    expect(copied.mock.calls[0][0]).toContain("Keep the summary under 200 words.");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Use this template"]')!.click());
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    expect(new URLSearchParams(href.split("?")[1]).get("operation")).toBe("apply-template");
    expect(new URLSearchParams(href.split("?")[1]).get("template")).toBe("My custom agent");
    expect(href).not.toContain("definition");
  });
  it("searches the whole catalog and gives a useful empty result", async () => {
    await mount();
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search templates"]')!;
    const searchFor = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    searchFor("CUSTOM");
    expect(host.querySelectorAll("article")).toHaveLength(2);
    searchFor("No such template");
    expect(host.textContent).toContain("No templates match");
    searchFor("");
    expect(host.querySelectorAll("article")).toHaveLength(7);
  });
  it("keeps the composer usable when the catalog fails, then retries", async () => {
    listTemplates.mockRejectedValueOnce(new Error("The template catalog is offline."));
    await mount();
    typeBrief("An agent that monitors my queue.");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelectorAll("article")).toHaveLength(0);
    await act(async () => button("Try again").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll("article")).toHaveLength(7);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder]')!.value).toBe("An agent that monitors my queue.");
  });
});
