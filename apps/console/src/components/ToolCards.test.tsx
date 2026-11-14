import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { McpToolPicker } from "./McpToolPicker";
import { type Agent, toolOffers } from "@/lib/agentForm";
import type { McpServer } from "@/lib/mcp";

// The agent editor's Tools & skills grid: every collapsed card is one fixed height, the same component for every source
// (a built-in tool, an MCP server's). Each holds the tool's name, ONE human line (the served `blurb`, else its description
// clamped to three lines), its state as a one-line tag ("Sandbox-only", "Workflow only", else the reason itself, cut to
// one line) with the full reason in the tag's title, and More, which shows the rest in place, on that card alone.
// jsdom has no layout, so the structure is pinned here; the console e2e's tool-cards flow measures heights and widths in
// Chromium.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const FETCH_SUMMARY = "Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked, a part at a time.";
const LONG_NAME = "a_very_long_tool_name_for_the_worst_case_card";
const MCP_NAME = "mcp:github-enterprise/list_repository_collaborators_with_permissions";
const LONG_SUMMARY = "A tool with no blurb, whose description is the model's and runs well past three lines of a card: it says what it takes, what it returns, and every limit it has, at length, and then some more.";
const RAW = [
  { name: "web_fetch", available: true, summary: FETCH_SUMMARY, blurb: "Read a public web page", harnesses: ["pi"] },
  { name: "bash", available: true, summary: "Run a bash command in the run's box, from its work/.", blurb: "Run shell commands", sandbox_only: true, harnesses: ["pi"] },
  // The worst case: a long name, no blurb (the three-line fallback) and a tag.
  { name: LONG_NAME, available: true, summary: LONG_SUMMARY, sandbox_only: true, harnesses: ["pi"] },
  // Unavailable for a long reason: the tag is that reason, cut to one line by CSS, never a word in its place.
  { name: "browser", available: false, missing: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"], summary: "Drive a hosted browser.", blurb: "Browse the web", harnesses: ["pi"] },
  // An MCP server's tool: a long id with no spaces and no blurb, which tools from the same server share a prefix of.
  { name: MCP_NAME, available: true, summary: "List a repository's collaborators and their permissions.", harnesses: ["pi"] },
];
const agent: Agent = { agent_id: "a1", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "A", instructions: "x", harness: "pi", skills: [], tools: [] } };

