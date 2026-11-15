import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./Templates";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { readTemplateDraft, templatePlaygroundHref } from "@/lib/templatePackages";
import type { TemplateApply, TemplateView } from "@/lib/v2";
import { pick, picker, valueOf } from "@/test/picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const template: TemplateView = {
  id: "github:acme/agents/templates/review", name: "review", display_name: "Review", version: "1.0.0", description: "Review changes.",
  bundled: false, source: "github:acme/agents/templates/review@main", sha: "0123456789abcdef0123456789abcdef01234567", publisher: "acme",
  category: null, tags: [], license: null, author: null, repository: null, output: null, input_schema: null,
  harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null, computer: null, computer_here: null, checkout: null,
  parameters: { type: "object", additionalProperties: false, properties: {} }, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  mcp: [{ source: "github", toolkit: "github", reason: null, required: true, tools: [{ name: "read", tool: "mcp:github/read", asks: "allow" }] }],
};
const saved = (name: string) => ({ name, source: "github" as const, toolkit: "github", url: "https://api.githubcopilot.com/mcp/", auth: { type: "github_app" as const }, tools: [], credential: null });
const body: TemplateApply = { parameters: {}, grants: ["mcp:github/read"], servers: { github: "github-work" }, overrides: { approvals: "ask" } };
const draft = (body: unknown) => new URLSearchParams(templatePlaygroundHref(template, body as TemplateApply).split("?")[1]).get("draft")!;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); });
async function mount({ playground = false, prepared, list = async () => ({ servers: [saved("github-work"), saved("github-home")] }) }: {
  playground?: boolean; prepared?: string; list?: () => Promise<{ servers: ReturnType<typeof saved>[] }>;
} = {}) {
  const apply = vi.fn(async () => ({ agent_id: "review-1", trigger_ids: [], warnings: [] }));
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(TemplatesPage, { v2: { listTemplates: async () => ({ templates: [template] }), listMcpServers: list, applyTemplate: apply } as never,
    name: template.id, playground, draft: prepared, go: () => {} })));
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  return { host, apply, button };
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("owner MCP bindings in template handoffs", () => {
  it("round trips only declared toolkit bindings to valid saved-server names", () => {
    expect(readTemplateDraft(draft(body), template)).toEqual({ body });
    for (const servers of [{ other: "github-work" }, { github: "" }, { github: ["github-work"] }, { github: "https://other.example/mcp" }, ["github-work"], null]) {
      expect(readTemplateDraft(draft({ ...body, servers }), template).error).toBeTruthy();
    }
  });

  it("keeps the selected account, full imported id and reviewed SHA from Run through manual Apply", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
    const copied = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText: copied } });
    const run = await mount();
    expect(run.button("Run").disabled).toBe(true);
    await pick(picker(run.host, "Server for github")!, "github-work");
    await click(run.host.querySelector('[data-tool="mcp:github/read"] input')!);
    await click(run.button("Run"));
    expect(run.apply).not.toHaveBeenCalled();
    expect(copied.mock.calls[0][0]).toContain(JSON.stringify(body, null, 2));
    expect(copied.mock.calls[0][0]).toContain(template.sha!);
    expect(copied.mock.calls[0][0]).toContain("Preserve any explicit server choices");
    await click(run.host.querySelector('[aria-label="Choose coding agent for Run"]')!);
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get("template")).toBe(template.id);
    expect(JSON.parse(query.get("draft")!)).toEqual({ template: template.id, version: template.version, sha: template.sha, body });
    act(() => root!.unmount()); root = undefined; document.body.innerHTML = "";
    const manual = await mount({ playground: true, prepared: query.get("draft")! });
    expect(valueOf(picker(manual.host, "Server for github")!)).toBe("github-work");
    expect(manual.button("Apply").disabled).toBe(false);
    expect(manual.apply).not.toHaveBeenCalled();
    await click(manual.button("Apply"));
    expect(manual.apply.mock.calls[0]).toEqual([template.id, body, expect.any(String)]);
  });

  it("refuses a removed prepared binding even when a different account is the only current match", async () => {
    const page = await mount({ playground: true, prepared: draft(body), list: async () => ({ servers: [saved("github-home")] }) });
    expect(page.host.textContent).toContain("prepared server choice");
    expect(page.host.textContent).toContain("fresh request");
    expect(page.button("Apply").disabled).toBe(true);
    await click(page.button("Apply"));
    expect(page.apply).not.toHaveBeenCalled();
  });

  it("does not hand off a request while the saved owner accounts are unread", async () => {
    let answer!: (value: { servers: ReturnType<typeof saved>[] }) => void;
    const pending = new Promise<{ servers: ReturnType<typeof saved>[] }>((resolve) => { answer = resolve; });
    const page = await mount({ list: () => pending });
    expect(page.button("Run").disabled).toBe(true);
    await act(async () => answer({ servers: [saved("github-work")] }));
    expect(page.button("Run").disabled).toBe(false);
    expect(page.host.textContent).toContain("Uses github-work");
    expect(page.apply).not.toHaveBeenCalled();
  });
});
