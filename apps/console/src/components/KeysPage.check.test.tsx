import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { createClient } from "@/lib/client";
import { when } from "@/lib/format";
import { type KeyIn, servedKey } from "@/test/keys";
import type { ToolKey, ToolKeys } from "@/lib/v2";

// A saved key's check (GET /v2/settings/tool-keys' `check` on each key): accepted by its provider, with when; not
// checked, with why in the server's words and when it last tried, if it did; nothing when there is no check. A key its
// provider refuses is never saved: the PUT's 422 says so at the field, and the row is not set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake: no key anywhere. */
const FAKE = "not-a-real-key-0123456789";
const AT = "2026-11-03T21:40:00.000Z";
const NOT_ANSWERED = "the provider would not answer the check (403); the key may still work for its tools";

const monid = (check: unknown, set = true): ToolKey =>
  servedKey({ id: "monid", kind: "tool", label: "Monid", fields: [{ name: "MONID_API_KEY", set, source: set ? "console" : null, changed_at: set ? "2026-11-09T09:00:00Z" : null }], unlocks: ["monid.discover"], harnesses: ["pi"], ...(check === undefined ? {} : { check }) } as KeyIn);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function server(key: ToolKey, write?: () => Response) {
  const fetch = (async (_url: string, init?: RequestInit) => ((init?.method ?? "GET") === "GET" ? json(200, { keys: [key], reenter: null } satisfies ToolKeys) : write!())) as typeof globalThis.fetch;
  return createClient({ fetch });
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
async function open(v2: ReturnType<typeof createClient>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(KeysPage, { v2, atRest: "sealed", writable: true })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  return { host, settle, text: () => host.textContent ?? "" };
}

describe("KeysPage, a saved key's check", () => {
  it("accepted: the provider accepted this key, and when", async () => {
    const page = await open(server(monid({ state: "accepted", at: AT })));
    expect(page.text()).toContain(`Monid accepted this key · ${when(AT)}`);
  });

  it("not checked, with when it tried: the reason in the server's words, then when", async () => {
    const page = await open(server(monid({ state: "not_checked", reason: NOT_ANSWERED, at: AT })));
    expect(page.text()).toContain(`Not checked: ${NOT_ANSWERED} · ${when(AT)}`);
  });

  it("not checked, never tried: the reason alone", async () => {
    const page = await open(server(monid({ state: "not_checked", reason: NOT_ANSWERED })));
    expect(page.text()).toContain(`Not checked: ${NOT_ANSWERED}`);
    expect(page.text()).not.toContain(`${NOT_ANSWERED} ·`);
  });

  it("no check, null or absent, says nothing of one", async () => {
    for (const check of [null, undefined]) {
      const page = await open(server(monid(check)));
      expect(page.text()).not.toMatch(/accepted this key|Not checked/);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("a key its provider refuses is not saved: the 422's message is at the field, and the row stays not set", async () => {
    const message = "Monid refused this key (401: Invalid API key format)";
    const page = await open(server(monid(null, false), () => json(422, { error: { code: "input_invalid", message, retryable: false, fields: [{ field: "values.MONID_API_KEY", reason: "refused_by_provider", message }] } })));
    const click = async (label: RegExp) => { await act(async () => { [...page.host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!.click(); }); await page.settle(); };
    await click(/^Paste$/);
    const input = page.host.querySelector('input[name="MONID_API_KEY"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, FAKE); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(/^Save$/);
    expect(input.closest("label")!.querySelector('[role="alert"]')!.textContent).toBe(message);
    expect(page.text()).toContain("Missing");
    expect(page.text()).not.toMatch(/accepted this key/);
  });
});
