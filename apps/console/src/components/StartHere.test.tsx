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
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

// Mission Control before the owner's first run: one click makes a template agent, runs it, and opens its run.
describe("StartHere", () => {
  it("offers the three templates, each with what it shows and Try it", () => {
    const h = html();
    for (const name of ["Hello, AgentRun", "Summarize a web page", "Plan a task"]) expect(h).toContain(name);
    expect(h.match(/>Try it</g)).toHaveLength(3);
    expect(h).toContain('href="#/agents/new"');
    expect(h).toContain("Create your own");
  });
  it("tries the template clicked, and says it's starting until the run opens", async () => {
    const tried: string[] = [];
    let open!: () => void;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(StartHere, { ...base, onTry: (t) => { tried.push(t.id); return new Promise((r) => { open = () => r(null); }); } })));
    await act(async () => { host.querySelectorAll<HTMLButtonElement>("button")[1]!.click(); });
    expect(tried).toEqual(["web"]);
    expect(host.textContent).toContain("Starting…");
    expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    await act(async () => { open(); });
  });
  it("says why a try failed, and lets it be tried again", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(StartHere, { ...base, onTry: async () => "agent_not_runnable: pi is not set up here" })));
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.textContent).toContain("agent_not_runnable: pi is not set up here");
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  });
  it("offers a template only when its tools run here, and says why one doesn't", () => {
    const h = html({ tools: toolOffers([{ name: "write", available: true, harnesses: ["pi"] }, { name: "web_fetch", available: false, missing: ["NETWORK"], harnesses: ["pi"] }]) });
    expect(h.match(/>Try it</g)).toHaveLength(2);
    expect(h).toContain("web_fetch can&#x27;t run on this server yet");
  });
  it("puts the model step first when no harness has a model to run, and no template", () => {
    const h = html({ harnesses: [{ id: "pi", available: true, default_model: null }] });
    expect(h).toContain("Add a model key");
    // The server's own setup: a provider's key or a gateway where it runs (Settings holds tool keys, not models).
    expect(h).toContain("ANTHROPIC_API_KEY");
    expect(h).toContain("AGENT_MODEL_BASE_URL");
    // A key alone names no model: the default model is AGENT_MODEL, for a provider's key and for a gateway alike.
    expect(h.match(/AGENT_MODEL</g)).toHaveLength(2);
    expect(h).not.toContain('href="#/settings/keys"');
    expect(h).not.toContain(">Try it<");
  });
  it("names the imported history when there is some, with a way to browse it", () => {
    expect(html({ imported: 6 })).toContain("6 imported sessions");
    expect(html({ imported: 6 })).toContain('href="#/runs"');
    expect(html()).not.toContain("imported");
  });
});
