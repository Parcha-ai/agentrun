import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { agentFixture, editorCaps, revisionsOf } from "@/fixtures";

// History opens a workflow agent's past revision as its graph, read-only, marked against the current one, with Make
// current beside it and Back to History; an agentic agent's History is as it was.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(slug: string, extra: Partial<Parameters<typeof AgentEditor>[0]> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(AgentEditor, { agent: agentFixture(slug), revisions: revisionsOf(slug), caps: editorCaps, step: "history", onSave: vi.fn(async () => null), ...extra })); });
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()) || label.test(b.getAttribute("aria-label") ?? ""));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); };
  return { host, button, click };
}

describe("AgentEditor's History, a workflow agent's past revision", () => {
  it("View opens its workflow as the read-only graph, marked against the current revision, with no save, and Back returns", async () => {
    const past = revisionsOf("support-triage").find((r) => !r.current)!;
    const validate = vi.fn();
    const page = await open("support-triage", { validate });
    expect(page.button(/^View rev 2$/), "the current revision is not offered").toBeUndefined();
    await page.click(new RegExp(`^View rev ${past.version}$`));
    const area = page.host.querySelector("textarea[aria-label='Workflow JSON']") as HTMLTextAreaElement;
    expect(JSON.parse(area.value)).toEqual(past.definition!.workflow);
    expect(area.readOnly).toBe(true);
    expect(page.host.querySelector("svg")).not.toBeNull();
    expect(page.host.textContent).toContain("Read-only");
    expect(page.host.textContent).toMatch(/against rev 2, the current one|Same as rev 2, the current one/);
    expect(page.button(/^Save revision$/)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    await page.click(/^Back to History$/);
    expect(page.host.querySelector("textarea[aria-label='Workflow JSON']")).toBeNull();
    expect(page.button(/^Save revision$/)).toBeTruthy();
  });

  it("Make current beside the graph makes that revision current", async () => {
    const past = revisionsOf("support-triage").find((r) => !r.current)!;
    const onMakeCurrent = vi.fn();
    const page = await open("support-triage", { onMakeCurrent });
    await page.click(new RegExp(`^View rev ${past.version}$`));
    await page.click(/^Make current$/);
    expect(onMakeCurrent).toHaveBeenCalledWith(past.revision);
  });

  it("an agentic agent's History offers no View, only Make current", async () => {
    const page = await open("invoice-checker");
    expect(page.button(/^View rev/)).toBeUndefined();
    expect(page.button(/^Make current$/)).toBeTruthy();
  });
});
