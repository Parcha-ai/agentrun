import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";
import type { Agent, AgentFields } from "@/lib/agentForm";
import { optionsOf, pick, picker } from "@/test/picker";

// The editor's Model field is a picker of the models the server offers for the harness (capabilities'
// harnesses[].models, each in the form that harness takes), with Custom... opening the free-text box.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const CUSTOM = "custom";
const caps: EditorCaps = {
  harnesses: [
    { id: "pi", available: true, default_model: "anthropic/claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"] },
    { id: "codex", available: true, default_model: "openai/gpt-6.1-sol", models: ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna"] },
  ],
  tools: [], thinking: [],
};
const agentOn = (harness: string, model?: string): Agent => ({ agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness, skills: [], tools: [], ...(model ? { model } : {}) } });

async function open(agent: Agent | null, onSave?: (fields: AgentFields) => void) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const save = async (fields: AgentFields) => { onSave?.(fields); return null; };
  await act(async () => { root!.render(createElement(AgentEditor, { agent, caps, step: "settings", onSave: save })); });
  const model = () => picker(host, "Model")!;
  const custom = () => host.querySelector<HTMLInputElement>('input[aria-label="Custom model"]');
  const click = async (name: RegExp) => { await act(async () => { [...host.querySelectorAll<HTMLElement>("button")].find((b) => name.test(b.textContent ?? ""))!.click(); }); };
  return { host, model, custom, click };
}

describe("AgentEditor, the Model picker", () => {
  it("lists the harness's models in the form it takes, the server default first and Custom last; no free-text box until asked", async () => {
    const page = await open(agentOn("pi"));
    expect(page.model().textContent).toContain("Server default (anthropic/claude-sonnet-5-5)");
    expect(page.custom()).toBeNull();
    expect((await optionsOf(page.model())).map((o) => o.value)).toEqual(["", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol", CUSTOM]);
  });

  it("picking a listed model sets it, and Save sends it", async () => {
    const saved: AgentFields[] = [];
    const page = await open(agentOn("pi"), (f) => saved.push(f));
    await pick(page.model(), "openai/gpt-6.1-sol");
    expect(page.model().textContent).toBe("openai/gpt-6.1-sol");
    expect(page.custom()).toBeNull();
    await page.click(/^Save revision$/);
    expect(saved[0]?.model).toBe("openai/gpt-6.1-sol");
  });

  it("Custom... reveals the free-text box, and what is typed there is the model", async () => {
    const saved: AgentFields[] = [];
    const page = await open(agentOn("pi"), (f) => saved.push(f));
    await pick(page.model(), CUSTOM);
    const box = page.custom()!;
    expect(box, "the box opens").not.toBeNull();
    expect(box.placeholder).toBe("provider/model");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "openrouter/anthropic/claude-sonnet-5.5"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.click(/^Save revision$/);
    expect(saved[0]?.model).toBe("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("an agent whose model the harness's list lacks opens on Custom, its model in the box", async () => {
    const page = await open(agentOn("pi", "anthropic/claude-sonnet-5.5"));
    expect(page.model().textContent).toBe("Custom...");
    expect(page.custom()?.value).toBe("anthropic/claude-sonnet-5.5");
  });

  it("an agent on a listed model opens on it", async () => {
    const page = await open(agentOn("codex", "openai/gpt-6-luna"));
    expect(page.model().textContent).toBe("openai/gpt-6-luna");
    expect(page.custom()).toBeNull();
  });

  it("the list is the harness's own: codex's models, not pi's", async () => {
    const page = await open(agentOn("codex"));
    expect((await optionsOf(page.model())).map((o) => o.value).filter((v) => v && v !== CUSTOM)).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna"]);
  });

  it("switching the harness on a new agent changes the list", async () => {
    const page = await open(null);
    expect((await optionsOf(page.model())).map((o) => o.value)).toContain("anthropic/claude-opus-5-5");
    await act(async () => { page.host.querySelector<HTMLInputElement>('input[type=radio][value="codex"]')!.click(); });
    const after = (await optionsOf(page.model())).map((o) => o.value);
    expect(after).not.toContain("anthropic/claude-opus-5-5");
    expect(after).toContain("openai/gpt-6.1-terra");
  });
});
