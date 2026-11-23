import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// The Playground's "No model" bar while capabilities say no model is ready: a Claude Code login that is on and reads
// signed in is a model (Claude Agent runs on it), so the bar is gone then, ChatGPT's offer included. Signed out, or
// with the mode off, the bar says what it said.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { models: { source: "providers", default: null, ready: false, needs: "key" }, harnesses: [], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" }, claude_login: true } };
const LOGIN = { place: "agentrun", command: "claude auth login", can_start: false, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" } };
const SIGNED_IN = { ...LOGIN, state: "signed_in", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };

async function open(login: unknown, caps: unknown = CAPS) {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return json(200, caps);
    if (path === "/v2/settings/claude-login") return json(200, login);
    if (path === "/v2/settings/chatgpt") return json(200, { state: "signed_out" });
    if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/playground";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { host, bar: () => host.querySelector('[aria-label="No model"]') };
}

describe("the Playground's No model bar and Claude Code's login on this machine", () => {
  it("a login that is on and signed in is a model: no bar, and no offer of ChatGPT in its place", async () => {
    const page = await open(SIGNED_IN);
    expect(page.bar()?.textContent ?? null).toBeNull();
    expect(page.host.textContent).not.toContain("No model yet");
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
});
