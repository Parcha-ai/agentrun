import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { McpServersPage } from "./McpServersPage";
import { ModelKeyCard } from "./ModelKeyCard";
import { createClient, type FieldIssue } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import { NO_ACCOUNTS, secretsWhyNot, secretsWritableOf, SIGN_IN_TO_CHANGE } from "@/lib/secrets";
import type { ToolKeys } from "@/lib/v2";
import { type KeyIn, servedKey } from "@/test/keys";
import { mcpServer } from "@/test/mcp";

// Secrets are write-only, and only the owner's password session writes them (GET /v2/auth/session's secrets_writable).
// Off it, every page holding a secret shows each one's state and says once how to change them, with no Paste, Replace,
// Remove, or credential input. A secret set in the environment is greyed wherever it shows.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (answer: (path: string) => unknown) => createClient({ fetch: (async (url: string) => json(200, answer(String(url)))) as typeof globalThis.fetch });
const mount = async (el: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  await settle();
  return host;
};
const labels = (host: Element) => [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());

const KEYS: ToolKeys = {
  keys: ([
    { id: "parallel", kind: "tool", label: "Parallel", fields: [{ name: "PARALLEL_API_KEY", set: true, source: "console", changed_at: "2026-11-09T09:00:00Z" }], unlocks: ["web_fetch"], harnesses: ["pi"], check: null },
    { id: "monid", kind: "tool", label: "Monid", fields: [{ name: "MONID_API_KEY", set: true, source: "env", changed_at: null }], unlocks: ["monid.run"], harnesses: ["pi"], check: null },
    { id: "anthropic", kind: "model", label: "Anthropic", fields: [{ name: "ANTHROPIC_API_KEY", set: false, source: null, changed_at: null }], unlocks: [], harnesses: ["pi"], check: null },
  ] as KeyIn[]).map(servedKey),
  reenter: null,
};
// Each server holds ONE secret, `secret` ("mcp:<server>"): its bearer token, its headers' values, or a sign-in.
const MCP: McpServer = mcpServer({
  name: "linear", url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: ["X-Api-Key"] }, credential: "sealed", tools: [], protocol: "2025-06-18",
  listed_at: "2026-11-09T09:00:00Z", updated_at: "2026-11-09T09:00:00Z",
  secret: { name: "mcp:linear", set: true, source: "console", changed_at: "2026-11-09T09:00:00Z" },
});
const BEARER: McpServer = mcpServer({ ...MCP, name: "fake", auth: { type: "bearer" }, secret: { name: "mcp:fake", set: true, source: "console", changed_at: "2026-11-09T09:00:00Z" } });
// A sign-in's server: its secret is from the sign-in, which is its only write (no paste).
const OAUTH: McpServer = mcpServer({ ...MCP, name: "gh", auth: { type: "oauth" }, credential: "expired", oauth: { scopes: [], client: "dynamic" }, secret: { name: "mcp:gh", set: true, source: "sign-in", changed_at: "2026-11-09T09:00:00Z" } }) as McpServer;

describe("the session that may write secrets", () => {
  it("is the one whose read says secrets_writable: true, accounts on or off, and no other", () => {
    expect(secretsWritableOf({ status: 200, body: { password_set: true, signed_in: true, secrets_writable: true } })).toBe(true);
    expect(secretsWritableOf({ status: 200, body: { accounts: false, secrets_writable: true } })).toBe(true);
    expect(secretsWritableOf({ status: 200, body: { password_set: true, signed_in: true, secrets_writable: false } })).toBe(false);
    expect(secretsWritableOf({ status: 200, body: { password_set: true, signed_in: true } })).toBe(false);
    // A token-only browser (a server with no session read for it) never writes.
    expect(secretsWritableOf({ status: 404, body: null })).toBe(false);
  });

  it("a no says why, by the server's reason, else by whether the server has accounts", () => {
    expect(secretsWhyNot({ status: 200, body: { secrets_writable: false, secrets_reason: "sign_in" } })).toBe("sign_in");
    expect(secretsWhyNot({ status: 200, body: { accounts: false, secrets_writable: false, secrets_reason: "no_accounts" } })).toBe("no_accounts");
    expect(secretsWhyNot({ status: 200, body: { accounts: false, secrets_writable: false } })).toBe("no_accounts");
    expect(secretsWhyNot({ status: 200, body: { password_set: true, signed_in: true } })).toBe("sign_in");
    // A browser in on the API token alone (no launcher session): it never writes.
    expect(secretsWhyNot({ status: 200, body: { accounts: false, secrets_writable: false, secrets_reason: "token" } })).toBe("token");
  });
});

describe("Keys in a browser on the API token alone", () => {
  it("says to open the console from the server's link", async () => {
    const host = await mount(createElement(KeysPage, { v2: client(() => KEYS), atRest: "sealed", writable: false, whyNot: "token" }));
    expect(host.textContent).toContain("Open the console from the server's link to change secrets.");
    expect(labels(host).filter((l) => /^(Paste|Replace|Remove)$/.test(l ?? ""))).toEqual([]);
  });
});

describe("Keys on a server with no accounts, not on loopback", () => {
  it("says to set secrets in the environment or turn accounts on, never to sign in", async () => {
    const host = await mount(createElement(KeysPage, { v2: client(() => KEYS), atRest: "sealed", writable: false, whyNot: "no_accounts" }));
    expect(host.textContent).toContain(NO_ACCOUNTS);
    expect(host.textContent).not.toContain(SIGN_IN_TO_CHANGE);
  });
});

