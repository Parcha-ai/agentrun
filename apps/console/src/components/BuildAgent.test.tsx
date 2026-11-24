import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildAgent } from "./BuildAgent";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { parseAgentDraft } from "@/lib/agentDraft";
import type { MarketplaceList, TemplateView } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const copied = vi.fn(async (_text: string) => {});
const packageTemplate = (name: string): TemplateView => ({
  id: name, bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name, display_name: name, version: "2.1.0", description: `A complete ${name} agent package.`,
  license: "Apache-2.0", author: null, repository: null, output: null, input_schema: null,
  harness: ["claude-agent"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, needs: null, computer_here: null, checkout: null, mcp: [], parameters: { type: "object", additionalProperties: false, properties: {} }, secrets: [],
  budget: null, learning: false, approvals_default: "ask", triggers: [], skills: ["research"], evals: [],
});
const catalog = ["Code review", "Inbound lead", "KYB", "Market monitor", "Release notes", "My custom agent", "Another custom agent"].map(packageTemplate);
const listTemplates = vi.fn(async () => ({ templates: catalog }));
/** The marketplace's list: off (a server that reads none) unless a case gives one. */
const OFF: MarketplaceList = { url: null, state: "off", read_at: null, templates: [] };
const listMarketplaceTemplates = vi.fn(async (): Promise<MarketplaceList> => OFF);
const mount = async () => {
  localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(BuildAgent, { origin: "https://console.example.test", v2: { listTemplates, listMarketplaceTemplates } })));
};
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const cardButton = (card: Element, text: string) => [...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
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
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); copied.mockClear(); listTemplates.mockReset().mockResolvedValue({ templates: catalog }); listMarketplaceTemplates.mockReset().mockResolvedValue(OFF); vi.unstubAllGlobals(); });

