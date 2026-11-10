import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// A server at a public address (on Render, say) takes a setup code at its first visit, and says so on its session read
// (`setup_code: true`, never the code itself). Opened at its plain address, with no #code= in the link, the setup form
// still asks for the code, says where to find it, and sends what was typed. An open setup (`setup_code: false`) asks for
// none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const NOTE = "Find the setup code in the server's log (on Render, the Logs tab), or open the link the log prints. The server's API token (AGENTRUN_TOKEN) works here too.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function open(setupCode: boolean, link = "/", refusal = "that is not the setup code in the server's log") {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path === "/v2/auth/session") return json(200, { password_set: false, signed_in: false, setup_code: setupCode });
    if (path === "/v2/setup") { sent.push(JSON.parse(String(init?.body ?? "{}"))); return json(403, { error: { code: "forbidden", message: refusal, retryable: false } }); }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  history.replaceState(null, "", link);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const end = Date.now() + 3000;
  while (!host.querySelector("form") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // The Setup code field: its label, its input and its hint, found by the label that names the input.
  const field = () => [...host.querySelectorAll("label")].find((l) => l.textContent === "Setup code" && l.control?.tagName === "INPUT")?.parentElement?.parentElement ?? undefined;
  return { host, sent, field };
}
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("App, a first visit at a public address opened with no setup link", () => {
  it("asks for the setup code, says where to find it, and sends the typed code", async () => {
    const p = await open(true);
    const field = p.field();
    expect(field, "the Setup code field").toBeTruthy();
    expect(field!.textContent).toContain(NOTE);
    await type(field!.querySelector("input")!, "typed-code-1");
    await type(p.host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(p.host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    await act(async () => { (p.host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(p.sent).toHaveLength(1);
    expect((p.sent[0] as { code?: string }).code).toBe("typed-code-1");
  });

  it("asks for no code on an open setup", async () => {
    const p = await open(false);
    expect(p.host.querySelector('input[aria-label="New password"]')).toBeTruthy();
    expect(p.field()).toBeUndefined();
  });

  it("never sends setup without a code while the server takes one: the button waits for the code", async () => {
    const p = await open(true);
    await type(p.host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(p.host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    const button = p.host.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => { (p.host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(p.sent).toHaveLength(0);
  });

  it("takes the code from a setup link opened in the same tab (only the address's fragment changes), and sends it exactly", async () => {
    const p = await open(true);
    await act(async () => { location.hash = "#code=AbC-123_xyz&tab=runs"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((p.field()!.querySelector("input") as HTMLInputElement).value).toBe("AbC-123_xyz");
    expect(location.hash).not.toContain("AbC-123_xyz");
    await type(p.host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(p.host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    await act(async () => { (p.host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((p.sent[0] as { code?: string }).code).toBe("AbC-123_xyz");
  });

  it("says a new code is in the log when the server voided or expired the one tried", async () => {
    const p = await open(true, "/", "that setup code expired, or five wrong tries voided it: a new one is in the server's log");
    await type(p.field()!.querySelector("input")!, "old-code");
    await type(p.host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(p.host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    await act(async () => { (p.host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(p.host.querySelector('[role="alert"]')?.textContent).toBe("That setup code expired or was voided after too many wrong tries: a new one is in the server's log (on Render, the Logs tab).");
  });

  it("takes a setup link opened while the session read is still on its way", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") { await held; return json(200, { password_set: false, signed_in: false, setup_code: true }); }
      if (path === "/v2/setup") { sent.push(JSON.parse(String(init?.body ?? "{}"))); return json(403, { error: { code: "forbidden", message: "x", retryable: false } }); }
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    history.replaceState(null, "", "/");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    // The link lands before the server has answered who this is.
    // Its one hashchange fires now (set without jsdom's own later event), while auth is still unknown.
    await act(async () => { history.replaceState(null, "", "/#code=Early-Code_123"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await act(async () => { release(); });
    const end = Date.now() + 3000;
    while (!host.querySelector("form") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const label = [...host.querySelectorAll("label")].find((l) => l.textContent === "Setup code");
    expect((label?.control as HTMLInputElement | null)?.value).toBe("Early-Code_123");
    expect(location.hash).not.toContain("Early-Code_123");
  });
});
