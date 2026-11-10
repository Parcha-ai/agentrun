import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
});
