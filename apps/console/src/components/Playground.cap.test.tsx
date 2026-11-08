import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The playground's cap box is an agentic agent's: a cap typed there for one agent never rides along, unseen, on a
// workflow agent's request after a switch (the box isn't shown for it, so nothing could correct it).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("Playground, a cap typed for one agent", () => {
  for (const [typed, what] of [["-1", "a cap the box would refuse"], ["0.4", "a valid cap"]] as const) it(`${what} is not sent, nor checked, for a workflow agent picked after it`, () => {
    const agentic = agentFixture("invoice-checker");
    const workflow = agentFixture("support-triage");
    expect(workflow.kind).toBe("workflow");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = (agentId: string) => act(() => root!.render(createElement(Playground, { agents: [agentic, workflow], efforts: [], origin: "http://serve.test", agentId, onSend: async () => ({ status: 202 }) as never })));
    render(agentic.agent_id);
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const cap = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    expect(cap).not.toBeNull();
    act(() => { setInput.call(cap, typed); cap.dispatchEvent(new Event("input", { bubbles: true })); });
    render(workflow.agent_id);
    expect(host.querySelector('input[inputmode="decimal"]')).toBeNull();
    const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { const t = host.querySelector("textarea")!; setText.call(t, '{"subject":"Where is my invoice?","body":"Cannot find it."}'); t.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.textContent).toContain('"subject":"Where is my invoice?"');
    expect(host.textContent).not.toContain("max_cost_usd");
    expect(host.textContent).not.toContain("A spend cap is a positive number of dollars.");
    const send = [...host.querySelectorAll("button")].find((b) => /Send/.test(b.textContent ?? ""))!;
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(false);
  });
});
