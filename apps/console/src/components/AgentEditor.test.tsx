import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";

const tools = [{ name: "read", available: true }, { name: "write", available: true }, { name: "web_fetch", available: true }];
const caps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }], tools, thinking: ["low"] };

// Tools are on by default: a new agent starts with what its harness runs here ticked, and says when it can't reach the web.
describe("AgentEditor, a new agent's tools", () => {
  it("starts with the harness's tools ticked, and the server's tool objects render as their names", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    expect((html.match(/checked=""/g) ?? []).length).toBe(3);
    expect(html).toContain("web_fetch");
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("says the agent can't reach the web when web_fetch is not among its tools", () => {
    const noWeb = { ...caps, tools: tools.filter((t) => t.name !== "web_fetch") };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: noWeb, step: "tools" }));
    expect(html).toContain("can&#x27;t reach the web");
  });
  const webFetch = { name: "web_fetch", available: true, summary: "Read one public web page through Parallel's extract." };
  const withWebFetch = { ...caps, tools: [...tools.filter((t) => t.name !== "web_fetch"), webFetch] };
  it("an agent whose only tool is web_fetch reaches the web: no notice", () => {
    const reader = { agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["web_fetch"] } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: reader, caps: withWebFetch, step: "tools" }));
    expect((html.match(/checked=""/g) ?? []).length).toBe(1);
    expect(html.match(/<input[^>]*value="web_fetch"[^>]*>/)?.[0]).toContain('checked=""');
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("an agent with no web tool is told which to tick, or that its harness runs none here", () => {
    const reader = { agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["read"] } };
    const both = withWebFetch;
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: reader, caps: both, step: "tools" }))).toContain("tick web_fetch in Tools.");
    const piOnly = { ...both, tools: both.tools.map((t) => ({ ...t, harnesses: t.name === "read" ? ["pi", "codex"] : ["pi"] })) };
    const onCodex = { ...reader, definition: { ...reader.definition, harness: "codex" } };
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: onCodex, caps: piOnly, step: "tools" }))).toContain("codex runs no web tool on this server.");
  });
  it("the tools step shows web_fetch from the server's capabilities, with what it does", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: withWebFetch, step: "tools" }));
    expect(html).toContain('value="web_fetch"');
    expect(html).toContain("Read one public web page through Parallel&#x27;s extract.");
  });
});

// An agent given no web tool on purpose (a file-only agent) is not nagged on every step: the Tools step says it quietly.
describe("AgentEditor, an agent with no web tool on purpose", () => {
  const files = { agent_id: "files", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Files", instructions: "Tidy the files.", harness: "pi", skills: [], tools: ["read", "write"] } };
  it("shows no page-level notice on a step other than Tools", () => {
    for (const step of ["context", "settings", "history"] as const) {
      expect(renderToStaticMarkup(createElement(AgentEditor, { agent: files, caps, step }))).not.toContain("can&#x27;t reach the web");
    }
  });
  it("says it on the Tools step, inside the step, with the same plain words", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: files, caps, step: "tools" }));
    const section = html.slice(html.indexOf("<section"));
    expect(section).toContain("This agent can&#x27;t reach the web: tick web_fetch in Tools.");
    expect(html.slice(0, html.indexOf("<section"))).not.toContain("can&#x27;t reach the web");
  });
});

// On a phone (375 px) the name gets the row: the kind chip, revision count and Archive sit in their own row under it,
// and the step rail shows step numbers, the labels kept for screen readers.
describe("AgentEditor, on a narrow screen", () => {
  const agent = { agent_id: "qa", kind: "agentic" as const, revision: "r1", revisions: 3, archived_at: null, definition: { version: 1, name: "QA pi", instructions: "Answer.", harness: "pi", skills: [], tools: ["read"] } };
  it("puts the badges in a row of their own, full width below the sm breakpoint", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "context", onArchive: () => {} }));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const row = header.match(/<div class="([^"]*)" role="group" aria-label="About this agent">([\s\S]*)<\/div>/);
    expect(row?.[1].split(" ")).toEqual(expect.arrayContaining(["basis-full", "sm:basis-auto"]));
    expect(row?.[2]).toContain("agentic");
    expect(row?.[2]).toContain("3 revisions");
    expect(row?.[2]).toContain("Archive");
    expect(row?.[2]).not.toContain("QA pi");
  });
  it("shows step numbers only below md: each step's label is for screen readers there", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "context" }));
    const rail = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
    const narrow = [...rail.matchAll(/<span class="([^"]*md:hidden[^"]*)">([^<]*)<\/span>/g)];
    expect(narrow.map((m) => m[2])).toEqual(["Context", "Tools &amp; skills", "Settings", "History"]);
    for (const m of narrow) expect(m[1].split(" ")).toContain("sr-only");
  });
});

