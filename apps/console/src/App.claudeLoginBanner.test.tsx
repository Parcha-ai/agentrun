import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";

// The Playground's "No model" bar while capabilities say no model is ready: a Claude Code login that is on and reads
// signed in is a model for an agent on Claude Agent (claude-agent), which runs on it, so the bar is gone then, ChatGPT's
// offer included. An agent on another harness still has no model, and keeps the bar. Signed out, or with the mode off,
// the bar says what it said. Each read of the login runs `claude auth status` on the server, so the console reads it
// once, again on leaving Settings (where a sign-in finishes) and after a run starts, never on every move between pages.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { models: { source: "providers", default: null, ready: false, needs: "key" }, harnesses: [], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" }, claude_login: true } };
const LOGIN = { place: "agentrun", command: "claude auth login", can_start: false, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" } };
const SIGNED_IN = { ...LOGIN, state: "signed_in", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
const agentOn = (harness: string): Agent => ({ ...SERVED_AGENT, agent_id: `on-${harness}`, kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: `On ${harness}`, instructions: "Answer.", harness, skills: [], tools: [] } });
const CLAUDE_AGENT = agentOn("claude-agent");

const settle = async () => { for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

async function open(login: unknown, caps: unknown = CAPS, agents: Agent[] = [CLAUDE_AGENT]) {
  let reads = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method === "POST" && path.startsWith("/v2/agents/") && path.endsWith("/runs")) return json(422, { error: { code: "scripted_refusal", message: "Scripted refusal", retryable: false } });
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return json(200, caps);
    if (path === "/v2/settings/claude-login") { reads++; return json(200, login); }
    if (path === "/v2/settings/chatgpt") return json(200, { state: "signed_out" });
    if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents, next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/playground";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  await settle();
  return { host, bar: () => host.querySelector('[aria-label="No model"]'), reads: () => reads };
}

const go = async (hash: string) => {
  location.hash = hash;
  await settle();
};

describe("the Playground's No model bar and Claude Code's login on this machine", () => {
  it("a login that is on and signed in is a model for an agent on Claude Agent: no bar, and no offer of ChatGPT in its place", async () => {
    const page = await open(SIGNED_IN);
    expect(page.bar()?.textContent ?? null).toBeNull();
    expect(page.host.textContent).not.toContain("No model yet");
  });

  it("an agent on another harness has no model from the login, signed in or not: the bar stays", async () => {
    const page = await open(SIGNED_IN, CAPS, [agentOn("pi")]);
    expect(page.bar()?.textContent, "the bar over an agent on pi while the login reads signed in").toContain("No model yet.");
  });

  it("a login that is on and signed out, or the mode off, leaves the bar as it was", async () => {
    for (const login of [{ ...LOGIN, state: "signed_out" }, { ...LOGIN, state: "off" }]) {
      const page = await open(login);
      expect(page.bar()?.textContent, login.state).toContain("No model yet.");
      act(() => root?.unmount());
      root = undefined;
      document.body.innerHTML = "";
    }
    // A server with the mode switched off is never asked, and says what it said.
    const off = await open(SIGNED_IN, { ...CAPS, features: { ...CAPS.features, claude_login: false } });
    expect(off.bar()?.textContent).toContain("No model yet.");
  });

  it("the login is read once, not again on each move between pages, and again on leaving Settings, where a sign-in finishes", async () => {
    const page = await open(SIGNED_IN);
    const first = page.reads();
    expect(first).toBeGreaterThan(0);
    for (const hash of ["#/runs", "#/agents", "#/playground"]) await go(hash);
    expect(page.reads(), "a move between pages read the login again, which runs the CLI on the server").toBe(first);
    await go("#/settings/keys");
    const inSettings = page.reads();
    await go("#/playground");
    expect(page.reads(), "back from Settings, the login is read again").toBeGreaterThan(inSettings);
    expect(page.bar()?.textContent ?? null).toBeNull();
  });

  it("the login is read again after a run starts in the Playground, refused or not, since a run checks it", async () => {
    const page = await open(SIGNED_IN);
    const before = page.reads();
    const message = page.host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea');
    expect(message, "the Playground's request box").not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(message!), "value")!.set!.call(message!, "Answer this.");
      message!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send request");
    expect(send, "the Send request button").toBeDefined();
    await act(async () => send!.click());
    await settle();
    expect(page.host.textContent).toContain("Scripted refusal");
    expect(page.reads(), "a run started, and the login was not read again").toBeGreaterThan(before);
  });
});
