import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// A run runs where its agent's definition says: the playground offers no place, and the request it shows names none,
// for an agent in a box too.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("Playground, a sandbox agent's run", () => {
  it("offers no place field, and the request it shows names no place", () => {
    const base = agentFixture("invoice-checker");
    const boxed = { ...base, agent_id: "boxed", definition: { ...base.definition, place: { mode: "sandbox" as const, box: "docker" as const } } };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, { agents: [base, boxed], efforts: [], origin: "http://serve.test", agentId: "boxed" })));
    expect(host.querySelector('input[name="place"]')).toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { const t = host.querySelector("textarea")!; set.call(t, "List the files here."); t.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.textContent).toContain('"content":"List the files here."');
    expect(host.textContent).not.toContain('"place"');
  });
});
