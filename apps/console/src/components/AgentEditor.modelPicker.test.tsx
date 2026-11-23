import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";
import type { Agent, AgentFields, SaveProblem } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
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
const agentOn = (harness: string, model?: string): Agent => ({ ...SERVED_AGENT, agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness, skills: [], tools: [], ...(model ? { model } : {}) } });

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

  it("shows each model's provider icon and changes the selected icon with the model", async () => {
    const page = await open(agentOn("pi"));
    expect(page.model().querySelector('[data-provider-icon="anthropic"]')).not.toBeNull();
    await pick(page.model(), "openai/gpt-6.1-sol");
    expect(page.model().querySelector('[data-provider-icon="openai"]')).not.toBeNull();
    expect(page.model().querySelector('[data-provider-icon="anthropic"]')).toBeNull();
    expect(page.model().getAttribute("aria-label")).toBe("Model");
    expect(page.model().querySelector("img")?.getAttribute("alt")).toBe("");
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

  it("clearing the box of an agent opened on Custom keeps the box, so a replacement can be typed", async () => {
    const page = await open(agentOn("pi", "anthropic/claude-sonnet-5.5"));
    const box = page.custom()!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, ""); box.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(page.custom(), "the box stays").not.toBeNull();
    expect(page.model().textContent).toBe("Custom...");
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

  it("a free model is tagged Free with its context size, and Free only narrows the list to the free ones", async () => {
    const FREE = "openrouter/inclusionai/ling-3.2-flash:free";
    const NEMO = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
    const free: EditorCaps = { ...caps, harnesses: [{ id: "pi", available: true, default_model: "openrouter/anthropic/claude-sonnet-5.5", models: ["openrouter/anthropic/claude-sonnet-5.5", NEMO, FREE], free_models: [{ id: NEMO, context_window: 1_000_000 }, { id: FREE, context_window: 1_048_576 }] }] };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(AgentEditor, { agent: agentOn("pi"), caps: free, step: "settings", onSave: async () => null })); });
    const options = await optionsOf(picker(host, "Model")!);
    expect(options.find((o) => o.value === FREE)?.text).toMatch(/Free · 1M context$/);
    expect(options.find((o) => o.value === NEMO)?.text).toMatch(/Free · 1M context$/);
    expect(options.find((o) => o.value === "openrouter/anthropic/claude-sonnet-5.5")?.text).not.toMatch(/Free/);
    const only = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Free models only"]')!;
    expect(only.getAttribute("aria-checked")).toBe("false");
    await act(async () => { only.click(); });
    expect((await optionsOf(picker(host, "Model")!)).map((o) => o.value)).toEqual(["", NEMO, FREE, CUSTOM]);
  });

  it("the cap's note says the server's limit on requests for a free model, picked or the default; not for a plan's model or a paid one", async () => {
    const FREE = "openrouter/inclusionai/ling-3.2-flash:free";
    const withFree: EditorCaps = { ...caps, freeRequests: 60, harnesses: [{ id: "pi", available: true, default_model: "anthropic/claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5", FREE, "chatgpt/gpt-6.1-sol"], free_models: [{ id: FREE, context_window: 1_048_576 }] }, { id: "codex", available: true, default_model: "chatgpt/gpt-6.1-sol", models: ["chatgpt/gpt-6.1-sol"] }, { id: "opencode", available: true, default_model: FREE, models: [FREE], free_models: [{ id: FREE, context_window: 1_048_576 }] }] };
    const noteOn = async (agent: Agent) => {
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      await act(async () => { root!.render(createElement(AgentEditor, { agent, caps: withFree, step: "settings", onSave: async () => null })); });
      const said = host.querySelector('[data-note="free-requests"]')?.textContent ?? null;
      act(() => root!.unmount());
      root = undefined;
      host.remove();
      return said;
    };
    expect(await noteOn(agentOn("pi", FREE))).toBe("free model: up to 60 requests");
    expect(await noteOn(agentOn("opencode"))).toBe("free model: up to 60 requests");
    expect(await noteOn(agentOn("codex"))).toBeNull();
    expect(await noteOn(agentOn("pi", "chatgpt/gpt-6.1-sol"))).toBeNull();
    expect(await noteOn(agentOn("pi"))).toBeNull();
    expect(await noteOn(agentOn("pi", "anthropic/claude-opus-5-5"))).toBeNull();
  });

  it("a harness with no free model shows no Free only switch", async () => {
    const page = await open(agentOn("pi"));
    expect(page.host.querySelector('button[role="switch"][aria-label="Free models only"]')).toBeNull();
  });

  // What the server says of a model depends on the harness ("On pi, a model is ..."): the field shows it only while the
  // form names the harness and model it was said of.
  const REFUSAL = 'On pi, a model is <provider>/<model id>, like anthropic/claude-sonnet-5-5 or openrouter/anthropic/claude-sonnet-5.5: "Sonnet 5.5" is not one. Did you mean anthropic/claude-sonnet-5-5?';
  const refusal: SaveProblem = { kind: "invalid", message: "The definition is not valid.", fields: { "definition.model": REFUSAL } };
  /** The Model field's own box: its label, its control, and what it says under them. */
  const modelBox = (host: HTMLElement) => {
    const label = [...host.querySelectorAll("label")].find((l) => l.htmlFor === picker(host, "Model")!.id);
    expect(label, "the Model field has its label").toBeDefined();
    return label!.parentElement!.parentElement!;
  };
  const alerts = (host: HTMLElement) => [...modelBox(host).querySelectorAll(':scope > [role="alert"]')].map((e) => e.textContent);
  const harness = async (host: HTMLElement, id: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`input[type=radio][value="${id}"]`)!.click(); }); };

  it("a refusal said on pi is not shown once the harness is codex, the model the same; back on pi it is", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(AgentEditor, { agent: agentOn("pi", "Sonnet 5.5"), caps, step: "settings", onSave: async () => null, problem: refusal })); });
    expect(alerts(host)).toEqual([REFUSAL]);
    await harness(host, "codex");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Custom model"]')?.value, "the model is still the one refused").toBe("Sonnet 5.5");
    expect(alerts(host), "pi's words, not codex's").toEqual([]);
    await harness(host, "pi");
    expect(alerts(host)).toEqual([REFUSAL]);
  });

  it("a save's refusal that arrives after the harness changed is not shown at the field", async () => {
    let answer: ((problem: SaveProblem) => void) | undefined;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(AgentEditor, { agent: agentOn("pi"), caps, step: "settings", onSave: () => new Promise<SaveProblem>((resolve) => { answer = resolve; }) })); });
    await pick(picker(host, "Model")!, CUSTOM);
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Custom model"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "Sonnet 5.5"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { [...host.querySelectorAll<HTMLElement>("button")].find((b) => /^Save revision$/.test(b.textContent ?? ""))!.click(); });
    expect(answer, "the save is waiting for its answer").toBeDefined();
    await harness(host, "codex");
    await act(async () => answer!(refusal));
    expect(alerts(host), "said of pi, the form on codex").toEqual([]);
    await harness(host, "pi");
    expect(alerts(host), "the harness and model sent").toEqual([REFUSAL]);
  });

  it("a save's warning at the model shows at the field only while the form names the saved harness and model", async () => {
    const WARNING = "No key for openai is set on this server: set OPENAI_API_KEY.";
    const agent: Agent = { ...agentOn("pi", "openai/gpt-6.1-sol"), warnings: [{ field: "definition.model", reason: "not_set_up_here", message: WARNING }] };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(AgentEditor, { agent, caps, step: "settings", onSave: async () => null })); });
    expect(modelBox(host).textContent).toContain(WARNING);
    await harness(host, "codex");
    expect(modelBox(host).textContent, "said of the saved revision on pi").not.toContain(WARNING);
    await harness(host, "pi");
    expect(modelBox(host).textContent).toContain(WARNING);
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
