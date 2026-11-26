import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { placesOf } from "@/lib/place";
import { SERVED_AGENT } from "@/test/agent";

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

// The runner's shell runs bash only for a run whose shell is the runner's own: the server lets bash on a runner place
// where its run shell (resolve-computer.ts runShellOf) is "local", which GET /v2/computers serves as each provider's
// `shell`. A desktop that mounts the run's folder ("computer") is on a runner place but gets no such shell, so a Mode 2
// move to it drops bash, says why, and its card is not offered; one that mounts nothing ("local") keeps bash.
describe("AgentEditor, bash on a runner-placed computer (Mode 2)", () => {
  const provider = (id: string, shell: "computer" | "local" | "none") => ({ id, name: id, secrets: [], required: [], ready: true, metered: false, shell });
  const KINDS = [
    { kind: "none", offered: true, groups: [], tools: ["read", "bash"], settings: [], record: { available: false, why: "fixture: no computer" }, providers: [], shell: "local" },
    { kind: "desktop", offered: true, groups: ["screen"], tools: ["read", "screen.shot"], settings: ["surface", "exec", "record"], record: { available: false, why: "fixture: no ffmpeg" }, providers: [provider("e2b", "computer"), provider("unmounted", "local")] },
  ];
  const agent = (computer: Record<string, unknown>): Agent => ({
    ...SERVED_AGENT, agent_id: "shelly", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Shelly", instructions: "Probe.", harness: "pi", skills: [], tools: ["read", "bash"], computer: computer as NonNullable<Agent["definition"]["computer"]> },
  });
  function open(a: Agent) {
    let saved: Record<string, unknown> | undefined;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: a, caps: { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools, places: MODE2, computers: KINDS }, step: "computer", onSave: async (f: Record<string, unknown>) => { saved = f; return null; } } as never)));
    const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
    const input = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
    const step = (label: RegExp) => click([...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")));
    const save = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); }); return saved; };
    return { host, click, input, step, save };
  }

  it("a move from no computer to a desktop that mounts the run's folder drops bash, says why, and its card is not offered", async () => {
    const form = open(agent({ kind: "none" }));
    form.click(form.input('input[name="computer-kind"][value="desktop"]'));
    expect(form.input('input[name="computer-provider"][value="e2b"]')!.checked).toBe(true);
    expect(form.host.textContent).toMatch(/Bash is turned off/);
    form.step(/Tools/);
    const bash = form.input('input[type="checkbox"][value="bash"]')!;
    expect(bash.checked).toBe(false);
    expect(bash.disabled).toBe(true);
    expect(bash.closest("label")!.textContent).toContain("Sandbox-only");
    const sent = await form.save();
    expect(sent).toMatchObject({ computer: { kind: "desktop", provider: "e2b" }, place: { mode: "runner" } });
    expect(sent?.tools).not.toContain("bash");
  });

  it("an agent saved on that desktop is not offered bash on its card", () => {
    const form = open(agent({ kind: "desktop", provider: "e2b" }));
    form.step(/Tools/);
    expect(form.input('input[type="checkbox"][value="bash"]')!.disabled).toBe(true);
  });

  it("a desktop that mounts nothing, whose run shell is the runner's own, keeps bash and says nothing", async () => {
    const form = open(agent({ kind: "none" }));
    form.click(form.input('input[name="computer-kind"][value="desktop"]'));
    form.click(form.input('input[name="computer-provider"][value="unmounted"]'));
    expect(form.host.textContent).not.toMatch(/Bash is turned off/);
    form.step(/Tools/);
    // Dropped by the move through e2b, and tickable again here.
    const bash = form.input('input[type="checkbox"][value="bash"]')!;
    expect(bash.disabled).toBe(false);
    form.click(bash);
    const sent = await form.save();
    expect(sent).toMatchObject({ computer: { kind: "desktop", provider: "unmounted" } });
    expect(sent?.tools).toContain("bash");
  });
});
