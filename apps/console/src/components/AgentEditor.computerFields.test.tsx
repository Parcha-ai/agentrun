import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, type AgentFields, toolOffers } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";

// The Computer step keeps what a person set on the computer (image, persistent, gpu, surface, exec, record) across a
// switch of provider or kind that can take it, and drops what the new pick can't, with one line on the kind's card for
// each. "Can take" is read from the served computers list: a kind's settings, and a provider's images, persistent and gpu.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, secrets: [], required: [], ready: true, metered: false, ...extra });
const DRIVEN = ["image", "persistent", "surface", "exec", "record"];
const KINDS = [
  { kind: "none", offered: true, groups: [], tools: ["read"], settings: [], providers: [] },
  { kind: "sandbox", offered: true, groups: ["exec"], tools: ["read", "bash"], settings: ["image", "persistent", "gpu"], providers: [
    provider("docker", "Docker"),
    provider("modal", "Modal", { images: ["py"], persistent: { images: ["py"] }, gpu: { types: ["T4"], max: 2 } }),
    provider("daytona", "Daytona", { images: ["py"], persistent: { images: ["py"] } }),
  ] },
  { kind: "desktop", offered: true, groups: ["screen"], tools: ["read", "screen.shot"], settings: DRIVEN, providers: [
    provider("orgo", "Orgo", { images: ["windows"], persistent: { images: ["windows"] } }),
    provider("e2b", "E2B"),
  ] },
  { kind: "phone", offered: true, groups: ["screen"], tools: ["read", "screen.shot"], settings: DRIVEN, providers: [provider("phone-harness", "Phone harness", { persistent: {} })] },
];
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi"] }]), computers: KINDS };
const agent = (computer: Record<string, unknown>): Agent => ({
  ...SERVED_AGENT, agent_id: "set", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Set", instructions: "Probe.", harness: "pi", skills: [], tools: ["read"], computer: computer as NonNullable<Agent["definition"]["computer"]> },
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
  /** The kind card's lines, one for each setting the switches dropped. */
  const said = () => [...host.querySelectorAll('[data-kind] [role="status"]')].map((n) => n.textContent);
  return { click, save, kind, prov, said };
}

describe("AgentEditor, the Computer step's fields across a switch", () => {
  it("another provider that takes them keeps image, persistent; drops a gpu it has none of, and says so", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.prov("daytona"));
    expect(m.said()).toHaveLength(1);
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "daytona", image: "py", persistent: true });
  });

  it("a provider with no images, no persistence and no GPUs drops all three, a line for each", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.prov("docker"));
    expect(m.said()).toHaveLength(3);
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "docker" });
  });

  it("a GPU type or count the provider doesn't give is dropped; one it does is kept", async () => {
    const t4x3 = mount(agent({ ...SANDBOX, provider: "docker", gpu: { type: "T4", count: 3 } }));
    t4x3.click(t4x3.prov("modal"));
    expect(t4x3.said()).toHaveLength(1);
    expect(await t4x3.save()).toEqual({ kind: "sandbox", provider: "modal", image: "py", persistent: true });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const a100 = mount(agent({ kind: "sandbox", provider: "docker", gpu: { type: "A100", count: 1 } }));
    a100.click(a100.prov("modal"));
    expect(a100.said()).toHaveLength(1);
    expect(await a100.save()).toEqual({ kind: "sandbox", provider: "modal" });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const ok = mount(agent({ ...SANDBOX, provider: "docker" }));
    ok.click(ok.prov("modal"));
    expect(ok.said()).toEqual([]);
    expect(await ok.save()).toEqual(SANDBOX);
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
    expect(m.said()).toHaveLength(2);
    expect(await m.save()).toEqual({ kind: "desktop", provider: "e2b", surface: "code", exec: false, record: true });
  });

  it("desktop to phone keeps surface, exec, record and persistent; drops the image", async () => {
    const m = mount(agent(DESKTOP));
    m.click(m.kind("phone"));
    expect(m.said()).toHaveLength(1);
    expect(await m.save()).toEqual({ kind: "phone", provider: "phone-harness", persistent: true, surface: "code", exec: false, record: true });
  });

  it("desktop to sandbox drops surface, exec and record, and Docker the image and persistent: a line for each", async () => {
    const m = mount(agent(DESKTOP));
    m.click(m.kind("sandbox"));
    expect(m.said()).toHaveLength(5);
    expect(await m.save()).toEqual({ kind: "sandbox", provider: "docker" });
  });

  it("sandbox to desktop drops the GPU and an image Orgo doesn't offer, and none drops all", async () => {
    const m = mount(agent(SANDBOX));
    m.click(m.kind("desktop"));
    expect(m.said()).toHaveLength(2);
    expect(await m.save()).toEqual({ kind: "desktop", provider: "orgo", persistent: true });
    m.click(m.kind("none"));
    expect(m.said()).toHaveLength(3);
    expect(await m.save()).toEqual({ kind: "none" });
  });

  it("what a kind takes is its served settings: a desktop the server says records nothing drops record, and shows no Recording switch", async () => {
    const desktop = KINDS[2]!;
    desktop.settings = DRIVEN.filter((field) => field !== "record");
    try {
      const m = mount(agent(DESKTOP));
      m.click(m.prov("e2b"));
      expect(m.said()).toHaveLength(3);
      expect(await m.save()).toEqual({ kind: "desktop", provider: "e2b", surface: "code", exec: false });
      expect(document.querySelector('[aria-label="Recording"]')).toBeNull();
    } finally {
      desktop.settings = DRIVEN;
    }
  });

  it("says nothing when a switch drops nothing", async () => {
    const m = mount(agent({ kind: "sandbox", provider: "docker" }));
    m.click(m.kind("desktop"));
    expect(m.said()).toEqual([]);
  });
});
