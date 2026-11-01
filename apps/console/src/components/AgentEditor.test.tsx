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

  it("lays the picker out one column per choice on a wide screen: four with Decision, three without", () => {
    const three = { ...caps, harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }] };
    const group = (html: string) => html.match(/<div class="([^"]*)" role="radiogroup" aria-label="Harness"/)?.[1] ?? "";
    expect(group(renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...three, decisionProvider: "jev" }, step: "settings" })))).toContain("sm:grid-cols-4");
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    expect(group(renderToStaticMarkup(createElement(AgentEditor, { agent: agent as never, caps: three, step: "settings" })))).toContain("sm:grid-cols-3");
  });

  it("offers no Decision when editing an agent", () => {
    const agent = { agent_id: "old", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Old", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent as never, caps: { ...caps, decisionProvider: "jev" }, step: "settings" }));
    expect(html).not.toContain('value="decision"');
  });
});
