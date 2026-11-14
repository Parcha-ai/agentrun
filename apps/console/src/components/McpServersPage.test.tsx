import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { freeName, McpServersPage } from "./McpServersPage";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import { type McpServer, PREVIEW_SCOPE_NOTE } from "@/lib/mcp";
import recorded from "@/fixtures/mcp.requests.json";
import { pick, picker, valueOf } from "@/test/picker";

// Settings → MCP servers over /v2/settings/mcp-servers: add a server, preview its tools, save it; each refusal in plain
// words; OAuth's sign-in and its way back; the saved list with each credential's state, refresh and delete. A credential
// typed is sent and then gone from the page: never in an input's value attribute, never shown again.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Obvious fakes: none of these is a token anywhere. */
const VARS = { url: "http://127.0.0.1:4100/mcp", token: "not-a-real-token-0123", wrong_token: "not-the-token-9876", oauth_url: "http://127.0.0.1:4200/mcp" };
type Sent = { method: string; path: string; body?: unknown };
/** The fixture's request for `step`, its placeholders filled. */
const expected = (step: string): Sent => {
  const r = recorded.requests.find((x) => x.step === step)!;
  const filled = JSON.parse(Object.entries(VARS).reduce((text, [k, v]) => text.split(`{${k}}`).join(v), JSON.stringify(r))) as Sent & { step: string };
  return { method: filled.method, path: filled.path, ...(filled.body !== undefined ? { body: filled.body } : {}) };
};

