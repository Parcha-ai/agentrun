import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground, type StartResult } from "./Playground";
import { agentFixture } from "@/fixtures";

// The playground's spend cap and the agent's least cap (min_cap_usd): a hint under the field, a cap under it refused
// before it is sent, and a 422 too_low the server gives shown under the field as the server says it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const revisions = [{ revision: "rev-2", version: 2, current: true, note: null }, { revision: "rev-1", version: 1, current: false, note: null }];

function open(props: { minCapUsd?: number | null; result?: StartResult; efforts?: string[]; onSend?: () => Promise<StartResult> }) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [agentFixture("invoice-checker")], revisions, efforts: props.efforts ?? [], origin: "http://serve.test", agentId: "invoice-checker", minCapUsd: props.minCapUsd, result: props.result, onSend: props.onSend ?? (async () => ({ status: 202, ms: 1, body: {} })) })));
  const cap = () => host.querySelector('input[placeholder="e.g. 0.50"]') as HTMLInputElement;
  const field = () => cap().parentElement!;
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = () => [...host.querySelectorAll("button")].find((b) => /Send request/.test(b.textContent ?? ""))!;
  const pick = (revision: string) => act(() => {
    const select = [...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === revision))!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, revision);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const click = (label: RegExp) => act(() => { [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!.click(); });
  const code = () => host.querySelector("pre")!.textContent!;
  return { host, cap, field, type, send, pick, click, code, message: () => host.querySelector("textarea") as HTMLTextAreaElement };
}

describe("Playground, the agent's least cap", () => {
  it("says the least under the cap field, and refuses a cap under it before sending", () => {
    const page = open({ minCapUsd: 0.105 });
    expect(page.field().textContent).toContain("At least $0.11 for this agent.");
    page.type(page.message(), "Check this invoice.");
    page.type(page.cap(), "0.1");
    expect(page.field().textContent).toContain("At least $0.11 for this agent.");
    expect(page.send().disabled).toBe(true);
    page.type(page.cap(), "0.105");
    expect(page.send().disabled).toBe(false);
  });

  it("says no cap can be kept when the server says null, and says nothing new when it says nothing", () => {
    const none = open({ minCapUsd: null });
    expect(none.field().textContent).toContain("No cap can be kept on this agent's model.");
    act(() => root!.unmount()); root = undefined;
    const unknown = open({});
    expect(unknown.field().textContent).not.toContain("At least");
    expect(unknown.field().textContent).toContain("A spend cap in dollars; empty means none.");
  });

  it("shows a 422 too_low on max_cost_usd under the field, as the server says it", () => {
    const message = "The cap of $0.05 is under what this agent's first request needs: at least $0.11.";
    const result: StartResult = { status: 422, ms: 3, body: { error: { code: "invalid_request", message: "The request is invalid.", retryable: false, fields: [{ field: "max_cost_usd", reason: "too_low", message }] } } };
    const page = open({ minCapUsd: 0.105, result });
    expect(page.field().textContent).toContain(message);
  });

  // The least is the current revision's: an older one may run another model, so its start is left to the server.
  it("checks the cap against the current revision only, and leaves an older revision's to the server", () => {
    const page = open({ minCapUsd: null });
    page.type(page.message(), "Check this invoice.");
    page.type(page.cap(), "0.5");
    expect(page.send().disabled).toBe(true);
    page.pick("rev-1");
    expect(page.field().textContent).not.toContain("No cap can be kept");
    expect(page.send().disabled).toBe(false);
    page.pick("rev-2");
    expect(page.field().textContent).toContain("No cap can be kept on this agent's model.");
    expect(page.send().disabled).toBe(true);
  });

  // The code pane is the form's request as entered, so a copied request is refused as the form is, never sent bare.
  it("keeps the entered cap, revision and effort in the code when the cap is under the least or not a number", () => {
    const page = open({ minCapUsd: 0.105, efforts: ["high"] });
    page.type(page.message(), "Check this invoice.");
    page.pick("rev-2");
    page.click(/^high$/i);
    page.type(page.cap(), "0.05");
    expect(page.send().disabled).toBe(true);
    for (const part of ['"max_cost_usd":0.05', '"revision":"rev-2"', '"effort":"high"']) expect(page.code()).toContain(part);
    page.type(page.cap(), "five");
    expect(page.code()).toContain('"max_cost_usd":"five"');
  });

  it("shows the server's cap refusal only while the request it refused is the one in the form", async () => {
    const message = "The cap of $0.05 is under what this agent's first request needs: at least $0.11.";
    const refused: StartResult = { status: 422, ms: 3, body: { error: { code: "invalid_request", message: "The request is invalid.", retryable: false, fields: [{ field: "max_cost_usd", reason: "too_low", message }] } } };
    const page = open({ onSend: async () => refused });
    page.type(page.message(), "Check this invoice.");
    page.type(page.cap(), "0.05");
    await act(async () => { page.send().click(); });
    expect(page.field().textContent).toContain(message);
    page.type(page.cap(), "0.2");
    expect(page.field().textContent).not.toContain(message);
    page.type(page.cap(), "0.05");
    expect(page.field().textContent).toContain(message);
    page.pick("rev-1");
    expect(page.field().textContent).not.toContain(message);
  });
});
