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
