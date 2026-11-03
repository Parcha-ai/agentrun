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

function open(props: { minCapUsd?: number | null; result?: StartResult; efforts?: string[] }) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [agentFixture("invoice-checker")], efforts: props.efforts ?? [], origin: "http://serve.test", agentId: "invoice-checker", minCapUsd: props.minCapUsd, result: props.result, onSend: async () => ({ status: 202, ms: 1, body: {} }) })));
  const cap = () => host.querySelector('input[placeholder="e.g. 0.50"]') as HTMLInputElement;
  const field = () => cap().parentElement!;
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = () => [...host.querySelectorAll("button")].find((b) => /Send request/.test(b.textContent ?? ""))!;
  return { host, cap, field, type, send, message: () => host.querySelector("textarea") as HTMLTextAreaElement };
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
});
