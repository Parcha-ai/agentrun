import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, sessionRetryMs } from "./App";

// The first read of the session (GET /v2/auth/session) decides the page: setup, sign-in, or the console. One that fails
// (another's page in the server's place, a refusal) is never read as "this server has a password" (#2222): the page says
// it can't read the session, asks again on its own and with Retry now, and shows what the answer says once it comes.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OWNERLESS = { accounts: true, password_set: false, signed_in: false, secrets_writable: false, secrets_reason: "sign_in", setup_code: true };

/** The App over a server whose first `failures` session reads answer `failed()`, then the ownerless server's answer. */
function open(failures: number, failed: () => Response) {
  const reads = { session: 0 };
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path === "/v2/auth/session") return reads.session++ < failures ? failed() : json(200, OWNERLESS);
    if (path === "/v2/health") return json(200, { status: "ok" });
    if (path === "/v2/setup/import") return json(200, { offer: false });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  return { host, reads };
}
const heading = (host: HTMLElement) => host.querySelector("h1")?.textContent ?? null;
async function until(ok: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
}

describe("App, a first session read that fails", () => {
  it("says it can't read the session, never Sign in, and opens setup once a read answers", async () => {
    const page = () => new Response("<h1>Not Found</h1>", { status: 404, headers: { "content-type": "text/html" } });
    const { host, reads } = open(1, page);
    await until(() => heading(host) === "Can't read this server's sign-in", "the page says the session couldn't be read");
    expect(host.textContent).toContain("GET /v2/auth/session answered 404, not as this server answers");
    expect(host.textContent).not.toContain("Sign in");
    await until(() => heading(host) === "Start building", "the read asked again on its own opens setup", 4000);
    expect(reads.session).toBe(2);
  });

  it("a refusal of the server's own is said in its words, and Retry now asks at once", async () => {
    const refusal = () => json(503, { error: { code: "unavailable", message: "the store is not open yet", retryable: true } });
    const { host, reads } = open(1, refusal);
    await until(() => heading(host) === "Can't read this server's sign-in", "the page says the session couldn't be read");
    expect(host.textContent).toContain("GET /v2/auth/session answered 503: the store is not open yet");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry now")!.click(); });
    await until(() => heading(host) === "Start building", "Retry now opens setup", 800);
    expect(reads.session).toBe(2);
  });

  it("an older read that answers after a newer one opened setup, and after the owner set it up, changes nothing", async () => {
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => { release = resolve; });
    let session = 0;
    let set = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") {
        session++;
        if (session === 1) return new Response("<h1>Not Found</h1>", { status: 404, headers: { "content-type": "text/html" } });
        if (session === 2) return held;
        return json(200, set ? { ...OWNERLESS, password_set: true, signed_in: true, secrets_writable: true } : OWNERLESS);
      }
      if (path === "/v2/setup" && init?.method === "POST") { set = true; return json(201, { signed_in: true }); }
      if (path === "/v2/health") return json(200, { status: "ok" });
      if (path === "/v2/setup/import") return json(200, { offer: false });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const retry = () => act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry now")!.click(); });
    await until(() => heading(host) === "Can't read this server's sign-in", "the first read failed");
    await retry();
    await until(() => session === 2, "the second read is asked and held");
    await retry();
    await until(() => heading(host) === "Start building", "the third read opens setup");
    const type = async (el: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    await type(host.querySelector("#setup-code") as HTMLInputElement, "the-printed-code");
    await type(host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    await act(async () => { (host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    await until(() => set && !host.querySelector("form#setup, input[aria-label='New password']"), "the owner is set up and the setup form is gone");
    // The held second read answers now, as the server answered before the owner was set: it decides nothing.
    await act(async () => { release(json(200, OWNERLESS)); await new Promise((r) => setTimeout(r, 50)); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(heading(host), "the console stays, not setup").not.toBe("Start building");
    expect(host.querySelector('input[aria-label="New password"]')).toBeNull();
  });

  it("a gateway's 502 page while the server starts (as Render's edge answers for about a minute) says it is starting, never Sign in, and opens setup once the JSON comes", async () => {
    const gateway = () => new Response("<!DOCTYPE html><html><body>Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
    const { host, reads } = open(3, gateway);
    await until(() => heading(host) === "This server is starting", "the page says the server is starting");
    expect(host.textContent).toContain("Its address answered 502, not the server.");
    expect(host.textContent).toContain("Trying again");
    expect(host.textContent).not.toContain("Sign in");
    await until(() => heading(host) === "Start building", "the reads go on until the server answers, then setup", 12_000);
    expect(reads.session).toBe(4);
  }, 20_000);

  it("keeps asking past two minutes: the waits grow from 1 s to 30 s and never end", () => {
    const waits = Array.from({ length: 12 }, (_, n) => sessionRetryMs(n));
    expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(waits.every((ms) => ms > 0 && ms <= 30_000)).toBe(true);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(120_000);
    expect(sessionRetryMs(1000)).toBe(30_000);
  });
});
