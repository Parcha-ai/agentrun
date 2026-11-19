import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { agentFixture, editorCaps } from "@/fixtures";
import { DECISION, WORKFLOW } from "@/lib/agentForm";

// Each of the editor's own inputs is named by its label: a screen reader reads "Name" on the name input, a click on the
// label puts the cursor in it, and a test finds it by its label, as a person does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(props: Partial<Parameters<typeof AgentEditor>[0]>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(AgentEditor, { agent: null, caps: editorCaps, ...props })); });
  // What a label names, as getByLabelText finds it: the element its `for` points at, else the control inside it.
  const byLabel = (text: RegExp) => {
    const labels = [...host.querySelectorAll("label")].filter((l) => text.test((l.textContent ?? "").trim()));
    return labels.map((l) => (l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector("input, textarea, select"))).filter((c) => c !== null);
  };
  return { host, byLabel };
}

describe("the agent editor's labels name their inputs", () => {
  it("a new agent's first step: Name, Description and Instructions each name their own input", async () => {
    const { byLabel } = await open({ step: "context" });
    const [name] = byLabel(/^name/i);
    expect(name?.getAttribute("placeholder")).toBe("e.g., Invoice checker");
    expect(byLabel(/^description/i)[0]?.getAttribute("placeholder")).toBe("Short summary for the agent list");
    expect(byLabel(/^instructions/i)[0]?.tagName).toBe("TEXTAREA");
  });
  it("an agent's edit: the read-only name keeps its label, and Model names its input on the settings step", async () => {
    const agent = agentFixture("invoice-checker");
    const { byLabel } = await open({ agent, step: "context" });
    const name = byLabel(/^name/i)[0] as HTMLInputElement | undefined;
    expect(name?.value).toBe(agent.definition.name);
    expect(name?.readOnly).toBe(true);
    act(() => root!.unmount()); document.body.innerHTML = "";
    const settings = await open({ agent, step: "settings" });
    // The Model picker's button is what the label names.
    expect(settings.byLabel(/^model/i)[0]?.id).toBe("agent-model");
  });
  it("Instructions' preview has no input, so no label points at one that isn't there", async () => {
    const { host, byLabel } = await open({ step: "context" });
    const previewButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Preview")!;
    await act(async () => { previewButton.click(); });
    expect(host.querySelector("textarea")).toBeNull();
    expect(byLabel(/^instructions/i)).toEqual([]);
    const dangling = [...host.querySelectorAll("label")].filter((l) => l.htmlFor && !document.getElementById(l.htmlFor));
    expect(dangling.map((l) => l.textContent)).toEqual([]);
    expect(byLabel(/^name/i)).toHaveLength(1);
  });
});

// These fields contain lists, controls or an action rather than one labelled input. Test the actual editor with the
// shared Field, including the descriptions a screen reader follows; visible captions alone do not name a group.
const textAtIds = (el: Element, attribute: string) => (el.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean).map((id) => {
  const target = document.getElementById(id);
  expect(target, `${attribute} must point to an existing element: ${id}`).not.toBeNull();
  return target!.textContent ?? "";
}).join(" ");
const namedGroup = (host: HTMLElement, name: string) => {
  const matches = [...host.querySelectorAll<HTMLElement>('[role="group"]')].filter((group) => textAtIds(group, "aria-labelledby") === name);
  expect(matches, `one accessible ${name} group`).toHaveLength(1);
  return matches[0]!;
};

describe("the agent editor's composite field groups", () => {
  it("names Tools and Skills and links their help, refusal and warning without changing the tool edit", async () => {
    const savedAgent = agentFixture("invoice-checker");
    const agent = { ...savedAgent, definition: { ...savedAgent.definition, tools: ["read", "write"], skills: ["billing.md"] }, warnings: [{ field: "definition.tools[0]", reason: "missing" as const, message: "Need a configured source." }] };
    let saved: { tools?: string[] } | undefined;
    const { host } = await open({ agent, step: "tools", problem: { kind: "invalid", message: "Refused", fields: { "definition.tools[0]": "Choose another tool." } }, onSave: async (fields) => { saved = fields; return null; } });
    const tools = namedGroup(host, "Tools"), skills = namedGroup(host, "Skills");
    const descriptions = textAtIds(tools, "aria-describedby");
    expect(descriptions).toContain("On by default");
    expect(descriptions).toContain("Choose another tool.");
    expect(descriptions).toContain("Need a configured source.");
    expect(textAtIds(skills, "aria-describedby")).toContain("Skill files are saved with each revision");
    expect(skills.textContent).toContain("billing.md");
    const read = tools.querySelector<HTMLInputElement>('input[type="checkbox"][value="read"]')!;
    expect(read.checked).toBe(true);
    await act(async () => { read.focus(); read.click(); });
    expect(document.activeElement).toBe(read);
    expect(read.checked).toBe(false);
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Save revision")!.click(); });
    expect(saved?.tools).toEqual(["write"]);
  });

  it("names a saved workflow's action group and links its help and warning", async () => {
    const savedAgent = agentFixture("invoice-checker");
    const agent = { ...savedAgent, kind: "workflow" as const, definition: { ...savedAgent.definition, workflow: { v: 2, name: "check", root: { node: "chain", steps: [] } } }, warnings: [{ field: "definition.workflow/root", reason: "missing" as const, message: "Workflow needs a source." }] };
    const { host } = await open({ agent, step: "context" });
    const group = namedGroup(host, "Workflow");
    expect(textAtIds(group, "aria-describedby")).toContain("Edit its nodes in the Workflow step");
    expect(textAtIds(group, "aria-describedby")).toContain("Workflow needs a source.");
    const action = group.querySelector<HTMLButtonElement>("button")!;
    expect(action.textContent?.trim()).toBe("Open the workflow");
    action.focus();
    expect(document.activeElement).toBe(action);
    expect([...group.querySelectorAll("label")].filter((label) => label.htmlFor && !document.getElementById(label.htmlFor))).toEqual([]);
  });

  it.each([WORKFLOW, DECISION])("names the new %s starter explanation instead of labelling a nonexistent input", async (harness) => {
    const { host } = await open({ step: "settings", caps: { ...editorCaps, decisionProvider: "jev" } });
    await act(async () => { host.querySelector<HTMLInputElement>(`input[type="radio"][value="${harness}"]`)!.click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Context"))!.click(); });
    const group = namedGroup(host, "Workflow");
    expect(group.textContent).toContain(harness === DECISION ? "A decision agent is a workflow" : "A workflow agent starts from a one-step workflow");
    expect(group.querySelector("label")).toBeNull();
  });

  it("keeps each composite group's naming and help IDs unique when two editors render", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement("div", null, ...["one", "two"].map((key) => createElement(AgentEditor, { key, agent: agentFixture("invoice-checker"), caps: editorCaps, step: "tools" })))); });
    const groups = [...host.querySelectorAll('[role="group"]')].filter((group) => ["Tools", "Skills"].includes(textAtIds(group, "aria-labelledby")));
    expect(groups).toHaveLength(4);
    const ids = groups.flatMap((group) => ["aria-labelledby", "aria-describedby"].flatMap((attribute) => (group.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect([...host.querySelectorAll("[id]")].filter((el) => el.id === id)).toHaveLength(1);
  });
});