const TOOLS = [
  { name: "add", title: "Add", description: "Add two numbers.", input_schema: { type: "object" } },
  { name: "slow_write", description: "Write a line after a wait.", input_schema: { type: "object" } },
];
const PREVIEW = { protocol: "2026-07-28", server_info: { name: "fake-mcp", version: "1.0.0" }, tools: TOOLS };
const saved = (extra: Partial<McpServer> = {}): McpServer => ({ name: "fake", url: VARS.url, auth: { type: "bearer" }, source: "url", toolkit: null, credential: "sealed", tools: TOOLS, protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", ...extra });
/** The source the add form shows, read-only: what made the server, never a choice. */
const sourceShown = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-mcp-source]")?.dataset.mcpSource;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, retryable: false, ...extra } });

const PRIVATE_HOSTS = "/v2/settings/mcp-servers/oauth/private-hosts";
/** The server's own callback (its AGENTRUN_PUBLIC_URL), on another address than the page's: the words name this one. */
const CALLBACK = "https://agents.example.test/v2/settings/mcp-servers/oauth/callback";
/** A server: GET the list answers `lists` in turn (the last again after); every other request is `answer`'s. */
function server(lists: McpServer[][], answer: (call: Sent) => Response | Promise<Response> | undefined = () => undefined) {
  const calls: Sent[] = [];
  let read = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Sent = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const own = answer(call);
    if (own) return own;
    if (call.method === "GET" && call.path === "/v2/settings/mcp-servers") return json(200, { servers: lists[Math.min(read++, lists.length - 1)] });
    if (call.method === "GET" && call.path === PRIVATE_HOSTS) return json(200, { hosts: [] });
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, props: Record<string, unknown> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const opened: string[] = [];
  act(() => root!.render(createElement(McpServersPage, { v2, writable: true, open: (u: string) => opened.push(u), ...props })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp, within: Element = host) => [...within.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp, within: Element = host) => {
    const b = button(label, within);
    if (!b) throw new Error(`no button ${label}; buttons: ${[...within.querySelectorAll("button")].map((x) => JSON.stringify(x.textContent)).join(", ")}`);
    await act(async () => { b.click(); });
    await settle();
  };
  const input = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const type = async (name: string, value: string) => {
    const el = input(name);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const pick = async (auth: string) => { await act(async () => { (host.querySelector(`input[name="mcp-auth"][value="${auth}"]`) as HTMLInputElement).click(); }); };
  const row = (name: string) => host.querySelector(`[data-server="${name}"]`)!;
  return { host, settle, button, click, input, type, pick, row, opened, text: () => host.textContent ?? "" };
}

describe("Settings → MCP servers, adding one", () => {
  it("previews the tools and the protocol, then saves: the exact requests, and the token gone from the page", async () => {
    const s = server([[], [saved()]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : c.method === "PUT" ? json(200, saved()) : undefined));
    const p = await open(s.v2);
    expect(p.text()).toContain("No MCP server is saved here yet");
    await p.click(/^Add server$/);
    await p.type("mcp-name", "fake");
    await p.type("mcp-url", VARS.url);
    await p.pick("bearer");
    await p.type("mcp-token", VARS.token);
    await p.click(/^Preview$/);
    // The preview: the protocol agreed, the server's own name, and each tool with its title and description.
    expect(p.text()).toContain("2026-07-28");
    expect(p.text()).toContain("fake-mcp 1.0.0");
    const tools = [...p.host.querySelectorAll('[aria-label="Tools it lists"] li')].map((li) => li.textContent);
    expect(tools).toEqual([expect.stringContaining("add"), expect.stringContaining("slow_write")]);
    expect(tools[0]).toContain("Add two numbers.");
    expect(tools[0]).toContain("Add");
    // The list is what the server offers, not what this credential allows: said with the preview.
    expect(p.host.querySelector('[aria-label="Preview"]')?.textContent).toContain(PREVIEW_SCOPE_NOTE);
    expect(PREVIEW_SCOPE_NOTE).toContain("not what this credential allows");
    expect(PREVIEW_SCOPE_NOTE).toContain("refused by the server");
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([expected("preview"), expected("save")]);
    // Saved: the list shows it, and no input or text on the page holds the token.
    expect(p.row("fake").textContent).toContain("2 tools");
    expect(p.row("fake").textContent).toContain("sealed");
    expect(document.body.innerHTML).not.toContain(VARS.token);
  });

  it("says a refused token in plain words, and sends it nowhere but the preview", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server refused the credential sent (HTTP 401).", { details: { auth: "bearer", status: 401 } }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "fake");
    await p.type("mcp-url", VARS.url);
    await p.pick("bearer");
    await p.type("mcp-token", VARS.wrong_token);
    await p.click(/^Preview$/);
    expect(p.text()).toContain("This server asks for a token");
    expect(s.writes()).toEqual([expected("preview, a wrong token")]);
    expect(p.button(/^Save$/)?.disabled ?? true).toBe(true);
    expect(document.body.innerHTML).not.toContain(VARS.wrong_token);
  });

  it("offers Sign in to a server behind OAuth, which starts the sign-in and opens the page it answers", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server asks for a credential (HTTP 401).", { details: { auth: "oauth", status: 401 } })
      : c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=x" }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "docs");
    await p.type("mcp-url", VARS.oauth_url);
    await p.click(/^Preview$/);
    expect(p.text()).toContain("This server signs in with OAuth");
    await p.click(/^Sign in$/);
    expect(s.writes()).toEqual([expected("preview, a server behind OAuth"), expected("sign in")]);
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=x"]);
  });

  it("a preview whose OAuth lets no app register itself turns the form to OAuth with its Client ID and Secret fields, says how in words with the server's callback, and signs in with the client entered", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server asks for a credential (HTTP 401).", { details: { auth: "oauth", status: 401, oauth: { registration: false, callback: CALLBACK } } })
      : c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=x" }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "github");
    await p.type("mcp-url", VARS.oauth_url);
    await p.click(/^Preview$/);
    expect(p.text()).toContain("its sign-in lets no app register itself");
    // The server's callback (its public address), never the page's own address.
    expect(p.text()).toContain(`${CALLBACK} as its callback URL`);
    expect(p.text()).not.toContain(location.origin);
    // Not a dead end: the form is on OAuth, its Client ID field shows, needed, and has the cursor.
    expect((p.host.querySelector('input[name="mcp-auth"][value="oauth"]') as HTMLInputElement).checked).toBe(true);
    expect(p.input("mcp-client-id")).toBeTruthy();
    expect(p.input("mcp-client-secret")).toBeTruthy();
    expect(p.text()).toContain("Client ID (this server needs one)");
    expect(document.activeElement).toBe(p.input("mcp-client-id"));
    // An obvious fake, built so no scan reads it as a credential.
    const clientSecret = ["not", "a", "real", "secret"].join("-");
    await p.type("mcp-client-id", "Iv1.handmade");
    await p.type("mcp-client-secret", clientSecret);
    await p.click(/^Sign in$/);
    expect(s.writes().at(-1)).toEqual({ method: "POST", path: "/v2/settings/mcp-servers/github/oauth/start", body: { url: VARS.oauth_url, client_id: "Iv1.handmade", client_secret: clientSecret } });
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=x"]);
  });

  it("a needs-a-Client-ID refusal goes with its address: another address typed drops its words and the field is optional again", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server asks for a credential (HTTP 401).", { details: { auth: "oauth", status: 401, oauth: { registration: false, callback: CALLBACK } } }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "github");
    await p.type("mcp-url", VARS.oauth_url);
    await p.click(/^Preview$/);
    expect(p.text()).toContain("Client ID (this server needs one)");
    await p.type("mcp-url", VARS.url);
    await p.settle();
    expect(p.text()).not.toContain("its sign-in lets no app register itself");
    expect(p.text()).toContain("Client ID (optional)");
  });

  it("a sign-in refused because its provider lets no app register itself says so on the Client ID field's words and opens the field: never a dead end", async () => {
    const words = "github.com doesn't let apps register themselves: create an OAuth App on GitHub and enter its Client ID and Secret here.";
    let starts = 0;
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server asks for a credential (HTTP 401).", { details: { auth: "oauth", status: 401 } })
      : c.path.endsWith("/oauth/start") ? (starts++ === 0 ? refusal(422, "input_invalid", words, { fields: [{ field: "client_id", reason: "registration_unavailable", message: words }], details: { oauth: { registration: false, callback: CALLBACK } } }) : json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=y" })) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "github");
    await p.type("mcp-url", VARS.oauth_url);
    await p.click(/^Preview$/);
    // Discovery said nothing of registration: the plain Sign in, whose start is then refused.
    await p.click(/^Sign in$/);
    expect(p.text()).toContain(words);
    expect(p.text()).toContain(`${CALLBACK} as its callback URL`);
    expect((p.host.querySelector('input[name="mcp-auth"][value="oauth"]') as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(p.input("mcp-client-id"));
    await p.type("mcp-client-id", "Iv1.handmade");
    await p.click(/^Sign in$/);
    expect(s.writes().at(-1)?.body).toEqual({ url: VARS.oauth_url, client_id: "Iv1.handmade" });
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=y"]);
  });

  it("after a Preview finds OAuth, choosing Sign in with OAuth shows one Sign in button, not two", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(422, "auth_required", "The MCP server asks for a credential (HTTP 401).", { details: { auth: "oauth", status: 401 } }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "docs");
    await p.type("mcp-url", VARS.oauth_url);
    await p.click(/^Preview$/);
    expect([...p.host.querySelectorAll("form button")].filter((b) => b.textContent?.trim() === "Sign in")).toHaveLength(1);
    await p.pick("oauth");
    await p.settle();
    expect(p.text()).toContain("This server signs in with OAuth");
    expect([...p.host.querySelectorAll("form button")].filter((b) => b.textContent?.trim() === "Sign in")).toHaveLength(1);
  });

  it("drops a preview's answer when the address changed while it ran: Save waits for a preview of what is typed", async () => {
    let answer: (r: Response) => void = () => {};
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? (new Promise<Response>((done) => { answer = done; }) as unknown as Response) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "fake");
    await p.type("mcp-url", VARS.url);
    await p.click(/^Preview$/);
    await p.type("mcp-url", "http://127.0.0.1:4999/mcp");
    await act(async () => { answer(json(200, PREVIEW)); });
    await p.settle();
    expect(p.host.querySelector('[aria-label="Tools it lists"]')).toBeNull();
    expect(p.button(/^Save$/)!.disabled).toBe(true);
    await p.click(/^Preview$/);
    await act(async () => { answer(json(200, PREVIEW)); });
    await p.settle();
    expect(p.host.querySelector('[aria-label="Tools it lists"]')).not.toBeNull();
    expect(p.button(/^Save$/)!.disabled).toBe(false);
    expect(s.writes().map((c) => (c.body as { url: string }).url)).toEqual([VARS.url, "http://127.0.0.1:4999/mcp"]);
  });

  it("says each other refusal in plain words", async () => {
    const cases: [Response, string][] = [
      [refusal(422, "not_mcp", "Nothing it answered was MCP."), "This address doesn't speak MCP"],
      [refusal(422, "input_invalid", "invalid", { fields: [{ field: "url", reason: "redirect", message: "The MCP server answered 302, pointing to https://example.com/mcp." }] }), "This address redirects; use the final address"],
      [refusal(424, "upstream_failed", "The MCP server could not be reached: connection refused.", { retryable: true }), "The server failed: The MCP server could not be reached: connection refused."],
      [refusal(409, "wrong_origin", "This server's sign-in comes back to http://127.0.0.1:7340.", { details: { open: "http://127.0.0.1:7340/#/settings/mcp" } }), "Open http://127.0.0.1:7340/#/settings/mcp and sign in from it."],
    ];
    for (const [answer, words] of cases) {
      const s = server([[]], (c) => (c.path.endsWith("/preview") ? answer.clone() : undefined));
      const p = await open(s.v2);
      await p.click(/^Add server$/);
      await p.type("mcp-name", "fake");
      await p.type("mcp-url", VARS.url);
      await p.click(/^Preview$/);
      expect(p.text(), words).toContain(words);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
});

describe("Settings → MCP servers, the saved ones", () => {
  it("shows each credential's state, and an expired sign-in offers Sign in again", async () => {
    const s = server([[saved(), saved({ name: "docs", auth: { type: "oauth" }, credential: "expired", oauth: { scopes: ["read"], client: "dynamic" } }), saved({ name: "old", credential: "unreadable" }), saved({ name: "open", auth: { type: "none" }, credential: null })]],
      (c) => (c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=y" }) : undefined));
    const p = await open(s.v2);
    expect(p.row("fake").textContent).toContain("sealed");
    expect(p.row("docs").textContent).toContain("expired");
    expect(p.row("old").textContent).toContain("can't be opened");
    expect(p.row("open").textContent).toContain("no credential");
    await p.click(/^Sign in again$/, p.row("docs"));
    // The scopes it signed in with go again.
    expect(s.writes()).toEqual([{ method: "POST", path: "/v2/settings/mcp-servers/docs/oauth/start", body: { url: VARS.url, scopes: ["read"] } }]);
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=y"]);
  });

  it("a saved server whose sign-in needs a Client ID offers Enter a Client ID, which opens its form with the refusal's words, the field needed and the cursor in it", async () => {
    const words = "github.com doesn't let apps register themselves: create an OAuth App on GitHub and enter its Client ID and Secret here.";
    const s = server([[saved({ name: "gh", url: VARS.oauth_url, auth: { type: "oauth" }, credential: "expired", oauth: { scopes: [], client: "dynamic" } })]],
      (c) => (c.path.endsWith("/oauth/start") ? (c.body as { client_id?: string }).client_id ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=z" }) : refusal(422, "input_invalid", words, { fields: [{ field: "client_id", reason: "registration_unavailable", message: words }], details: { oauth: { registration: false, callback: CALLBACK } } }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Sign in again$/, p.row("gh"));
    expect(p.row("gh").textContent).toContain(words);
    await p.click(/^Enter a Client ID$/, p.row("gh"));
    const form = p.host.querySelector("form")!;
    expect(form.textContent).toContain(words);
    expect(form.textContent).toContain("Client ID (this server needs one)");
    expect(document.activeElement).toBe(p.input("mcp-client-id"));
    await p.type("mcp-client-id", "Iv1.handmade");
    await p.click(/^Sign in again with these settings$/);
    expect(s.writes().at(-1)?.body).toEqual({ url: VARS.oauth_url, client_id: "Iv1.handmade" });
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=z"]);
  });

  it("an expired sign-in says so beside its OAuth line, never the time its revoked token would have lasted to; a sealed one keeps its time", async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const p = await open(server([[saved({ name: "docs", auth: { type: "oauth" }, credential: "expired", oauth: { expires_at: later, scopes: ["read"], client: "dynamic" } }), saved({ name: "live", auth: { type: "oauth" }, credential: "sealed", oauth: { expires_at: later, scopes: [], client: "dynamic" } })]]).v2);
    expect(p.row("docs").textContent).toContain("Signed in with OAuth · read · sign-in expired: sign in again");
    expect(p.row("docs").textContent).not.toContain("token until");
    expect(p.row("live").textContent).toContain("token until");
  });

  it("signs in again with the person's own client by its scopes alone: the server reuses the client it kept", async () => {
    const own = saved({ name: "crm", auth: { type: "oauth" }, credential: "expired", oauth: { scopes: ["read", "write"], client: "pre-registered", client_id: "owner-app" } });
    const s = server([[own]], (c) => (c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=z" }) : undefined));
    const p = await open(s.v2);
    expect(p.row("crm").textContent).toContain("client owner-app");
    await p.click(/^Sign in again$/, p.row("crm"));
    expect(s.writes()).toEqual([{ method: "POST", path: "/v2/settings/mcp-servers/crm/oauth/start", body: { url: VARS.url, scopes: ["read", "write"] } }]);
    // No server form opened (the private network hosts' own form is always there).
    expect(p.host.querySelector('form[aria-label="Change crm"], form[aria-label="Add an MCP server"]')).toBeNull();
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=z"]);
  });

  it("a change sends no prices: the server keeps the saved ones for the tools it still lists (a PUT with none keeps them)", async () => {
    const priced = saved({ prices: { add: 0.05, gone: 1 } });
    const s = server([[priced]], (c) => (c.method === "PUT" ? json(200, priced) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("fake"));
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([{ method: "PUT", path: "/v2/settings/mcp-servers/fake", body: { url: VARS.url, auth: { type: "bearer" } } }]);
  });

  it("previews an edit with the saved server's name beside the address as shown, so the server maps it to the saved endpoint", async () => {
    const masked = saved({ url: "https://mcp.example.com/…", auth: { type: "none" } });
    const s = server([[masked]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("fake"));
    await p.click(/^Preview$/);
    expect(s.writes()).toEqual([{ method: "POST", path: "/v2/settings/mcp-servers/preview", body: { url: "https://mcp.example.com/…", auth: { type: "none" }, name: "fake" } }]);
  });

  it("a save that lands after its form was closed and another opened leaves the other form open, with what was typed", async () => {
    let finish: (r: Response) => void = () => {};
    const s = server([[saved(), saved({ name: "other" })]], (c) => (c.method === "PUT" ? new Promise<Response>((done) => { finish = done; }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("fake"));
    await p.click(/^Save$/);
    await p.click(/^Cancel$/);
    await p.click(/^Change$/, p.row("other"));
    await p.type("mcp-url", "http://127.0.0.1:4999/mcp");
    await act(async () => { finish(json(200, saved())); });
    await p.settle();
    expect(p.input("mcp-name")?.value).toBe("other");
    expect(p.input("mcp-url")?.value).toBe("http://127.0.0.1:4999/mcp");
  });

  it("changes one with its token kept: the field is empty and says saved", async () => {
    const s = server([[saved()]], (c) => (c.method === "PUT" ? json(200, saved()) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("fake"));
    expect(p.input("mcp-token").value).toBe("");
    expect(p.text()).toContain("Saved");
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([expected("save again, the token kept")]);
  });

  it("signs in again, never a PUT, when a saved OAuth server's scopes change; a change that needs no sign-in is saved", async () => {
    const docs = saved({ name: "docs", auth: { type: "oauth" }, credential: "sealed", oauth: { scopes: ["read"], client: "dynamic" } });
    const s = server([[docs]], (c) => (c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=w" }) : c.method === "PUT" ? json(200, docs) : undefined));
    let p = await open(s.v2);
    await p.click(/^Change$/, p.row("docs"));
    await p.type("mcp-scopes", "read write");
    expect(p.button(/^Save$/)).toBeUndefined();
    await p.click(/^Sign in again with these settings$/);
    expect(s.writes()).toEqual([{ method: "POST", path: "/v2/settings/mcp-servers/docs/oauth/start", body: { url: VARS.url, scopes: ["read", "write"] } }]);
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=w"]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const t = server([[docs]], (c) => (c.method === "PUT" ? json(200, docs) : undefined));
    p = await open(t.v2);
    await p.click(/^Change$/, p.row("docs"));
    await p.type("mcp-url", "http://127.0.0.1:4100/v2/mcp");
    await p.click(/^Save$/);
    expect(t.writes()).toEqual([{ method: "PUT", path: "/v2/settings/mcp-servers/docs", body: { url: "http://127.0.0.1:4100/v2/mcp", auth: { type: "oauth" } } }]);
  });

  it("marks a server whose read says some of its tools are not metered, and each such tool", async () => {
    const s = server([[saved({ prices: { add: 0.05 }, not_metered: ["slow_write"] }), saved({ name: "paid", prices: { add: 0.05, slow_write: 0 } })]]);
    const p = await open(s.v2);
    expect(p.row("fake").textContent).toContain("not metered");
    expect([...p.row("fake").querySelectorAll("details [data-tool-detail]")].map((x) => x.textContent)).toEqual(["$0.05 a call", "not metered"]);
    expect(p.row("paid").textContent).not.toContain("not metered");
  });

  it("says where each credential came from and when it last changed, from the read's secret; none says nothing", async () => {
    const changed = "2026-11-04T10:00:00Z";
    const s = server([[
      saved({ secret: { name: "mcp:fake", set: true, source: "console", changed_at: changed } }),
      saved({ name: "docs", auth: { type: "oauth" }, oauth: { scopes: [], client: "dynamic" }, secret: { name: "mcp:docs", set: true, source: "sign-in", changed_at: changed } }),
      saved({ name: "open", auth: { type: "none" }, credential: null, secret: { name: "mcp:open", set: false, source: null, changed_at: null } }),
    ]]);
    const p = await open(s.v2);
    // Each server's one secret is its SecretRow (SecretRow.tsx): where it came from, and when it last changed.
    expect(p.row("fake").querySelector('[data-secret="mcp:fake"]')!.textContent).toMatch(/Pasted here.*Changed .* ago/);
    expect(p.row("docs").querySelector('[data-secret="mcp:docs"]')!.textContent).toMatch(/From sign-in.*Changed .* ago/);
    expect(p.row("open").querySelector('[data-secret="mcp:open"]')!.textContent).toContain("Missing");
    expect(p.row("open").textContent).not.toContain("Changed");
  });

  it("refreshes one and says what was added, removed and changed", async () => {
    const after = saved({ tools: [TOOLS[0], { name: "paid", description: "A call the server bills.", input_schema: {} }] });
    const s = server([[saved()], [after]], (c) => (c.path.endsWith("/refresh") ? json(200, { added: ["paid"], removed: ["slow_write"], changed: ["add"], server: after }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Refresh$/, p.row("fake"));
    expect(s.writes()).toEqual([expected("refresh")]);
    expect(p.row("fake").textContent).toContain("Added paid");
    expect(p.row("fake").textContent).toContain("Removed slow_write");
    expect(p.row("fake").textContent).toContain("Changed add");
    expect(s.calls.filter((c) => c.method === "GET" && c.path === "/v2/settings/mcp-servers")).toHaveLength(2);
  });

  it("a refresh refused for an expired sign-in reloads the list: the row shows the sign-in expired and offers Sign in again, with the refusal kept", async () => {
    const later = "2026-11-08T10:00:00Z";
    const live = saved({ name: "docs", auth: { type: "oauth" }, credential: "sealed", oauth: { expires_at: later, scopes: ["read"], client: "dynamic" } });
    const revoked = { ...live, credential: "expired" as const };
    const said = "The sign-in to docs expired or was revoked: sign in again from the MCP servers page.";
    const s = server([[live], [revoked]], (c) => (c.path.endsWith("/refresh") ? refusal(422, "input_invalid", said, { fields: [{ field: "name", reason: "expired", message: said }] }) : undefined));
    const p = await open(s.v2);
    expect(p.button(/^Sign in again$/, p.row("docs"))).toBeUndefined();
    await p.click(/^Refresh$/, p.row("docs"));
    expect(s.calls.filter((c) => c.method === "GET" && c.path === "/v2/settings/mcp-servers")).toHaveLength(2);
    expect(p.row("docs").textContent).toContain("sign-in expired");
    expect(p.row("docs").textContent).not.toContain("token until");
    expect(p.button(/^Sign in again$/, p.row("docs"))).toBeDefined();
    expect(p.row("docs").querySelector('[role="alert"]')?.textContent).toContain(said);
  });

  it("deletes one only once confirmed", async () => {
    const s = server([[saved()], []], (c) => (c.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Delete$/, p.row("fake"));
    expect(s.writes()).toEqual([]);
    expect(p.row("fake").textContent).toContain("Delete fake?");
    await p.click(/^Delete$/, p.row("fake").querySelector('[role="alertdialog"]')!);
    expect(s.writes()).toEqual([expected("delete")]);
    expect(p.text()).toContain("No MCP server is saved here yet");
  });

  it("offers every credential type at once: a credential is always kept sealed, so nothing waits on a seal key", async () => {
    const p = await open(server([[]]).v2);
    await p.click(/^Add server$/);
    const radios = [...p.host.querySelectorAll('input[name="mcp-auth"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["none", "bearer", "headers", "oauth", "github_app"]);
    expect(radios.every((r) => !r.disabled)).toBe(true);
    expect(p.text()).not.toContain("seal key");
  });
});

describe("Settings → MCP servers, GitHub App", () => {
  const GITHUB = "https://api.githubcopilot.com/mcp/";
  const app = (extra: Partial<McpServer> = {}) => saved({ name: "github", url: GITHUB, auth: { type: "github_app" }, credential: null, ...extra });

  it("offers GitHub App, fills GitHub's address, and saves auth {type: github_app} with no token", async () => {
    const s = server([[], [app()]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : c.method === "PUT" ? json(200, app()) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "github");
    await p.pick("github_app");
    expect(p.input("mcp-url").value).toBe(GITHUB);
    expect(p.text()).toContain("this server's GitHub App");
    await p.click(/^Preview$/);
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([
      { method: "POST", path: "/v2/settings/mcp-servers/preview", body: { url: GITHUB, auth: { type: "github_app" } } },
      { method: "PUT", path: "/v2/settings/mcp-servers/github", body: { url: GITHUB, auth: { type: "github_app" } } },
    ]);
    expect(p.row("github").textContent).toContain("GitHub App");
  });

  it("sends optional static headers with a github_app save", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : c.method === "PUT" ? json(200, app({ auth: { type: "github_app", headers: ["X-GitHub-Toolsets"] } })) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "github");
    await p.pick("github_app");
    await p.type("mcp-header-name-0", "X-GitHub-Toolsets");
    await p.type("mcp-header-value-0", "repos");
    await p.click(/^Preview$/);
    await p.click(/^Save$/);
    expect(s.writes()[1]).toEqual({ method: "PUT", path: "/v2/settings/mcp-servers/github", body: { url: GITHUB, auth: { type: "github_app", headers: { "X-GitHub-Toolsets": "repos" } } } });
  });

  it("shows a saved github_app server as GitHub App and edits it as one, not as None", async () => {
    const s = server([[app()]], (c) => (c.method === "PUT" ? json(200, app()) : undefined));
    const p = await open(s.v2);
    expect(p.row("github").textContent).toContain("GitHub App");
    await p.click(/^Change$/, p.row("github"));
    expect((p.host.querySelector('input[name="mcp-auth"][value="github_app"]') as HTMLInputElement).checked).toBe(true);
    expect((p.host.querySelector('input[name="mcp-auth"][value="none"]') as HTMLInputElement).checked).toBe(false);
    expect(p.input("mcp-url").value).toBe(GITHUB);
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([{ method: "PUT", path: "/v2/settings/mcp-servers/github", body: { url: GITHUB, auth: { type: "github_app" } } }]);
  });

  it("routes #/settings/mcp?add=github&auth=github_app to the add form, and ignores a name no server can have", () => {
    expect(route("#/settings/mcp?add=github&auth=github_app")).toMatchObject({ settings: "mcp", add: { name: "github", auth: "github_app" } });
    expect(route("#/settings/mcp?add=Not_A_Name")).not.toHaveProperty("add");
    expect(route("#/settings/mcp")).not.toHaveProperty("add");
    // A Composio need's: the preset, its toolkit and the actions to tick (an action no tool can be named is dropped).
    expect(route("#/settings/mcp?add=slack&preset=composio&toolkit=slack&tools=SLACK_SEND_MESSAGE,bad%20name,SLACK_FIND_CHANNELS").add)
      .toEqual({ name: "slack", preset: "composio", toolkit: "slack", tools: ["SLACK_SEND_MESSAGE", "SLACK_FIND_CHANNELS"] });
    expect(route("#/settings/mcp?add=slack&preset=composio&toolkit=Not_A_Toolkit").add).toEqual({ name: "slack" });
  });

  it("opens the add form for a template's url need with its toolkit filled, and saves the server as url and that toolkit", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : c.method === "PUT" ? json(200, saved({ name: "hubspot" })) : undefined));
    const p = await open(s.v2, { add: { name: "hubspot" } });
    expect(p.input("mcp-name").value).toBe("hubspot");
    expect(p.input("mcp-toolkit").value).toBe("hubspot");
    expect(sourceShown(p.host)).toBe("url");
    await p.type("mcp-url", VARS.url);
    await p.click(/^Preview$/);
    await p.click(/^Save$/);
    expect(s.writes().at(-1)).toEqual({ method: "PUT", path: "/v2/settings/mcp-servers/hubspot", body: { url: VARS.url, auth: { type: "none" }, toolkit: "hubspot" } });
  });

  it("a new server with no toolkit sends none; the source is never sent, and GitHub App access is GitHub's own", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? json(200, PREVIEW) : c.method === "PUT" ? json(200, saved()) : undefined));
    const p = await open(s.v2);
    await p.click(/^Add server$/);
    await p.type("mcp-name", "fake");
    await p.type("mcp-url", VARS.url);
    await p.click(/^Preview$/);
    await p.click(/^Save$/);
    expect(s.writes().at(-1)!.body).toEqual({ url: VARS.url, auth: { type: "none" } });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const gh = await open(server([[]]).v2, { add: { name: "github", auth: "github_app" } });
    expect(sourceShown(gh.host)).toBe("github");
    expect(picker(gh.host, "Source")).toBeFalsy();
    expect(gh.input("mcp-toolkit").value).toBe("github");
    expect(gh.input("mcp-toolkit").readOnly).toBe(true);
  });

  it("changes a saved server's toolkit, sending only what changed and never a source", async () => {
    const s = server([[saved({ name: "crm" })]], (c) => (c.method === "PUT" ? json(200, saved({ name: "crm" })) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("crm"));
    expect(sourceShown(p.host)).toBe("url");
    await p.type("mcp-toolkit", "hubspot");
    await p.click(/^Save$/);
    expect(s.writes().at(-1)!.body).toEqual({ url: VARS.url, auth: { type: "bearer" }, toolkit: "hubspot" });
  });

  it("shows a Composio server's source as what made it, read-only, and a toolkit edit sends only the toolkit", async () => {
    const s = server([[saved({ name: "work-slack", source: "composio", toolkit: "slack" })]], (c) => (c.method === "PUT" ? json(200, saved({ name: "work-slack", source: "composio", toolkit: "slack-eu" })) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("work-slack"));
    expect(sourceShown(p.host)).toBe("composio");
    expect(picker(p.host, "Source")).toBeFalsy();
    await p.type("mcp-toolkit", "slack-eu");
    await p.click(/^Save$/);
    expect(s.writes().at(-1)!.body).toEqual({ url: VARS.url, auth: { type: "bearer" }, toolkit: "slack-eu" });
  });

  it("a sign-in carries the toolkit, so the server it saves is matched by a template's need", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/oauth/start") ? json(200, { authorization_url: "http://127.0.0.1:4300/authorize?state=t" }) : undefined));
    const p = await open(s.v2, { add: { name: "notion" } });
    await p.type("mcp-url", VARS.oauth_url);
    await p.pick("oauth");
    await p.settle();
    await p.click(/^Sign in$/);
    expect(s.writes().at(-1)).toEqual({ method: "POST", path: "/v2/settings/mcp-servers/notion/oauth/start", body: { url: VARS.oauth_url, toolkit: "notion" } });
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=t"]);
  });

  it("shows each saved server's source and toolkit", async () => {
    const p = await open(server([[saved({ name: "slack", source: "composio", toolkit: "slack" }), saved()]]).v2);
    expect(p.row("slack").textContent).toContain("Composio");
    expect(p.row("slack").querySelector("[data-toolkit]")!.textContent).toBe("toolkit slack");
    expect(p.row("fake").textContent).toContain("URL");
    expect(p.row("fake").querySelector("[data-toolkit]")!.textContent).toBe("no toolkit");
  });

  it("opens the add form for a server a template needs, its name and GitHub App filled", async () => {
    const p = await open(server([[]]).v2, { add: { name: "github", auth: "github_app" } });
    expect(p.host.querySelector('form[aria-label="Add an MCP server"]')).toBeTruthy();
    expect(p.input("mcp-name").value).toBe("github");
    expect(p.input("mcp-url").value).toBe(GITHUB);
    expect((p.host.querySelector('input[name="mcp-auth"][value="github_app"]') as HTMLInputElement).checked).toBe(true);
  });

  it("opens the add form again when Back returns to a setup URL while the page stays mounted", async () => {
    const { v2 } = server([[]]);
    const p = await open(v2, { add: { name: "github", auth: "github_app" } });
    const show = async (add?: { name: string; auth?: "github_app" }) => {
      await act(async () => { root!.render(createElement(McpServersPage, { v2, writable: true, ...(add ? { add } : {}) })); });
    };
    expect(p.host.querySelector('form[aria-label="Add an MCP server"]')).toBeTruthy();
    await show(undefined);
    expect(p.host.querySelector('form[aria-label="Add an MCP server"]')).toBeFalsy();
    await show({ name: "github", auth: "github_app" });
    expect(p.host.querySelector('form[aria-label="Add an MCP server"]')).toBeTruthy();
    expect(p.input("mcp-name").value).toBe("github");
  });

  it("says in words when GitHub is not connected, pointing at Settings → GitHub", async () => {
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(409, "github_not_connected", "This server has no GitHub App") : undefined));
    const p = await open(s.v2, { add: { name: "github", auth: "github_app" } });
    await p.click(/^Preview$/);
    expect(p.text()).toContain("GitHub is not connected on this server.");
    expect(p.text()).toContain("Settings → GitHub");
  });

  it("keeps the server's own words when the App is connected but has no repository", async () => {
    const why = "The GitHub App is installed but no repository is selected: add one in the installation's settings on GitHub.";
    const s = server([[]], (c) => (c.path.endsWith("/preview") ? refusal(409, "github_not_connected", why) : undefined));
    const p = await open(s.v2, { add: { name: "github", auth: "github_app" } });
    await p.click(/^Preview$/);
    expect(p.text()).toContain(why);
    expect(p.text()).toContain("Settings → GitHub");
  });
});

describe("Settings → MCP servers, back from a sign-in", () => {
  it("reads the address the server sends the browser back to, and says how it went", async () => {
    const back = route(`#${recorded.sign_in_return.split("#")[1]}`);
    expect(back).toMatchObject({ section: "settings", settings: "mcp", signIn: { server: "docs", ok: true } });
    let p = await open(server([[saved({ name: "docs", auth: { type: "oauth" } })]]).v2, { signIn: back.signIn });
    expect(p.text()).toContain("Signed in to docs");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const failed = route("#/settings/mcp?server=docs&sign_in=failed&error=access_denied");
    expect(failed.signIn).toEqual({ server: "docs", ok: false, error: "access_denied" });
    p = await open(server([[]]).v2, { signIn: failed.signIn });
    expect(p.text()).toContain("Signing in to docs failed: the sign-in was declined on its approval page.");
    expect(p.text()).not.toContain("access_denied");
  });

  it("says every failure code in words from the one table, and one it doesn't know in general words: never a code on screen", async () => {
    for (const [code, words] of [
      ["invalid_grant", "its authorization server didn't take the sign-in's code (it expired, or was used already): sign in again."],
      ["changed_meanwhile", "the server was changed or removed while you signed in, so nothing was saved."],
      ["upstream_failed", "the MCP server or its authorization server failed: try again."],
      ["a_code_nobody_knows", "the sign-in didn't finish: try again."],
    ]) {
      const p = await open(server([[]]).v2, { signIn: { server: "docs", ok: false, error: code } });
      expect(p.text()).toContain(`Signing in to docs failed: ${words}`);
      expect(p.text()).not.toContain(code);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
});

describe("Settings → MCP servers, private network hosts", () => {
  const section = () => document.querySelector('section[aria-labelledby="mcp-private-hosts"]')!;
  it("says it is off by default and what it allows, and lists none", async () => {
    const p = await open(server([[]]).v2);
    expect(section().querySelector("h2")?.textContent).toBe("Private network hosts");
    expect(section().textContent).toContain("Off by default.");
    expect(section().textContent).toContain("over https only; never this machine, loopback or a link-local address such as cloud metadata");
    expect(section().textContent).toContain("No host is allowed");
    expect(p.button(/^Allow$/, section())?.disabled).toBe(true);
  });

  it("adds and removes a host, each by sending the whole list, and shows the list the server kept", async () => {
    let kept: string[] = ["10.20.30.40"];
    const s = server([[]], (c) => {
      if (c.path !== PRIVATE_HOSTS) return undefined;
      if (c.method === "PUT") kept = ((c.body as { hosts: string[] }).hosts).map((h) => h.toLowerCase().replace(/\.+$/, ""));
      return json(200, { hosts: kept });
    });
    const p = await open(s.v2);
    expect(section().querySelector('[data-host="10.20.30.40"]')).not.toBeNull();
    await p.type("mcp-private-host", " Auth.Corp.example. ");
    await p.click(/^Allow$/, section());
    expect(s.writes()).toEqual([{ method: "PUT", path: PRIVATE_HOSTS, body: { hosts: ["10.20.30.40", "Auth.Corp.example."] } }]);
    expect([...section().querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent)).toEqual(["10.20.30.40", "auth.corp.example"]);
    expect(p.input("mcp-private-host").value).toBe("");
    await p.click(/^Remove$/, section().querySelector('[data-host="10.20.30.40"]')!);
    expect(s.writes()[1]).toEqual({ method: "PUT", path: PRIVATE_HOSTS, body: { hosts: ["auth.corp.example"] } });
    expect([...section().querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent)).toEqual(["auth.corp.example"]);
  });

  it("says the server's refusal in its words, and keeps what was typed and the list as it was", async () => {
    const s = server([[]], (c) => {
      if (c.path !== PRIVATE_HOSTS) return undefined;
      if (c.method === "PUT") return refusal(422, "input_invalid", "*.corp.example holds a wildcard: name each host on its own.", { fields: [{ field: "hosts[0]", reason: "invalid", message: "*.corp.example holds a wildcard: name each host on its own." }] });
      return json(200, { hosts: [] });
    });
    const p = await open(s.v2);
    await p.type("mcp-private-host", "*.corp.example");
    await p.click(/^Allow$/, section());
    expect(section().querySelector('[role="alert"]')?.textContent).toContain("holds a wildcard: name each host on its own.");
    expect(p.input("mcp-private-host").value).toBe("*.corp.example");
    expect(section().textContent).toContain("No host is allowed");
  });

  it("a write refused for want of the owner's password session says so", async () => {
    const said = "Allowing private-network hosts takes the owner's password sign-in in the console, never a token.";
    const s = server([[]], (c) => (c.path !== PRIVATE_HOSTS ? undefined : c.method === "PUT" ? refusal(403, "forbidden", said) : json(200, { hosts: [] })));
    const p = await open(s.v2);
    await p.type("mcp-private-host", "auth.corp.example");
    await p.click(/^Allow$/, section());
    expect(section().querySelector('[role="alert"]')?.textContent).toContain(said);
  });
});

describe("Settings → MCP servers, the Composio preset", () => {
  const KEY = "not-a-real-composio-key-0123";
  const ACTIONS = [{ slug: "GITHUB_STAR_REPO", name: "Star a repo", description: "Star a repository." }, { slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "List a repository's issues." }];
  const TOOLS_PATH = "/v2/settings/mcp-servers/composio/tools";
  const answer = (c: Sent) => {
    if (c.path === TOOLS_PATH) return json(200, { toolkit: "github", no_auth: false, tools: ACTIONS });
    if (c.method === "PUT" && c.path === "/v2/settings/mcp-servers/gh/composio") return json(200, { server: saved({ name: "gh", auth: { type: "headers", headers: ["x-api-key"] } }), connect_url: "https://connect.composio.test/link/ac_1", not_served: ["GITHUB_STAR_REPO"] });
    return undefined;
  };

  it("loads a toolkit's actions, saves the ones picked, and shows the link to connect the account; the key is gone from the page", async () => {
    const s = server([[], [saved({ name: "gh" })]], answer);
    const p = await open(s.v2);
    await p.click(/^Add from Composio$/);
    await p.type("composio-key", KEY);
    await p.type("composio-toolkit", "github");
    await p.click(/^Load actions$/);
    expect(s.writes()[0]).toEqual({ method: "POST", path: TOOLS_PATH, body: { api_key: KEY, toolkit: "github" } });
    const box = (slug: string) => p.host.querySelector(`input[type="checkbox"][value="${slug}"]`) as HTMLInputElement;
    expect(p.text()).toContain("Star a repo");
    await act(async () => { box("GITHUB_LIST_ISSUES").click(); });
    await p.type("composio-name", "gh");
    await p.click(/^Save$/);
    expect(s.writes()[1]).toEqual({ method: "PUT", path: "/v2/settings/mcp-servers/gh/composio", body: { api_key: KEY, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"] } });
    const link = [...p.host.querySelectorAll("a")].find((a) => /Connect your github account/.test(a.textContent ?? ""));
    expect(link?.getAttribute("href")).toBe("https://connect.composio.test/link/ac_1");
    expect(p.text()).toContain("Composio's server doesn't list GITHUB_STAR_REPO");
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("drops an action list asked for a toolkit no longer in the field, and keeps Cancel off while a save is out", async () => {
    let late: (r: Response) => void = () => undefined;
    let first = true;
    let finish: (r: Response) => void = () => undefined;
    const s = server([[]], (c) => {
      if (c.path === TOOLS_PATH && first) { first = false; return new Promise<Response>((done) => { late = done; }); }
      if (c.method === "PUT") return new Promise<Response>((done) => { finish = done; });
      return answer(c);
    });
    const p = await open(s.v2);
    await p.click(/^Add from Composio$/);
    await p.type("composio-key", KEY);
    await p.type("composio-toolkit", "github");
    await p.click(/^Load actions$/);
    await p.type("composio-toolkit", "slack");
    await act(async () => { late(await json(200, { toolkit: "github", no_auth: false, tools: ACTIONS })); });
    expect(p.host.querySelector('input[type="checkbox"]')).toBeNull();
    await p.click(/^Load actions$/);
    await act(async () => { (p.host.querySelector('input[type="checkbox"][value="GITHUB_LIST_ISSUES"]') as HTMLInputElement).click(); });
    await p.type("composio-name", "gh");
    await p.click(/^Save$/);
    const cancel = [...p.host.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    expect(cancel?.disabled).toBe(true);
    await act(async () => { finish(await json(200, { server: saved({ name: "gh" }) })); });
  });

  it("a template's setup link never fills a name a saved server has: older slack servers stay, and the new one takes the first free name", async () => {
    const older = [saved({ name: "slack" }), saved({ name: "slack-2" }), saved({ name: "hubspot" })];
    const s = server([older], answer);
    const p = await open(s.v2, { add: { name: "slack", preset: "composio", toolkit: "slack", tools: ["SLACK_SEND_MESSAGE"] } });
    expect(p.input("composio-toolkit").value).toBe("slack");
    await p.type("composio-key", KEY);
    await p.click(/^Load actions$/);
    expect(p.input("composio-name").value).toBe("slack-3");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const u = await open(server([older]).v2, { add: { name: "hubspot" } });
    expect(u.input("mcp-name").value).toBe("hubspot-2");
    expect(u.input("mcp-toolkit").value).toBe("hubspot");
  });

  it("a free name stays within a server name's 32 characters: the toolkit's name is cut to leave room for its number", () => {
    const long = "a".repeat(32);
    expect(freeName(long, [{ name: long }])).toBe(`${"a".repeat(30)}-2`);
    expect(freeName(long, [{ name: long }, { name: `${"a".repeat(30)}-2` }])).toBe(`${"a".repeat(30)}-3`);
    // A cut that would end on a dash drops it, so the name keeps one dash before its number.
    expect(freeName(`${"a".repeat(29)}-bc`, [{ name: `${"a".repeat(29)}-bc` }])).toBe(`${"a".repeat(29)}-2`);
    // Past -9 the number takes three characters, and the cut takes one more.
    const taken = [long, ...Array.from({ length: 8 }, (_, i) => `${"a".repeat(30)}-${i + 2}`)].map((name) => ({ name }));
    expect(freeName(long, taken)).toBe(`${"a".repeat(29)}-10`);
  });

  it("opens filled for a template's Composio need: its name and toolkit, and its actions ticked once they load", async () => {
    const s = server([[]], answer);
    const p = await open(s.v2, { add: { name: "gh", preset: "composio", toolkit: "github", tools: ["GITHUB_LIST_ISSUES"] } });
    expect(p.host.querySelector('form[aria-label="Add from Composio"]')).toBeTruthy();
    expect(p.host.querySelector('form[aria-label="Add an MCP server"]')).toBeNull();
    expect(p.input("composio-toolkit").value).toBe("github");
    expect(p.text()).toContain("A template uses GITHUB_LIST_ISSUES");
    await p.type("composio-key", KEY);
    await p.click(/^Load actions$/);
    const box = (slug: string) => p.host.querySelector(`input[type="checkbox"][value="${slug}"]`) as HTMLInputElement;
    expect(box("GITHUB_LIST_ISSUES").checked).toBe(true);
    expect(box("GITHUB_STAR_REPO").checked).toBe(false);
    expect(p.input("composio-name").value).toBe("gh");
    await p.click(/^Save$/);
    expect(s.writes().at(-1)).toEqual({ method: "PUT", path: "/v2/settings/mcp-servers/gh/composio", body: { api_key: KEY, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"] } });
  });
});

describe("Settings → MCP servers, a server's tool settings", () => {
  const ALL = ["allow", "ask", "deny"] as const;
  const gate = (permission: "allow" | "ask" | "deny" = "ask") => ({ permission, default_permission: "ask" as const, permissions: [...ALL] });
  const MARKED = [
    { name: "get_repo", input_schema: { type: "object" }, effect: "read", ...gate() },
    { name: "open_issue", input_schema: { type: "object" }, effect: "write", ...gate() },
    { name: "delete_repo", input_schema: { type: "object" }, effect: "destructive", ...gate() },
  ] as unknown as McpServer["tools"];
  /** A server whose tool settings are `settings`, kept as each PUT replaces them. Its read of gh marks each read-only
   *  tool `fallback_allow_reads` while gh's wildcard carries it, and `allow_reads` (its permission allow) where no setting
   *  of its own decides it, as the server does (`marks: false`: a read that marks none). */
  function withSettings(settings: Record<string, unknown>, { marks = true } = {}) {
    let now = settings;
    const s = server([[saved({ name: "gh", tools: MARKED })]], (c) => {
      if (c.method === "GET" && c.path === "/v2/settings/mcp-servers") {
        const on = marks && (now["mcp:gh/*"] as { allow_reads?: true } | undefined)?.allow_reads === true;
        const tools = MARKED.map((t) => {
          if (!on || t.effect !== "read") return t;
          const own = (now[`mcp:gh/${t.name}`] as { permission?: string } | undefined)?.permission;
          return own ? { ...t, permission: own, fallback_allow_reads: true } : { ...t, permission: "allow", allow_reads: true, fallback_allow_reads: true };
        });
        return json(200, { servers: [saved({ name: "gh", tools: tools as McpServer["tools"] })] });
      }
      if (c.path !== "/v2/settings/tools") return undefined;
      if (c.method === "PUT") now = c.body as Record<string, unknown>;
      return json(200, { web_search: { provider: "auto" }, web_fetch: { provider: "kernel" }, browser: { provider: "kernel" }, ...now });
    });
    return { ...s, settings: () => now };
  }
  // Capabilities' providers, each its default: a save sends none of them back as if picked.
  const CHOICES = [{ name: "web_search", default_provider: "auto" }, { name: "web_fetch", default_provider: "kernel" }, { name: "browser", default_provider: "kernel" }];
  const table = (p: Awaited<ReturnType<typeof open>>) => p.row("gh").querySelector("table")!;
  const permission = (p: Awaited<ReturnType<typeof open>>, tool: string) => table(p).querySelector<HTMLButtonElement>(`button[aria-haspopup=listbox][aria-label="mcp:gh/${tool} permission"]`)!;

  it("marks each tool read, write or destructive, as the server's read says", async () => {
    const p = await open(withSettings({}).v2, { choices: CHOICES });
    const marks = [...table(p).querySelectorAll("tr[data-tool]")].map((row) => [row.getAttribute("data-tool"), row.querySelector("[data-effect]")?.getAttribute("data-effect")]);
    expect(marks).toEqual([["mcp:gh/get_repo", "read"], ["mcp:gh/open_issue", "write"], ["mcp:gh/delete_repo", "destructive"]]);
  });

  it("Allow reads is one click: it saves allow_reads on the server's wildcard, every other setting kept, and the read-only tools then read allow by default", async () => {
    const s = withSettings({ "mcp:other/*": { permission: "deny" }, "mcp:gh/*": { permission: "ask" } });
    const p = await open(s.v2, { choices: CHOICES });
    const toggle = p.row("gh").querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle.click(); });
    await p.settle();
    expect(s.writes()).toEqual([{ method: "PUT", path: "/v2/settings/tools", body: { "mcp:other/*": { permission: "deny" }, "mcp:gh/*": { permission: "ask", allow_reads: true } } }]);
    expect(p.row("gh").querySelector('button[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(valueOf(permission(p, "get_repo"))).toBe("allow");
    expect(valueOf(permission(p, "open_issue"))).toBe("ask");
    // Where each allow comes from, in words: Allow reads, never "default", which would read as every server allowing reads.
    expect(permission(p, "get_repo").textContent).toBe("allow (allow reads)");
    expect(permission(p, "open_issue").textContent).toBe("ask (default)");
    // Off again: the field goes, the rest stays.
    await act(async () => { p.row("gh").querySelector<HTMLButtonElement>('button[role="switch"]')!.click(); });
    await p.settle();
    expect(s.settings()).toEqual({ "mcp:other/*": { permission: "deny" }, "mcp:gh/*": { permission: "ask" } });
  });

  it("a read-only tool set to ask under Allow reads falls back to allow (allow reads), as the server's read says: allow again removes its own setting, so turning the switch off leaves it asking", async () => {
    const s = withSettings({ "mcp:gh/*": { allow_reads: true }, "mcp:gh/get_repo": { permission: "ask" } });
    const p = await open(s.v2, { choices: CHOICES });
    expect(valueOf(permission(p, "get_repo"))).toBe("ask");
    // Ask is its own setting, not the default: with it removed, Allow reads lets the tool run.
    expect(permission(p, "get_repo").textContent).toBe("ask");
    expect(table(p).querySelector('tr[data-tool="mcp:gh/get_repo"]')!.textContent).toContain("default: allow (allow reads)");
    await pick(permission(p, "get_repo"), "allow");
    await p.settle();
    expect(s.settings()).toEqual({ "mcp:gh/*": { allow_reads: true } });
    expect(permission(p, "get_repo").textContent).toBe("allow (allow reads)");
    await act(async () => { p.row("gh").querySelector<HTMLButtonElement>('button[role="switch"]')!.click(); });
    await p.settle();
    expect(s.settings()).toEqual({});
    expect(valueOf(permission(p, "get_repo"))).toBe("ask");
  });

  it("the switch and its label are one line: the label beside the switch, which it names", async () => {
    const p = await open(withSettings({}).v2, { choices: CHOICES });
    const toggle = p.row("gh").querySelector<HTMLButtonElement>('button[role="switch"]')!;
    const label = document.getElementById(toggle.getAttribute("aria-labelledby")!)!;
    expect(label.textContent).toBe("Allow reads");
    expect(label.parentElement).toBe(toggle.parentElement);
  });

  it("an allow by Allow reads is the server's word: a read that doesn't mark the tool so leaves it at its default, whatever the wildcard holds", async () => {
    const p = await open(withSettings({ "mcp:gh/*": { allow_reads: true } }, { marks: false }).v2, { choices: CHOICES });
    expect(valueOf(permission(p, "get_repo"))).toBe("ask");
    expect(permission(p, "get_repo").textContent).toBe("ask (default)");
  });

  it("setting a destructive tool to allow takes a second click: nothing is saved until it is confirmed, and Keep asking saves nothing", async () => {
    const s = withSettings({});
    const p = await open(s.v2, { choices: CHOICES });
    await pick(permission(p, "delete_repo"), "allow");
    await p.settle();
    expect(s.writes()).toEqual([]);
    const confirm = p.row("gh").querySelector("[role='alertdialog']")!;
    expect(confirm.textContent).toContain("mcp:gh/delete_repo");
    await p.click(/^Keep asking$/, confirm);
    expect(s.writes()).toEqual([]);
    expect(p.row("gh").querySelector("[role='alertdialog']")).toBeNull();
    await pick(permission(p, "delete_repo"), "allow");
    await p.settle();
    await p.click(/^Allow without asking$/, p.row("gh").querySelector("[role='alertdialog']")!);
    expect(s.writes()).toEqual([{ method: "PUT", path: "/v2/settings/tools", body: { "mcp:gh/delete_repo": { permission: "allow" } } }]);
    // A write is set in one click.
    await pick(permission(p, "open_issue"), "allow");
    await p.settle();
    expect(s.writes()).toHaveLength(2);
  });
});
