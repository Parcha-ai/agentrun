import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { DECISION, WORKFLOW } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { optionsOf, pick, picker } from "@/test/picker";

const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "web_fetch", available: true, harnesses: ["pi"] }];
const caps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }], tools, thinking: ["low"] };

// Tools are on by default: a new agent starts with what its harness runs here ticked, and says when it can't reach the web.
describe("AgentEditor, a new agent's tools", () => {
  it("starts with the harness's tools ticked, and the server's tool objects render as their names", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    // The tools ticked (the Approvals choice below them is a radio of its own).
    expect((html.match(/<input type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(3);
    expect(html).toContain("web_fetch");
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("says the agent can't reach the web when web_fetch is not among its tools", () => {
    const noWeb = { ...caps, tools: tools.filter((t) => t.name !== "web_fetch") };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: noWeb, step: "tools" }));
    expect(html).toContain("can&#x27;t reach the web");
  });
  const webFetch = { name: "web_fetch", available: true, summary: "Read one public web page through Parallel's extract.", harnesses: ["pi"] };
  const withWebFetch = { ...caps, tools: [...tools.filter((t) => t.name !== "web_fetch"), webFetch] };
  it("an agent whose only tool is web_fetch reaches the web: no notice", () => {
    const reader = { ...SERVED_AGENT, agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["web_fetch"] } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: reader, caps: withWebFetch, step: "tools" }));
    expect((html.match(/<input type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(1);
    expect(html.match(/<input[^>]*value="web_fetch"[^>]*>/)?.[0]).toContain('checked=""');
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("an agent with no web tool is told which to tick, or that its harness runs none here", () => {
    const reader = { ...SERVED_AGENT, agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["read"] } };
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
  const files = { ...SERVED_AGENT, agent_id: "files", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Files", instructions: "Tidy the files.", harness: "pi", skills: [], tools: ["read", "write"] } };
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

// On a phone (375 px) the name gets the row: the kind chip and revision count sit in their own row under it,
// and the settings picker names the current section. New agents use the same sections.
describe("AgentEditor, on a narrow screen", () => {
  const agent = { ...SERVED_AGENT, agent_id: "qa", kind: "agentic" as const, revision: "r1", revisions: 3, archived_at: null, definition: { version: 1, name: "QA pi", instructions: "Answer.", harness: "pi", skills: [], tools: ["read"] } };
  it("keeps the badges together and the named Archive icon at the right of the header", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "context", onArchive: () => {} }));
    const header = host.querySelector("header")!;
    const row = header.querySelector('[role="group"][aria-label="About this agent"]')!;
    expect([...row.classList]).toEqual(expect.arrayContaining(["basis-full", "sm:basis-auto"]));
    expect(row.textContent).toContain("agentic");
    expect(row.textContent).toContain("3 revisions");
    expect(row.textContent).not.toContain("QA pi");
    const archive = header.querySelector('button[aria-label="Archive"]')!;
    expect(archive).toBeTruthy();
    expect(archive.textContent?.trim()).toBe("");
    expect(archive.getAttribute("title")).toBe("Archive");
    expect(row.contains(archive)).toBe(false);
    expect(header.lastElementChild).toBe(archive);
    expect(archive.classList.contains("ml-auto")).toBe(true);
  });
  it("names the current settings section on narrow screens without reducing it to a number", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "context" }));
    const menu = host.querySelector('nav[aria-label="Agent settings sections"]');
    const picker = menu?.querySelector('button[aria-label="Settings section"]');
    expect(picker?.textContent).toBe("General");
    expect(picker?.querySelector(".sr-only")).toBeNull();
    expect(menu?.querySelector('[aria-current="page"]')?.textContent?.trim()).toMatch(/^General/);
    expect(menu?.querySelector('[aria-current="step"], .lucide-check')).toBeNull();
    expect(host.textContent).not.toMatch(/Step \d/);
  });
  it("uses the settings sections for a new agent without a numbered wizard", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...caps, learning: "on" }, step: "context" }));
    const nav = host.querySelector('nav[aria-label="Agent settings sections"]');
    expect(nav?.querySelector('button[aria-label="Settings section"]')?.textContent).toBe("General");
    expect([...nav!.querySelectorAll("ul button")].map(b => b.textContent?.trim())).toEqual([
      "GeneralName, description and instructions", "ToolsWhat this agent can do", "SkillsSkill files saved with this revision", "Model & runtimeRuntime, model and spending", "LearningCorrections and reusable workflows",
    ]);
    expect(host.querySelector('[aria-current="step"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Step \d|Previous|Next/);
    expect(host.querySelector('input[aria-label="Revision note"]')).toBeNull();
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
  const both = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "codex", available: true }], tools: [...tools, { name: "ask_person", available: true, harnesses: ["pi"] }] };

  it("keeps every tool on a module's harness the server offers them on, as on pi: none comes off and no card is disabled", async () => {
    // The server lists a module's harness on each tool its runs get (serve's toolsView): pi's, on the general spec.
    const onModule = (ids: string[]) => (ids.includes("pi") ? [...ids, "own"] : ids);
    const withModule = { ...both, harnesses: [...both.harnesses, { id: "own", label: "Own", available: true }], tools: both.tools.map((t) => ({ ...t, harnesses: onModule(t.harnesses) })), mcpHarnesses: ["pi", "claude-agent", "codex", "opencode", "own"] };
    const { host, click, checked, done } = await setup({ agent: null, caps: withModule, step: "tools" });
    const picked = checked();
    expect(picked).toEqual(["ask_person", "read", "write", "web_fetch"]);
    click([...host.querySelectorAll("button")].find((b) => /Model & runtime/.test(b.textContent ?? "")));
    await pick(picker(host, "Runtime")!, "own");
    click([...host.querySelectorAll("button")].find((b) => /Tools/.test(b.textContent ?? "")));
    expect(checked()).toEqual(picked);
    expect([...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].filter((i) => i.disabled).map((i) => i.value)).toEqual([]);
    done();
  });

  it("keeps a hand-picked set when the harness changes, less what the new harness doesn't run, which a switch back ticks again", async () => {
    const { host, click, checked, done } = await setup({ agent: null, caps: both, step: "tools" });
    const fetchBox = host.querySelector<HTMLInputElement>('input[type=checkbox][value="web_fetch"]');
    click(fetchBox);
    const picked = checked();
    expect(picked).not.toContain("web_fetch");
    click([...host.querySelectorAll("button")].find((b) => /Model & runtime/.test(b.textContent ?? "")));
    await pick(picker(host, "Runtime")!, "codex");
    click([...host.querySelectorAll("button")].find((b) => /Tools/.test(b.textContent ?? "")));
    // codex runs only the file tools here (no `harnesses` served: the server's own rule): ask_person comes off.
    expect(checked()).toEqual(picked.filter((t) => t !== "ask_person"));
    click([...host.querySelectorAll("button")].find((b) => /Model & runtime/.test(b.textContent ?? "")));
    await pick(picker(host, "Runtime")!, "pi");
    click([...host.querySelectorAll("button")].find((b) => /Tools/.test(b.textContent ?? "")));
    expect(checked()).toEqual(picked);
    done();
  });

  it("an existing agent whose definition names no tools opens with none ticked, never the defaults", async () => {
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [] } };
    let saved: { tools?: string[] } | undefined;
    const { host, click, checked, done } = await setup({ agent, caps: both, step: "tools", onSave: async (fields: { tools?: string[] }) => { saved = fields; return null; } });
    expect(checked()).toEqual([]);
    // A save (of another edit: with none, Save is off) sends none: it never widens what the agent can do.
    const { act } = await import("react");
    click(host.querySelector('fieldset[aria-label="Tool approvals"] input[type="radio"][value="never"]'));
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
    expect((await optionsOf(picker(host, "Runtime")!)).find(option => option.value === DECISION)?.disabled).toBe(false);
    await pick(picker(host, "Runtime")!, DECISION);
    expect(picker(host, "Thinking")).toBeNull();
    expect(button(/Tools/)).toBeUndefined();
    click(button(/General/));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Workflow step");
    type(host.querySelector('input[placeholder="e.g., Invoice checker"]'), "Gambling check");
    await act(async () => { button(/^Create$/)!.click(); });
    expect(saved).toMatchObject({ harness: DECISION, name: "Gambling check" });
    done();
  });

  it("shows Decision disabled, with why, when the server runs no decision workflows", async () => {
    const { host, done } = await mount({ agent: null, caps, step: "settings" });
    expect((await optionsOf(picker(host, "Runtime")!)).find(option => option.value === DECISION)?.disabled).toBe(true);
    expect(host.querySelector("details")?.textContent).toContain("decision workflows");
    done();
  });

  it("offers five runtime choices when creating, including Decision and Workflow", async () => {
    const three = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }], decisionProvider: "jev" };
    const { host, done } = await mount({ agent: null, caps: three, step: "settings" });
    expect((await optionsOf(picker(host, "Runtime")!)).map(option => option.value)).toEqual(["pi", "claude-agent", "codex", DECISION, WORKFLOW]);
    expect(host.querySelector('input[type="radio"][name="harness"]')).toBeNull();
    done();
  });

  it("offers no Decision and no Workflow when editing an agent", async () => {
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    const { host, done } = await mount({ agent, caps: { ...caps, decisionProvider: "jev" }, step: "settings" });
    expect((await optionsOf(picker(host, "Runtime")!)).map(option => option.value)).toEqual(["pi", "claude-agent"]);
    done();
  });

  it("picks Workflow on a server with no decision provider: enabled where Decision is not, no instructions, tools, thinking or model to fill, and Create sends the choice", async () => {
    let saved: { harness?: string; name?: string } | undefined;
    const { host, click, button, type, act, done } = await mount({ agent: null, caps, step: "settings", onSave: async (fields: { harness?: string; name?: string }) => { saved = fields; return null; } });
    const options = await optionsOf(picker(host, "Runtime")!);
    expect(options.find(option => option.value === DECISION)?.disabled).toBe(true);
    expect(options.find(option => option.value === WORKFLOW)?.disabled).toBe(false);
    await pick(picker(host, "Runtime")!, WORKFLOW);
    expect(picker(host, "Thinking")).toBeNull();
    expect(picker(host, "Model")).toBeNull();
    expect(button(/Tools/)).toBeUndefined();
    click(button(/General/));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("paste a workflow's JSON over it, in the Workflow step");
    type(host.querySelector('input[placeholder="e.g., Invoice checker"]'), "Next steps");
    await act(async () => { button(/^Create$/)!.click(); });
    expect(saved).toMatchObject({ harness: WORKFLOW, name: "Next steps" });
    done();
  });
});


