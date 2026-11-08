import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { toolOffers } from "@/lib/agentForm";
import { placesOf } from "@/lib/place";

// A new agent's place, as the server serves it (capabilities.places.default_place): the form starts on it, and in a
// sandbox it ticks bash with the other tools, so a new agent in the box has a shell. On the server (the runner), or on an
// older server that serves no default_place, the form is today's: no place sent, bash not ticked. What the person picks
// or unticks is what is sent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const DOCKER = { mode: "sandbox", box: "docker" };
const boxes = [{ id: "bwrap", available: false, reason: "fixture: no bwrap" }, { id: "docker", available: true }];
const served = (extra: Record<string, unknown>) => placesOf({ places: { modes: ["runner", "sandbox"], boxes, ...extra } });
const tools = toolOffers([{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] }, { name: "browser", available: true, harnesses: ["pi"] }]);
const capsWith = (places: ReturnType<typeof placesOf>) => ({ harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools, places });

function mount(places: ReturnType<typeof placesOf>) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { caps: capsWith(places), step: "settings", onSave: async (f: Record<string, unknown>) => { saved = f; return null; } } as never)));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const input = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
  const step = (label: RegExp) => click([...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")));
  const fill = () => {
    step(/Context|Instructions/);
    const set = (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => act(() => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    set(host.querySelector("#agent-name"), "Shelly");
    set(host.querySelector("#agent-instructions"), "Probe.");
  };
  const save = async () => { await act(async () => { [...document.querySelectorAll("button")].find((b) => /^Create/.test(b.textContent ?? ""))!.click(); }); return saved; };
  return { host, click, input, step, fill, save };
}

describe("AgentEditor, a new agent's default place", () => {
  it("starts on the place the server serves as a new agent's default: the sandbox, its box picked", () => {
    const { input } = mount(served({ default_place: DOCKER }));
    expect(input('input[name="place"][value="sandbox"]')!.checked).toBe(true);
    expect(input('input[name="box"][value="docker"]')!.checked).toBe(true);
  });

  it("ticks bash with the other tools for a sandbox default, and not when the default is the server", () => {
    const boxed = mount(served({ default_place: DOCKER }));
    boxed.step(/Tools/);
    expect(boxed.input('input[type="checkbox"][value="bash"]')!.checked).toBe(true);
    expect(boxed.input('input[type="checkbox"][value="read"]')!.checked).toBe(true);
    // The browser runs only on the runner (the server refuses it in a box): a sandbox default never ticks it.
    expect(boxed.input('input[type="checkbox"][value="browser"]')!.checked).toBe(false);
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const runner = mount(served({ default_place: { mode: "runner" }, default_reason: "fixture: no docker" }));
    expect(runner.input('input[name="place"][value="runner"]')!.checked).toBe(true);
    runner.step(/Tools/);
    expect(runner.input('input[type="checkbox"][value="bash"]')!.checked).toBe(false);
    expect(runner.input('input[type="checkbox"][value="browser"]')!.checked).toBe(true);
  });

  it("an older server that serves no default_place keeps today's form: on the server, bash not ticked, no place sent", async () => {
    const { input, step, fill, save } = mount(served({}));
    expect(input('input[name="place"][value="runner"]')!.checked).toBe(true);
    step(/Tools/);
    expect(input('input[type="checkbox"][value="bash"]')!.checked).toBe(false);
    fill();
    const sent = await save();
    expect(sent).toMatchObject({ tools: ["read", "write", "browser"] });
    expect(sent!.place).toBeUndefined();
  });

  it("never overrides the person: the default is sent as served, bash unticked stays off, and a pick of the server is sent", async () => {
    const kept = mount(served({ default_place: DOCKER }));
    kept.fill();
    expect(await kept.save()).toMatchObject({ place: DOCKER, tools: ["read", "write", "bash"] });
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const unticked = mount(served({ default_place: DOCKER }));
    unticked.step(/Tools/);
    unticked.click(unticked.input('input[type="checkbox"][value="bash"]'));
    unticked.fill();
    expect(await unticked.save()).toMatchObject({ place: DOCKER, tools: ["read", "write"] });
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const runner = mount(served({ default_place: DOCKER }));
    runner.click(runner.input('input[name="place"][value="runner"]'));
    runner.fill();
    expect(await runner.save()).toMatchObject({ place: { mode: "runner" }, tools: ["read", "write"] });
  });
});
