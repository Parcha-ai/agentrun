import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { McpServersPage } from "./McpServersPage";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import recorded from "@/fixtures/mcp.requests.json";

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
const saved = (extra: Partial<McpServer> = {}): McpServer => ({ name: "fake", url: VARS.url, auth: { type: "bearer" }, credential: "sealed", tools: TOOLS, protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z", ...extra });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, retryable: false, ...extra } });

/** A server: GET the list answers `lists` in turn (the last again after); every other request is `answer`'s. */
function server(lists: McpServer[][], answer: (call: Sent) => Response | undefined = () => undefined) {
  const calls: Sent[] = [];
  let read = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Sent = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const own = answer(call);
    if (own) return own;
    if (call.method === "GET" && call.path === "/v2/settings/mcp-servers") return json(200, { servers: lists[Math.min(read++, lists.length - 1)] });
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
  act(() => root!.render(createElement(McpServersPage, { v2, atRest: "sealed", open: (u: string) => opened.push(u), ...props })));
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
      [refusal(409, "no_sealing_key", "This server was handed no seal key."), "no seal key"],
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
    expect(p.host.querySelector("form")).toBeNull();
    expect(p.opened).toEqual(["http://127.0.0.1:4300/authorize?state=z"]);
  });

  it("a change keeps the tools' prices: a save sends the saved ones for the tools it still lists", async () => {
    const priced = saved({ prices: { add: 0.05, gone: 1 } });
    const s = server([[priced]], (c) => (c.method === "PUT" ? json(200, priced) : undefined));
    const p = await open(s.v2);
    await p.click(/^Change$/, p.row("fake"));
    await p.click(/^Save$/);
    expect(s.writes()).toEqual([{ method: "PUT", path: "/v2/settings/mcp-servers/fake", body: { url: VARS.url, auth: { type: "bearer" }, prices: { add: 0.05 } } }]);
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

  it("refreshes one and says what was added, removed and changed", async () => {
    const after = saved({ tools: [TOOLS[0], { name: "paid", description: "A call the server bills.", input_schema: {} }] });
    const s = server([[saved()], [after]], (c) => (c.path.endsWith("/refresh") ? json(200, { added: ["paid"], removed: ["slow_write"], changed: ["add"], server: after }) : undefined));
    const p = await open(s.v2);
    await p.click(/^Refresh$/, p.row("fake"));
    expect(s.writes()).toEqual([expected("refresh")]);
    expect(p.row("fake").textContent).toContain("Added paid");
    expect(p.row("fake").textContent).toContain("Removed slow_write");
    expect(p.row("fake").textContent).toContain("Changed add");
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

  it("explains a launcher with no seal key before anything is typed", async () => {
    const p = await open(server([[]]).v2, { atRest: "unavailable" });
    expect(p.text()).toContain("no seal key");
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
    expect(p.text()).toContain("Signing in to docs failed");
    expect(p.text()).toContain("access_denied");
  });
});
