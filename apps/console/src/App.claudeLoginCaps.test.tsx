import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LOGIN_ROW } from "@/lib/claudeLogin";
import { servedKey } from "@/test/keys";

// Settings → API Keys asks for Claude Code's login only where capabilities say its routes answer (features.claude_login), so
// a Docker server, where they are 404, gets no request the browser would log. Capabilities that can't be read hide
// nothing: the row asks as it did before the field, and a 404 there still shows no row.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { models: { source: "providers", ready: true }, harnesses: [], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" } } };
// The plan rows sit beside the Anthropic key.
const KEYS = { keys: [servedKey({ id: "anthropic", kind: "model", label: "Anthropic", fields: [{ name: "ANTHROPIC_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi", "claude-agent"], check: null })], reenter: null };
const OFF = { state: "off", place: "agentrun", command: "claude auth login", can_start: false };

async function open(capabilities: () => Response) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://serve.test").pathname;
    asked.push(path);
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return capabilities();
    if (path === "/v2/settings/claude-login") return json(200, OFF);
    if (path === "/v2/settings/tool-keys") return json(200, KEYS);
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/settings/keys";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { host, logins: () => asked.filter((path) => path === "/v2/settings/claude-login").length, row: () => host.querySelector(`[aria-label="${LOGIN_ROW}"]`) };
}

describe("Settings → API Keys asks capabilities before Claude Code's login", () => {
  it("claude_login false: no request and no row", async () => {
    const page = await open(() => json(200, { ...CAPS, features: { ...CAPS.features, claude_login: false } }));
    expect(page.logins()).toBe(0);
    expect(page.row()).toBeNull();
  });

  it("claude_login true: the row reads the login", async () => {
    const page = await open(() => json(200, { ...CAPS, features: { ...CAPS.features, claude_login: true } }));
    expect(page.logins()).toBeGreaterThan(0);
    expect(page.row()).not.toBeNull();
  });

  it("capabilities that can't be read hide nothing: the row asks as before", async () => {
    const page = await open(() => json(500, { error: { code: "internal", message: "fixture: a passing failure", retryable: true } }));
    expect(page.logins()).toBeGreaterThan(0);
    expect(page.row()).not.toBeNull();
  });
});
