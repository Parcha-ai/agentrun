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

const NOTE = "The server printed it in its log: find the newest line that starts “Set up this server:”. Open that line's link, or paste what follows code= here.";
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
    expect(p.host.querySelector('[role="alert"]')?.textContent).toBe("That setup code expired (a code lasts 30 minutes) or was voided after too many wrong tries. The server printed a new one: use the newest “Set up this server:” line in its log (on Render, the Logs tab).");
  });

  it("Get a new code asks the server for one (POST /v2/setup/code, no password, no code) and says where the new line is and until when it works", async () => {
    const p = await open(true);
    const asked: string[] = [];
    const before = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (new URL(url, "http://serve.test").pathname !== "/v2/setup/code") return before(url, init);
      asked.push(`${init?.method} ${String(init?.body ?? "")}`);
      return json(200, { printed: true, expires_at: "2026-11-17T12:34:00.000Z" });
    });
    await act(async () => { [...p.host.querySelectorAll("button")].find((b) => b.textContent === "Get a new code")!.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(asked).toEqual(["POST {}"]);
    expect(p.sent).toHaveLength(0);
    expect(p.host.querySelector('[role="status"]')?.textContent).toBe(`The server printed a new code: it is the newest “Set up this server:” line in the server's log (the terminal it runs in, docker logs <container>, or Render's Logs tab). It works once, until ${new Date("2026-11-17T12:34:00.000Z").toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}.`);
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