describe("AgentEditor, a new agent whose server capabilities arrive after it opens", () => {
  it("ticks the harness's tools once they arrive, as a page does when /v2/capabilities answers late", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(AgentEditor, { agent: null, caps: { ...caps, tools: [] }, step: "tools" })));
    expect(host.querySelectorAll("input[type=checkbox]:checked").length).toBe(0);
    act(() => root.render(createElement(AgentEditor, { agent: null, caps, step: "tools" })));
    expect(host.querySelectorAll("input[type=checkbox]:checked").length).toBe(3);
    expect(host.textContent).not.toContain("can't reach the web");
    act(() => root.unmount());
  });
});

describe("AgentEditor, tools a person chose by hand", () => {
  const setup = async (props: Record<string, unknown>) => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(AgentEditor, props as never)));
    const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
    const checked = () => [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].filter((i) => i.checked).map((i) => i.value);
    return { host, click, checked, done: () => act(() => root.unmount()) };
  };
  const both = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "codex", available: true }], tools: [...tools, { name: "ask_person", available: true }] };

  it("keeps a hand-picked set when the harness changes", async () => {
    const { host, click, checked, done } = await setup({ agent: null, caps: both, step: "tools" });
    const fetchBox = host.querySelector<HTMLInputElement>('input[type=checkbox][value="web_fetch"]');
    click(fetchBox);
    const picked = checked();
    expect(picked).not.toContain("web_fetch");
    click([...host.querySelectorAll("button")].find((b) => /Settings/.test(b.textContent ?? "")));
    click(host.querySelector('input[type=radio][value="codex"]'));
    click([...host.querySelectorAll("button")].find((b) => /Tools/.test(b.textContent ?? "")));
    expect(checked()).toEqual(picked);
    done();
  });

  it("an existing agent whose definition names no tools opens with none ticked, never the defaults", async () => {
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [] } };
    let saved: { tools?: string[] } | undefined;
    const { host, click, checked, done } = await setup({ agent, caps: both, step: "tools", onSave: async (fields: { tools?: string[] }) => { saved = fields; return null; } });
    expect(checked()).toEqual([]);
    // A save (of an edit to the instructions) sends none: it never widens what the agent can do.
    const { act } = await import("react");
    click([...host.querySelectorAll("button")].find((b) => /Context/.test(b.textContent ?? "")));
    act(() => {
      const el = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "Answer, then check.");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /Save revision/i.test(b.textContent ?? ""))!.click(); });
    expect(saved?.tools ?? []).toEqual([]);
    done();
  });
});

describe("AgentEditor, a new decision agent", () => {
  const mount = async (props: Record<string, unknown>) => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(AgentEditor, props as never)));
    const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
    const type = (el: Element | null, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return { host, click, button, type, act, done: () => act(() => root.unmount()) };
  };

  it("picks Decision in the harness picker on create: no instructions, tools or thinking to fill, and Create sends the choice", async () => {
    let saved: { harness?: string; name?: string } | undefined;
    const { host, click, button, type, act, done } = await mount({ agent: null, caps: { ...caps, decisionProvider: "jev" }, step: "settings", onSave: async (fields: { harness?: string; name?: string }) => { saved = fields; return null; } });
    const decision = host.querySelector<HTMLInputElement>('input[type=radio][value="decision"]');
    expect(decision?.disabled).toBe(false);
    click(decision);
    expect(host.querySelector('[role=radiogroup][aria-label="Thinking"]')).toBeNull();
    expect(button(/Tools/)).toBeUndefined();
    click(button(/Context/));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Workflow step");
    type(host.querySelector('input[placeholder="e.g., Invoice checker"]'), "Gambling check");
    await act(async () => { button(/^Create$/)!.click(); });
    expect(saved).toMatchObject({ harness: "decision", name: "Gambling check" });
    done();
  });

  it("shows Decision disabled, with why, when the server runs no decision workflows", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "settings" }));
    const radio = html.match(/<input type="radio" name="harness"[^>]*value="decision"[^>]*>/)?.[0];
    expect(radio).toContain('disabled=""');
    expect(html).toContain("decision workflows");
  });

  it("lays the picker out by a minimum card width, five choices with Decision and Workflow, three without: as many columns as fit", () => {
    const three = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }] };
    const group = (html: string) => html.match(/<div class="([^"]*)" role="radiogroup" aria-label="Harness"/)?.[1] ?? "";
    const cards = (html: string) => (html.match(/name="harness"/g) ?? []).length;
    const fit = "grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))]";
    const five = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...three, decisionProvider: "jev" }, step: "settings" }));
    expect([group(five).split(" ").includes(fit), cards(five)]).toEqual([true, 5]);
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    const editing = renderToStaticMarkup(createElement(AgentEditor, { agent: agent as never, caps: three, step: "settings" }));
    expect([group(editing).split(" ").includes(fit), cards(editing)]).toEqual([true, 3]);
  });

  it("offers no Decision and no Workflow when editing an agent", () => {
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent as never, caps: { ...caps, decisionProvider: "jev" }, step: "settings" }));
    expect(html).not.toContain('value="decision"');
    expect(html).not.toContain('value="workflow"');
  });

  it("picks Workflow on a server with no decision provider: enabled where Decision is not, no instructions, tools, thinking or model to fill, and Create sends the choice", async () => {
    let saved: { harness?: string; name?: string } | undefined;
    const { host, click, button, type, act, done } = await mount({ agent: null, caps, step: "settings", onSave: async (fields: { harness?: string; name?: string }) => { saved = fields; return null; } });
    expect(host.querySelector<HTMLInputElement>('input[type=radio][value="decision"]')?.disabled).toBe(true);
    const general = host.querySelector<HTMLInputElement>('input[type=radio][value="workflow"]');
    expect(general?.disabled).toBe(false);
    click(general);
    expect(host.querySelector('[role=radiogroup][aria-label="Thinking"]')).toBeNull();
    expect(host.querySelector('input[placeholder="provider/model"]')).toBeNull();
    expect(button(/Tools/)).toBeUndefined();
    click(button(/Context/));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("paste a workflow's JSON over it, in the Workflow step");
    type(host.querySelector('input[placeholder="e.g., Invoice checker"]'), "Next steps");
    await act(async () => { button(/^Create$/)!.click(); });
    expect(saved).toMatchObject({ harness: "workflow", name: "Next steps" });
    done();
  });
});


