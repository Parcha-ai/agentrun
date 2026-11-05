import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";

const tools = [{ name: "read", available: true }, { name: "write", available: true }, { name: "fetch_page", available: true }];
const caps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }], tools, thinking: ["low"] };

// Tools are on by default: a new agent starts with what its harness runs here ticked, and says when it can't reach the web.
describe("AgentEditor, a new agent's tools", () => {
  it("starts with the harness's tools ticked, and the server's tool objects render as their names", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    expect((html.match(/checked=""/g) ?? []).length).toBe(3);
    expect(html).toContain("fetch_page");
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("says the agent can't reach the web when fetch_page is not among its tools", () => {
    const noWeb = { ...caps, tools: tools.filter((t) => t.name !== "fetch_page") };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: noWeb, step: "tools" }));
    expect(html).toContain("can&#x27;t reach the web");
  });
  const webFetch = { name: "web_fetch", available: true, summary: "Read one public web page through Parallel's extract." };
  const withWebFetch = { ...caps, tools: [...tools.filter((t) => t.name !== "fetch_page"), webFetch] };
  it("an agent whose only tool is web_fetch reaches the web: no notice", () => {
    const reader = { agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["web_fetch"] } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: reader, caps: withWebFetch, step: "tools" }));
    expect((html.match(/checked=""/g) ?? []).length).toBe(1);
    expect(html.match(/<input[^>]*value="web_fetch"[^>]*>/)?.[0]).toContain('checked=""');
    expect(html).not.toContain("can&#x27;t reach the web");
  });
  it("an agent with no web tool is told which to tick, or that its harness runs none here", () => {
    const reader = { agent_id: "reader", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reader", instructions: "Read it.", harness: "pi", skills: [], tools: ["read"] } };
    const both = { ...caps, tools: [...tools, webFetch] };
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: reader, caps: both, step: "tools" }))).toContain("tick fetch_page or web_fetch in Tools.");
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
    expect(section).toContain("This agent can&#x27;t reach the web: tick fetch_page in Tools.");
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
    const fetchBox = host.querySelector<HTMLInputElement>('input[type=checkbox][value="fetch_page"]');
    click(fetchBox);
    const picked = checked();
    expect(picked).not.toContain("fetch_page");
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
    // A save sends none: it never widens what the agent can do.
    const { act } = await import("react");
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

  it("lays the picker out one column per choice on a wide screen: five with Decision and Workflow, three without", () => {
    const three = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }] };
    const group = (html: string) => html.match(/<div class="([^"]*)" role="radiogroup" aria-label="Harness"/)?.[1] ?? "";
    expect(group(renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...three, decisionProvider: "jev" }, step: "settings" })))).toContain("sm:grid-cols-5");
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    expect(group(renderToStaticMarkup(createElement(AgentEditor, { agent: agent as never, caps: three, step: "settings" })))).toContain("sm:grid-cols-3");
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