// Runtime setup remains accessible by keyboard or touch and keeps long install instructions inside the pane.
describe("AgentEditor, a runtime this server doesn't run", () => {
  const REASON = "Claude Agent SDK not installed: @anthropic-ai/claude-agent-sdk 0.3.286 is not installed beside @parcha/agentrun-harness-claude, and no module was given (sdk); install it with: npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286; once it is installed, restart AgentRun to pick it up.";
  const off = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: false, reason: REASON }] };
  it("keeps the full setup reason in a collapsed disclosure with wrapping text", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: off, step: "settings" }));
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Runtime setup");
    const claude = [...details.querySelectorAll("dt")].find(term => term.textContent === "Claude")!;
    expect(claude.nextElementSibling?.textContent).toBe(REASON);
    expect(claude.nextElementSibling?.classList.contains("break-words")).toBe(true);
    expect(claude.parentElement?.classList.contains("min-w-0")).toBe(true);
    expect(picker(host, "Runtime")?.textContent).not.toContain("npm install");
    expect(picker(host, "Runtime")?.getAttribute("title")).toBeNull();
  });
  it("lists setup reasons only for unavailable runtimes", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: off, step: "settings" }));
    const names = [...host.querySelectorAll("details dt")].map(term => term.textContent);
    expect(names).toContain("Claude");
    expect(names).not.toContain("Pi");
  });
});

