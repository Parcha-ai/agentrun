import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentEditPage } from "./AgentsPage";
import type { Client } from "@/lib/client";
import { optionsOf, pick, picker } from "@/test/picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

function mount(decisionProvider?: string) {
  const createAgent = vi.fn(async (_body: unknown) => { throw new Error("Keep the draft after recording the request"); });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditPage, {
    v2: { createAgent, computers: async () => ({ kinds: [] }), toolSettings: async () => ({}) } as unknown as Client, agentId: null, go: vi.fn(),
    caps: { harnesses: [{ id: "pi", available: true }], tools: [], thinking: [], decisionProvider },
  })));
  return { host, createAgent };
}

it.each(["decision", "workflow"])("creates a %s from the shared editor without sending agent-only fields", async kind => {
  const { host, createAgent } = mount("parallel");
  await act(async () => {
    const name = host.querySelector<HTMLInputElement>("#agent-name")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Review");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "");
    instructions.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith("Model & runtime"))!.click());
  await act(async () => {
    const cap = host.querySelector<HTMLInputElement>("#agent-max-cost")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(cap, "not a number");
    cap.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.trim().startsWith("General"))!.click());
  await pick(picker(host, "Agent type")!, `starter:${kind}`);
  expect(host.querySelector("#agent-instructions")).toBeNull();
  expect(host.querySelector('[aria-label="Agent settings sections"]')?.textContent).not.toMatch(/Computer|Tools|Learning|Model & runtime/);
  const create = [...host.querySelectorAll("button")].find(b => b.textContent === "Create")!;
  expect(create.disabled).toBe(false);
  await act(async () => create.click());
  expect(createAgent).toHaveBeenCalledOnce();
  const body = createAgent.mock.calls[0]![0] as unknown as { definition: Record<string, unknown> };
  expect(body.definition).toMatchObject({ name: "Review", workflow: { v: 2 }, tools: [] });
  for (const field of ["harness", "instructions", "model", "thinking", "computer", "learning"]) expect(body.definition).not.toHaveProperty(field);
  if (kind === "decision") expect(JSON.stringify(body.definition.workflow)).toContain('"provider":"parallel"');
});

it("explains an unavailable Decision choice while still offering Workflow", async () => {
  const { host } = mount();
  const options = await optionsOf(picker(host, "Agent type")!);
  expect(options.find(o => o.value === "starter:decision")).toMatchObject({ disabled: true, text: expect.stringContaining("no decision provider's key") });
  expect(options.find(o => o.value === "starter:workflow")).toMatchObject({ disabled: false });
});
