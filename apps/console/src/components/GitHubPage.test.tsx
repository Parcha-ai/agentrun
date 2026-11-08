import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPage } from "./GitHubPage";
import { SETTINGS_PAGES } from "./Settings";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import { githubReturnOf } from "@/lib/github";

// Settings → GitHub over /v2/integrations/github: one GitHub App per server. Not connected (404), Connect starts it
// (POST …/connect answers {action, manifest, state}) and the page posts a form to GitHub's `action` with the manifest
// alone (the action carries ?state=); connected shows the App and where it is installed; Disconnect deletes it here
// and says what to delete on GitHub. The way back from GitHub lands on #/settings/github?github=… (connected, or
// error&reason=<code>): words per code, never the raw value.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let submits = 0;
beforeEach(() => { submits = 0; vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => { submits += 1; }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

const ACTION = "https://github.com/settings/apps/new?state=st_0123456789abcdef";
const MANIFEST = { name: "agentrun-acme", url: "https://agentrun.example.test", hook_attributes: { url: "https://agentrun.example.test/v2/integrations/github/events" }, redirect_url: "https://agentrun.example.test/v2/integrations/github/callback", public: false, default_permissions: { contents: "read", issues: "write" }, default_events: ["issues"] };
const CONNECTED = { app_id: "123456", slug: "agentrun-acme", installations: [{ id: 7, account: "acme" }] };
const NOTE_URL = "https://github.com/settings/apps/agentrun-acme/advanced";

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string, details?: Record<string, unknown>) => json(status, { error: { code, message, retryable: false, ...(details ? { details } : {}) } });
/** A server with GitHub `state.connection` (null: not connected). `connect` and `disconnect` answer those routes. */
function server(state: { connection: typeof CONNECTED | null }, { connect = () => json(200, { action: ACTION, manifest: MANIFEST, state: "st_0123456789abcdef" }), disconnect }: { connect?: () => Response; disconnect?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/v2/integrations/github" && call.method === "GET") return state.connection ? json(200, state.connection) : refusal(404, "github_not_connected", "GitHub is not connected.");
    if (call.path === "/v2/integrations/github/connect" && call.method === "POST") return connect();
    if (call.path === "/v2/integrations/github" && call.method === "DELETE") {
      if (disconnect) return disconnect();
      state.connection = null;
      return json(200, { disconnected: true, triggers_off: 2, note: `Delete the App itself on GitHub: ${NOTE_URL}` });
    }
    return refusal(404, "not_found", "no such route");
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
async function page(v2: ReturnType<typeof createClient>, returned?: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(GitHubPage, { v2, returned: githubReturnOf(returned) })); });
  await settle();
  const button = (name: RegExp) => [...host.querySelectorAll("button")].find((b) => name.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  const click = async (name: RegExp) => { const b = button(name); expect(b, String(name)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  return { host, button, click };
}

describe("Settings → GitHub", () => {
  it("is a Settings page at #/settings/github", () => {
    expect(SETTINGS_PAGES.some((p) => p.id === "github" && p.label === "GitHub")).toBe(true);
    expect(route("#/settings/github")).toMatchObject({ section: "settings", settings: "github" });
  });

  it("not connected (404): a Connect button and an organization field, nothing to disconnect", async () => {
    const { v2 } = server({ connection: null });
    const p = await page(v2);
    expect(p.button(/^Connect GitHub$/)).toBeTruthy();
    expect(p.host.querySelector('input[name="org"]')).not.toBeNull();
    expect(p.button(/Disconnect/)).toBeUndefined();
  });

  it("Connect posts a form to GitHub's action with the manifest alone, once, however often it is clicked", async () => {
    const { v2, calls } = server({ connection: null });
    const p = await page(v2);
    const b = p.button(/^Connect GitHub$/)!;
    await act(async () => { b.click(); b.click(); });
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/integrations/github/connect", body: {} }]);
    const form = p.host.querySelector("form[data-github-manifest]") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe(ACTION);
    const fields = [...form.querySelectorAll("input")];
    expect(fields).toHaveLength(1);
    expect(fields[0].getAttribute("type")).toBe("hidden");
    expect(fields[0].getAttribute("name")).toBe("manifest");
    expect(fields[0].value).toBe(JSON.stringify(MANIFEST));
    expect(submits).toBe(1);
    expect(p.button(/Opening GitHub/)?.disabled).toBe(true);
  });

  it("an organization typed in goes with the start", async () => {
    const { v2, calls } = server({ connection: null });
    const p = await page(v2);
    const org = p.host.querySelector('input[name="org"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { set.call(org, "acme"); org.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.click(/^Connect GitHub$/);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ org: "acme" });
  });

  for (const [what, action] of [["not on github.com", "https://elsewhere.example/settings/apps/new?state=x"], ["not https", "http://github.com/settings/apps/new?state=x"], ["no URL at all", "javascript:alert(1)"]] as const) {
    it(`an action ${what} is never posted to: no form, no submit, a line in its place`, async () => {
      const { v2 } = server({ connection: null }, { connect: () => json(200, { action, manifest: MANIFEST, state: "x" }) });
      const p = await page(v2);
      await p.click(/^Connect GitHub$/);
      expect(p.host.querySelector("form[data-github-manifest]")).toBeNull();
      expect(submits).toBe(0);
      expect(p.host.querySelector('[role="alert"]')?.textContent).toContain("GitHub's address didn't look right, so nothing was sent.");
      expect(p.host.innerHTML).not.toContain(action);
      expect(p.button(/^Connect GitHub$/)?.disabled).toBe(false);
    });
  }

  for (const [code, message] of [["github_no_public_url", "GitHub can't reach this server: set its public URL first"], ["github_no_seal_key", "This server can't keep the App's keys: it was started without a seal key."]] as const) {
    it(`a ${code} refusal says the server's words and gives the button back`, async () => {
      const { v2 } = server({ connection: null }, { connect: () => refusal(409, code, message) });
      const p = await page(v2);
      await p.click(/^Connect GitHub$/);
      expect(p.host.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(submits).toBe(0);
      expect(p.button(/^Connect GitHub$/)?.disabled).toBe(false);
    });
  }

  const WRONG_ORIGIN = "Connect GitHub from this server's public URL: GitHub sends you back there.";
  it("a wrong-origin refusal with no public URL served says the words alone, no link (never one read from the text)", async () => {
    const { v2 } = server({ connection: null }, { connect: () => refusal(409, "github_wrong_origin", `${WRONG_ORIGIN} It is https://agentrun.example.test.`) });
    const p = await page(v2);
    await p.click(/^Connect GitHub$/);
    const alert = p.host.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain(WRONG_ORIGIN);
    expect(alert.querySelector("a")).toBeNull();
  });

  it("a wrong-origin refusal whose public URL is no http(s) URL links nothing", async () => {
    const { v2 } = server({ connection: null }, { connect: () => refusal(409, "github_wrong_origin", WRONG_ORIGIN, { public_url: "javascript:alert(1)" }) });
    const p = await page(v2);
    await p.click(/^Connect GitHub$/);
    expect(p.host.querySelector('[role="alert"] a')).toBeNull();
    expect(p.host.innerHTML).not.toContain("javascript:alert(1)");
  });

  it("already connected (409): the server's words, then the App this server has", async () => {
    const state = { connection: null as typeof CONNECTED | null };
    const { v2 } = server(state, { connect: () => { state.connection = CONNECTED; return refusal(409, "github_already_connected", "This server already has a GitHub App. Disconnect it first."); } });
    const p = await page(v2);
    await p.click(/^Connect GitHub$/);
    expect(p.host.textContent).toContain("This server already has a GitHub App. Disconnect it first.");
    expect(p.host.textContent).toContain("agentrun-acme");
    expect(p.button(/^Disconnect$/)).toBeTruthy();
  });

  it("connected: the App by its slug (linked to GitHub), its id, and the accounts it is installed on", async () => {
    const { v2 } = server({ connection: CONNECTED });
    const p = await page(v2);
    const link = [...p.host.querySelectorAll("a")].find((a) => a.textContent === "agentrun-acme") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/apps/agentrun-acme");
    expect(p.host.textContent).toContain("123456");
    expect([...p.host.querySelectorAll('ul[aria-label="Installations"] li')].map((li) => li.textContent)).toEqual(["acme"]);
    expect(p.button(/^Connect GitHub$/)).toBeUndefined();
  });

  it("connected with no installation yet says so", async () => {
    const { v2 } = server({ connection: { ...CONNECTED, installations: [] } });
    const p = await page(v2);
    expect(p.host.textContent).toContain("Not installed on any account yet.");
  });

  it("Disconnect asks first; its answer's note shows with its URL as a link, and how many triggers went off", async () => {
    const { v2, calls } = server({ connection: CONNECTED });
    const p = await page(v2);
    await p.click(/^Disconnect$/);
    expect(p.host.textContent).toContain("Every GitHub trigger turns off.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await p.click(/^Disconnect GitHub$/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    const note = p.host.querySelector('[aria-label="Disconnected"]') as HTMLElement;
    expect(note.textContent).toContain("Delete the App itself on GitHub");
    expect(note.querySelector("a")?.getAttribute("href")).toBe(NOTE_URL);
    expect(note.textContent).toContain("2 GitHub triggers turned off.");
    expect(p.button(/^Connect GitHub$/)).toBeTruthy();
  });

  it("Disconnect then Cancel sends nothing", async () => {
    const { v2, calls } = server({ connection: CONNECTED });
    const p = await page(v2);
    await p.click(/^Disconnect$/);
    await p.click(/^Cancel$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(p.button(/^Disconnect$/)).toBeTruthy();
  });

  it("a note whose URL is no http(s) URL shows as plain text, never a link", async () => {
    const state = { connection: CONNECTED as typeof CONNECTED | null };
    const { v2 } = server(state, { disconnect: () => { state.connection = null; return json(200, { disconnected: true, triggers_off: 0, note: "Delete the App itself on GitHub: javascript:alert(1)" }); } });
    const p = await page(v2);
    await p.click(/^Disconnect$/);
    await p.click(/^Disconnect GitHub$/);
    const note = p.host.querySelector('[aria-label="Disconnected"]') as HTMLElement;
    expect(note.querySelector("a")).toBeNull();
    expect(note.textContent).toContain("Delete the App itself on GitHub: javascript:alert(1)");
  });

  it("a disconnect answered 404 (another tab disconnected it first) reads the status again: not connected, no error", async () => {
    const state = { connection: CONNECTED as typeof CONNECTED | null };
    // As the server answers it: 404 not_found (server.ts disconnectGitHub).
    const { v2 } = server(state, { disconnect: () => { state.connection = null; return refusal(404, "not_found", "No GitHub App is connected to this server."); } });
    const p = await page(v2);
    await p.click(/^Disconnect$/);
    await p.click(/^Disconnect GitHub$/);
    expect(p.button(/^Connect GitHub$/)).toBeTruthy();
    expect(p.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a disconnect refused as not connected (409) reads the status again: not connected", async () => {
    const state = { connection: CONNECTED as typeof CONNECTED | null };
    const { v2 } = server(state, { disconnect: () => { state.connection = null; return refusal(409, "github_not_connected", "GitHub is not connected."); } });
    const p = await page(v2);
    await p.click(/^Disconnect$/);
    await p.click(/^Disconnect GitHub$/);
    expect(p.button(/^Connect GitHub$/)).toBeTruthy();
    expect(p.button(/^Disconnect$/)).toBeUndefined();
  });
});

describe("the way back from GitHub (#/settings/github?github=…)", () => {
  it("the route reads only github and reason from the address", () => {
    expect(route("#/settings/github?github=connected")).toMatchObject({ settings: "github", github: { ok: true } });
    expect(route("#/settings/github?github=error&reason=state_invalid")).toMatchObject({ settings: "github", github: { ok: false, reason: "state_invalid" } });
    expect(route("#/settings/github?other=1")).toMatchObject({ settings: "github" });
    expect(route("#/settings/github?other=1").github).toBeUndefined();
  });

  for (const [query, words] of [
    ["github=connected", "Connected. The App is installed."],
    ["github=error&reason=state_invalid", "That connection was started elsewhere or has expired. Start again."],
    ["github=error&reason=conversion_failed", "GitHub didn't hand back the App. Try connecting again."],
    ["github=error&reason=installation_unverified", "The App's install couldn't be confirmed. Install it again from GitHub."],
    ["github=error&reason=already_connected", "Another GitHub App was connected while this one was being created. Delete the new App on GitHub."],
    ["github=error&reason=a_future_reason", "The connection didn't finish. Try again."],
    ["github=error", "The connection didn't finish. Try again."],
  ] as const) {
    it(`${query} reads "${words}", never the raw value, reads the status fresh, and cleans the address`, async () => {
      const replace = vi.spyOn(history, "replaceState");
      const { v2, calls } = server({ connection: query === "github=connected" ? CONNECTED : null });
      const p = await page(v2, query);
      expect(p.host.querySelector('[aria-label="From GitHub"]')?.textContent).toContain(words);
      for (const raw of ["state_invalid", "conversion_failed", "installation_unverified", "already_connected", "a_future_reason"]) expect(p.host.textContent).not.toContain(raw);
      expect(calls.some((c) => c.method === "GET" && c.path === "/v2/integrations/github")).toBe(true);
      expect(replace).toHaveBeenCalledWith(null, "", `${location.pathname}${location.search}#/settings/github`);
    });
  }
});
