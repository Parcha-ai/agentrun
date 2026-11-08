import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunBar } from "./RunBar";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";

// The run bar's Spend cap box: a cap for this run alone. A typed amount goes out as the start's max_cost_usd; an empty box
// sends none, so the agent's default cap applies, and the box shows that default as its placeholder. A refusal of the
// cap (a 422 naming max_cost_usd, below the least a request costs among them) is said at the box in the server's words.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const agent = (definition: Partial<Agent["definition"]> = {}, kind: Agent["kind"] = "agentic"): Agent => ({
  agent_id: "capper", kind, revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Capper", instructions: "Answer.", harness: "pi", skills: [], tools: ["read"], ...definition },
});

function mount(a: Agent, refuse?: ClientError) {
  const starts: Record<string, unknown>[] = [];
  const v2 = { startRun: async (_id: string, body: Record<string, unknown>) => { starts.push(body); if (refuse) throw refuse; return { run: { run_id: "r1" }, status: 202 }; } };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunBar, { agent: a, efforts: ["low", "high"], v2: v2 as never, go: () => {} })));
  const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Spend cap"]');
  const write = (text: string) => set(host.querySelector("textarea")!, text);
  const run = () => act(async () => { [...host.querySelectorAll("button")].find((b) => /^Run$/.test((b.textContent ?? "").trim()))!.click(); });
  const runButton = () => [...host.querySelectorAll("button")].find((b) => /^Run$/.test((b.textContent ?? "").trim()))!;
  const issue = () => host.querySelector('[data-issue="max_cost_usd"]')?.textContent ?? null;
  return { host, starts, box, set, write, run, runButton, issue };
}

describe("RunBar, the Spend cap box", () => {
  it("sends a typed cap as the start's max_cost_usd", async () => {
    const m = mount(agent({ max_cost_usd: 0.5 }));
    expect(m.box()).not.toBeNull();
    m.write("hi");
    m.set(m.box()!, "0.75");
    await m.run();
    expect(m.starts).toEqual([{ input: { content: "hi" }, max_cost_usd: 0.75 }]);
  });

  it("an empty box sends no cap, and shows the agent's default cap as its placeholder", async () => {
    const m = mount(agent({ max_cost_usd: 0.5 }));
    expect(m.box()!.value).toBe("");
    expect(m.box()!.getAttribute("placeholder")).toBe("$0.50");
    m.write("hi");
    await m.run();
    expect(m.starts).toEqual([{ input: { content: "hi" } }]);
  });

  it("with no default cap on the agent, the placeholder says the run has none", () => {
    const m = mount(agent());
    expect(m.box()!.getAttribute("placeholder")).toBe("none");
  });

  it("a workflow run takes a cap too", async () => {
    const m = mount(agent({ workflow: { v: 2, name: "w", root: { node: "code", label: "a", code: "(s) => s" } } as never }, "workflow"));
    m.set(m.host.querySelector("textarea")!, "{}");
    m.set(m.box()!, "1");
    await m.run();
    expect(m.starts).toEqual([{ input: {}, max_cost_usd: 1 }]);
  });

  it("a cap that is not a positive number is said at the box, and Run sends nothing", async () => {
    const m = mount(agent());
    m.write("hi");
    m.set(m.box()!, "-1");
    expect(m.issue()).toBe("A spend cap is a positive number of dollars.");
    expect(m.runButton().disabled).toBe(true);
    await m.run();
    expect(m.starts).toEqual([]);
  });

  it("a start refused for its cap says the server's words at the box, and not again in the list under the refusal", async () => {
    const said = "Raise the cap to at least $0.10: one request of this model can cost that much.";
    const refusal = Object.assign(new ClientError(422, "input_invalid", "The request's fields are not valid."), { fields: [{ field: "max_cost_usd", reason: "below_least", message: said }] });
    const m = mount(agent(), refusal);
    m.write("hi");
    m.set(m.box()!, "0.01");
    await m.run();
    expect(m.starts).toEqual([{ input: { content: "hi" }, max_cost_usd: 0.01 }]);
    expect(m.issue()).toBe(said);
    const alert = m.host.querySelector('[role="alert"]:not([data-issue])')!;
    expect(alert.textContent).toContain("The run did not start: The request's fields are not valid.");
    expect(alert.textContent).not.toContain(said);
  });
});
