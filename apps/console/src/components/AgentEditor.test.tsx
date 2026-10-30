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

describe("AgentEditor's Tools step says where tools run", () => {
  const bwrap = { mode: "bwrap" as const, cgroup: true, egress: "open" as const };
  it("names the server's box when the agent's harness runs native tools", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...caps, harnesses: [{ id: "pi", available: true, native_tools: true }], box: bwrap }, step: "tools" }));
    expect(html).toContain("Tools run in a bwrap sandbox · network open");
  });
  it("claims nothing when the agent's harness runs no native tools", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: { ...caps, harnesses: [{ id: "pi", available: true, native_tools: false }], box: bwrap }, step: "tools" }));
    expect(html).not.toContain("Tools run in");
  });
});