// Tool cards adapt to a narrow pane; runtime settings use an ordered form instead of a card grid.
describe("AgentEditor, card grids in a narrow pane", () => {
  const classOf = (html: string, marker: RegExp) => marker.exec(html)?.[1]?.split(" ") ?? [];
  it("lays the tool cards out by a minimum column width, not two columns from sm up", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    const cls = classOf(html.slice(html.indexOf("<fieldset")), /<ul class="([^"]*)"/);
    expect(cls).toContain("grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]");
    expect(cls).not.toContain("sm:grid-cols-2");
  });
  it("groups Runtime, Model and Thinking before Spending, with Learning in its own navigation section during creation", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...caps, learning: "on" }, step: "settings" }));
    const runtime = picker(host, "Runtime")!;
    const model = picker(host, "Model")!;
    const thinking = picker(host, "Thinking")!;
    const cap = host.querySelector("#agent-max-cost")!;
    const runtimeSection = runtime.closest("section")!;
    const learning = host.querySelector('[role="switch"][aria-labelledby="learning-switch"]');
    expect(learning).toBeNull();
    expect([runtimeSection, cap.closest("section")!].map(section => section.querySelector("h2")?.textContent)).toEqual(["Runtime & model", "Spending"]);
    expect(runtimeSection.contains(model)).toBe(true);
    expect(runtimeSection.contains(thinking)).toBe(true);
    expect(runtimeSection.contains(cap)).toBe(false);
    expect(runtime.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinking.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cap.closest("section")?.contains(learning)).toBe(false);
    expect([...host.querySelectorAll("[class]")].some(element => /(?:^|[ :])columns-/.test(element.className))).toBe(false);
  });
});
