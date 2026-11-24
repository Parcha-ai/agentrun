import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartHere, type StartHereProps } from "./StartHere";
import { ModelKeyCard } from "./ModelKeyCard";
import { createClient } from "@/lib/client";
import type { ChatGPTView } from "@/lib/v2";
import { toolOffers } from "@/lib/agentForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const harnesses = [{ id: "pi", available: true, default_model: "faux/faux-1" }];
const tools = toolOffers([{ name: "write", available: true, harnesses: ["pi"] }, { name: "web_fetch", available: true, harnesses: ["pi"] }]);
const base: StartHereProps = { harnesses, tools, onTry: async () => null };
const html = (p: Partial<StartHereProps> = {}) => renderToStaticMarkup(createElement(StartHere, { ...base, ...p }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); });
const mount = (p: Partial<StartHereProps> = {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(StartHere, { ...base, ...p })));
  return host;
};
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const expand = (host: HTMLElement) => act(() => button(host, "See templates").click());

describe("StartHere", () => {
  it("starts with native connection, without model setup or expanded execution controls", () => {
    const h = html({ harnesses: [{ id: "pi", available: true, default_model: null }] });
    expect(h).toContain("No model key needed");
    expect(h).toContain("Connect your agents");
    expect(h).toContain("live connection or a history import");
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
    // Each card says what it does once: its name, its one line, its button.
    expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Hello, AgentRunA first agent: writes hello.md and answers in one line.Try it",
      "Summarize a web pageReads a public web page and sums it up in three bullets.Try it",
      "Plan a taskTurns a goal into steps, risks and a first move.Try it",
    ]);
    const tries = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Try it");
    expect(tries).toHaveLength(3);
    // No card is singled out: every Try it is the same button.
    expect(new Set(tries.map((t) => t.className)).size).toBe(1);
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


it("mounts managed setup only on request and preserves its pending state across collapse", () => {
  let mounts = 0;
  let unmounts = 0;
  function Setup() {
    const [pending, setPending] = useState(false);
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return createElement("button", { onClick: () => setPending(!pending) }, pending ? "Cancel pending setup" : "Begin managed setup");
  }
  const host = mount({ harnesses: [], modelSetup: createElement(Setup) });
  expect(mounts).toBe(0);
  expect(host.textContent).not.toContain("Begin managed setup");
  expand(host);
  act(() => button(host, "Begin managed setup").click());
  expand(host);
  const pending = button(host, "Cancel pending setup");
  expect(pending.closest("[hidden]")).not.toBeNull();
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
  expand(host);
  expect(button(host, "Cancel pending setup").closest("[hidden]")).toBeNull();
  act(() => button(host, "Cancel pending setup").click());
  expect(button(host, "Begin managed setup")).toBeTruthy();
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
});


it("keeps the actual ChatGPT card and pasted callback through collapse, completion and Done", async () => {
  const calls: string[] = [];
  const authorize = "https://auth.openai.com/api/accounts/authorize?state=fake-state";
  const pasted = "http://127.0.0.1:1455/auth/callback?code=fake-code&state=fake-state";
  let state: ChatGPTView = { state: "signed_out" };
  let refreshed = 0;
  let done = 0;
  vi.stubGlobal("open", vi.fn(() => ({ location: { href: "" }, opener: null, close() {} })));
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    let body: unknown = state;
    if (path === "/v2/settings/tool-keys") body = { keys: [], reenter: null };
    if (path === "/v2/settings/chatgpt/sign-in") {
      state = { state: "pending", authorize_url: authorize };
      body = { authorize_url: authorize, expires_at: "2099-01-01T00:00:00Z" };
    }
    if (path === "/v2/settings/chatgpt/sign-in/finish") {
      expect(JSON.parse(String(init?.body))).toEqual({ redirect_url: pasted });
      body = state = { state: "signed_in", email: "person@example.com", plan: "plus", models: ["gpt-6.1-sol"] };
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  function Page() {
    const [plan, setPlan] = useState<ChatGPTView>({ state: "signed_out" });
    const [ready, setReady] = useState(false);
    const [planShown, setPlanShown] = useState(false);
    return createElement(StartHere, { ...base, harnesses: ready ? harnesses : [], modelSetup: !ready || planShown
      ? createElement(ModelKeyCard, { v2, writable: true, needs: ready ? null : "key", plan,
        onPlan: (next: ChatGPTView) => { setPlan(next); setPlanShown(true); if (next.state === "signed_in") { refreshed++; setReady(true); } },
        onDone: () => { done++; setPlanShown(false); } }) : undefined });
  }
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(Page)));
  expect(calls).toEqual([]);
  expand(host);
  await act(async () => button(host, "Continue with ChatGPT").click());
  const input = host.querySelector<HTMLInputElement>('input[name="redirect_url"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, pasted); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expand(host);
  expect(input.closest("[hidden]")).not.toBeNull();
  expand(host);
  expect(host.querySelector('input[name="redirect_url"]')).toBe(input);
  expect(input.value).toBe(pasted);
  await act(async () => button(host, "Finish sign-in").click());
  expect(refreshed).toBe(1);
  expect(host.textContent).toContain("Signed in as person@example.com (Plus)");
  expect(host.textContent).toContain("Eligible usage in this app uses your ChatGPT plan");
  expect(host.querySelector('[aria-label="Model key"]')).not.toBeNull();
  await act(async () => button(host, "Done").click());
  expect(done).toBe(1);
  expect(host.querySelector('[aria-label="Model key"]')).toBeNull();
  expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /v2/settings/chatgpt/sign-in", "POST /v2/settings/chatgpt/sign-in/finish"]);
});