async function open() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const caps = { harnesses: [{ id: "pi", available: true }], tools: toolOffers(RAW), thinking: [] };
  act(() => root!.render(createElement(AgentEditor, { agent, caps, step: "tools", onSave: async () => null })));
  await settle();
  const grid = [...host.querySelectorAll("ul")].find((u) => u.querySelector("input[type=checkbox][value]"))!;
  const card = (name: string) => grid.querySelector(`input[value="${name}"]`)!.closest("li")!.firstElementChild as HTMLElement;
  return { host, grid, card };
}
const button = (card: HTMLElement, label: string) => [...card.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the editor's tool cards", () => {
  it("reads the served blurb", () => {
    expect(toolOffers(RAW).map((t) => t.blurb)).toEqual(["Read a public web page", "Run shell commands", undefined, "Browse the web", undefined]);
  });

  it("are one fixed height, top-aligned in their row, with no description while collapsed", async () => {
    const { grid, card } = await open();
    expect(grid.classList.contains("items-start")).toBe(true);
    for (const name of ["web_fetch", "bash", LONG_NAME]) expect(card(name).classList.contains("h-36"), name).toBe(true);
    expect(card("web_fetch").textContent).not.toContain(FETCH_SUMMARY);
  });

  it("show one human line: the blurb on one line, else the description clamped to three", async () => {
    const { card } = await open();
    const blurb = [...card("web_fetch").querySelectorAll("span")].find((s) => s.textContent === "Read a public web page")!;
    expect(blurb.classList.contains("truncate")).toBe(true);
    const fallback = [...card(LONG_NAME).querySelectorAll("span")].find((s) => s.textContent === LONG_SUMMARY)!;
    expect(fallback.classList.contains("line-clamp-3")).toBe(true);
  });

  it("say their state in a short tag, the full reason in its title; the worst case's name and tag hold one line each", async () => {
    const { card } = await open();
    const tag = card("bash").querySelector("[data-tag]")!;
    expect(tag.textContent).toBe("Sandbox-only");
    expect(tag.getAttribute("title")).toMatch(/^Sandbox-only: /);
    expect(card("web_fetch").querySelector("[data-tag]")).toBeNull();
    // The name's own span (the innermost one holding it).
    const name = [...card(LONG_NAME).querySelectorAll("span")].find((s) => s.textContent === LONG_NAME && !s.querySelector("span"))!;
    expect(name.classList.contains("truncate")).toBe(true);
    expect(card(LONG_NAME).querySelector("[data-tag]")!.classList.contains("truncate")).toBe(true);
    // A long reason is the tag as it is, one line by CSS: the server's words, never a stand-in.
    const needs = card("browser").querySelector("[data-tag]")!;
    expect(needs.textContent).toBe("Needs BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID");
    expect(needs.getAttribute("title")).toBe("Needs BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID");
    expect(needs.classList.contains("truncate")).toBe(true);
  });

  it("More shows the description and the reason on that card alone, which may grow, and never ticks the tool; Less closes it", async () => {
    const { host, card } = await open();
    await act(async () => { button(card("bash"), "More")!.click(); });
    expect(card("bash").classList.contains("h-36")).toBe(false);
    expect(card("bash").textContent).toContain("Run a bash command in the run's box, from its work/.");
    expect(card("bash").textContent).toMatch(/Sandbox-only: /);
    expect(button(card("bash"), "Less")).toBeTruthy();
    expect(card("web_fetch").classList.contains("h-36")).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input[value='bash']")!.checked).toBe(false);
    await act(async () => { button(card("bash"), "Less")!.click(); });
    expect(card("bash").classList.contains("h-36")).toBe(true);
    expect(button(card("bash"), "More")).toBeTruthy();
  });

  it("a long name is cut to one line on the card, whole in its title, and whole, wrapping anywhere, under More", async () => {
    const { card } = await open();
    const name = () => [...card(MCP_NAME).querySelectorAll("span")].find((s) => s.textContent === MCP_NAME && !s.querySelector("span"))!;
    expect(name().classList.contains("truncate")).toBe(true);
    expect(name().getAttribute("title")).toBe(MCP_NAME);
    expect(card(MCP_NAME).classList.contains("h-36")).toBe(true);
    await act(async () => { button(card(MCP_NAME), "More")!.click(); });
    expect(name().classList.contains("truncate")).toBe(false);
    expect(name().classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(name().textContent).toBe(MCP_NAME);
    // Only the open card wraps its name: the others keep theirs to one line.
    const other = [...card(LONG_NAME).querySelectorAll("span")].find((s) => s.textContent === LONG_NAME && !s.querySelector("span"))!;
    expect(other.classList.contains("truncate")).toBe(true);
  });
});

