import { SERVED_AGENT } from "@/test/agent";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEditor, type EditorProps } from "./AgentEditor";
import { editBody, type Agent, type AgentFields, type SaveProblem } from "@/lib/agentForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const caps = { harnesses: [{ id: "pi", available: true }], tools: [], thinking: [] };
const agent: Agent = { ...SERVED_AGENT, agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Reviewer", instructions: "Review the work.", harness: "pi", tools: [], skills: ["other", "reviewing"] } };
const files = { "reviewing/SKILL.md": "---\nname: reviewing\ndescription: Review changes.\n---\n\nRead references/checklist.md.\n", "reviewing/references/checklist.md": "Keep every requirement.\n", "other/SKILL.md": "Other skill stays.\n" };
let root: Root | undefined;
let host: HTMLDivElement;
let props: EditorProps;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label)!;
const saveButton = () => host.querySelector<HTMLButtonElement>("footer button:last-of-type")!;
const contents = () => host.querySelector<HTMLTextAreaElement>("#agent-skill-content")!;
const click = async (label: string) => { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); };
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(overrides: Partial<EditorProps> = {}) {
  props = { agent, caps, step: "skills", onSave: async () => null, ...overrides };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(AgentEditor, props)));
}
async function update(overrides: Partial<EditorProps>) {
  props = { ...props, ...overrides };
  await act(async () => root!.render(createElement(AgentEditor, props)));
}
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("agent skill authoring", () => {
  it.each<Record<string, string>>([{}, { "other/SKILL.md": files["other/SKILL.md"] }])("preserves unavailable saved skills and refuses partial skill edits", async incomplete => {
    const saved: AgentFields[] = [];
    await render({ skillFiles: incomplete, onSave: async fields => { saved.push(fields); return null; } });
    expect(host.textContent).toContain("reviewing");
    expect(host.textContent).toContain("other");
    expect(host.textContent).toContain("Skill files are unavailable");
    expect(button("Add skill").disabled).toBe(true);
    expect(button("Edit skill reviewing").disabled).toBe(true);
    const nav = host.querySelector('nav[aria-label="Agent settings sections"]')!;
    await act(async () => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim().startsWith("General"))!.click());
    type(host.querySelector<HTMLInputElement>("#agent-description")!, "Still editable.");
    await click("Save revision");
    expect(saved[0].skillFiles).toBeUndefined();
    expect(editBody(agent, saved[0], "", incomplete).definition.skills).toEqual(["other", "reviewing"]);
    await update({ skillFiles: files });
    await act(async () => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim().startsWith("Skills"))!.click());
    expect(button("Add skill").disabled).toBe(false);
  });
  it("keeps saved names while files load, offers retry after failure, and never enables a partial edit", async () => {
    const retry = vi.fn(); await render({ onRetrySkills: retry });
    expect(host.textContent).toContain("reviewing"); expect(button("Add skill")).toBeTruthy();
    expect(button("Add skill").disabled).toBe(true); expect(button("Edit skill reviewing").disabled).toBe(true);
    expect(host.textContent).toContain("Loading skills");
    await update({ skillFilesError: "The skill files could not be read." });
    expect(host.textContent).toContain("The skill files could not be read.");
    await click("Retry skills"); expect(retry).toHaveBeenCalledOnce(); expect(button("Edit skill reviewing").disabled).toBe(true);
    await update({ skillFiles: files, skillFilesError: undefined });
    expect(button("Edit skill reviewing").disabled).toBe(false); expect(saveButton().disabled).toBe(true);
  });
  it("edits markdown without dropping support files, clears dirty on revert, and keeps drafts across sections", async () => {
    const saved: AgentFields[] = [], prompt = vi.fn();
    await render({ skillFiles: files, onEditPromptChange: prompt, onSave: async fields => { saved.push(fields); return null; } });
    await click("Edit skill reviewing"); expect(contents().value).toBe(files["reviewing/SKILL.md"]);
    type(contents(), "New instructions."); expect(saveButton().disabled).toBe(false);
    expect(prompt.mock.calls.at(-1)![0]).toContain('"reviewing/SKILL.md": "New instructions."');
    type(contents(), files["reviewing/SKILL.md"]); expect(saveButton().disabled).toBe(true);
    type(contents(), "Final instructions.");
    const nav = host.querySelector('nav[aria-label="Agent settings sections"]')!;
    await act(async () => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim().startsWith("General"))!.click());
    await act(async () => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim().startsWith("Skills"))!.click());
    await click("Edit skill reviewing"); expect(contents().value).toBe("Final instructions."); await click("Save revision");
    expect(saved[0].skillFiles).toEqual({ ...files, "reviewing/SKILL.md": "Final instructions." }); expect(saveButton().disabled).toBe(true);
  });
  it("creates a named skill draft and rejects duplicate names without replacing saved content", async () => {
    const saved: AgentFields[] = []; await render({ skillFiles: files, onSave: async fields => { saved.push(fields); return null; } });
    await click("Add skill"); type(host.querySelector<HTMLInputElement>("#agent-skill-name")!, "Reviewing"); await click("Create skill");
    expect(host.textContent).toContain("already exists"); expect(saveButton().disabled).toBe(true);
    type(host.querySelector<HTMLInputElement>("#agent-skill-name")!, "Release Checks"); await click("Create skill");
    expect(contents().value).toContain("name: release-checks"); expect(saveButton().disabled).toBe(false);
    type(contents(), "---\nname: release-checks\ndescription: Check releases.\n---\n\nCheck the release notes.\n"); await click("Save revision");
    expect(saved[0].skillFiles).toEqual({ ...files, "release-checks/SKILL.md": contents().value });
  });
  it("keeps edits made during a save unsaved after its response, including support file edits", async () => {
    let answer: (p: SaveProblem | null) => void = () => {}; const sent: AgentFields[] = [];
    await render({ skillFiles: files, onSave: fields => { sent.push(fields); return new Promise(resolve => { answer = resolve; }); } });
    await click("Edit skill reviewing"); type(contents(), "First draft."); await click("Save revision");
    expect(contents().disabled).toBe(false); type(contents(), "Second draft."); await act(async () => answer(null));
    await update({ skillFiles: { ...files, "reviewing/SKILL.md": "First draft." } });
    expect(contents().value).toBe("Second draft."); expect(saveButton().disabled).toBe(false);
    expect(sent[0].skillFiles).toEqual({ ...files, "reviewing/SKILL.md": "First draft." });
    await click("Skill file");
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="reviewing/references/checklist.md"]')!.click());
    expect(contents().value).toBe(files["reviewing/references/checklist.md"]);
    type(contents(), "A revised checklist."); await click("Save revision");
    expect(sent[1].skillFiles).toEqual({ ...files, "reviewing/SKILL.md": "Second draft.", "reviewing/references/checklist.md": "A revised checklist." });
    await act(async () => answer(null));
  });
  it("does not expose custom skill edits on source-owned agents", async () => {
    await render({ agent: { ...agent, definition: { ...agent.definition, sdk: { runtime: "codex-sdk" } } }, skillFiles: files });
    expect(button("Add skill")).toBeUndefined(); expect(button("Edit skill reviewing")).toBeUndefined(); expect(host.textContent).toContain("original source");
  });
});
