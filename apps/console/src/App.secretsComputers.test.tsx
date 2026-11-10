import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { NO_ACCOUNTS, SIGN_IN_TO_CHANGE } from "@/lib/secrets";

// Settings → Computers and Settings → Workspace paste a secret only where the session read says secrets_writable: true,
// the same as Keys and MCP servers (one hook, useSecrets). The base's default (a session may unless told it may not) is
// gone: a read without the flag offers no Paste, and the page says why in the session's reason.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const COMPUTERS = { kinds: [{ kind: "sandbox", offered: true, groups: [], tools: [], providers: [
  { id: "e2b", name: "E2B", metered: true, secrets: [{ name: "computer:e2b:E2B_API_KEY", set: false, source: null, changed_at: null }], required: ["computer:e2b:E2B_API_KEY"], ready: false, why: "E2B needs E2B_API_KEY saved" },
] }] };
const ARCHIL = { on: false, secret: { name: "workspace:archil", set: false, source: null, changed_at: null } };

async function open(hash: string, session: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path === "/v2/auth/session") return json(200, session);
    if (path === "/v2/capabilities") return json(200, { harnesses: [], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (path === "/v2/computers") return json(200, COMPUTERS);
    if (path === "/v2/workspace/archil") return json(200, ARCHIL);
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const end = Date.now() + 4000;
  while (!host.querySelector("[data-secret]") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { host, pastes: () => [...host.querySelectorAll("button")].filter((b) => /^(Paste|Replace|Remove)$/.test(b.textContent?.trim() ?? "")).length };
}

const SIGNED_IN = { accounts: true, password_set: true, signed_in: true };

describe("Computers and Workspace read the session's secrets_writable, required", () => {
  for (const [page, hash] of [["Computers", "#/settings/computers"], ["Workspace", "#/settings/workspace"]] as const) {
    it(`${page}: a session read without the flag offers no Paste, and says to sign in`, async () => {
      const p = await open(hash, SIGNED_IN);
      expect(p.host.querySelector("[data-secret]")).not.toBeNull();
      expect(p.pastes()).toBe(0);
      expect(p.host.textContent).toContain(SIGN_IN_TO_CHANGE);
    });

    it(`${page}: the session that may write secrets gets Paste`, async () => {
      const p = await open(hash, { ...SIGNED_IN, secrets_writable: true });
      expect(p.pastes()).toBeGreaterThan(0);
    });

    it(`${page}: a no from a server without accounts says so in its own words`, async () => {
      const p = await open(hash, { accounts: false, secrets_writable: false, secrets_reason: "no_accounts" });
      expect(p.pastes()).toBe(0);
      expect(p.host.textContent).toContain(NO_ACCOUNTS);
    });
  }
});
