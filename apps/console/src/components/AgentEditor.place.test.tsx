import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { placesOf } from "@/lib/place";

// Where an agent runs, in the editor's Settings step: the server's places, bash following the place in the form (a box
// opens it, the runner turns it off and says so), the place in the save, and a refusal at a tool on that tool's field.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const places = placesOf({ places: { modes: ["runner", "sandbox"], boxes: [{ id: "bwrap", available: false, reason: "fixture: no bwrap" }, { id: "docker", available: true }] } });
const tools = toolOffers([{ name: "read", available: true }, { name: "bash", available: true, sandbox_only: true }]);
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools, places };
const agent = (place?: unknown, tools: string[] = ["read"]): Agent => ({
  agent_id: "boxed", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Boxed", instructions: "Probe.", harness: "pi", skills: [], tools, ...(place ? { place } : {}) },
});

function mount(props: Record<string, unknown>) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { onSave: async (f: Record<string, unknown>) => { saved = f; return null; }, ...props } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const step = (label: RegExp) => click([...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")));
  const input = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
  return { host, click, step, input, saved: () => saved };
}

describe("AgentEditor, where the agent runs", () => {
  it("offers the place in the Settings step only on a server that lists places", () => {
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: agent(), caps, step: "settings" }))).toContain('aria-label="Where it runs"');
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: agent(), caps: { ...caps, places: null }, step: "settings" }))).not.toContain("Where it runs");
  });

  it("an agent that names no place, on a server whose default_place is docker, has bash open, as its runs are in the box; with the browser it is on the runner", () => {
    const boxed = placesOf({ places: { modes: ["runner", "sandbox"], default_place: { mode: "sandbox", box: "docker" }, boxes: [{ id: "docker", available: true }] } });
    const shell = mount({ agent: agent(), caps: { ...caps, places: boxed }, step: "settings" });
    expect(shell.input('input[name="place"][value="sandbox"]')!.checked).toBe(true);
    shell.step(/Tools/);
    expect(shell.input('input[type="checkbox"][value="bash"]')!.disabled).toBe(false);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const browsing = mount({ agent: agent(undefined, ["read", "browser"]), caps: { ...caps, places: boxed, tools: toolOffers([{ name: "read", available: true }, { name: "browser", available: true }, { name: "bash", available: true, sandbox_only: true }]) }, step: "settings" });
    expect(browsing.input('input[name="place"][value="runner"]')!.checked).toBe(true);
  });

  it("picking Sandbox opens bash's tick at once; it's saved with the place", async () => {
    const { click, step, input, saved } = mount({ agent: agent(), caps, step: "settings" });
    click(input('input[name="place"][value="sandbox"]'));
    step(/Tools/);
    expect(input('input[type="checkbox"][value="bash"]')!.disabled).toBe(false);
    click(input('input[type="checkbox"][value="bash"]'));
    await act(async () => { [...document.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); });
    expect(saved()).toMatchObject({ place: { mode: "sandbox", box: "docker" }, tools: ["read", "bash"] });
  });

  it("going back to the server turns bash off and says so; bash's tick is then greyed with why", async () => {
    const { host, click, step, input, saved } = mount({ agent: agent({ mode: "sandbox", box: "docker" }, ["read", "bash"]), caps, step: "settings" });
    click(input('input[name="place"][value="runner"]'));
    expect(host.textContent).toContain("Bash runs only in a sandbox, so it's turned off for this agent.");
    step(/Tools/);
    const bash = input('input[type="checkbox"][value="bash"]')!;
    expect(bash.checked).toBe(false);
    expect(bash.disabled).toBe(true);
    expect(bash.closest("label")!.textContent).toContain("Sandbox-only");
    await act(async () => { [...document.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); });
    expect(saved()).toMatchObject({ place: { mode: "runner" }, tools: ["read"] });
  });

  it("a server refusal at one tool (a 422 at definition.tools[1]) shows on the Tools field", () => {
    const problem = { kind: "invalid", message: "the definition is not valid", fields: { "definition.tools[1]": "fixture: bash runs only in a box" } };
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(undefined, ["read", "bash"]), caps, step: "tools", problem } as never));
    expect(html).toContain("fixture: bash runs only in a box");
  });

  it("a tool the server can't run says the server's reason, never a bare \"Needs \"", () => {
    const withReason = toolOffers([{ name: "read", available: true }, { name: "bash", available: false, sandbox_only: true, reason: "fixture: no box can run it here" }]);
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent({ mode: "sandbox", box: "docker" }), caps: { ...caps, tools: withReason }, step: "tools" }));
    expect(html).toContain("fixture: no box can run it here");
    expect(html).not.toMatch(/Needs\s*</);
  });
});