describe("Keys, off the password session", () => {
  it("shows each key's state, says once how to change them, and offers no Paste, Replace or Remove", async () => {
    const host = await mount(createElement(KeysPage, { v2: client(() => KEYS), atRest: "sealed", writable: false }));
    expect(host.textContent).toContain(SIGN_IN_TO_CHANGE);
    expect(host.textContent!.split(SIGN_IN_TO_CHANGE)).toHaveLength(2);
    expect(labels(host).filter((l) => /^(Paste|Replace|Remove)$/.test(l ?? ""))).toEqual([]);
    expect(host.querySelector('[data-secret="tool:PARALLEL_API_KEY"]')!.textContent).toContain("Pasted here");
    expect(host.querySelector('[data-secret="tool:MONID_API_KEY"]')!.getAttribute("data-source")).toBe("env");
  });

  it("says each key by its own name, never its secret's plane", async () => {
    const host = await mount(createElement(KeysPage, { v2: client(() => KEYS), atRest: "sealed", writable: true }));
    expect(host.querySelector('[data-secret="tool:PARALLEL_API_KEY"]')!.textContent).toContain("PARALLEL_API_KEY");
    expect(host.textContent).not.toMatch(/\b(tool|model):/);
  });

  it("on it: Replace and Remove on a key pasted here, Paste on a missing one, nothing on one set in the environment", async () => {
    const host = await mount(createElement(KeysPage, { v2: client(() => KEYS), atRest: "sealed", writable: true }));
    expect(host.textContent).not.toContain(SIGN_IN_TO_CHANGE);
    expect(labels(host.querySelector('[data-secret="tool:PARALLEL_API_KEY"]')!)).toEqual(["Replace", "Remove"]);
    expect(labels(host.querySelector('[data-secret="model:ANTHROPIC_API_KEY"]')!)).toEqual(["Paste"]);
    expect(labels(host.querySelector('[data-secret="tool:MONID_API_KEY"]')!)).toEqual([]);
  });
});

describe("the model key card, off the password session", () => {
  it("says how to change secrets in place of the keys to paste", async () => {
    const host = await mount(createElement(ModelKeyCard, { v2: client(() => KEYS), needs: "key", atRest: "sealed", writable: false }));
    expect(host.textContent).toContain(SIGN_IN_TO_CHANGE);
    expect(labels(host)).not.toContain("Anthropic");
  });
});

describe("MCP servers and their credentials", () => {
  const v2 = () => client((path) => (path === "/v2/settings/mcp-servers" ? { servers: [MCP, BEARER, OAUTH] } : {}));
  const radio = (host: Element, value: string) => host.querySelector<HTMLInputElement>(`input[name="mcp-auth"][value="${value}"]`)!;

  it("one row per server's secret, said as what it is, with no second line of its own", async () => {
    const host = await mount(createElement(McpServersPage, { v2: v2(), writable: true }));
    for (const name of ["linear", "fake", "gh"]) expect(host.querySelectorAll(`[data-server="${name}"] [data-secret]`)).toHaveLength(1);
    expect(host.querySelector('[data-secret="mcp:fake"]')!.textContent).toContain("Bearer token");
    expect(host.querySelector('[data-secret="mcp:linear"]')!.textContent).toContain("Headers");
    expect(host.querySelector('[data-server="linear"]')!.textContent!.match(/Pasted/g)).toHaveLength(1);
    expect(host.textContent).not.toContain("last changed");
    expect(host.textContent).not.toContain("mcp:");
  });

  it("bearer and headers: Replace opens the server's form on the password session; off it, no way to type one", async () => {
    const on = await mount(createElement(McpServersPage, { v2: v2(), writable: true }));
    const row = on.querySelector('[data-secret="mcp:linear"]')!;
    expect(labels(row)).toEqual(["Replace"]);
    await act(async () => { [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Replace")!.click(); });
    expect(on.querySelector('input[name="mcp-header-value-0"]')).not.toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";

    const off = await mount(createElement(McpServersPage, { v2: v2(), writable: false }));
    expect(labels(off.querySelector('[data-secret="mcp:linear"]')!)).toEqual([]);
    expect(off.textContent).toContain(SIGN_IN_TO_CHANGE);
    await act(async () => { [...off.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add server")!.click(); });
    expect(["none", "bearer", "headers", "oauth"].map((v) => radio(off, v).disabled)).toEqual([false, true, true, true]);
    expect(off.querySelector('input[name="mcp-client-secret"]')).toBeNull();
  });

  it("OAuth: no Paste or Replace; its one Sign in is the write, on the password session only", async () => {
    const on = await mount(createElement(McpServersPage, { v2: v2(), writable: true }));
    const gh = on.querySelector('[data-server="gh"]')!;
    expect(labels(gh.querySelector('[data-secret="mcp:gh"]')!)).toEqual([]);
    expect(gh.querySelector('[data-secret="mcp:gh"]')!.textContent).toContain("From sign-in");
    expect(labels(gh).filter((l) => /^Sign in/.test(l ?? ""))).toEqual(["Sign in again"]);
    act(() => root?.unmount()); document.body.innerHTML = "";

    const off = await mount(createElement(McpServersPage, { v2: v2(), writable: false, whyNot: "token" }));
    expect(labels(off.querySelector('[data-server="gh"]')!).filter((l) => /^Sign in/.test(l ?? ""))).toEqual([]);
    expect(off.textContent).toContain("Open the console from the server's link to change secrets.");
  });
});

describe("a refused field's reason", () => {
  it("is one the server's document names (InputIssue.reason), never any string", () => {
    const named: FieldIssue = { field: "auth.url", reason: "not_https", message: "An MCP server's address is https." };
    // @ts-expect-error a reason the server's document doesn't name
    const made_up: FieldIssue = { field: "auth.url", reason: "made_up", message: "no such reason" };
    expect([named.reason, made_up.reason]).toEqual(["not_https", "made_up"]);
  });
});
