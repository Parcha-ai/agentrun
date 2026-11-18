import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { GATEWAY_FROM_ENV, GATEWAY_ROW, ModelGatewayRow } from "./ModelGatewayRow";
import { createClient } from "@/lib/client";
import { WHY_NOT_WORDS } from "@/lib/secrets";
import type { ModelGateway, ToolKeys } from "@/lib/v2";
import { servedKey } from "@/test/keys";
import { pick, picker, valueOf } from "@/test/picker";

// Settings → Model keys' "Use a model gateway" row (model-gateway.ts on the server): off, a button opens its form; Test
// asks the gateway's models through the server, with the address and key typed, and the tiers are picked from them; a
// save sends the key once and never shows it again; in use, Change and Stop using it; set where AgentRun starts, the
// gateway is shown read-only with what to change there.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = `not-a-secret-${"console-gateway"}-5e2a`;
const KEYS: ToolKeys = { keys: [servedKey({ id: "openrouter", kind: "model", label: "OpenRouter", fields: [{ name: "OPENROUTER_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi"], check: null })], reenter: null };
const UNSET = { name: "model:gateway", set: false, source: null, changed_at: null };
const OFF: ModelGateway = { source: null, base_url: null, ids: "as_named", models: { default: null, fast: null, strong: null }, set_at_start: [], secret: UNSET, problem: null };
const IN_USE: ModelGateway = { ...OFF, source: "console", base_url: "https://gateway.example/v1", models: { default: "gpt-6.1-sol", fast: null, strong: null }, secret: { name: "model:gateway", set: true, source: "console", changed_at: "2026-11-18T10:00:00.000Z" } };
const FROM_ENV: ModelGateway = { ...OFF, source: "env", base_url: "https://env-gateway.example", models: { default: "team/model", fast: null, strong: null }, set_at_start: ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY"], secret: { name: "model:gateway", set: true, source: "env", changed_at: null } };

type Call = { method: string; path: string; body?: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function server(read: () => ModelGateway, write: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    if (call.path === "/v2/settings/tool-keys") return json(200, KEYS);
    const answer = call.method === "GET" ? read() : write(call);
    return answer instanceof Response ? answer : json(200, answer);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, { writable = true, onChange }: { writable?: boolean; onChange?: () => void } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(KeysPage, { v2, writable, plan: createElement(ModelGatewayRow, { v2, writable, onChange }) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const row = () => host.querySelector<HTMLElement>(`[aria-label="${GATEWAY_ROW}"]`)!;
  const type = async (name: string, value: string) => {
    const el = row().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    // React tracks a controlled input's value: set it through the native setter so its onChange sees the change.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const submit = async () => { await act(async () => { row().querySelector("form")!.requestSubmit(); }); await settle(); };
  return { host, button, click, row, type, submit, settle };
}

describe("Settings → Model keys, Use a model gateway", () => {
  it("off: the form tests the gateway with the address and key typed, picks the default from what it lists, and saves the key once, never shown again", async () => {
    let view = OFF;
    const changed: number[] = [];
    const { v2, calls } = server(() => view, (call) => {
      if (call.path.endsWith("/test")) return { ok: true, models: ["gpt-6.1-sol", "claude-sonnet-5-5"] };
      const body = call.body as { base_url: string; models: { default: string } };
      return (view = { ...IN_USE, base_url: body.base_url, models: { default: body.models.default, fast: null, strong: null } });
    });
    const page = await open(v2, { onChange: () => changed.push(1) });
    expect(page.host.querySelector('section[aria-label="Model keys"]')!.contains(page.row())).toBe(true);
    expect(page.row().textContent).toContain("off");
    await page.click(new RegExp(`^${GATEWAY_ROW}$`));
    await page.type("base_url", "https://gateway.example/v1");
    // The key's field is uncontrolled: a person's typing, never React's state.
    page.row().querySelector<HTMLInputElement>('input[name="api_key"]')!.value = KEY;
    await page.click(/^Test$/);
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", path: "/v2/settings/model-gateway/test", body: { base_url: "https://gateway.example/v1", api_key: KEY } });
    expect(page.row().textContent).toContain("The gateway lists 2 models");
    const field = picker(page.row(), "Default model")!;
    expect(valueOf(field)).toBe("gpt-6.1-sol");
    await pick(field, "claude-sonnet-5-5");
    await page.submit();
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: "/v2/settings/model-gateway", body: { base_url: "https://gateway.example/v1", api_key: KEY, ids: "as_named", models: { default: "claude-sonnet-5-5", fast: null, strong: null } } });
    expect(changed).toEqual([1]);
    // In use: what it is, and that a key is saved, never the key.
    expect(page.row().textContent).toContain("in use");
    expect(page.row().textContent).toContain("claude-sonnet-5-5");
    expect(page.row().querySelector("form")).toBeNull();
    expect(page.host.innerHTML).not.toContain(KEY);
  });

  it("in use, Use no key: Test asks with no key (api_key null), never the saved one, as Save then sends", async () => {
    const { v2, calls } = server(() => IN_USE, (call) => (call.path.endsWith("/test") ? { ok: true, models: ["gpt-6.1-sol"] } : IN_USE));
    const page = await open(v2);
    await page.click(/^Change$/);
    const box = page.row().querySelector<HTMLInputElement>('input[name="no_key"]')!;
    await act(async () => { box.click(); });
    await page.click(/^Test$/);
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", path: "/v2/settings/model-gateway/test", body: { base_url: "https://gateway.example/v1", api_key: null } });
    await page.submit();
    expect((calls.find((c) => c.method === "PUT")?.body as { api_key?: unknown }).api_key).toBeNull();
  });

  it("a refused address is said at its field, in the server's words", async () => {
    const words = "base_url must be an https URL of a gateway, with a path if it serves the API under one; it is http, not https.";
    const { v2 } = server(() => OFF, () => json(422, { error: { code: "input_invalid", message: words, retryable: false, fields: [{ field: "base_url", reason: "invalid", message: words }] } }));
    const page = await open(v2);
    await page.click(new RegExp(`^${GATEWAY_ROW}$`));
    await page.type("base_url", "http://gateway.example");
    await page.type("model_default", "gpt-6.1-sol");
    await page.submit();
    expect(page.row().querySelector('[role="alert"]')!.textContent).toBe(words);
    expect(page.row().querySelector("form")).not.toBeNull();
  });

  it("in use: Stop using it asks first, then removes it", async () => {
    let view = IN_USE;
    const changed: number[] = [];
    const { v2, calls } = server(() => view, () => (view = OFF));
    const page = await open(v2, { onChange: () => changed.push(1) });
    expect(page.row().textContent).toContain("https://gateway.example/v1");
    await page.click(/^Stop using it$/);
    expect(page.row().querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await act(async () => { page.row().querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-of-type')!.click(); });
    await page.settle();
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/v2/settings/model-gateway");
    expect(changed).toEqual([1]);
    expect(page.row().textContent).toContain("off");
  });

  it("set where AgentRun starts: shown read-only, with what to change there, and no form", async () => {
    const { v2 } = server(() => FROM_ENV, () => { throw new Error("no write"); });
    const page = await open(v2);
    expect(page.row().textContent).toContain(GATEWAY_FROM_ENV);
    expect(page.row().textContent).toContain("https://env-gateway.example");
    expect(page.row().textContent).toContain("set where AgentRun starts");
    expect(page.button(/^Change$/)).toBeUndefined();
    expect(page.button(new RegExp(`^${GATEWAY_ROW}$`))).toBeUndefined();
  });

  it("without the owner's session: why, and nothing to press", async () => {
    const { v2 } = server(() => OFF, () => { throw new Error("no write"); });
    const page = await open(v2, { writable: false });
    expect(page.row().textContent).toContain(WHY_NOT_WORDS.sign_in);
    expect(page.button(new RegExp(`^${GATEWAY_ROW}$`))).toBeUndefined();
  });
});