describe("Build agent page", () => {
  it("keeps same-name bundled and imported packages distinct in selection, prompt and playground, with current provenance", async () => {
    const bundled = packageTemplate("same-name");
    const imported: TemplateView = { ...bundled, id: "github:acme/agents/templates/same-name", bundled: false,
      source: "github:acme/agents/templates/same-name@main", publisher: "acme", sha: "0123456789abcdef0123456789abcdef01234567" };
    listTemplates.mockResolvedValue({ templates: [bundled, imported] });
    await mount();
    const cards = host.querySelectorAll("article");
    expect(cards).toHaveLength(2);
    expect(cards[1].getAttribute("aria-label")).toBe(`same-name from ${imported.id}`);
    expect(cards[1].querySelector("[data-provenance]")?.textContent).toContain(imported.sha!.slice(0, 12));
    await act(async () => cardButton(cards[1], "Use this template").click());
    expect(copied.mock.calls[0][0]).toContain(JSON.stringify(imported.id));
    expect(copied.mock.calls[0][0]).toContain(imported.sha!);
    expect(copied.mock.calls[0][0]).toContain("/templates/" + encodeURIComponent(imported.id) + "/apply");
    await act(async () => cards[1].querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Use this template"]')!.click());
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    expect(new URLSearchParams(href.split("?")[1]).get("template")).toBe(imported.id);
    const changed = { ...imported, sha: "abcdef0123456789abcdef0123456789abcdef01" };
    listTemplates.mockResolvedValue({ templates: [bundled, changed] });
    await act(async () => root!.render(createElement(BuildAgent, { origin: "https://console.example.test", v2: { listTemplates, listMarketplaceTemplates } })));
    expect(host.querySelector("[data-provenance]")?.textContent).toContain(changed.sha!.slice(0, 12));
    expect(host.querySelector("[data-provenance]")?.textContent).not.toContain(imported.sha!.slice(0, 12));
  });
  it("starts with the composer and every server template, including custom packages", async () => {
    await mount();
    expect(host.querySelector("h1")?.textContent).toBe("What do you want to build?");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder]')?.value).toBe("");
    expect(button("Build an agent")).toBeDefined();
    expect(host.querySelectorAll("article")).toHaveLength(7);
    // Every card shows its action as it opens, nothing to click first, and no version: choosing here never needs one.
    for (const template of catalog) {
      const card = host.querySelector(`article[aria-label="${template.name}"]`)!;
      expect(cardButton(card, "Use this template")).toBeDefined();
      expect(card.textContent).not.toContain("2.1.0");
    }
    expect(host.querySelector("article > button, article [aria-expanded]:not([aria-haspopup])")).toBeNull();
    // The composer, its prompt and the templates share the page's one column.
    expect([...host.querySelectorAll('[class*="max-w-page"]')].map((e) => e.tagName)).toEqual(["SECTION"]);
    expect(host.querySelector("section")!.classList.contains("max-w-page")).toBe(true);
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
    const card = host.querySelector('article[aria-label="My custom agent"]')!;
    expect(fetch).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
    await act(async () => cardButton(card, "Use this template").click());
    expect(copied.mock.calls[0][0]).toContain("/v2/templates/My%20custom%20agent/apply");
    expect(copied.mock.calls[0][0]).toContain("2.1.0");
    expect(copied.mock.calls[0][0]).toContain("Keep the summary under 200 words.");
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Use this template"]')!.click());
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
    // Each word typed, in any order, as the console's other filters match.
    const titles = () => [...host.querySelectorAll("article")].map((a) => a.textContent);
    searchFor("custom agent");
    const phrase = titles();
    expect(phrase.length).toBeGreaterThan(0);
    searchFor("agent custom");
    expect(titles()).toEqual(phrase);
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

  it("lists what the marketplace lists: the Suggested page's scanner is left out, and a card it lists reads its title and one line as the marketplace's card does (GRE-4834)", async () => {
    const scout: TemplateView = { ...packageTemplate("agent-scout"), display_name: "Agent scout" };
    const kyb: TemplateView = { ...packageTemplate("kyb"), display_name: "KYB due diligence (${parameters.risk_appetite} risk appetite)", description: "Business due diligence on one company, at length." };
    listTemplates.mockResolvedValue({ templates: [kyb, scout] });
    listMarketplaceTemplates.mockResolvedValue({ url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z", templates: [
      { name: "kyb", title: "KYB due diligence", summary: "Checks who owns and runs a company.", tags: [], needs: [], page_url: "https://marketplace.example/templates/kyb/", here: "kyb" },
    ] });
    await mount();
    await act(async () => {});
    const cards = [...host.querySelectorAll("article")];
    expect(cards.map((c) => c.querySelector("h3")!.textContent)).toEqual(["KYB due diligence"]);
    expect(cards[0]!.getAttribute("aria-label")).toBe("KYB due diligence");
    expect(cards[0]!.textContent).toContain("Checks who owns and runs a company.");
    expect([...host.querySelectorAll('[role="status"]')].map((s) => s.textContent)).toContain("1 of 1");
  });

  it("leads every card with its harness's icon, the one the Templates page and an agent's card show, not an icon picked per template", async () => {
    listMarketplaceTemplates.mockResolvedValue({ url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z", templates: [
      { name: "company-brief", title: "Company research brief", tags: [], needs: [], harness: ["codex", "pi"], page_url: "https://marketplace.example/templates/company-brief/" },
    ] });
    await mount();
    await act(async () => {});
    const cards = [...host.querySelectorAll("article")];
    const icons = cards.map((c) => c.querySelector('[data-template-icon] [role="img"]')?.getAttribute("aria-label"));
    expect(icons).toEqual([...catalog.map(() => "Harness: Claude"), "Harness: Codex, Pi"]);
    // Above the card's action: one icon, its harness's (the action's own button keeps its icons).
    for (const card of cards) expect(card.firstElementChild!.querySelectorAll("svg.lucide, img").length, `${card.getAttribute("aria-label")}: one icon, its harness's`).toBe(1);
  });

  it("lists the marketplace's templates that are not here after this server's, in the count and the search, each installed from the install page or its marketplace page (GRE-4834)", async () => {
    const source = `github:Parcha-ai/agentrun-templates/templates/company-brief@${"c".repeat(40)}`;
    listMarketplaceTemplates.mockResolvedValue({
      url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z",
      templates: [
        { name: "KYB", title: "KYB", tags: [], needs: [], page_url: "https://marketplace.example/templates/kyb/", here: "KYB" },
        { name: "company-brief", title: "Company research brief", summary: "A one-page brief on a company.", category: "research", tags: [], needs: [], page_url: "https://marketplace.example/templates/company-brief/", source },
        { name: "vendor-outage-watch", title: "Vendor outage watch", tags: [], needs: [], page_url: "https://marketplace.example/templates/vendor-outage-watch/" },
      ],
    });
    await mount();
    await act(async () => {});
    const cards = [...host.querySelectorAll("article")];
    expect(cards.map((c) => c.getAttribute("aria-label")).slice(-2)).toEqual(["Company research brief from the marketplace", "Vendor outage watch from the marketplace"]);
    expect(cards).toHaveLength(catalog.length + 2);
    expect([...host.querySelectorAll('[role="status"]')].map((s) => s.textContent)).toContain(`${catalog.length + 2} of ${catalog.length + 2}`);
    const brief = cards.at(-2)!;
    expect(brief.textContent).toContain("A one-page brief on a company.");
    expect(brief.textContent).toContain("From the marketplace · research");
    expect(brief.querySelector("a")!.getAttribute("href")).toBe(`#/templates/install?src=${encodeURIComponent(source)}`);
    const watch = cards.at(-1)!.querySelector("a")!;
    expect([watch.textContent, watch.getAttribute("href"), watch.getAttribute("target")]).toEqual(["Install from the marketplace", "https://marketplace.example/templates/vendor-outage-watch/", "_blank"]);
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Search templates"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "outage");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...host.querySelectorAll("article")].map((c) => c.getAttribute("aria-label"))).toEqual(["Vendor outage watch from the marketplace"]);
  });
});

