import { SERVED_AGENT } from "@/test/agent";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";
import type { Agent, AgentFields } from "@/lib/agentForm";
import { optionsOf, pick, picker, valueOf } from "@/test/picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex"] }];
const caps: EditorCaps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: false, reason: "codex needs OPENAI_API_KEY." }], tools, thinking: ["low", "high"] };
const agentOn = (harness: string, thinking?: Agent["definition"]["thinking"]): Agent => ({ ...SERVED_AGENT, agent_id: "runtime-agent", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Runtime agent", instructions: "Check the result.", harness, model: "custom/model", thinking, skills: [], tools: ["read"], max_cost_usd: 2.5 } });
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount(agent: Agent | null = null, editorCaps: EditorCaps = caps) {
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const sent: AgentFields[] = [];
  act(() => root!.render(createElement(AgentEditor, { agent, caps: editorCaps, step: "settings", onSave: async fields => { sent.push(fields); return null; } })));
  const save = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => /^(Saved|Save revision)/.test(button.textContent ?? ""))!;
  return { host, sent, save };
}

describe("AgentEditor runtime and thinking pickers", () => {
  it("opens on the default runtime and changes it through the compact picker", async () => {
    const { host } = mount();
    expect(picker(host, "Runtime")).toBeTruthy();
    expect(valueOf(picker(host, "Runtime")!)).toBe("pi");
    await pick(picker(host, "Runtime")!, "claude-agent");
    expect(valueOf(picker(host, "Runtime")!)).toBe("claude-agent");
    expect(host.querySelector<HTMLInputElement>('input[name="harness"]')?.value).toBe("claude-agent");
    expect(host.querySelector('input[type="radio"][name="harness"]')).toBeNull();
  });

  it("shows unavailable runtime setup without selecting a disabled option", async () => {
    const { host } = mount();
    const setup = [...host.querySelectorAll("summary")].find(summary => summary.textContent === "Runtime setup")!;
    expect(setup).toBeTruthy();
    expect(setup.closest("details")?.open).toBe(false);
    await act(async () => setup.click());
    expect(setup.closest("details")?.open).toBe(true);
    expect(setup.closest("details")?.textContent).toContain("codex needs OPENAI_API_KEY.");
    expect(valueOf(picker(host, "Runtime")!)).toBe("pi");
    expect((await optionsOf(picker(host, "Runtime")!)).find(option => option.value === "codex")).toMatchObject({ text: expect.stringContaining("Codex · Not available"), disabled: true });
  });

  it("explains unavailable runtimes directly in the dropdown without expanding Runtime setup", async () => {
    const { host, sent } = mount();
    const field = picker(host, "Runtime")!;
    expect(host.querySelector("details")?.open).toBe(false);
    await act(async () => field.click());
    const list = document.querySelector('[role="listbox"]')!;
    const codex = list.querySelector<HTMLElement>('[role="option"][data-value="codex"]')!;
    expect(codex.textContent).toContain("Codex · Not available");
    expect(codex.textContent).toContain("codex needs OPENAI_API_KEY.");
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(codex.getAttribute("title")).toBeNull();
    expect([...codex.querySelectorAll("span")].some(span => span.textContent === "codex needs OPENAI_API_KEY." && !span.closest('[hidden], [aria-hidden="true"], .hidden, .sr-only'))).toBe(true);
    expect(list.querySelector('[role="option"][data-value="pi"]')?.textContent).toBe("Pi");
    expect(list.querySelector('[role="option"][data-value="claude-agent"]')?.textContent).toBe("Claude");
    await act(async () => codex.click());
    expect(valueOf(field)).toBe("pi");
    expect(sent).toEqual([]);
    expect(host.querySelector("details")?.open).toBe(false);
  });

  it("supplies a visible fallback when the server marks a runtime unavailable without a reason", async () => {
    const { host } = mount(null, { ...caps, harnesses: [{ id: "pi", available: true }, { id: "codex", available: false }] });
    const codex = (await optionsOf(picker(host, "Runtime")!)).find(option => option.value === "codex");
    expect(codex?.disabled).toBe(true);
    expect(codex?.text).toContain("Codex · Not available");
    expect(codex?.text).toContain("This server did not provide a reason.");
  });

  it.each(["codex", "unlisted-runtime"])("keeps saved unavailable runtime %s visible and unchanged until another choice", async harness => {
    const { host, save, sent } = mount(agentOn(harness, "extra-thinking" as Agent["definition"]["thinking"]));
    expect(picker(host, "Runtime")).toBeTruthy();
    expect(valueOf(picker(host, "Runtime")!)).toBe(harness);
    expect(picker(host, "Runtime")?.textContent).toContain("Not available");
    const selected = (await optionsOf(picker(host, "Runtime")!)).find(option => option.value === harness);
    expect(selected?.disabled).toBe(false);
    expect(selected?.text).toContain(harness === "codex" ? "codex needs OPENAI_API_KEY." : "This server does not report this runtime.");
    if (harness === "codex") expect(picker(host, "Runtime")?.textContent).not.toContain("OPENAI_API_KEY");
    else expect(picker(host, "Runtime")?.textContent).not.toContain("This server does not report");
    await pick(picker(host, "Runtime")!, harness);
    expect(host.querySelector('[role="status"][aria-label="Tools this harness doesn\'t run"]')).toBeNull();
    expect(valueOf(picker(host, "Thinking")!)).toBe("extra-thinking");
    expect((await optionsOf(picker(host, "Thinking")!)).some(option => option.value === "extra-thinking")).toBe(true);
    expect(save().disabled).toBe(true);
    expect(sent).toEqual([]);
    const toolsSection = [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Agent settings sections"] ul button')].find(button => button.textContent?.trim().startsWith("Tools"))!;
    await act(async () => toolsSection.click());
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"][value="read"]')?.checked).toBe(true);
    const runtimeSection = [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Agent settings sections"] ul button')].find(button => button.textContent?.trim().startsWith("Model & runtime"))!;
    await act(async () => runtimeSection.click());
    await pick(picker(host, "Runtime")!, "pi");
    expect(valueOf(picker(host, "Thinking")!)).toBe("extra-thinking");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Custom model"]')?.value).toBe("custom/model");
    if (harness === "codex") expect((await optionsOf(picker(host, "Runtime")!)).find(option => option.value === harness)?.disabled).toBe(true);
    expect(save().disabled).toBe(false);
  });

  it("uses model default for unset thinking and returns to a clean draft after choosing it again", async () => {
    const { host, save, sent } = mount(agentOn("pi"));
    expect(picker(host, "Thinking")?.textContent).toBe("Model default");
    expect(valueOf(picker(host, "Thinking")!)).toBe("");
    await pick(picker(host, "Thinking")!, "high");
    expect(save().disabled).toBe(false);
    await pick(picker(host, "Thinking")!, "");
    expect(save().disabled).toBe(true);
    expect(sent).toEqual([]);
  });

  it("clears explicit thinking to model default without changing the runtime, model, tools or cap", async () => {
    const { host, save, sent } = mount(agentOn("pi", "high"));
    await pick(picker(host, "Thinking")!, "");
    await act(async () => save().click());
    expect(sent).toHaveLength(1);
    expect(sent[0].thinking).toBeUndefined();
    expect(sent[0]).toMatchObject({ harness: "pi", model: "custom/model", tools: ["read"], max_cost_usd: 2.5, instructions: "Check the result." });
  });
});
