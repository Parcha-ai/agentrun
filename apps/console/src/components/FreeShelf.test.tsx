import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeShelf } from "./FreeShelf";
import { TemplatesPage } from "./Templates";
import { route } from "@/App";
import type { HarnessInfo } from "@/lib/models";
import type { TemplateView } from "@/lib/v2";

// The Free shelf: what runs for $0 on this server, from capabilities and the templates list alone. Local models first,
// the web tools in the server's own words, and the templates that run free, each with "Use free", which opens the
// template's Apply screen on the server's free default model (the existing create flow, its overrides.model).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; go.mockClear(); applyTemplate.mockClear(); });

const LOCAL = { id: "ollama/qwen3:8b", context_window: 65536 };
const CATALOG = { id: "openrouter/example/free-model:free", context_window: 262144 };
const pi = (free: { id: string; context_window: number }[], default_model: string | null = "anthropic/claude-x"): HarnessInfo =>
  ({ id: "pi", available: true, default_model, models: ["anthropic/claude-x", ...free.map((m) => m.id)], free_models: free });
const SEARCH_WHY = "keyless Exa, picked in settings: Exa's free search, no key";
const FETCH_WHY = "keyless Firecrawl: each URL read goes to Firecrawl's keyless service";
const TOOLS = [
  { name: "web_search", available: true, harnesses: ["pi"], resolves: { pi: "exa-keyless" }, why: { pi: SEARCH_WHY } },
  { name: "web_fetch", available: true, harnesses: ["pi"], resolves: { pi: "firecrawl-keyless" }, why: { pi: FETCH_WHY } },
];
const template = (over: Partial<TemplateView>): TemplateView => ({
  id: "t", bundled: false, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "t", display_name: null, version: "0.1.0", description: "Does a thing.", license: null, author: null, repository: null, output: null,
  input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null, computer: null, needs: null,
  computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [],
  evals: [], mcp: [], parameters: { type: "object", additionalProperties: false, properties: { topic: { type: "string", description: "Topic" } } }, ...over,
} as TemplateView);
const FIELD = template({ id: "field-monitor", name: "field-monitor", display_name: "Field monitor (free to run)", tags: ["free", "research"], model: { tier: "fast", prefer: "openrouter/nvidia/some-free:free" } });
const PAID = template({ id: "kyb", name: "kyb", display_name: "KYB", model: { tier: "strong" } });

const go = vi.fn();
const applyTemplate = vi.fn(async () => ({ agent_id: "made-1", triggers: [], warnings: [] }));
const client = (templates: TemplateView[]) => ({ listTemplates: async () => ({ templates }), listMcpServers: async () => ({ servers: [] }), applyTemplate, emailAccount: async () => ({ configured: false }) });

async function mountShelf(harnesses: HarnessInfo[], templates: TemplateView[] = [FIELD, PAID]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(FreeShelf, { v2: client(templates) as never, harnesses, tools: TOOLS, freeRequests: 60, go })));
  return host;
}
const section = (host: HTMLElement, label: string) => host.querySelector(`section[aria-label="${label}"]`)!;
const rows = (host: HTMLElement, label: string) => [...section(host, label).querySelectorAll("li")].map((li) => li.textContent);
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("the Free shelf's models", () => {
  it("with local and catalog models: the local ones first, by tag, 'local (Ollama)' and context; the catalog ones with the run limit", async () => {
    const host = await mountShelf([pi([CATALOG, LOCAL])]);
    const [first, second] = rows(host, "Free models");
    expect(first).toContain("qwen3:8b · local (Ollama)");
    expect(first).toContain("66K context");
    expect(first).not.toContain("requests");
    expect(second).toContain(CATALOG.id);
    expect(second).toContain("262K context");
    expect(second).toContain("up to 60 requests a run");
    expect(host.querySelector('[data-testid="free-fit-slot"]')).toBeNull();
  });

  it("with free catalog models only: says there is no local model and leaves the hardware-fit card's slot", async () => {
    const host = await mountShelf([pi([CATALOG])]);
    expect(rows(host, "Free models")).toHaveLength(1);
    const slot = host.querySelector('[data-testid="free-fit-slot"]');
    expect(slot).not.toBeNull();
    expect(section(host, "Free models").textContent).toContain("No local model yet");
  });

  it("with no free model at all: says so, keeps the slot, and offers no Use free", async () => {
    const host = await mountShelf([pi([])]);
    expect(rows(host, "Free models")).toEqual([]);
    expect(section(host, "Free models").textContent).toContain("No free model on this server yet");
    expect(host.querySelector('[data-testid="free-fit-slot"]')).not.toBeNull();
    const card = section(host, "Agents that run free").querySelector(`article[aria-label="Field monitor (free to run)"]`)!;
    expect((button(card, "Use free") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the Free shelf's web tools", () => {
  it("shows what web_search and web_fetch resolve to, in capabilities' own why", async () => {
    const host = await mountShelf([pi([LOCAL])]);
    const tools = section(host, "Web tools");
    const search = tools.querySelector('[data-tool="web_search"]')!;
    const fetch = tools.querySelector('[data-tool="web_fetch"]')!;
    expect(search.querySelector("[data-resolves]")!.textContent).toBe("exa-keyless");
    expect(search.querySelector("[data-why]")!.textContent).toBe(SEARCH_WHY);
    expect(fetch.querySelector("[data-resolves]")!.textContent).toBe("firecrawl-keyless");
    expect(fetch.querySelector("[data-why]")!.textContent).toBe(FETCH_WHY);
  });
});

describe("the Free shelf's agents", () => {
  it("lists only the templates that run free, and Use free opens its Apply screen on the free default model", async () => {
    const host = await mountShelf([pi([CATALOG, LOCAL])]);
    const agents = section(host, "Agents that run free");
    expect(agents.querySelector(`article[aria-label="KYB"]`)).toBeNull();
    const card = agents.querySelector(`article[aria-label="Field monitor (free to run)"]`)!;
    expect(card.textContent).toContain("qwen3:8b · local (Ollama)");
    await act(async () => button(card, "Use free")!.click());
    expect(go).toHaveBeenCalledWith(`#/templates/field-monitor?model=${encodeURIComponent(LOCAL.id)}`);
  });

  it("the address opens that template's Apply screen with the model", () => {
    expect(route(`#/templates/field-monitor?model=${encodeURIComponent(LOCAL.id)}`)).toEqual({ section: "templates", template: "field-monitor", model: LOCAL.id });
    expect(route("#/templates/field-monitor")).toEqual({ section: "templates", template: "field-monitor" });
  });

  it("Apply on that screen creates the agent through the existing apply, on that model", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(TemplatesPage, { v2: client([FIELD]) as never, name: FIELD.id, model: LOCAL.id, go })));
    expect(host.textContent).toContain("qwen3:8b · local (Ollama)");
    await act(async () => button(host, "Apply")!.click());
    expect(applyTemplate).toHaveBeenCalledTimes(1);
    expect(applyTemplate.mock.calls[0]).toEqual([FIELD.id, { parameters: {}, overrides: { approvals: "ask", model: LOCAL.id } }, expect.any(String)]);
  });
});
