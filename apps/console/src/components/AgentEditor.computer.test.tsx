import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { placesOf } from "@/lib/place";

// The editor's Computer step: where the agent's runs execute and what they drive. It comes before Tools & skills (the
// computer decides the tools), and a pick there is saved as definition.computer, the setting the server keeps place as
// a view of.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const places = placesOf({ places: { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }] } });
const tools = toolOffers([{ name: "read", available: true }, { name: "bash", available: true, sandbox_only: true }]);
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools, places };
const agent = (definition: Record<string, unknown> = {}): Agent => ({
  agent_id: "computed", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Computed", instructions: "Probe.", harness: "pi", skills: [], tools: ["read"], ...definition },
});

function mount(props: Record<string, unknown>) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { onSave: async (f: Record<string, unknown>) => { saved = f; return null; }, ...props } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const input = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
  const save = () => act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!.click(); });
  const rail = () => [...host.querySelectorAll("ol li")].map((li) => li.textContent ?? "");
  return { host, click, input, save, rail, saved: () => saved };
}

describe("AgentEditor, the Computer step", () => {
  it("comes after Context and before Tools & skills", () => {
    const { rail } = mount({ agent: agent(), caps, step: "computer" });
    const names = rail().map((text) => /^\d*\s*(Context|Computer|Tools & skills|Settings|History)/.exec(text)?.[1] ?? text);
    expect(names.indexOf("Computer")).toBe(names.indexOf("Context") + 1);
    expect(names.indexOf("Tools & skills")).toBe(names.indexOf("Computer") + 1);
  });

  it("holds where the agent runs; the Settings step no longer does", () => {
    const computer = mount({ agent: agent(), caps, step: "computer" });
    expect(computer.host.querySelector('[aria-label="Where it runs"]')).not.toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    const settings = mount({ agent: agent(), caps, step: "settings" });
    expect(settings.host.querySelector('[aria-label="Where it runs"]')).toBeNull();
  });

  it("a sandbox picked is saved as the computer: sandbox on that box's provider", async () => {
    const { click, input, save, saved } = mount({ agent: agent(), caps, step: "computer" });
    click(input('input[name="place"][value="sandbox"]'));
    await save();
    expect(saved()).toMatchObject({ computer: { kind: "sandbox", provider: "docker" } });
  });

  it("the server picked is saved as the computer none", async () => {
    const { click, input, save, saved } = mount({ agent: agent({ place: { mode: "sandbox", box: "docker" }, computer: { kind: "sandbox", provider: "docker" }, tools: ["read", "bash"] }), caps, step: "computer" });
    click(input('input[name="place"][value="runner"]'));
    await save();
    expect(saved()).toMatchObject({ computer: { kind: "none" } });
  });

  it("is not offered to a workflow agent, which runs on the runner", () => {
    const { rail } = mount({ agent: { ...agent(), kind: "workflow", definition: { version: 1, name: "Flow", skills: [], tools: [], workflow: { version: 1, root: { node: "chain", steps: [] } } } }, caps, step: "workflow" });
    expect(rail().some((text) => text.includes("Computer"))).toBe(false);
  });

  // The kind cards, each kind's providers and "The loop gets …" read the server's computers list (capabilities.computers,
  // the same list GET /v2/computers answers). The words below are this fixture's; the console shows the server's.
  const KINDS = [
    { kind: "none", offered: true, groups: [], tools: ["read", "write", "edit", "bash"], providers: [] },
    { kind: "sandbox", offered: true, groups: ["exec", "files", "processes"], tools: ["read", "write", "edit", "bash", "bash_background"], providers: [
      { id: "docker", name: "Docker", keys: [], ready: true, metered: false },
      { id: "daytona", name: "Daytona", keys: [{ name: "DAYTONA_API_KEY", required: true, saved: true }], ready: false, why: "fixture: Daytona can't mount this server's run folders" },
    ] },
    { kind: "desktop", offered: true, groups: ["screen", "input.pointer", "input.keys"], tools: ["read", "write", "edit", "bash", "screen.shot", "input.actions"], providers: [
      { id: "orgo", name: "Orgo", keys: [{ name: "ORGO_API_KEY", required: true, saved: true }], ready: true, metered: true },
      { id: "e2b", name: "E2B", keys: [{ name: "E2B_API_KEY", required: true, saved: false }], ready: false, why: "fixture: E2B needs E2B_API_KEY saved" },
    ] },
    { kind: "phone", offered: true, groups: ["screen", "input.touch", "apps"], tools: ["read", "screen.shot", "input.actions"], providers: [
      { id: "phone-harness", name: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true, saved: false }], ready: false, why: "fixture: Phone harness needs PHONE_HARNESS_API_KEY saved" },
    ] },
    { kind: "browser", offered: false, why: "fixture: no provider of a browser computer can run here", groups: ["cdp"], tools: [], providers: [] },
  ];
  const listed = { ...caps, computers: KINDS };
  const card = (host: HTMLElement, kind: string) => host.querySelector(`[data-kind="${kind}"]`) as HTMLElement | null;
  const kindRadio = (host: HTMLElement, kind: string) => host.querySelector(`input[name="computer-kind"][value="${kind}"]`) as HTMLInputElement | null;
  const providerRadio = (host: HTMLElement, id: string) => host.querySelector(`input[name="computer-provider"][value="${id}"]`) as HTMLInputElement | null;

  it("shows each kind the server lists, in its order; a kind not offered is greyed with the server's why and a link to the Computers settings", () => {
    const { host } = mount({ agent: agent(), caps: listed, step: "computer" });
    expect([...host.querySelectorAll('input[name="computer-kind"]')].map((x) => (x as HTMLInputElement).value)).toEqual(["none", "sandbox", "desktop", "phone", "browser"]);
    expect(kindRadio(host, "browser")!.disabled).toBe(true);
    expect(card(host, "browser")!.textContent).toContain("fixture: no provider of a browser computer can run here");
    expect(card(host, "browser")!.querySelector('a[href="#/settings/computers"]')).not.toBeNull();
    expect(kindRadio(host, "desktop")!.disabled).toBe(false);
  });

  it("greys a kind offered with no provider ready, in its provider's words", () => {
    const { host } = mount({ agent: agent(), caps: listed, step: "computer" });
    expect(kindRadio(host, "phone")!.disabled).toBe(true);
    expect(card(host, "phone")!.textContent).toContain("fixture: Phone harness needs PHONE_HARNESS_API_KEY saved");
  });

  it("a kind picked shows its providers, one not ready disabled with its why, and the tools its loop gets as served", () => {
    const { host, click } = mount({ agent: agent(), caps: listed, step: "computer" });
    click(kindRadio(host, "desktop"));
    expect(providerRadio(host, "orgo")!.disabled).toBe(false);
    expect(providerRadio(host, "e2b")!.disabled).toBe(true);
    expect(providerRadio(host, "e2b")!.closest("label")!.textContent).toContain("fixture: E2B needs E2B_API_KEY saved");
    expect(host.querySelector('[aria-label="The loop gets"]')!.textContent).toContain("read, write, edit, bash, screen.shot, input.actions");
  });

  it("a kind picked takes its first ready provider, and the pick is saved as the computer", async () => {
    const { host, click, save, saved } = mount({ agent: agent(), caps: listed, step: "computer" });
    click(kindRadio(host, "desktop"));
    expect(providerRadio(host, "orgo")!.checked).toBe(true);
    await save();
    expect(saved()).toMatchObject({ computer: { kind: "desktop", provider: "orgo" } });
  });

  it("a metered provider says Metered, the word only; one that isn't says nothing of it", () => {
    const { host, click } = mount({ agent: agent(), caps: listed, step: "computer" });
    click(kindRadio(host, "desktop"));
    const orgo = providerRadio(host, "orgo")!.closest("label")!;
    expect(orgo.textContent).toContain("Metered");
    expect(orgo.querySelector("a")).toBeNull();
    click(kindRadio(host, "sandbox"));
    expect(providerRadio(host, "docker")!.closest("label")!.textContent).not.toContain("Metered");
  });

  it("none is saved with no provider, and shows no provider list", async () => {
    const { host, click, save, saved } = mount({ agent: agent({ computer: { kind: "sandbox", provider: "docker" }, place: { mode: "sandbox", box: "docker" } }), caps: listed, step: "computer" });
    expect(kindRadio(host, "sandbox")!.checked).toBe(true);
    expect(providerRadio(host, "docker")!.checked).toBe(true);
    click(kindRadio(host, "none"));
    expect(host.querySelector('input[name="computer-provider"]')).toBeNull();
    await save();
    expect(saved()!.computer).toEqual({ kind: "none" });
  });
});
