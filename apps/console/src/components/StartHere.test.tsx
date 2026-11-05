import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { StartHere, type StartHereProps } from "./StartHere";
import { toolOffers } from "@/lib/agentForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const harnesses = [{ id: "pi", available: true, default_model: "faux/faux-1" }];
const tools = toolOffers([{ name: "write", available: true, harnesses: ["pi"] }, { name: "web_fetch", available: true, harnesses: ["pi"] }]);
const base: StartHereProps = { harnesses, tools, onTry: async () => null };
const html = (p: Partial<StartHereProps> = {}) => renderToStaticMarkup(createElement(StartHere, { ...base, ...p }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); });
const mount = (p: Partial<StartHereProps> = {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(StartHere, { ...base, ...p })));
  return host;
};
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const expand = (host: HTMLElement) => act(() => button(host, "Run an agent here").click());

describe("StartHere", () => {
  it("starts with history import, without model setup or expanded execution controls", () => {
    const h = html({ harnesses: [{ id: "pi", available: true, default_model: null }] });
    expect(h).toContain("No model key needed");
    expect(h).toContain("Import agents");
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain("Try it");
    expect(h).not.toContain("Set up models");
  });
  it("offers runnable templates after choosing to run here, and starts only the one selected", async () => {
    const tried: string[] = [];
    let finish!: () => void;
    const host = mount({ onTry: (t) => { tried.push(t.id); return new Promise((r) => { finish = () => r(null); }); } });
    expand(host);
    for (const name of ["Hello, AgentRun", "Summarize a web page", "Plan a task"]) expect(host.textContent).toContain(name);
    const tries = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Try it");
    expect(tries).toHaveLength(3);
    await act(async () => tries[1]!.click());
    expect(tried).toEqual(["web"]);
    expect(host.textContent).toContain("Starting…");
    expect(tries.every((b) => b.disabled)).toBe(true);
    await act(async () => finish());
    expect(tries.every((b) => !b.disabled)).toBe(true);
  });
  it("says why a try failed and lets it be tried again", async () => {
    const host = mount({ onTry: async () => "agent_not_runnable: pi is not set up here" });
    expand(host);
    await act(async () => button(host, "Try it").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("agent_not_runnable");
    expect(button(host, "Try it").disabled).toBe(false);
  });
  it("offers a template only when its tools run here", () => {
    const host = mount({ tools: toolOffers([{ name: "write", available: true, harnesses: ["pi"] }, { name: "web_fetch", available: false, missing: ["NETWORK"], harnesses: ["pi"] }]) });
    expand(host);
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Try it")).toHaveLength(2);
    expect(host.textContent).toContain("web_fetch can't run on this server yet");
  });
  it("takes execution setup to Settings only when the server can keep keys", () => {
    const host = mount({ harnesses: [], keySettings: true });
    expect(host.querySelector('a[href="#/settings/keys"]')).toBeNull();
    expand(host);
    expect(host.querySelector('a[href="#/settings/keys"]')?.textContent).toBe("Set up models in Settings");
    expect(host.textContent).not.toContain("Try it");
  });
  it("explains server setup when Settings cannot save a model key", () => {
    const host = mount({ harnesses: [], keySettings: false });
    expand(host);
    expect(host.textContent).toContain("Configure a model where this server runs");
    expect(host.querySelector('a[href="#/settings/keys"]')).toBeNull();
  });
  it("names imported history and supports an import action without asking for a key", () => {
    const h = html({ imported: 6, importAction: createElement("button", null, "Import agents") });
    expect(h).toContain("6 imported sessions");
    expect(h).toContain('href="#/runs"');
    expect(h).toContain(">Import agents<");
  });
  it("remembers dismissing the introduction across visits", () => {
    const host = mount();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss introduction"]')!.click());
    expect(host.textContent).toBe("");
    act(() => root!.unmount()); root = undefined;
    expect(mount().textContent).toBe("");
  });
});
