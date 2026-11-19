import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, type AgentFields, toolOffers } from "@/lib/agentForm";

// The Computer step keeps what a person set on the computer (image, persistent, gpu, surface, exec, record) across a
// switch of provider or kind that can take it, and drops, in words, what the new pick can't. "Can take" is read from the
// served computers list: a provider's images, persistent and gpu; the kinds that drive or record are serve's.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, secrets: [], required: [], ready: true, metered: false, ...extra });
const KINDS = [
  { kind: "none", offered: true, groups: [], tools: ["read"], providers: [] },
  { kind: "sandbox", offered: true, groups: ["exec"], tools: ["read", "bash"], providers: [
    provider("docker", "Docker"),
    provider("modal", "Modal", { images: ["py"], persistent: { images: ["py"] }, gpu: { types: ["T4"], max: 2 } }),
    provider("daytona", "Daytona", { images: ["py"], persistent: { images: ["py"] } }),
  ] },
  { kind: "desktop", offered: true, groups: ["screen"], tools: ["read", "screen.shot"], providers: [
    provider("orgo", "Orgo", { images: ["windows"], persistent: { images: ["windows"] } }),
    provider("e2b", "E2B"),
  ] },
  { kind: "phone", offered: true, groups: ["screen"], tools: ["read", "screen.shot"], providers: [provider("phone-harness", "Phone harness", { persistent: {} })] },
];
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi"] }]), computers: KINDS };
const agent = (computer: Record<string, unknown>): Agent => ({
  agent_id: "set", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Set", instructions: "Probe.", harness: "pi", skills: [], tools: ["read"], computer } as Agent["definition"],
});
const SANDBOX = { kind: "sandbox", provider: "modal", image: "py", persistent: true, gpu: { type: "T4", count: 1 } };
const DESKTOP = { kind: "desktop", provider: "orgo", image: "windows", persistent: true, surface: "code", exec: false, record: true };

function mount(a: Agent) {
  let saved: AgentFields | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent: a, caps, step: "computer", onSave: async (f: AgentFields) => { saved = f; return null; } } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const save = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); }); return saved!.computer; };
  const kind = (k: string) => host.querySelector(`input[name="computer-kind"][value="${k}"]`);
  const prov = (id: string) => host.querySelector(`input[name="computer-provider"][value="${id}"]`);
  const said = () => [...host.querySelectorAll('[role="status"]')].map((n) => n.textContent).filter((t) => / is off: /.test(t ?? ""));
  return { click, save, kind, prov, said };
}

describe("AgentEditor, the Computer step's fields across a switch", () => {
  it("another provider that takes them keeps image, persistent; drops a gpu it has none of, and says so", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.prov("daytona"));
    expect(m.said()).toEqual(["The GPU is off: Daytona has no GPUs."]);
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "daytona", image: "py", persistent: true });
  });

  it("a provider with no images, no persistence and no GPUs drops all three, each in words", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.prov("docker"));
    expect(m.said()).toEqual([
      'The image is off: Docker does not offer "py" for a sandbox.',
      "Keeping the computer between runs is off: Docker's sandbox keeps no computer between runs.",
      "The GPU is off: Docker has no GPUs.",
    ]);
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "docker" });
  });

  it("a GPU type or count the provider doesn't give is dropped; one it does is kept", async () => {
    const t4x3 = mount(agent({ ...SANDBOX, provider: "docker", gpu: { type: "T4", count: 3 } }));
    t4x3.click(t4x3.prov("modal"));
    expect(t4x3.said()).toEqual(["The GPU is off: Modal gives at most 2 per computer."]);
    expect((await t4x3.save())?.gpu).toBeUndefined();
    act(() => root?.unmount()); document.body.innerHTML = "";
    const a100 = mount(agent({ ...SANDBOX, provider: "docker", image: undefined, persistent: undefined, gpu: { type: "A100", count: 1 } }));
    a100.click(a100.prov("modal"));
    expect(a100.said()).toEqual(["The GPU is off: Modal has no A100."]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const ok = mount(agent({ ...SANDBOX, provider: "docker" }));
    ok.click(ok.prov("modal"));
    expect((await ok.save())?.gpu).toEqual({ type: "T4", count: 1 });
  });

  it("a provider ready for computers whose GPUs this server can't give drops the GPU in serve's words", async () => {
    const why = "A Modal GPU computer can't mount this run's folder yet: no mount on gVisor. Use a GPU computer from the library, or this sandbox without a GPU.";
    const modal = KINDS[1]!.providers[1]! as { gpu?: Record<string, unknown> };
    const gpu = modal.gpu;
    modal.gpu = { ...gpu, why };
    try {
      const m = mount(agent({ ...SANDBOX, provider: "docker" }));
      m.click(m.prov("modal"));
      expect(m.said()).toEqual([`The GPU is off: ${why}`]);
      expect((await m.save())?.gpu).toBeUndefined();
    } finally {
      modal.gpu = gpu;
    }
  });

  it("a desktop's provider that offers the image and persistence keeps all six; one that doesn't drops image and persistent only", async () => {
    const m = mount(agent({ ...DESKTOP, provider: "e2b" }));
    m.click(m.prov("orgo"));
    expect(await m.save()).toEqual(DESKTOP);
    m.click(m.prov("e2b"));
    expect(m.said()).toEqual(['The image is off: E2B does not offer "windows" for a desktop.', "Keeping the computer between runs is off: E2B's desktop keeps no computer between runs."]);
    expect(await m.save()).toEqual({ kind: "desktop", provider: "e2b", surface: "code", exec: false, record: true });
  });

  it("desktop to phone keeps surface, exec, record and persistent; drops the image", async () => {
    const m = mount(agent(DESKTOP));
    m.click(m.kind("phone"));
    expect(m.said()).toEqual(['The image is off: Phone harness does not offer "windows" for a phone.']);
    expect(await m.save()).toEqual({ kind: "phone", provider: "phone-harness", persistent: true, surface: "code", exec: false, record: true });
  });

  it("desktop to sandbox drops surface, exec and record, in words; the desktop's image stays off", async () => {
    const m = mount(agent(DESKTOP));
    m.click(m.kind("sandbox"));
    const said = m.said().join("\n");
    expect(said).toContain("The way the agent drives it is off: only a desktop or a phone takes it, and a sandbox has nothing to drive.");
    expect(said).toContain("The no-shell setting is off: only a desktop or a phone takes it");
    expect(said).toContain("Recording is off: a sandbox has no screen to record.");
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "docker" });
  });

  it("sandbox to desktop drops the GPU, says only a sandbox takes it, and none drops all", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.kind("desktop"));
    expect(m.said()).toContain("The GPU is off: only a sandbox takes GPUs.");
    expect((await m.save())?.gpu).toBeUndefined();
    m.click(m.kind("none"));
    expect(m.said()).toContain("The GPU is off: with no computer, there is nothing to hold it.");
    expect(await m.save()).toEqual({ kind: "none" });
  });

  it("says nothing when a switch drops nothing", async () => {
    const m = mount(agent({ kind: "sandbox", provider: "docker" }));
    m.click(m.kind("desktop"));
    expect(m.said()).toEqual([]);
  });
});
