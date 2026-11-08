import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";

// The agent's default spend cap per run (`definition.max_cost_usd`): a run started without a cap of its own, and a
// trigger with none, is capped at it. Empty means none, and clearing one sends an explicit 0 (the server's "no default"):
// leaving the field out never removes a spend limit. The server judges the number and its 422 shows under the field.
const caps = { harnesses: [{ id: "pi", available: true }], tools: [{ name: "read", available: true }], thinking: ["low"] };
const capped = { agent_id: "inv", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Invoices", instructions: "Check.", harness: "pi", skills: [], tools: ["read"], max_cost_usd: 2.5 } };
const LABEL = "Default spend cap per run, $";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: (() => void)[] = [];
afterEach(() => { roots.splice(0).forEach((u) => u()); document.body.innerHTML = ""; });

function mount(props: Record<string, unknown>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(createElement(AgentEditor, { caps, step: "settings", ...props } as never)));
  roots.push(() => act(() => root.unmount()));
  const fill = (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const type = (value: string) => fill(host.querySelector<HTMLInputElement>("#agent-max-cost"), value);
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent?.trim() ?? ""));
  const save = async () => { await act(async () => { button(/^(Save revision|Create)$/)!.click(); }); };
  return { host, fill, type, button, save };
}

describe("AgentEditor, the agent's default spend cap per run", () => {
  it("shows in Settings with the definition's value, and is empty on an agent without one", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: capped, caps, step: "settings" }));
    expect(html).toContain(LABEL);
    expect(html.match(/<input[^>]*id="agent-max-cost"[^>]*>/)?.[0]).toContain('value="2.5"');
    const bare = { ...capped, definition: { ...capped.definition, max_cost_usd: undefined } };
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: bare, caps, step: "settings" })).match(/<input[^>]*id="agent-max-cost"[^>]*>/)?.[0]).toContain('value=""');
    const none = { ...capped, definition: { ...capped.definition, max_cost_usd: 0 } };
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: none, caps, step: "settings" })).match(/<input[^>]*id="agent-max-cost"[^>]*>/)?.[0]).toContain('value=""');
  });

  it("is offered on a workflow agent as on an agentic one, and not on a new Decision agent, which starts with none", () => {
    const flow = { agent_id: "wf", kind: "workflow" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Flow", workflow: { nodes: [] }, skills: [], tools: [], max_cost_usd: 3 } };
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: flow, caps, step: "settings" })).match(/<input[^>]*id="agent-max-cost"[^>]*>/)?.[0]).toContain('value="3"');
    const { host } = mount({ agent: null, caps: { ...caps, decisionProvider: "jev" } });
    expect(host.textContent).toContain(LABEL);
    act(() => { host.querySelector<HTMLInputElement>('input[type=radio][value="decision"]')!.click(); });
    expect(host.textContent).not.toContain(LABEL);
  });

  it("a workflow agent's save sends its cap with its workflow, as an agentic agent's does", async () => {
    const sent: Record<string, unknown>[] = [];
    const flow = { agent_id: "wf", kind: "workflow" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Flow", workflow: { nodes: [] }, skills: [], tools: [] } };
    const { type, save } = mount({ agent: flow, onSave: async (fields: Record<string, unknown>) => { sent.push(fields); return null; } });
    type("4");
    await save();
    expect(sent).toHaveLength(1);
    expect([sent[0]!.max_cost_usd, sent[0]!.maxCostText, sent[0]!.workflow]).toEqual([4, undefined, { nodes: [] }]);
  });

  it("an untouched save sends the cap back as it was; a new number replaces it; emptied, the save sends 0 to clear it", async () => {
    const sent: Record<string, unknown>[] = [];
    const { type, save } = mount({ agent: capped, onSave: async (fields: Record<string, unknown>) => { sent.push(fields); return null; } });
    await save();
    type("4");
    await save();
    type("");
    await save();
    expect(sent.map((s) => s.max_cost_usd)).toEqual([2.5, 4, 0]);
    expect(sent.some((s) => "maxCostText" in s && s.maxCostText !== undefined)).toBe(false);
  });

  it("an agent with no cap, saved with the field still empty, sends none: there is nothing to clear", async () => {
    const sent: Record<string, unknown>[] = [];
    const bare = { ...capped, definition: { ...capped.definition, max_cost_usd: undefined } };
    const { save } = mount({ agent: bare, onSave: async (fields: Record<string, unknown>) => { sent.push(fields); return null; } });
    await save();
    expect(sent[0]?.max_cost_usd).toBeUndefined();
  });

  it("0 typed on an agent with no cap sends none (nothing to clear, so no new revision); 0 on a capped agent clears it", async () => {
    const sent: Record<string, unknown>[] = [];
    const bare = { ...capped, definition: { ...capped.definition, max_cost_usd: undefined } };
    const onSave = async (fields: Record<string, unknown>) => { sent.push(fields); return null; };
    const a = mount({ agent: bare, onSave });
    a.type("0");
    await a.save();
    a.type("$0");
    await a.save();
    roots.splice(0).forEach((u) => u()); document.body.innerHTML = "";
    const b = mount({ agent: capped, onSave });
    b.type("0");
    await b.save();
    expect(sent.map((s) => ["max_cost_usd" in s, s.max_cost_usd])).toEqual([[false, undefined], [false, undefined], [true, 0]]);
  });

  it("a currency sign with no number is refused under the field, never read as empty: a saved cap is not cleared", async () => {
    let calls = 0;
    const { host, type, save } = mount({ agent: capped, onSave: async () => { calls++; return null; } });
    for (const text of ["$", " $ "]) {
      type(text);
      await save();
    }
    expect(calls).toBe(0);
    expect(host.querySelector("#agent-max-cost")!.closest("div")!.parentElement!.textContent).toMatch(/number of dollars/);
  });

  it("a new agent's Create sends the cap typed", async () => {
    let sent: Record<string, unknown> | undefined;
    const { host, fill, type, button, save } = mount({ agent: null, step: "context", onSave: async (fields: Record<string, unknown>) => { sent = fields; return null; } });
    fill(host.querySelector<HTMLInputElement>('input[placeholder="e.g., Invoice checker"]'), "Capped");
    fill(host.querySelector("textarea"), "Check.");
    act(() => { button(/Settings/)!.click(); });
    type("0.75");
    await save();
    expect(sent).toMatchObject({ max_cost_usd: 0.75 });
  });

  it("text that is no number is refused under the field and not sent; the server's 422 on the cap shows under it", async () => {
    let calls = 0;
    const { host, type, save } = mount({ agent: capped, onSave: async () => { calls++; return null; } });
    type("ten");
    await save();
    expect(calls).toBe(0);
    expect(host.querySelector("#agent-max-cost")!.closest("div")!.parentElement!.textContent).toMatch(/number of dollars/);
    const problem = { kind: "invalid", message: "The definition is invalid.", fields: { "definition.max_cost_usd": "definition.max_cost_usd is a number above 0, in US dollars" } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: capped, caps, step: "settings", problem } as never));
    const at = html.indexOf(LABEL);
    expect(at).toBeGreaterThan(-1);
    expect(html.indexOf("definition.max_cost_usd is a number above 0, in US dollars", at)).toBeGreaterThan(at);
  });
});
