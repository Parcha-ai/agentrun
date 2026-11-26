import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { toolOffers } from "@/lib/agentForm";
import { placesOf } from "@/lib/place";

// Mode 2: the runner has a shell (Archil's serverless exec), and capabilities say so by serving the runner as a new
// agent's default place. That shell runs bash, so an agent on the runner keeps bash: ticked by default, tickable, and kept
// when the person moves it to the runner. The background tools still need a box. Mode 1: the runner has no shell, so a
// move to the runner drops bash.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["pi", "claude-agent", "codex", "opencode"];
const tools = toolOffers([
  { name: "read", available: true, harnesses: ALL }, { name: "write", available: true, harnesses: ALL },
  { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] }, { name: "bash_background", available: true, sandbox_only: true, harnesses: ["pi"] },
]);
const served = (boxes: unknown[], defaultPlace: unknown) => placesOf({ places: { modes: ["runner", "sandbox"], boxes, default_place: defaultPlace } });
const MODE2 = served([{ id: "modal", available: true }], { mode: "runner" });
const MODE1 = served([{ id: "docker", available: true }], { mode: "sandbox", box: "docker" });

function mount(places: ReturnType<typeof placesOf>) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { caps: { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools, places }, step: "computer", onSave: async (f: Record<string, unknown>) => { saved = f; return null; } } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const input = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
  const step = (label: RegExp) => click([...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")));
  const save = async () => {
    step(/General|Instructions/);
    const set = (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => act(() => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    set(host.querySelector("#agent-name"), "Shelly");
    set(host.querySelector("#agent-instructions"), "Probe.");
    await act(async () => { [...document.querySelectorAll("button")].find((b) => /^Create/.test(b.textContent ?? ""))!.click(); });
    return saved;
  };
  return { host, click, input, step, save };
}

describe("AgentEditor, bash on the runner", () => {
  it("Mode 2: a new agent on the runner has bash ticked and tickable, and a move to the runner keeps it", async () => {
    const form = mount(MODE2);
    expect(form.input('input[name="place"][value="runner"]')!.checked).toBe(true);
    form.step(/Tools/);
    const bash = () => form.input('input[type="checkbox"][value="bash"]')!;
    expect(bash().checked).toBe(true);
    expect(form.input('input[type="checkbox"][value="bash_background"]')!.checked).toBe(false);
    form.click(bash());
    expect(bash().checked).toBe(false);
    form.click(bash());
    expect(bash().checked).toBe(true);
    // To a box and back to the runner: bash stays.
    form.step(/Computer/);
    form.click(form.input('input[name="place"][value="sandbox"]'));
    form.click(form.input('input[name="place"][value="runner"]'));
    expect(form.host.textContent).not.toContain("only in a sandbox, so");
    const sent = await form.save();
    expect(sent).toMatchObject({ place: { mode: "runner" } });
    expect(sent?.tools).toContain("bash");
    expect(sent?.tools).not.toContain("bash_background");
  });

  it("Mode 1: a move from Docker's box to the runner drops bash", async () => {
    const form = mount(MODE1);
    form.step(/Tools/);
    expect(form.input('input[type="checkbox"][value="bash"]')!.checked).toBe(true);
    form.step(/Computer/);
    form.click(form.input('input[name="place"][value="runner"]'));
    const sent = await form.save();
    expect(sent).toMatchObject({ place: { mode: "runner" } });
    expect(sent?.tools).not.toContain("bash");
  });
});
