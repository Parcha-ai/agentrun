import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { agentFixture, editorCaps } from "@/fixtures";

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
    expect(settings.byLabel(/^model/i)[0]?.getAttribute("placeholder")).toBe("provider/model");
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
