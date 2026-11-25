import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildAgent } from "./BuildAgent";
import { AgentRequest } from "./AgentRequest";
import type { EditorCaps } from "./AgentEditor";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { briefAgentDraft, parseAgentDraft } from "@/lib/agentDraft";
import { buildAgentPrompt } from "@/lib/codingAgentPrompts";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import type { MarketplaceList, TemplateView } from "@/lib/v2";
import { SERVED_AGENT } from "@/test/agent";
import { SERVER_DENY } from "@/lib/toolSettings";

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
    // The editor, creating, is where a Decision or a Workflow agent is made: Build links it.
    expect(host.querySelector('a[href="#/agents/new?editor"]')?.textContent).toBe("set one up in the editor");
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

  it("lists the marketplace's templates when this server's list fails, in the count and the search, beside the failure", async () => {
    listTemplates.mockRejectedValueOnce(new Error("The template catalog is offline."));
    listMarketplaceTemplates.mockResolvedValue({
      url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z",
      templates: [
        { name: "company-brief", title: "Company research brief", tags: [], needs: [], page_url: "https://marketplace.example/templates/company-brief/" },
        { name: "vendor-outage-watch", title: "Vendor outage watch", tags: [], needs: [], page_url: "https://marketplace.example/templates/vendor-outage-watch/" },
      ],
    });
    await mount();
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect([...host.querySelectorAll("article")].map((c) => c.getAttribute("aria-label"))).toEqual(["Company research brief from the marketplace", "Vendor outage watch from the marketplace"]);
    expect([...host.querySelectorAll('[role="status"]')].map((s) => s.textContent)).toContain("2 of 2");
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Search templates"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "nothing like it");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect([...host.querySelectorAll('[role="status"]')].map((s) => s.textContent)).toContain("No templates match “nothing like it”.");
  });

  it("says a marketplace that failed, with Try again, and lists its templates once a try reads them; this server's own stay listed", async () => {
    const READ: MarketplaceList = { url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z", templates: [{ name: "vendor-outage-watch", title: "Vendor outage watch", tags: [], needs: [], page_url: "https://marketplace.example/templates/vendor-outage-watch/" }] };
    listMarketplaceTemplates.mockRejectedValueOnce(new Error("The marketplace is offline.")).mockResolvedValue(READ);
    await mount();
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("The marketplace is offline.");
    expect(host.querySelectorAll("article")).toHaveLength(catalog.length);
    await act(async () => button("Try again").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect([...host.querySelectorAll("article")].at(-1)!.getAttribute("aria-label")).toBe("Vendor outage watch from the marketplace");
  });

  it("a marketplace the server could not read now is said with Try again, which reads it again", async () => {
    listMarketplaceTemplates.mockResolvedValue({ url: "https://marketplace.example", state: "unreachable", read_at: null, problem: "It answered 503.", templates: [] });
    await mount();
    await act(async () => {});
    const note = [...host.querySelectorAll('[role="status"]')].find((s) => s.textContent?.startsWith("The marketplace couldn't be read"))!;
    expect(note.textContent).toContain("It answered 503.");
    expect(listMarketplaceTemplates).toHaveBeenCalledTimes(1);
    await act(async () => cardButton(note, "Try again").click());
    expect(listMarketplaceTemplates).toHaveBeenCalledTimes(2);
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
    // A word only the marketplace's summary has, which the card shows, finds it.
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Search templates"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "owns");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...host.querySelectorAll("article h3")].map((h) => h.textContent)).toEqual(["KYB due diligence"]);
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

// The Tools step: before the agent is created, pick its tools (the editor's own cards, the MCP servers saved in Settings
// among them) and where it runs. What is picked goes on the create request; a step left alone sends today's request.
describe("Build agent page, the Tools step", () => {
  const origin = "https://console.example.test";
  const caps: Pick<EditorCaps, "tools" | "places" | "mcp" | "mcpHarnesses"> = {
    tools: [
      { name: "web_fetch", available: true, harnesses: ["pi"], blurb: "Read a web page." },
      { name: "web_search", available: true, harnesses: ["pi"], blurb: "Search the web." },
      { name: "bash", available: true, harnesses: ["pi"], sandbox_only: true, blurb: "Run a shell command." },
    ],
    places: { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }], defaultPlace: { mode: "runner" } },
    mcp: true, mcpHarnesses: ["pi"],
  };
  const gmail: McpServer = {
    name: "gmail", url: "https://mcp.example.test/gmail", auth: { type: "none" }, source: "composio", toolkit: "gmail", credential: null,
    tools: [{ name: "GMAIL_SEND_EMAIL", description: "Send an email." }, { name: "GMAIL_FETCH_EMAILS", description: "Read the inbox." }],
  };
  const listMcpServers = vi.fn(async () => ({ servers: [gmail] }));
  const mountTools = async (given: ComponentProps<typeof BuildAgent>["caps"] = caps) => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(BuildAgent, { origin, v2: { listTemplates, listMarketplaceTemplates, listMcpServers }, caps: given })));
  };
  const toolsStep = () => host.querySelector<HTMLElement>('section[aria-label="Tools"]');
  const openTools = async () => {
    expect(button("Choose tools"), "the Tools step is offered").toBeDefined();
    await act(async () => button("Choose tools").click());
  };
  const tick = (grant: string) => act(async () => host.querySelector<HTMLInputElement>(`[data-tool-card="${grant}"] input[type="checkbox"]`)!.click());
  /** The created agent's request: the playground's Create an agent, opened on the draft Build hands it, sent. */
  const created = async (draft: string) => {
    const posts: { path: string; body: { definition: Record<string, unknown> } }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === "POST") posts.push({ path: new URL(url, origin).pathname, body });
      return new Response(JSON.stringify({ ...SERVED_AGENT, agent_id: "new-1", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: body?.definition ?? {} }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const requestHost = document.body.appendChild(document.createElement("div"));
    const requestRoot = createRoot(requestHost);
    await act(async () => requestRoot.render(createElement(AgentRequest, { v2: createClient({ fetch }), origin, operation: "create-agent", draft })));
    await act(async () => [...requestHost.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Send request")!.click());
    act(() => requestRoot.unmount());
    return posts;
  };
  const draftParam = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Build an agent"]')!.click());
    const href = document.querySelector<HTMLAnchorElement>('[role="menuitem"][href^="#/playground"]')!.getAttribute("href")!;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Build an agent"]')!.click());
    return new URLSearchParams(href.split("?")[1]).get("draft");
  };
  afterEach(() => listMcpServers.mockClear());

  it("shows a Tools step before the agent is created: the server's tools, its saved MCP servers and where it runs", async () => {
    await mountTools();
    expect(toolsStep(), "a Tools step on the create page").not.toBeNull();
    await openTools();
    for (const name of ["web_fetch", "web_search", "bash"]) expect(host.querySelector(`[data-tool-card="${name}"]`), `the ${name} card`).not.toBeNull();
    expect(host.querySelector('[aria-label="MCP server gmail"]'), "the gmail MCP server from Settings").not.toBeNull();
    expect(host.querySelector('[data-tool-card="mcp:gmail/GMAIL_SEND_EMAIL"]'), "gmail's send tool").not.toBeNull();
    expect(host.querySelector('[role="radiogroup"][aria-label="Where it runs"]'), "where it runs").not.toBeNull();
    expect(listMcpServers).toHaveBeenCalled();
  });

  it("puts a picked MCP tool from the gmail server on the created agent's request body and in the coding-agent prompt", async () => {
    await mountTools();
    typeBrief("Answer my email.");
    await openTools();
    await tick("mcp:gmail/GMAIL_SEND_EMAIL");
    await tick("web_fetch");
    const draft = await draftParam();
    expect(parseAgentDraft(draft)?.definition.tools, "the draft's tools").toEqual(["mcp:gmail/GMAIL_SEND_EMAIL", "web_fetch"]);
    const posts = await created(draft!);
    expect(posts.map((p) => p.path)).toEqual(["/v2/agents"]);
    expect(posts[0].body.definition.tools, "the created agent's tools").toEqual(["mcp:gmail/GMAIL_SEND_EMAIL", "web_fetch"]);
    await act(async () => button("Build an agent").click());
    expect(copied.mock.calls.at(-1)![0], "the coding agent is told the picked tools").toContain("mcp:gmail/GMAIL_SEND_EMAIL");
  });

  it("puts where it runs, picked in the same step, on the created agent's request body", async () => {
    await mountTools();
    typeBrief("Run my scripts.");
    await openTools();
    await act(async () => host.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Where it runs"] input[value="sandbox"]')!.click());
    await tick("bash");
    const draft = await draftParam();
    expect(parseAgentDraft(draft)?.definition.place, "the draft's place").toEqual({ mode: "sandbox", box: "docker" });
    const posts = await created(draft!);
    expect(posts[0].body.definition.place, "the created agent's place").toEqual({ mode: "sandbox", box: "docker" });
    expect(posts[0].body.definition.tools).toEqual(["bash"]);
  });

  it("reads the saved MCP servers when MCP turns on while the step is open, without closing and reopening it", async () => {
    // The capabilities answer after the step opened: until then the server says nothing of MCP.
    await mountTools({ ...caps, mcp: false });
    await openTools();
    expect(host.querySelector('[data-tool-card="mcp:gmail/GMAIL_SEND_EMAIL"]')).toBeNull();
    await act(async () => root!.render(createElement(BuildAgent, { origin, v2: { listTemplates, listMarketplaceTemplates, listMcpServers }, caps })));
    expect(listMcpServers, "the MCP servers are read once MCP is on").toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-tool-card="mcp:gmail/GMAIL_SEND_EMAIL"]'), "gmail's tools show in the open step").not.toBeNull();
  });

  it("says a tool the server denies for every agent is refused, and it can't be ticked", async () => {
    const denied = { ...caps, tools: [...caps.tools, { name: "read", available: true, harnesses: ["pi"], blurb: "Read a file." }],
      gates: [{ name: "read", permission: "deny" as const, default_permission: "allow" as const, permissions: ["allow" as const, "ask" as const, "deny" as const] }] };
    await mountTools(denied);
    await openTools();
    const card = host.querySelector<HTMLElement>('[data-tool-card="read"]')!;
    expect(card.textContent, "the card says the server refuses it").toContain(SERVER_DENY);
    expect(card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, "its box can't be ticked").toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-tool-card="web_fetch"] input[type="checkbox"]')!.disabled, "an allowed tool still can").toBe(false);
  });

  it("skipping the step keeps today's request: no tools picked, no place, the same prompt", async () => {
    await mountTools();
    typeBrief("Summarise the news.");
    await openTools();
    await act(async () => button("Done").click());
    expect(host.querySelector('[data-tool-card="web_fetch"]'), "the step closes").toBeNull();
    expect(parseAgentDraft(await draftParam())).toEqual(briefAgentDraft("Summarise the news."));
    await act(async () => button("Build an agent").click());
    expect(copied.mock.calls.at(-1)![0]).toBe(buildAgentPrompt(origin, "Summarise the news."));
    const posts = await created(JSON.stringify(briefAgentDraft("Summarise the news.")));
    expect(posts[0].body.definition.tools).toEqual([]);
    expect(posts[0].body.definition).not.toHaveProperty("place");
  });
});
