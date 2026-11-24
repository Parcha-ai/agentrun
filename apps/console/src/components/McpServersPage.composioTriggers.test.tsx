import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { McpServersPage } from "./McpServersPage";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";

// Settings → MCP servers, a saved Composio server's triggers (GET /v2/settings/mcp-servers/{name}/composio/triggers):
// each trigger that uses it, linked, with its event and whether it is on at Composio; where the project's webhook
// subscription sends its events; and Rotate secret (asked first), which answers no secret. A server of any other source
// reads none of this.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = (extra: Partial<McpServer> = {}): McpServer => ({ name: "gh", url: "https://backend.composio.test/v3/mcp/srv_1/mcp?user_id=agentrun-qa", auth: { type: "headers", headers: ["x-api-key"] }, source: "composio", toolkit: "github", credential: "sealed", tools: [], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", ...extra } as McpServer);
const OURS = "https://agents.example.test/v2/hooks/composio/cph_0123456789abcdef01234567";
const TRIGGERS = { triggers: [{ id: "trg_c", name: "new issues", enabled: true, event: "GITHUB_ISSUE_ADDED_EVENT", instance_id: "ti_1", on_composio: "on" }, { id: "trg_d", name: "old issues", enabled: false, event: "GITHUB_ISSUE_ADDED_EVENT", instance_id: "ti_2", on_composio: "off" }], subscription: { ours: true, webhook_url: OURS } };

type Sent = { method: string; path: string; body?: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(servers: McpServer[], listed: unknown = TRIGGERS) {
  const calls: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Sent = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    if (call.method === "GET" && call.path === "/v2/settings/mcp-servers") return json(200, { servers });
    if (call.method === "GET" && call.path === "/v2/settings/mcp-servers/oauth/private-hosts") return json(200, { hosts: [] });
    if (call.method === "GET" && call.path === "/v2/settings/mcp-servers/gh/composio/triggers") return json(200, listed);
    if (call.method === "POST" && call.path === "/v2/settings/mcp-servers/gh/composio/rotate-secret") return json(200, { rotated: true });
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(McpServersPage, { v2, writable: true })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp, within: Element = host) => [...within.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp, within: Element = host) => {
    const b = button(label, within);
    if (!b) throw new Error(`no button ${label}`);
    await act(async () => { b.click(); });
    await settle();
  };
  return { host, button, click };
}

describe("Settings → MCP servers: a Composio server's triggers", () => {
  it("lists each trigger that uses it, linked, with its event and its state at Composio, and where the subscription sends events", async () => {
    const p = await open(server([saved()]).v2);
    const box = p.host.querySelector('[data-server="gh"] [data-composio-triggers]')!;
    expect(box).not.toBeNull();
    const links = [...box.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["new issues", "#/triggers/trg_c"]);
    expect(links).toContainEqual(["old issues", "#/triggers/trg_d"]);
    expect(box.textContent).toContain("GITHUB_ISSUE_ADDED_EVENT");
    expect(box.querySelector('[data-trigger="trg_c"]')?.textContent).toMatch(/on at Composio/);
    expect(box.querySelector('[data-trigger="trg_d"]')?.textContent).toMatch(/off at Composio/);
    expect(box.textContent).toMatch(/webhook subscription sends its events here/i);
  });

  it("with no trigger yet, says so and links a new one from an app", async () => {
    const p = await open(server([saved()], { triggers: [], subscription: null }).v2);
    const box = p.host.querySelector('[data-server="gh"] [data-composio-triggers]')!;
    expect(box.textContent).toMatch(/No trigger uses it yet/);
    expect(box.querySelector('a[href="#/triggers/new-composio"]')).not.toBeNull();
    expect(p.button(/^Rotate secret$/, box)).toBeUndefined();
  });

  it("a subscription at another address is named, and offers no rotate", async () => {
    const p = await open(server([saved()], { triggers: [], subscription: { ours: false, webhook_url: "https://elsewhere.example/hooks/composio" } }).v2);
    const box = p.host.querySelector('[data-server="gh"] [data-composio-triggers]')!;
    expect(box.textContent).toContain("https://elsewhere.example/hooks/composio");
    expect(p.button(/^Rotate secret$/, box)).toBeUndefined();
  });

  it("Rotate secret asks first, then rotates, and shows no secret", async () => {
    const s = server([saved()]);
    const p = await open(s.v2);
    const box = p.host.querySelector('[data-server="gh"] [data-composio-triggers]')!;
    await p.click(/^Rotate secret$/, box);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
    expect(p.host.querySelector('[role="alertdialog"][aria-label="Rotate the subscription\'s secret?"]')).not.toBeNull();
    await p.click(/^Yes, rotate$/);
    expect(s.calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/settings/mcp-servers/gh/composio/rotate-secret", body: {} }]);
    expect(p.host.querySelector('[data-server="gh"]')!.textContent).toMatch(/Rotated: Composio signs with the new secret from now on/);
  });

  it("a server of any other source reads no Composio triggers", async () => {
    const s = server([saved({ name: "docs", source: "url", toolkit: null, auth: { type: "none" }, credential: null } as Partial<McpServer>)]);
    const p = await open(s.v2);
    expect(p.host.querySelector("[data-composio-triggers]")).toBeNull();
    expect(s.calls.some((c) => c.path.includes("/composio/triggers"))).toBe(false);
  });
});

describe("Settings → MCP servers: a Composio server's account", () => {
  const checked = "2026-11-24T10:00:00Z";
  const account = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-server="gh"] [data-composio-account]');
  it("a connected account shows as a success chip with each account's label, never an id", async () => {
    const p = await open(server([saved({ composio_account: { state: "connected", labels: ["person@example.com", "work@example.com"], checked_at: checked } })]).v2);
    expect(account(p.host)?.dataset.composioAccount).toBe("connected");
    const said = account(p.host)!;
    expect(said.querySelector(".text-success-text")?.textContent, "a success chip").toBe("connected");
    expect(said.textContent).toContain("person@example.com, work@example.com");
  });
  it.each([
    ["pending", "text-warning-text"],
    ["expired", "text-warning-text"],
    ["none", "text-warning-text"],
    ["unknown", "text-muted-foreground"],
  ] as const)("a %s account shows as a chip of %s", async (state, tone) => {
    const p = await open(server([saved({ composio_account: { state, checked_at: checked } })]).v2);
    expect(account(p.host)?.dataset.composioAccount).toBe(state);
    expect(account(p.host)?.firstElementChild?.classList.contains(tone), "the chip's tone").toBe(true);
  });
  it("a server whose read says nothing of an account (a no-auth toolkit, a per-run one, or never refreshed) shows none", async () => {
    const p = await open(server([saved()]).v2);
    expect(account(p.host)).toBeNull();
  });
});
