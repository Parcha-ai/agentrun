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

  // Pending: the kind cards (each kind the server lists, a kind it doesn't offer greyed with its why and a link to the
  // Computers settings page), each kind's providers (ready, or why not) and "The loop gets …" all read capabilities.computers.kinds. That
  // read is not in the server's OpenAPI yet (it comes with GET /v2/computers in tl-places' server switch), so there is no
  // generated type to build it on.
  it.todo("shows each kind the server lists in capabilities.computers.kinds, a kind not offered greyed with the server's why");
  it.todo("shows a kind's providers, a provider not ready disabled with its why, and \"The loop gets\" the kind's served tools");
  it.todo("saves the kind and provider picked as the computer, and a kind with one provider picks it");
});
