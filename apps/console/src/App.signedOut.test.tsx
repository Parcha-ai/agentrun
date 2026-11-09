import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Signed out elsewhere (Sign out in another tab, the session ended): the first read the server answers 401 turns the
// whole console to its sign-in page, as a fresh load does, saying why; signing in again goes back to the same page. A
// wrong password on the sign-in page is its own 401, and says so there.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "sign in first", retryable: false } };
const RUN = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Look at the page", created_at: "2026-11-08T06:00:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null };

function server() {
  const s = { signedIn: true, password: ["the", "right", "password", "0"].join("-"), asked: [] as string[] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    const method = init?.method ?? "GET";
    s.asked.push(`${method} ${u.pathname}`);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: s.signedIn });
    if (u.pathname === "/v2/auth/sign-in" && method === "POST") {
      const { password } = JSON.parse(String(init?.body ?? "{}")) as { password?: string };
      if (password !== s.password) return json(401, { error: { code: "unauthenticated", message: "that is not the password", retryable: false } });
      s.signedIn = true;
      return json(200, { signed_in: true });
    }
    if (!s.signedIn) return json(401, UNAUTHENTICATED);
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: [RUN], next_cursor: null });
    if (u.pathname === "/v2/runs/r1") return json(200, RUN);
    if (u.pathname === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: [], complete: true, truncated: false });
    if (u.pathname === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "working", state: "working", rows: [], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 0 });
    if (u.pathname === "/v2/runs/r1/browser") return json(200, { state: "live", viewer: "/v2/runs/r1/browser/live/v/AbCdEfGhIjKlMnOpQrStUv#t=SECRET-TOKEN-1234567890" });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  return s;
}

async function open(hash: string) {
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  const heading = () => host.querySelector("h1")?.textContent ?? "";
  const password = () => host.querySelector('input[type="password"]') as HTMLInputElement | null;
  return { host, wait, heading, password };
}

describe("App, signed out in another tab", () => {
  it("the run page's next read is refused (401): the sign-in page shows why, and signing in goes back to the run", async () => {
    const s = server();
    const p = await open("#/runs/r1");
    await p.wait(() => p.heading() === "Look at the page", "the run's page");
    s.signedIn = false;
    await p.wait(() => !!p.password(), "the sign-in page, after a read is refused");
    expect(p.host.textContent).toContain("Sign in");
    expect(p.host.textContent).toContain("You were signed out. Sign in to go on.");
    expect(p.host.querySelector("iframe")).toBeNull();
    expect(location.hash).toBe("#/runs/r1");

    const input = p.password()!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, s.password);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...p.host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Continue")!;
    await act(async () => { submit.click(); });
    await p.wait(() => p.heading() === "Look at the page", "back on the run's page after signing in");
  }, 20_000);

  it("a wrong password on that sign-in page is said there, and the page stays", async () => {
    const s = server();
    const p = await open("#/runs/r1");
    await p.wait(() => p.heading() === "Look at the page", "the run's page");
    s.signedIn = false;
    await p.wait(() => !!p.password(), "the sign-in page");
    const input = p.password()!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "not-the-password-at-all");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { [...p.host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Continue")!.click(); });
    await p.wait(() => !!p.host.querySelector('[role="alert"]')?.textContent?.match(/password/i), "the wrong password said");
    expect(p.password()).not.toBeNull();
  }, 20_000);
});
