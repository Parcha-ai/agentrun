import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeysPage, envLines } from "./ApiKeysPage";
import { createClient } from "@/lib/client";
import type { SecretsWhyNot } from "@/lib/secrets";
import type { ApiKey } from "@/lib/v2";

// Settings → AgentRun API keys over /v2/settings/api-keys: the keys made, a form that makes one and shows it once, and
// Revoke for each, asked first. Making and revoking are the owner's session's alone.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake, not a key of any server; made from parts, so the source holds no key-shaped literal. */
const MADE = `${["ar", "key", ""].join("_")}${"bm90LWEtcmVhbC1rZXkt".repeat(3).slice(0, 43)}`;
const ORIGIN = "https://agentrun.example.test";
const key = (extra: Partial<ApiKey> = {}): ApiKey => {
  const id = extra.id ?? "01a20b30-b53a-7000-9abd-64340ac132cb";
  return { id, name: "billing app", created_at: "2026-11-03T12:00:00.000Z", last_used_at: null, secret: { name: `api-key:${id}`, set: true, source: "console", changed_at: "2026-11-03T12:00:00.000Z" }, ...extra };
};

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server with `state.keys`: GET lists them, POST makes one (201, with its value), DELETE revokes one. */
function server(state: { keys: ApiKey[]; limit?: number; refused?: string; unreadable?: string[]; readsFail?: boolean; createFails?: boolean; revokeFails?: boolean; goneElsewhere?: boolean }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(call.path, "http://serve.test").pathname;
    if (state.readsFail && call.method === "GET") return json(500, { error: { code: "internal", message: "the read failed", retryable: true } });
    if (path === "/v2/settings/api-keys" && call.method === "GET") return json(200, { keys: state.keys, limit: state.limit ?? 50, ...(state.refused ? { refused: state.refused } : {}), ...(state.unreadable?.length ? { unreadable: state.unreadable } : {}) });
    if (path === "/v2/settings/api-keys" && call.method === "POST") {
      if (state.createFails) return json(409, { error: { code: "api_keys_full", message: "This server keeps at most 50 API keys.", retryable: false } });
      const made = key({ id: "01a20b30-b53a-7000-9abd-000000000002", name: (call.body as { name: string }).name });
      state.keys = [...state.keys, made];
      return json(201, { ...made, api_key: MADE });
    }
    const one = /^\/v2\/settings\/api-keys\/([^/]+)$/.exec(path);
    if (one && call.method === "DELETE") {
      if (state.revokeFails) return json(500, { error: { code: "internal", message: "the store is away", retryable: true } });
      const id = decodeURIComponent(one[1]!);
      // Revoked from another window since this page read the list: the server has no such key.
      if (state.goneElsewhere) { state.keys = state.keys.filter((k) => k.id !== id); return json(404, { error: { code: "not_found", message: "No API key has that id: it was revoked, or never created.", retryable: false } }); }
      state.keys = state.keys.filter((k) => k.id !== id);
      state.unreadable = state.unreadable?.filter((u) => u !== id);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, state };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function open(v2: ReturnType<typeof createClient>, { writable = true, whyNot }: { writable?: boolean; whyNot?: SecretsWhyNot } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ApiKeysPage, { v2, writable, whyNot, origin: ORIGIN })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp, within: Element = host) => [...within.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (label: RegExp, within: Element = host) => { await act(async () => { button(label, within)!.click(); }); await settle(); };
  const input = () => host.querySelector('input[name="name"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const rows = () => [...host.querySelectorAll('[aria-label="Keys"] li')];
  const shown = () => host.querySelector('[aria-label="New API key"]');
  return { host, button, click, input, type, rows, shown, settle };
}

describe("Settings → AgentRun API keys", () => {
  it("lists each key by its name, when it was made and when it was last used, and never a key", async () => {
    const { v2 } = server({ keys: [key(), key({ id: "01a20b30-b53a-7000-9abd-000000000003", name: "ci", last_used_at: "2026-11-04T09:30:00.000Z" })] });
    const page = await open(v2);
    expect(page.host.querySelector("h1")?.textContent).toBe("AgentRun API keys");
    const [first, second] = page.rows();
    expect(first!.textContent).toContain("billing app");
    expect(first!.textContent).toMatch(/Created Nov 3/);
    expect(first!.textContent).toContain("Never used");
    expect(second!.textContent).toContain("ci");
    expect(second!.textContent).toMatch(/Last used Nov 4/);
    expect(page.host.textContent).toContain("Keys · 2 of 50");
    expect(page.host.textContent).not.toContain("ar_key_");
    expect(page.shown()).toBeNull();
  });

  it("with no key yet, says so", async () => {
    const page = await open(server({ keys: [] }).v2);
    expect(page.host.textContent).toContain("No key has been created yet.");
    expect(page.rows()).toHaveLength(0);
  });

  it("makes a key by its name and shows it once, with the two lines an app's environment takes; Done forgets it", async () => {
    const { v2, calls } = server({ keys: [] });
    const page = await open(v2);
    expect(page.button(/^Create key$/)!.disabled).toBe(true);
    await page.type("  billing app ");
    await page.click(/^Create key$/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/settings/api-keys", body: { name: "billing app" } }]);
    const shown = page.shown()!;
    expect(shown.querySelector("code")?.textContent).toBe(MADE);
    expect(shown.textContent).toContain("shown this once");
    expect(shown.querySelector('[aria-label="Environment variables"]')?.textContent).toBe(envLines(ORIGIN, MADE));
    expect(envLines(ORIGIN, MADE)).toBe(`AGENTRUN_BASE_URL=${ORIGIN}\nAGENTRUN_API_KEY=${MADE}`);
    expect(document.activeElement).toBe(shown);
    expect(page.input().value).toBe("");
    expect(page.rows().map((row) => row.textContent)).toEqual([expect.stringContaining("billing app")]);
    expect(page.rows()[0]!.textContent).not.toContain(MADE);

    await page.click(/^Done$/);
    expect(page.shown()).toBeNull();
    expect(page.host.textContent).not.toContain(MADE);
  });

  it("while a new key is on the page the form makes no other: the key is shown only there, so Done comes first", async () => {
    const { v2, calls } = server({ keys: [] });
    const page = await open(v2);
    await page.type("first");
    await page.click(/^Create key$/);
    expect(page.shown()).not.toBeNull();
    expect(page.host.querySelector('form[aria-label="Create an API key"]')?.textContent).toContain("Copy the key above and press Done to create another.");
    expect(page.input().disabled).toBe(true);
    expect(page.button(/^Create key$/)!.disabled).toBe(true);
    await page.click(/^Done$/);
    expect(page.input().disabled).toBe(false);
    expect(page.host.textContent).not.toContain("press Done to create another");
    await page.type("second");
    await page.click(/^Create key$/);
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { name: string }).name)).toEqual(["first", "second"]);
  });

  it("copies the key with one press", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const page = await open(server({ keys: [] }).v2);
    await page.type("ci");
    await page.click(/^Create key$/);
    await page.click(/Copy key/, page.shown()!);
    expect(writeText).toHaveBeenCalledWith(MADE);
    await page.click(/Copy both/, page.shown()!);
    expect(writeText).toHaveBeenLastCalledWith(envLines(ORIGIN, MADE));
  });

  it("revokes a key only after it is asked: Cancel keeps it and gives the focus back, Revoke the key removes it", async () => {
    const { v2, calls } = server({ keys: [key(), key({ id: "01a20b30-b53a-7000-9abd-000000000003", name: "ci" })] });
    const page = await open(v2);
    await page.click(/^Revoke ci$/);
    const ask = page.host.querySelector('[role="alertdialog"]')!;
    expect(ask.getAttribute("aria-label")).toBe("Revoke ci?");
    expect(ask.textContent).toContain("refused at once");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await page.click(/^Cancel$/, ask);
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
    expect(page.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(page.button(/^Revoke ci$/));
    expect(page.rows()).toHaveLength(2);

    await page.click(/^Revoke ci$/);
    await page.click(/^Revoke the key$/);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v2/settings/api-keys/01a20b30-b53a-7000-9abd-000000000003"]);
    expect(page.rows().map((row) => row.textContent)).toEqual([expect.stringContaining("billing app")]);
    // The revoked row and its buttons are gone: the focus is on the list, which says what it is, not lost to the page.
    const list = page.host.querySelector('[aria-label="Keys"] [tabindex="-1"]')!;
    expect(document.activeElement).toBe(list);
    expect([list.getAttribute("role"), list.getAttribute("aria-label")]).toEqual(["group", "API keys"]);
  });

  it("a revocation the server refuses keeps the row, says why, and gives the focus back to that row's button", async () => {
    const { v2 } = server({ keys: [key({ name: "ci" })], revokeFails: true });
    const page = await open(v2);
    await page.click(/^Revoke ci$/);
    await page.click(/^Revoke the key$/);
    expect(page.host.textContent).toContain("The key was not revoked");
    expect(page.rows()).toHaveLength(1);
    expect(document.activeElement).toBe(page.button(/^Revoke ci$/));
  });

  it("a key already revoked from another window is revoked: no error, its row goes, and the focus is on the list", async () => {
    const { v2 } = server({ keys: [key(), key({ id: "01a20b30-b53a-7000-9abd-000000000003", name: "ci" })], goneElsewhere: true });
    const page = await open(v2);
    await page.click(/^Revoke ci$/);
    await page.click(/^Revoke the key$/);
    expect(page.host.textContent).not.toContain("The key was not revoked");
    expect(page.rows().map((row) => row.textContent)).toEqual([expect.stringContaining("billing app")]);
    expect(document.activeElement).toBe(page.host.querySelector('[aria-label="Keys"] [tabindex="-1"]'));
  });

  it("a row that is no key's is listed by its id, counts toward the limit, and Remove takes it away", async () => {
    const { v2, calls } = server({ keys: [key()], unreadable: ["not-a-key"], limit: 2 });
    const page = await open(v2);
    expect(page.host.textContent).toContain("Keys · 2 of 2");
    expect(page.host.textContent).toContain("This server keeps at most 2 keys.");
    const [, damaged] = page.rows();
    expect(damaged!.textContent).toContain("not-a-key");
    expect(damaged!.textContent).toContain("It opens nothing and counts toward the limit.");
    await page.click(/^Remove the unreadable row not-a-key$/);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v2/settings/api-keys/not-a-key"]);
    expect(page.rows()).toHaveLength(1);
    expect(page.host.textContent).toContain("Keys · 1 of 2");
    expect(page.input().disabled).toBe(false);
  });

  it("revoking the key just made takes its panel away: it would offer a key that opens nothing", async () => {
    const page = await open(server({ keys: [] }).v2);
    await page.type("short lived");
    await page.click(/^Create key$/);
    expect(page.shown()).not.toBeNull();
    await page.click(/^Revoke short lived$/);
    await page.click(/^Revoke the key$/);
    expect(page.shown()).toBeNull();
    expect(page.host.textContent).not.toContain(MADE);
  });

  it("a session that may not write secrets reads the list, and is told why it makes and revokes none", async () => {
    const { v2, calls } = server({ keys: [key()] });
    const page = await open(v2, { writable: false, whyNot: "sign_in" });
    expect(page.rows()).toHaveLength(1);
    expect(page.host.textContent).toContain("Sign in with your password to change secrets.");
    expect(page.input().disabled).toBe(true);
    expect(page.button(/^Create key$/)!.disabled).toBe(true);
    expect(page.button(/^Revoke /)).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("at the server's limit, says so and makes none", async () => {
    const page = await open(server({ keys: [key()], limit: 1 }).v2);
    expect(page.host.textContent).toContain("This server keeps at most 1 key. Revoke one you no longer use to create another.");
    expect(page.input().disabled).toBe(true);
    expect(page.button(/^Create key$/)!.disabled).toBe(true);
  });

  it("on a server that is one person's, says why in the server's words and makes none; a key there can still be revoked", async () => {
    const why = "Claude Code's login on this machine is on, and a Claude plan is one person's.";
    const { v2, calls } = server({ keys: [key()], refused: why });
    const page = await open(v2);
    expect(page.host.querySelector('form[aria-label="Create an API key"]')?.textContent).toContain(why);
    expect(page.input().disabled).toBe(true);
    expect(page.button(/^Create key$/)!.disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(page.button(/^Revoke billing app$/)).toBeDefined();
  });

  it("says a refused create in the server's words, and shows no key", async () => {
    const page = await open(server({ keys: [], createFails: true }).v2);
    await page.type("one too many");
    await page.click(/^Create key$/);
    expect(page.host.textContent).toContain("The key was not created");
    expect(page.host.textContent).toContain("This server keeps at most 50 API keys.");
    expect(page.shown()).toBeNull();
    expect(page.input().value).toBe("one too many");
  });

  it("a list that could not be read is said, with Try again", async () => {
    const { v2, state } = server({ keys: [key()], readsFail: true });
    const page = await open(v2);
    expect(page.host.textContent).toContain("The API keys could not be read: internal: the read failed");
    state.readsFail = false;
    await page.click(/^Try again$/);
    expect(page.rows()).toHaveLength(1);
  });
});
