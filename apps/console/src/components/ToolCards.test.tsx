import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, toolOffers } from "@/lib/agentForm";

// The agent editor's Tools & skills grid: every collapsed card is one height. Each holds the tool's name, ONE human
// line (the served `blurb`, else its description clamped to two lines), its state as a one-line tag ("Sandbox-only",
// "Workflow only", else the reason itself, cut to one line) with the full reason in
// the tag's title, and Details, which shows the model-facing description and the reason in place, on that card alone.
// jsdom has no layout, so the structure is pinned here; the walk measures heights and overflow in Chromium.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const FETCH_SUMMARY = "Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked, a part at a time.";
const LONG_NAME = "a_very_long_tool_name_for_the_worst_case_card";
const MCP_NAME = "mcp:github-enterprise/list_repository_collaborators_with_permissions";
const LONG_SUMMARY = "A tool with no blurb, whose description is the model's and runs well past two lines of a card: it says what it takes, what it returns, and every limit it has, at length.";
const RAW = [
  { name: "web_fetch", available: true, summary: FETCH_SUMMARY, blurb: "Read a public web page", harnesses: ["pi"] },
  { name: "bash", available: true, summary: "Run a bash command in the run's box, from its work/.", blurb: "Run shell commands", sandbox_only: true, harnesses: ["pi"] },
  // The worst case: a long name, no blurb (the two-line fallback) and a tag.
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

describe("the editor's tool cards", () => {
  it("reads the served blurb", () => {
    expect(toolOffers(RAW).map((t) => t.blurb)).toEqual(["Read a public web page", "Run shell commands", undefined, "Browse the web", undefined]);
  });

  it("are one fixed height, top-aligned in their row, with no description while collapsed", async () => {
    const { grid, card } = await open();
    expect(grid.classList.contains("items-start")).toBe(true);
    for (const name of ["web_fetch", "bash", LONG_NAME]) expect(card(name).classList.contains("h-32"), name).toBe(true);
    expect(card("web_fetch").textContent).not.toContain(FETCH_SUMMARY);
  });

  it("show one human line: the blurb on one line, else the description clamped to two", async () => {
    const { card } = await open();
    const blurb = [...card("web_fetch").querySelectorAll("span")].find((s) => s.textContent === "Read a public web page")!;
    expect(blurb.classList.contains("truncate")).toBe(true);
    const fallback = [...card(LONG_NAME).querySelectorAll("span")].find((s) => s.textContent === LONG_SUMMARY)!;
    expect(fallback.classList.contains("line-clamp-2")).toBe(true);
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

  it("Details shows the description and the reason on that card alone, which may grow, and never ticks the tool", async () => {
    const { host, card } = await open();
    const details = [...card("bash").querySelectorAll("button")].find((b) => b.textContent === "Details")!;
    await act(async () => { details.click(); });
    expect(card("bash").classList.contains("h-32")).toBe(false);
    expect(card("bash").textContent).toContain("Run a bash command in the run's box, from its work/.");
    expect(card("bash").textContent).toMatch(/Sandbox-only: /);
    expect([...card("bash").querySelectorAll("button")].some((b) => b.textContent === "Hide details")).toBe(true);
    expect(card("web_fetch").classList.contains("h-32")).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input[value='bash']")!.checked).toBe(false);
  });

  it("a long name is cut to one line on the card, whole in its title, and whole, wrapping, in Details", async () => {
    const { card } = await open();
    const name = () => [...card(MCP_NAME).querySelectorAll("span")].find((s) => s.textContent === MCP_NAME && !s.querySelector("span"))!;
    expect(name().classList.contains("truncate")).toBe(true);
    expect(name().getAttribute("title")).toBe(MCP_NAME);
    expect(card(MCP_NAME).classList.contains("h-32")).toBe(true);
    const details = [...card(MCP_NAME).querySelectorAll("button")].find((b) => b.textContent === "Details")!;
    await act(async () => { details.click(); });
    expect(name().classList.contains("truncate")).toBe(false);
    expect(name().classList.contains("break-all")).toBe(true);
    expect(name().textContent).toBe(MCP_NAME);
    // Only the open card wraps its name: the others keep theirs to one line.
    const other = [...card(LONG_NAME).querySelectorAll("span")].find((s) => s.textContent === LONG_NAME && !s.querySelector("span"))!;
    expect(other.classList.contains("truncate")).toBe(true);
  });
});
