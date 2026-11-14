import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./Templates";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { route } from "@/App";
import type { TemplateView } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
const template: TemplateView = {
  id: "review/kit", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "review/kit", display_name: "Review kit", version: "2.4.0", description: "Review a pull request.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, secrets: ["REVIEW_KEY"], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: ["review"], evals: [],
  mcp: [{ source: "github", toolkit: "github", required: true, reason: null, tools: [{ name: "read", tool: "mcp:github/read", asks: "allow" }, { name: "write", tool: "mcp:github/write", asks: "ask" }] }],
  parameters: { type: "object", additionalProperties: false, required: ["repo"], properties: { repo: { type: "string", description: "Repository" }, max_files: { type: "integer", description: "Maximum files" } } },
};
const copied = vi.fn(async (_prompt: string) => {});
const applyTemplate = vi.fn(async () => ({ agent_id: "review-1", trigger_ids: [], warnings: [] }));
const v2 = { listTemplates: async () => ({ templates: [template] }), listMcpServers: async () => ({ servers: [] }), applyTemplate };
async function mount(name?: string, playground = false, draft?: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(TemplatesPage, { v2: v2 as never, name, playground, draft, go: () => {} })));
  return host;
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const type = (host: HTMLElement, field: string, value: string) => act(() => {
  const input = host.querySelector<HTMLInputElement>(`[data-field="parameters.${field}"] input`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const unmount = () => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; };
afterEach(() => { unmount(); localStorage.clear(); copied.mockClear(); applyTemplate.mockClear(); });

describe("running a served template", () => {
  it("hydrates prepared array choices as individual lines and applies the same typed values", async () => {
    const lists: TemplateView = { ...template, parameters: { type: "object", additionalProperties: false, required: ["names", "counts", "flags"], properties: {
      names: { type: "array", items: { type: "string" }, description: "Names" },
      counts: { type: "array", items: { type: "integer" }, description: "Counts" },
      flags: { type: "array", items: { type: "boolean" }, description: "Flags" },
    } } };
    const body = { parameters: { names: ["alpha", "beta"], counts: [1, 2], flags: [true, false] }, overrides: { approvals: "ask" } };
    const draft = JSON.stringify({ template: lists.name, version: lists.version, body });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(TemplatesPage, {
      v2: { ...v2, listTemplates: async () => ({ templates: [lists] }) } as never,
      name: lists.name, playground: true, draft, go: () => {},
    })));
    for (const [name, value] of Object.entries({ names: "alpha\nbeta", counts: "1\n2", flags: "true\nfalse" })) {
      expect(host.querySelector<HTMLTextAreaElement>(`[data-field="parameters.${name}"] textarea`)!.value).toBe(value);
    }
    expect(applyTemplate).not.toHaveBeenCalled();
    await click(button("Apply"));
    expect(applyTemplate.mock.calls[0]).toEqual([lists.name, body, expect.any(String)]);
  });

  it("uses the shared remembered agent for the exact catalog package, without applying it", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const host = await mount();
    expect(button("Run")).toBeTruthy();
    await click(button("Run"));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(button("Codex CLI"));
    expect(copied).not.toHaveBeenCalled();
    expect(applyTemplate).not.toHaveBeenCalled();
    await click(button("Run"));
    expect(copied.mock.calls[0][0]).toContain('template "review/kit", version "2.4.0"');
    expect(copied.mock.calls[0][0]).toContain("/v2/templates/review%2Fkit/apply");
    expect(copied.mock.calls[0][0]).toContain("instructions, rules, skills, schemas, learning and triggers");
    expect(copied.mock.calls[0][0]).toContain("Then read the created agent's current revision and run the template's intended task");
    expect(host.querySelector('[aria-label="Run options"] button')?.getAttribute("title")).toBe("Copy prompt for Codex CLI");
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("hands the current parameters and consent to the agent and the exact manual apply form", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "claude-cli");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const host = await mount(template.name);
    type(host, "repo", "acme/web"); type(host, "max_files", "7");
    await click(host.querySelector('[data-tool="mcp:github/write"] input')!);
    await click(host.querySelector('input[name="approvals"][value="never"]')!);
    await click(button("Run"));
    const body = { parameters: { repo: "acme/web", max_files: 7 }, grants: ["mcp:github/write"], overrides: { approvals: "never" } };
    const prompt = copied.mock.calls[0][0];
    expect(prompt).toContain(JSON.stringify(body, null, 2));
    expect(prompt).toContain("Ask for missing run inputs");
    expect(prompt).toContain("Carry out my requested run with the permissions already given");
    expect(prompt).toContain("Do not add tool grants or broaden approvals");
    expect(applyTemplate).not.toHaveBeenCalled();
    await click(host.querySelector('[aria-label="Choose coding agent for Run"]')!);
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    const target = route(href);
    expect(target.template).toBe(template.name);
    expect(JSON.parse(target.draft!)).toEqual({ template: template.name, version: template.version, body });
    expect(href).not.toContain("REVIEW_KEY");
    unmount();
    const manual = await mount(target.template, true, target.draft);
    expect(manual.querySelector<HTMLInputElement>('[data-field="parameters.repo"] input')!.value).toBe("acme/web");
    expect(manual.querySelector<HTMLInputElement>('[data-tool="mcp:github/write"] input')!.checked).toBe(true);
    expect(manual.querySelector<HTMLInputElement>('[data-tool="mcp:github/read"] input')!.checked).toBe(false);
    expect(manual.querySelector<HTMLInputElement>('input[name="approvals"][value="never"]')!.checked).toBe(true);
    expect(manual.textContent).toContain("creates an agent");
    expect(applyTemplate).not.toHaveBeenCalled();
    await click(button("Apply"));
    expect(applyTemplate).toHaveBeenCalledOnce();
    expect(applyTemplate.mock.calls[0]).toEqual([template.name, body, expect.any(String)]);
  });

  it("opens the selected coding app with the current form choices and blocks stale manual drafts", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex");
    const host = await mount(template.name);
    type(host, "repo", "acme/api");
    const link = host.querySelector<HTMLAnchorElement>('a[title="Open in Codex app"]')!;
    expect(new URL(link.href).searchParams.get("prompt")).toContain('"repo": "acme/api"');
    expect(applyTemplate).not.toHaveBeenCalled();
    unmount();
    await mount(template.name, true, JSON.stringify({ template: template.name, version: "1.0.0", body: { parameters: {}, overrides: { approvals: "ask" } } }));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("version changed");
    expect(button("Apply").disabled).toBe(true);
    expect(applyTemplate).not.toHaveBeenCalled();
  });
});