// A harness this server doesn't run: its card says so briefly (from the served available: false), and the server's whole
// reason (an install command with it) is a tap away in a details line, which wraps inside the card: nothing hover-only,
// and nothing spills out of a narrow card.
describe("AgentEditor, a harness this server doesn't run", () => {
  const REASON = "Claude Agent SDK not installed: @anthropic-ai/claude-agent-sdk 0.3.286 is not installed beside @parcha/agentrun-harness-claude, and no module was given (sdk); install it with: npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286; once it is installed, restart AgentRun to pick it up.";
  const off = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: false, reason: REASON }] };
  const cardOf = (html: string, id: string) => {
    const at = html.indexOf(`value="${id}"`);
    const start = html.lastIndexOf('<div class="', at);
    return { html: html.slice(start, html.indexOf("</details>", at) + 10), cls: /^<div class="([^"]*)"/.exec(html.slice(start))![1]!.split(" ") };
  };
  it("shows a short label in the card and the full reason in a details line that wraps, and the card can shrink", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: off, step: "settings" }));
    const card = cardOf(html, "claude-agent");
    expect(card.cls).toContain("min-w-0");
    expect(card.html).toContain("Not available here");
    const details = /<details[^>]*>([\s\S]*?)<\/details>/.exec(card.html);
    expect(details).toBeTruthy();
    expect(details![1]).toMatch(/<summary[^>]*>/);
    expect(details![1]).toContain("npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286");
    expect(/<details[^>]*>[\s\S]*?<p class="([^"]*)"/.exec(card.html)![1]!.split(" ")).toContain("break-words");
    // The reason is not in the card's own line any more, nor only in a hover title.
    expect(card.html.slice(0, card.html.indexOf("<details"))).not.toContain("npm install");
    expect(card.html).not.toMatch(/title="Claude Agent SDK/);
  });
  it("gives an available harness no details line", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: off, step: "settings" }));
    const at = html.indexOf('value="pi"');
    const next = html.indexOf('value="claude-agent"');
    expect(html.slice(at, next)).not.toContain("<details");
  });
});

// A phone on its side (844x390) leaves the step's pane about 300 px wide. The tool cards and the harness cards size their
// columns by a minimum width, so a narrow pane gets fewer columns (one tool card a row; harness cards that wrap), never
// cards squeezed until their text runs tall or overlaps.
describe("AgentEditor, card grids in a narrow pane", () => {
  const classOf = (html: string, marker: RegExp) => marker.exec(html)?.[1]?.split(" ") ?? [];
  it("lays the tool cards out by a minimum column width, not two columns from sm up", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    const cls = classOf(html, /<ul class="([^"]*)"/);
    expect(cls).toContain("grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]");
    expect(cls).not.toContain("sm:grid-cols-2");
  });
  it("lays the harness cards out by a minimum card width, and a card's name wraps rather than running into the next", () => {
    const five = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: false, reason: "codex needs OPENAI_API_KEY." }] };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...five, decisionProvider: "jev" }, step: "settings" }));
    const cls = classOf(html, /<div class="([^"]*)" role="radiogroup" aria-label="Harness"/);
    expect(cls).toContain("grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))]");
    expect(cls.some((c) => /^sm:grid-cols-\d$/.test(c))).toBe(false);
    const name = /<span class="([^"]*)">Decision<\/span>/.exec(html)?.[1]?.split(" ") ?? [];
    expect(name).toContain("break-words");
  });
});
