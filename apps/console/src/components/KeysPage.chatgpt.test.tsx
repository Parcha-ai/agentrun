import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeysPage } from "./KeysPage";
import { ChatGPTRow, WhatRunsHere } from "./ChatGPTSignIn";
import { createClient } from "@/lib/client";
import type { ChatGPTView, ToolKeys } from "@/lib/v2";
import { servedKey } from "@/test/keys";

// Settings → Model keys: a "ChatGPT plan" row beside the providers' keys, with its state, who and which plan, the plan's
// models and OpenAI's words on usage; Sign out asks first, then says what is left to do in ChatGPT; an expired sign-in
// says so and offers the sign-in again. Under the keys, what runs here: each harness ready, or what it needs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS: ToolKeys = { keys: [servedKey({ id: "openai", kind: "model", label: "OpenAI", fields: [{ name: "OPENAI_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi", "codex"], check: null })], reenter: null };
const SIGNED_IN: ChatGPTView = { state: "signed_in", email: "person@example.com", plan: "pro", models: ["gpt-6.1-sol", "gpt-6-luna"] };
const HARNESSES = [
  { id: "pi", available: true, default_model: "chatgpt/gpt-6.1-sol" },
  { id: "codex", available: true, default_model: "chatgpt/gpt-6.1-sol" },
  { id: "claude-agent", available: false, reason: "Claude Agent needs an Anthropic or OpenRouter key: add one in Settings → Model keys." },
  { id: "opencode", available: false, reason: "OpenCode needs a model key: add one in Settings → Model keys." },
];

type Call = { method: string; path: string };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function server(plan: () => ChatGPTView | Response, write: (call: Call) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url) };
    calls.push(call);
    if (call.method !== "GET") return write(call);
    if (call.path === "/v2/settings/tool-keys") return json(200, KEYS);
    const p = plan();
    return p instanceof Response ? p : json(200, p);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function open(v2: ReturnType<typeof createClient>, onChange?: () => void) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(KeysPage, { v2, onChange, writable: true, harnesses: HARNESSES, plan: createElement(ChatGPTRow, { v2, writable: true, onChange }) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const row = () => host.querySelector<HTMLElement>('[aria-label="ChatGPT plan"]');
  return { host, button, click, row, settle };
}

describe("Settings → Model keys, the ChatGPT plan row", () => {
  it("signed in: the state, who and which plan, the plan's models, and OpenAI's words on usage, among the model keys", async () => {
    const { v2 } = server(() => SIGNED_IN);
    const page = await open(v2);
    const models = page.host.querySelector('section[aria-label="Model keys"]')!;
    expect(models.contains(page.row())).toBe(true);
    const text = page.row()!.textContent!;
    expect(text).toContain("ChatGPT plan");
    expect(text).toContain("signed in");
    expect(text).toContain("Signed in as person@example.com (Pro)");
    expect(text).toContain("gpt-6.1-sol · gpt-6-luna");
    expect(text).toContain("Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.");
    expect(text).toContain("This sign-in is yours: don't let other people run agents on this server with it.");
  });

  it("Sign out asks first, then signs out and says what is left to do in ChatGPT", async () => {
    let plan: ChatGPTView = SIGNED_IN;
    let changed = 0;
    const { v2, calls } = server(() => plan, (call) => { if (call.method === "DELETE") plan = { state: "signed_out" }; return new Response(null, { status: 204 }); });
    const page = await open(v2, () => { changed++; });
    await page.click(/^Sign out$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(page.row()!.textContent).toMatch(/Sign out of ChatGPT on this server\?/);
    await page.click(/^Keep$/);
    expect(page.row()!.textContent).toContain("Signed in as");
    await page.click(/^Sign out$/);
    await page.click(/^Sign out$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/v2/settings/chatgpt" }]);
    expect(page.row()!.querySelector('[role="status"]')?.textContent).toBe("Signed out. If ChatGPT still lists AgentRun under connected apps, disconnect it there.");
    expect(page.row()!.textContent).not.toContain("Signed in as");
    expect(page.button(/^Continue with ChatGPT$/)).toBeTruthy();
    expect(changed).toBe(1);
  });

  it("expired: says so, and offers the sign-in again", async () => {
    const { v2 } = server(() => ({ state: "expired", email: "person@example.com", plan: "plus" }));
    const page = await open(v2);
    expect(page.row()!.textContent).toContain("Your ChatGPT sign-in expired. Sign in again.");
    expect(page.row()!.textContent).toContain("expired");
    expect(page.button(/^Continue with ChatGPT$/)).toBeTruthy();
  });

  it("on a server with no ChatGPT sign-in (no such route), no row", async () => {
    const { v2 } = server(() => json(404, { error: { code: "not_found", message: "no route", retryable: false } }));
    const page = await open(v2);
    expect(page.row()).toBeNull();
    expect(page.host.textContent).toContain("OpenAI");
  });

  it("lists what runs here: each harness ready, or what it needs in the server's words", async () => {
    const { v2 } = server(() => SIGNED_IN);
    const page = await open(v2);
    const list = page.host.querySelector('[aria-label="What runs here"]')!;
    const items = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/Pi.*ready/);
    expect(items[1]).toMatch(/Codex.*ready/);
    expect(items[2]).toMatch(/Claude.*needs a key.*Claude Agent needs an Anthropic or OpenRouter key/);
    expect(items[3]).toMatch(/OpenCode.*needs a key/);
  });
});

describe("WhatRunsHere", () => {
  it("says nothing when the server lists no harness", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(WhatRunsHere, { harnesses: [] })));
    expect(host.textContent).toBe("");
  });
});
