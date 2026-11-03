import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// A sandbox agent's run can be asked for on the server instead: the playground's `place` field, sent as "runner".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("Playground, a sandbox agent's run on the server", () => {
  it("offers place: runner only for an agent in a box, and the request carries it once ticked", () => {
    const base = agentFixture("invoice-checker");
    const boxed = { ...base, agent_id: "boxed", definition: { ...base.definition, place: { mode: "sandbox", box: "docker" } } };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, { agents: [base, boxed], efforts: [], origin: "http://serve.test", agentId: "invoice-checker" })));
    expect(host.querySelector('input[name="place"]')).toBeNull();
    act(() => root!.render(createElement(Playground, { agents: [base, boxed], efforts: [], origin: "http://serve.test", agentId: "boxed" })));
    const tick = host.querySelector('input[name="place"]') as HTMLInputElement;
    expect(tick).not.toBeNull();
    // A message to send, so the request shown is the one that would go.
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { const t = host.querySelector("textarea")!; set.call(t, "List the files here."); t.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.textContent).toContain('"content":"List the files here."');
    expect(host.textContent).not.toContain('"place":"runner"');
    act(() => tick.click());
    expect(host.textContent).toContain('"place":"runner"');
  });
});
