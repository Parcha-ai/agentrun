import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// The console's two sign-outs reach their own routes: Sign out POST /v2/auth/sign-out (this browser), Sign out everywhere
// POST /v2/auth/sign-out-everywhere (every browser, after its confirm). Either ends on the sign-in card.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const STATS = {
  agents: 0, runs: { total: 0, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [], cost: { usd: null, basis: null, unknown_runs: 0 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS,
};

function serve() {
  const posted: string[] = [];
  let signedIn = true;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    if (init?.method === "POST") posted.push(u.pathname);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: signedIn });
    if (u.pathname === "/v2/auth/sign-out" || u.pathname === "/v2/auth/sign-out-everywhere") { signedIn = false; return json(200, { signed_out: true }); }
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: {} });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  return posted;
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
async function mount() {
  location.hash = "#/";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  await wait(() => !!button("Sign out"), "the console, signed in");
  return { host, button };
}

describe("App's sign-outs", () => {
  it("Sign out posts this browser's sign-out, and the sign-in card comes back", async () => {
    const posted = serve();
    const p = await mount();
    await act(async () => { p.button("Sign out")!.click(); });
    await wait(() => !!p.host.querySelector('input[type="password"]'), "the sign-in card");
    expect(posted).toEqual(["/v2/auth/sign-out"]);
  });

  it("Sign out everywhere, confirmed, posts the sign-out of every browser, and the sign-in card comes back", async () => {
    const posted = serve();
    const p = await mount();
    await act(async () => { p.button("Sign out everywhere")!.click(); });
    const dialog = p.host.querySelector('[role="alertdialog"]') as HTMLElement;
    await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out everywhere")!.click(); });
    await wait(() => !!p.host.querySelector('input[type="password"]'), "the sign-in card");
    expect(posted).toEqual(["/v2/auth/sign-out-everywhere"]);
  });
});
