import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGPTSignIn } from "./ChatGPTSignIn";
import { createClient } from "@/lib/client";
import { MANAGE_USAGE_URL } from "@/lib/chatgpt";
import type { ChatGPTView } from "@/lib/v2";

// Sign in with ChatGPT over /v2/settings/chatgpt: the button starts the sign-in and opens OpenAI's page in a new tab, the
// paste step finishes it with the address that tab ended on, a refusal is said in the server's words, and on the
// machine the server runs on the sign-in finishes by itself, which the page sees by reading the state every 2 s while it
// waits and the page is in view. Signed in, it says who and on which plan, and OpenAI's words on usage.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 15_000 });

const AUTHORIZE = "https://auth.openai.com/api/accounts/authorize?client_id=example&state=fake-state";
const PASTED = "http://127.0.0.1:1455/auth/callback?code=fake-code&state=fake-state";
const SIGNED_IN: ChatGPTView = { state: "signed_in", email: "person@example.com", plan: "plus", models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"] };

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server whose GET /settings/chatgpt answers `state()` and whose writes `write` answers. */
function server(state: () => ChatGPTView, write: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return call.method === "GET" ? json(200, state()) : write(call);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
let tab: { location: { href: string }; opener: unknown; close: () => void };
beforeEach(() => {
  tab = { location: { href: "" }, opener: "the console", close: vi.fn() };
  vi.stubGlobal("open", vi.fn(() => tab));
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function mount(v2: ReturnType<typeof createClient>, view: ChatGPTView, onView: (v: ChatGPTView) => void = () => {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ChatGPTSignIn, { v2, view, onView, writable: true })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const paste = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('input[name="redirect_url"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const wait = async (ok: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(ok(), what).toBe(true);
  };
  return { host, button, click, paste, settle, wait };
}

describe("ChatGPTSignIn", () => {
  it("start, then paste the address the tab ended on: signed in, with who, the plan, and OpenAI's words on usage", async () => {
    let state: ChatGPTView = { state: "signed_out" };
    const { v2, calls } = server(() => state, (call) => {
      if (call.path === "/v2/settings/chatgpt/sign-in") { state = { state: "pending", authorize_url: AUTHORIZE }; return json(200, { authorize_url: AUTHORIZE, expires_at: new Date(Date.now() + 600_000).toISOString() }); }
      state = SIGNED_IN;
      return json(200, SIGNED_IN);
    });
    const seen: ChatGPTView[] = [];
    const page = await mount(v2, { state: "signed_out" }, (v) => seen.push(v));
    expect(page.button(/^Continue with ChatGPT$/)).toBeTruthy();
    await page.click(/^Continue with ChatGPT$/);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/v2/settings/chatgpt/sign-in"]);
    // OpenAI's page in a new tab, which can't reach back to the console.
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(AUTHORIZE);
    expect(tab.opener).toBeNull();
    expect(page.host.textContent).toContain("Signing in on this computer finishes by itself. On a server elsewhere, the tab ends on a page that won't load: copy that tab's whole address and paste it here.");
    expect(page.button(/^Finish sign-in$/)?.disabled).toBe(true);
    await page.paste(PASTED);
    await page.click(/^Finish sign-in$/);
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({ method: "POST", path: "/v2/settings/chatgpt/sign-in/finish", body: { redirect_url: PASTED } });
    expect(page.host.textContent).toContain("Signed in as person@example.com (Plus)");
    expect(page.host.textContent).toContain("Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.");
    expect(page.host.textContent).toContain("This sign-in is yours: don't let other people run agents on this server with it.");
    const manage = [...page.host.querySelectorAll("a")].find((a) => a.textContent === "Manage usage")!;
    expect(manage.getAttribute("href")).toBe(MANAGE_USAGE_URL);
    expect(MANAGE_USAGE_URL).toBe("https://chatgpt.com/#settings");
    expect(manage.getAttribute("target")).toBe("_blank");
    expect(manage.getAttribute("rel")).toContain("noopener");
    expect(seen.at(-1)).toEqual(SIGNED_IN);
    // The pasted address is not left in the page.
    expect(page.host.innerHTML).not.toContain("fake-code");
  });

  it("a refused address is said in the server's words, and the sign-in keeps waiting for another", async () => {
    const words = "That address is from another sign-in: paste the one from the sign-in you started last, or start again.";
    const { v2 } = server(() => ({ state: "pending", authorize_url: AUTHORIZE }), () => json(400, { error: { code: "bad_request", message: words, retryable: false } }));
    const page = await mount(v2, { state: "pending", authorize_url: AUTHORIZE });
    await page.paste(PASTED);
    await page.click(/^Finish sign-in$/);
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain(words);
    expect(page.button(/^Finish sign-in$/)).toBeTruthy();
    expect(page.host.textContent).not.toContain("Signed in as");
  });

  it("a start the server refuses (port 1455 busy) is said in its words, and no tab is left open", async () => {
    const words = "Another sign-in holds this machine's port 1455: finish or cancel it, then start again.";
    const { v2 } = server(() => ({ state: "signed_out" }), () => json(400, { error: { code: "bad_request", message: words, retryable: false } }));
    const page = await mount(v2, { state: "signed_out" });
    await page.click(/^Continue with ChatGPT$/);
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain(words);
    expect(tab.close).toHaveBeenCalled();
  });

  it("on the machine the server runs on, the sign-in finishes by itself: the waiting page reads the state and says signed in", async () => {
    let state: ChatGPTView = { state: "pending", authorize_url: AUTHORIZE };
    const { v2, calls } = server(() => state, () => json(500, {}));
    const seen: ChatGPTView[] = [];
    const page = await mount(v2, state, (v) => seen.push(v));
    expect(page.host.textContent).toContain("paste it here");
    // The browser's return reached the server's loopback: no paste.
    state = SIGNED_IN;
    await page.wait(() => !!page.host.textContent?.includes("Signed in as person@example.com (Plus)"), "the poll sees the sign-in finish");
    expect(calls.every((c) => c.method === "GET" && c.path === "/v2/settings/chatgpt")).toBe(true);
    expect(seen.at(-1)).toEqual(SIGNED_IN);
    // Signed in, it stops reading.
    const reads = calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    expect(calls.length).toBe(reads);
  });

  it("a browser's return the server could not finish says why, where the waiting page was, with Continue with ChatGPT to try again", async () => {
    let state: ChatGPTView = { state: "pending", authorize_url: AUTHORIZE };
    const { v2 } = server(() => state, () => json(500, {}));
    const page = await mount(v2, state);
    // OpenAI's tab said the sign-in completed; the server then could not exchange the code.
    state = { state: "signed_out", problem: "OpenAI refused the sign-in (invalid_grant): start it again." };
    await page.wait(() => !!page.host.querySelector('[role="alert"]'), "the problem is shown");
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe("OpenAI refused the sign-in (invalid_grant): start it again.");
    expect(page.button(/^Continue with ChatGPT$/)).toBeTruthy();
  });

  it("a page opened after such a sign-in says why from the server's view", async () => {
    const { v2 } = server(() => ({ state: "signed_out" }), () => json(500, {}));
    const page = await mount(v2, { state: "signed_out", problem: "This server could not reach OpenAI to finish the sign-in: check its connection, then start again." });
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("could not reach OpenAI");
  });

  it("a read slower than the 2 s poll still lands: one read at a time, so the next doesn't make it stale", async () => {
    const reads: number[] = [];
    const fetch = (async () => {
      reads.push(Date.now());
      await new Promise((r) => setTimeout(r, 2600));
      return json(200, SIGNED_IN);
    }) as typeof globalThis.fetch;
    const page = await mount(createClient({ fetch }), { state: "pending", authorize_url: AUTHORIZE });
    await page.wait(() => !!page.host.textContent?.includes("Signed in as person@example.com (Plus)"), "the slow read's answer lands", 9000);
    // Each read started after the one before it answered.
    for (let i = 1; i < reads.length; i++) expect(reads[i] - reads[i - 1]).toBeGreaterThanOrEqual(2500);
  });

  it("reads nothing while the page is out of view", async () => {
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { v2, calls } = server(() => ({ state: "pending", authorize_url: AUTHORIZE }), () => json(500, {}));
    const page = await mount(v2, { state: "pending", authorize_url: AUTHORIZE });
    await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    expect(calls).toEqual([]);
    hidden.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await page.settle();
    expect(calls.map((c) => c.path)).toEqual(["/v2/settings/chatgpt"]);
  });

  it("a waiting sign-in says until when it waits, and Start again starts a new one", async () => {
    const expires = new Date(Date.now() + 600_000).toISOString();
    let starts = 0;
    const { v2, calls } = server(() => ({ state: "pending", authorize_url: AUTHORIZE }), () => { starts++; return json(200, { authorize_url: `${AUTHORIZE}&n=${starts}`, expires_at: expires }); });
    const page = await mount(v2, { state: "signed_out" });
    await page.click(/^Continue with ChatGPT$/);
    const until = new Date(expires).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    expect(page.host.textContent).toContain(`Waits until ${until}`);
    await page.click(/^Start again$/);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/v2/settings/chatgpt/sign-in", "/v2/settings/chatgpt/sign-in"]);
    expect(tab.location.href).toBe(`${AUTHORIZE}&n=2`);
  });

  it("a page opened on a sign-in already waiting says until when it waits, from the server's view", async () => {
    const expires = new Date(Date.now() + 420_000).toISOString();
    const waiting: ChatGPTView = { state: "pending", authorize_url: AUTHORIZE, expires_at: expires };
    const { v2 } = server(() => waiting, () => json(500, {}));
    const page = await mount(v2, waiting);
    const until = new Date(expires).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    expect(page.host.textContent).toContain(`Waits until ${until}`);
  });

  it("while a pasted sign-in finishes, reads that still say waiting show no error, and it ends signed in", async () => {
    let state: ChatGPTView = { state: "pending", authorize_url: AUTHORIZE };
    let answer!: () => void;
    const { v2, calls } = server(() => state, () => new Promise<Response>((resolve) => { answer = () => { state = SIGNED_IN; resolve(json(200, SIGNED_IN)); }; }) as unknown as Response);
    const page = await mount(v2, state);
    await page.paste(PASTED);
    await act(async () => { page.button(/^Finish sign-in$/)!.click(); });
    // The server reads its models (up to 5 s) before it answers; meanwhile its GET says pending.
    await page.wait(() => calls.some((c) => c.method === "GET"), "the page reads the state while it finishes");
    expect(page.host.querySelector('[role="alert"]')).toBeNull();
    expect(page.host.textContent).toContain("Finishing");
    await act(async () => { answer(); });
    await page.settle();
    expect(page.host.querySelector('[role="alert"]')).toBeNull();
    expect(page.host.textContent).toContain("Signed in as person@example.com (Plus)");
  });

  it("a paste that lands after the browser's return finished the sign-in shows signed in, not the server's refusal", async () => {
    let state: ChatGPTView = { state: "pending", authorize_url: AUTHORIZE };
    const words = "No ChatGPT sign-in is waiting (one lasts 10 minutes): start the sign-in again.";
    const { v2 } = server(() => state, () => { state = SIGNED_IN; return json(400, { error: { code: "bad_request", message: words, retryable: false } }); });
    const seen: ChatGPTView[] = [];
    const page = await mount(v2, state, (v) => seen.push(v));
    await page.paste(PASTED);
    await page.click(/^Finish sign-in$/);
    expect(page.host.querySelector('[role="alert"]')).toBeNull();
    expect(page.host.textContent).toContain("Signed in as person@example.com (Plus)");
    expect(seen.at(-1)).toEqual(SIGNED_IN);
  });
});
