import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessKeysPage } from "./HarnessKeysPage";
import { createClient } from "@/lib/client";
import { SIGN_IN_TO_CHANGE } from "@/lib/secrets";
import type { HarnessKeys } from "@/lib/v2";

// Settings → Harness keys: each plan-billed recipe's keys by name, never a value; the owner's password session pastes one
// into a password input that is never filled from the server or kept in the page's state, and PUTs it for that harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const unsaved: HarnessKeys = { harnesses: [{ id: "model-agent", label: "Model Agent", ready: false, keys: [{ name: "harness:model-agent:MODEL_AGENT_API_KEY", set: false, source: null, changed_at: null }] }] };
const saved: HarnessKeys = { harnesses: [{ id: "model-agent", label: "Model Agent", ready: true, keys: [{ name: "harness:model-agent:MODEL_AGENT_API_KEY", set: true, source: "console", changed_at: "2026-11-22T09:00:00Z" }] }] };

async function mount(writable: boolean, answers: { list: () => HarnessKeys; put?: (status: number) => Response }, onChange?: () => void) {
  const asked: { method: string; path: string; body?: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    asked.push({ method: init?.method ?? "GET", path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (path === "/v2/settings/harness-keys") return json(200, answers.list());
    if (path.startsWith("/v2/settings/harness-keys/")) return init?.method === "PUT" && answers.put ? answers.put(204) : new Response(null, { status: 204 });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(HarnessKeysPage, { v2: createClient({ fetch }), writable, ...(onChange ? { onChange } : {}) })));
  await settle();
  return { host, asked };
}
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("HarnessKeysPage", () => {
  it("names each key, never a value, and the owner's session pastes one for that harness alone; the input is cleared after the save", async () => {
    let list = unsaved;
    const { host, asked } = await mount(true, { list: () => list });
    const section = host.querySelector('[data-harness="model-agent"]')!;
    expect(section.textContent).toContain("MODEL_AGENT_API_KEY");
    expect(section.textContent).toContain("not saved");
    await act(async () => { button(host, "Paste")!.click(); });
    await settle();
    const input = host.querySelector<HTMLInputElement>('form input[name="value"]')!;
    expect(input.type).toBe("password");
    const value = "typed-harness-key-123";
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.innerHTML).not.toContain(value);
    list = saved;
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    const put = asked.find((a) => a.method === "PUT");
    expect(put).toEqual({ method: "PUT", path: "/v2/settings/harness-keys/model-agent/MODEL_AGENT_API_KEY", body: JSON.stringify({ value }) });
    expect(host.querySelector("form")).toBeNull();
    expect(host.innerHTML).not.toContain(value);
    expect(host.querySelector('[data-harness="model-agent"]')!.textContent).toContain("ready");
    expect(button(host, "Remove")).toBeTruthy();
  });

  it("removes a saved key on a confirm, by its harness and name", async () => {
    const { host, asked } = await mount(true, { list: () => saved });
    await act(async () => { button(host, "Remove")!.click(); });
    expect(host.textContent).toContain("Remove MODEL_AGENT_API_KEY saved for Model Agent?");
    await act(async () => { [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Remove").at(-1)!.click(); });
    await settle();
    expect(asked.some((a) => a.method === "DELETE" && a.path === "/v2/settings/harness-keys/model-agent/MODEL_AGENT_API_KEY")).toBe(true);
  });

  it("says each save and remove to the console (onChange), so the harnesses it offers are read again with no reload", async () => {
    let changes = 0;
    let list = unsaved;
    const { host } = await mount(true, { list: () => list }, () => { changes += 1; });
    await act(async () => { button(host, "Paste")!.click(); });
    const input = host.querySelector<HTMLInputElement>('form input[name="value"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "typed-harness-key-123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    list = saved;
    await act(async () => { button(host, "Save")!.click(); });
    await settle();
    expect(changes).toBe(1);
    await act(async () => { button(host, "Remove")!.click(); });
    await act(async () => { [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Remove").at(-1)!.click(); });
    await settle();
    expect(changes).toBe(2);
  });

  it("off the owner's password session: each key's state, the one sentence on how to change them, and nothing to paste or remove", async () => {
    const { host } = await mount(false, { list: () => saved });
    expect(host.textContent).toContain(SIGN_IN_TO_CHANGE);
    expect(button(host, "Paste")).toBeUndefined();
    expect(button(host, "Replace")).toBeUndefined();
    expect(button(host, "Remove")).toBeUndefined();
    expect(host.querySelector("input")).toBeNull();
  });

  it("a server with no plan-billed recipe says there is nothing to save", async () => {
    const { host } = await mount(true, { list: () => ({ harnesses: [] }) });
    expect(host.textContent).toContain("no harness recipe billed to its vendor's plan");
  });
});