// Manuel's #20: a card's hover title repeated what the card already showed (the reason over the whole card, a short
// description over itself). A title now says only what is cut or hidden, and an open card, which shows all of it, has none.
describe("the tool cards' hover titles", () => {
  const titled = (el: Element) => [el, ...el.querySelectorAll("[title]")].filter((e) => e.hasAttribute("title"));

  it("the card itself has none, and a short name, a blurb and a fully shown description have none", async () => {
    const { card } = await open();
    for (const name of ["web_fetch", "bash", "browser", LONG_NAME, MCP_NAME]) expect(card(name).hasAttribute("title"), name).toBe(false);
    // web_fetch: a short name, a blurb, no tag: nothing on it is cut, so nothing has a title.
    expect(titled(card("web_fetch"))).toEqual([]);
  });

  it("a title says only what is cut or hidden: a long name, a reason a short tag stands for, a description past three lines", async () => {
    const { card } = await open();
    const nameOf = (n: string) => [...card(n).querySelectorAll("span")].find((s) => s.textContent === n && !s.querySelector("span"))!;
    expect(nameOf(LONG_NAME).getAttribute("title")).toBe(LONG_NAME);
    expect(nameOf("bash").hasAttribute("title")).toBe(false);
    // "Sandbox-only" stands for a longer reason: that reason is its title, never the tag's own word.
    const tag = card("bash").querySelector("[data-tag]")!;
    expect(tag.getAttribute("title")).toMatch(/^Sandbox-only: /);
    expect(tag.getAttribute("title")).not.toBe(tag.textContent);
    expect(card(LONG_NAME).querySelector("[data-line]")!.getAttribute("title")).toBe(LONG_SUMMARY);
    // No title anywhere is just the text it sits on, unless that text is long enough to be cut on its one line.
    for (const name of ["web_fetch", "bash", "browser", LONG_NAME, MCP_NAME]) {
      for (const el of titled(card(name))) {
        if (el.getAttribute("title") === el.textContent) expect((el.textContent ?? "").length, `${name}: "${el.textContent}"`).toBeGreaterThan(32);
      }
    }
  });

  it("an open card shows everything, so it has no hover titles", async () => {
    const { card } = await open();
    await act(async () => { button(card("bash"), "More")!.click(); });
    expect(titled(card("bash"))).toEqual([]);
    await act(async () => { button(card(MCP_NAME), "More")!.click(); });
    expect(titled(card(MCP_NAME))).toEqual([]);
  });

  it("an MCP tool's short description has no title; a long one, clamped, has the whole of it", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const LONG = "Save comment: Create or update a comment on a Linear issue, project, initiative, document or milestone. If id is provided, updates the existing comment; otherwise creates a new one.";
    const server = { name: "linear", url: "https://mcp.linear.example/mcp", auth: { type: "none" }, credential: null, tools: [{ name: "get_team", description: "Get a team by id." }, { name: "save_comment", description: LONG }] } as McpServer;
    act(() => root!.render(createElement(McpToolPicker, { servers: [server], tools: [], harness: "pi", onChange: () => {} })));
    const line = (tool: string) => host.querySelector(`[data-tool-card="mcp:linear/${tool}"] [data-line]`)!;
    expect(line("get_team").hasAttribute("title")).toBe(false);
    expect(line("save_comment").getAttribute("title")).toBe(LONG);
  });
});

// Whether a line is cut is what the browser draws, never a count of characters: with a layout given (every element 200 px
// wide, its text 6 px a character), a refusal under the count's 60 characters but wider than its line is whole in its
// title and offers More; a short name, not cut, has no title.
describe("the tool cards' measured lines", () => {
  const sizes = ["clientWidth", "scrollWidth", "clientHeight", "scrollHeight"] as const;
  const kept = sizes.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  // jsdom keeps these on Element.prototype: a stub on HTMLElement.prototype is taken away again, never left for later tests.
  afterEach(() => { for (const [k, d] of kept) { if (d) Object.defineProperty(HTMLElement.prototype, k, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]; } });
  it("a refusal cut on its line, though under 60 characters, is whole in its title and offers More", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return (this.textContent ?? "").length * 6; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 48 });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 48 });
    const REFUSED = "claude-agent drops a tool whose root has anyOf";
    expect(REFUSED.length).toBeLessThan(60);
    const server = { name: "crm", url: "https://mcp.crm.example/mcp", auth: { type: "none" }, credential: null,
      tools: [{ name: "find", description: "Find a contact.", input_schema: { anyOf: [{ type: "object" }] }, grant_problems: { "claude-agent": REFUSED } }] } as McpServer;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(McpToolPicker, { servers: [server], tools: [], harness: "claude-agent", harnesses: ["pi", "claude-agent"], onChange: () => {} })));
    await settle();
    const card = host.querySelector<HTMLElement>('[data-tool-card="mcp:crm/find"]')!;
    const alert = card.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(REFUSED);
    expect(alert.getAttribute("title")).toBe(REFUSED);
    expect(button(card, "More")).toBeTruthy();
    const name = [...card.querySelectorAll("span")].find((s) => s.textContent === "find" && !s.querySelector("span"))!;
    expect(name.hasAttribute("title")).toBe(false);
  });
});

