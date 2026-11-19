import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, type AgentFields, type SaveProblem, editBody, toolOffers } from "@/lib/agentForm";
import type { Computer } from "@/lib/v2";
import { SERVED_AGENT } from "@/test/agent";

// The Computer step's run video (`computer.record`, serve's README "A video of each run"): a switch of provider, or of
// kind to another that records, keeps it; a kind with no screen drops it and says so; a Recording switch sets and
// clears it; and a saved `record: true` survives an edit that never touches the computer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ready = (id: string, name: string) => ({ id, name, secrets: [], required: [], ready: true, metered: false });
const KINDS = [
  { kind: "none", offered: true, groups: [], tools: ["read"], providers: [] },
  { kind: "sandbox", offered: true, groups: ["exec", "files", "processes"], tools: ["read", "bash"], providers: [ready("docker", "Docker")] },
  { kind: "desktop", offered: true, groups: ["screen", "input.pointer", "input.keys"], tools: ["read", "screen.shot"], providers: [ready("orgo", "Orgo"), ready("e2b", "E2B")] },
  { kind: "phone", offered: true, groups: ["screen", "input.touch", "apps"], tools: ["read", "screen.shot"], providers: [ready("phone-harness", "Phone harness")] },
  { kind: "browser", offered: true, groups: ["cdp"], tools: ["browser"], providers: [ready("browserbase", "Browserbase")] },
];
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi"] }]), computers: KINDS };
const RECORDED: Computer = { kind: "desktop", provider: "orgo", record: true };
const agent = (computer: Computer = RECORDED): Agent => ({
  ...SERVED_AGENT, agent_id: "filmed", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Filmed", instructions: "Probe.", harness: "pi", skills: [], tools: ["read"], computer },
});

function mount(a: Agent, step = "computer", answer: SaveProblem | null = null) {
  let saved: AgentFields | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent: a, caps, step, onSave: async (f: AgentFields) => { saved = f; return answer; } } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const save = () => act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); });
  const kind = (k: string) => host.querySelector(`input[name="computer-kind"][value="${k}"]`) as HTMLInputElement;
  const provider = (id: string) => host.querySelector(`input[name="computer-provider"][value="${id}"]`) as HTMLInputElement;
  const recording = () => host.querySelector('[role="switch"][aria-labelledby="computer-record"]') as HTMLButtonElement | null;
  return { host, click, save, kind, provider, recording, saved: () => saved };
}

describe("AgentEditor, the Computer step's recording", () => {
  it("picking another provider of the same kind keeps record", async () => {
    const { click, save, provider, saved } = mount(agent());
    click(provider("e2b"));
    await save();
    expect(saved()!.computer).toEqual({ kind: "desktop", provider: "e2b", record: true });
  });

  it("picking another kind that records (desktop to phone, desktop to browser) keeps record", async () => {
    const phone = mount(agent());
    phone.click(phone.kind("phone"));
    await phone.save();
    expect(phone.saved()!.computer).toEqual({ kind: "phone", provider: "phone-harness", record: true });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const browser = mount(agent());
    browser.click(browser.kind("browser"));
    await browser.save();
    expect(browser.saved()!.computer).toEqual({ kind: "browser", provider: "browserbase", record: true });
  });

  it("picking a sandbox drops record and says so beside the kind; none does too", async () => {
    const { host, click, save, kind, saved } = mount(agent());
    click(kind("sandbox"));
    const card = host.querySelector('[data-kind="sandbox"]')!;
    expect(card.textContent).toContain("Recording is off: a sandbox has no screen to record.");
    await save();
    expect(saved()!.computer).toEqual({ kind: "sandbox", provider: "docker" });
    click(kind("none"));
    expect(host.querySelector('[data-kind="none"]')!.textContent).toContain("Recording is off: with no computer, there is no screen to record.");
    expect(host.querySelector('[data-kind="sandbox"]')!.textContent).not.toContain("Recording is off");
  });

  it("says nothing of recording when a kind switch drops none", () => {
    const { host, click, kind } = mount(agent({ kind: "desktop", provider: "orgo" }));
    click(kind("sandbox"));
    expect(host.textContent).not.toContain("Recording is off");
  });

  it("a Recording switch, off by default, sets and clears record, under the README's privacy words", async () => {
    const { host, click, save, recording, saved } = mount(agent({ kind: "desktop", provider: "orgo" }));
    expect(recording()).not.toBeNull();
    expect(recording()!.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("#computer-record")!.textContent).toBe("Record a video of each run");
    const words = host.querySelector('[aria-label="Recording"]')!.textContent;
    expect(words).toContain("everything on the screen");
    expect(words).toContain("what a person types after taking over");
    expect(words).toContain("any password shown");
    expect(words).toContain("Pixels can't be redacted.");
    click(recording());
    expect(recording()!.getAttribute("aria-checked")).toBe("true");
    await save();
    expect(saved()!.computer).toEqual({ kind: "desktop", provider: "orgo", record: true });
    click(recording());
    await save();
    expect(saved()!.computer).toEqual({ kind: "desktop", provider: "orgo" });
  });

  it("shows no Recording switch for a kind that can't record", () => {
    const { click, kind, recording } = mount(agent({ kind: "sandbox", provider: "docker" }));
    expect(recording()).toBeNull();
    click(kind("none"));
    expect(recording()).toBeNull();
  });

  it("a saved record: true shows on, and survives an edit that never opens the Computer step", async () => {
    const shown = mount(agent());
    expect(shown.recording()!.getAttribute("aria-checked")).toBe("true");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const a = agent();
    const { host, save, saved } = mount(a, "context");
    const instructions = host.querySelector("#agent-instructions") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Probe again.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await save();
    expect(editBody(a, saved()!, "").definition.computer).toEqual(RECORDED);
  });

  it("a server's 422 on record (no ffmpeg) shows its own words in the Computer step", async () => {
    const words = "definition.computer.record needs ffmpeg, which records the video: ffmpeg is not on this server's PATH";
    const { host, click, save, recording } = mount(agent({ kind: "desktop", provider: "orgo" }), "computer", { kind: "invalid", message: words, fields: { "definition.computer.record": words } });
    click(recording());
    await save();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(words);
  });
});