// Manuel's beta.33 report: an MCP server's tools (Linear's create_attachment, list_comments) printed their whole
// description, some cards 60 lines tall, and only built-in tools had More. The MCP picker's cards are the same ToolCard.
describe("an MCP server's tool cards", () => {
  const LONG = "Create attachment (deprecated): Deprecated fallback for tiny files only. Accepts base64 file content, verifies SHA-256 checksum, and uploads it through the MCP worker. Prefer `prepare_attachment_upload` plus direct PUT plus `create_attachment_from_upload`. ".repeat(6);
  const UNBROKEN = "QUJD".repeat(500);
  const server: McpServer = { name: "linear", url: "https://mcp.linear.example/mcp", auth: { type: "none" }, credential: null, not_metered: ["create_attachment", "list_comments", "get_team", "upload_blob"],
    tools: [
      { name: "create_attachment", description: LONG },
      { name: "get_team", description: "Get a team by id." },
      { name: "upload_blob", description: `Example: ${UNBROKEN}` },
      { name: "list_comments", description: LONG },
    ] } as McpServer;
  function picker() {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(McpToolPicker, { servers: [server], tools: [], harness: "pi", onChange: () => {} })));
    const card = (tool: string) => host.querySelector<HTMLElement>(`[data-tool-card="mcp:linear/${tool}"]`)!;
    const line = (tool: string) => card(tool).querySelector<HTMLElement>("[data-line]");
    return { host, card, line };
  }

  it("a long description is clamped to three lines, whole in its title, on a card of the same fixed height", () => {
    const { card, line } = picker();
    expect(card("create_attachment").classList.contains("h-36")).toBe(true);
    expect(line("create_attachment")!.classList.contains("line-clamp-3")).toBe(true);
    expect(line("create_attachment")!.getAttribute("title")).toBe(LONG);
    expect(card("create_attachment").textContent).toContain("not metered");
  });

  it("More opens that card alone, Less closes it; the others stay clamped", async () => {
    const { card } = picker();
    await act(async () => { button(card("create_attachment"), "More")!.click(); });
    expect(card("create_attachment").classList.contains("h-36")).toBe(false);
    expect(card("create_attachment").querySelector("[data-more]")!.textContent).toContain(LONG.trim());
    expect(card("list_comments").classList.contains("h-36")).toBe(true);
    expect(button(card("list_comments"), "More")).toBeTruthy();
    await act(async () => { button(card("create_attachment"), "Less")!.click(); });
    expect(card("create_attachment").classList.contains("h-36")).toBe(true);
  });

  it("a short description keeps the card's height, with no More", () => {
    const { card } = picker();
    expect(card("get_team").classList.contains("h-36")).toBe(true);
    expect(button(card("get_team"), "More")).toBeUndefined();
  });

  it("a 2000-character unbroken string wraps anywhere in a card that can't grow wider than its column, collapsed and open", async () => {
    const { card, line } = picker();
    expect(card("upload_blob").classList.contains("min-w-0")).toBe(true);
    expect(card("upload_blob").closest("li")!.classList.contains("min-w-0")).toBe(true);
    expect(line("upload_blob")!.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    await act(async () => { button(card("upload_blob"), "More")!.click(); });
    expect([...card("upload_blob").querySelectorAll("[data-more] span")].find((s) => s.textContent?.includes(UNBROKEN))!.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  });
});
