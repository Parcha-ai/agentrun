import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmailPage } from "./EmailPage";
import { createClient } from "@/lib/client";
import type { EmailAccount } from "@/lib/v2";

// Settings → Email over /v2/settings/email: the server's one mail account, from a preset (gmail, fastmail, icloud) or
// servers of the person's own (other); a Test that signs in to IMAP and SMTP and sends nothing; a removal; and the app
// password sealed on the server, never shown back: no answer holds it, and the page keeps no copy once it is saved.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake: not a password anywhere (a value the source export's scan knows as fake). */
const PASSWORD = "not-a-secret";
const NONE: EmailAccount = { configured: false, preset: null, address: null, user: null, imap: null, smtp: null, password_unreadable: false };
const GMAIL: EmailAccount = { configured: true, preset: "gmail", address: "you@example.com", user: "you@example.com", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, password_unreadable: false };
const SERVERS: Record<string, { imap: { host: string; port: number }; smtp: { host: string; port: number } }> = {
  gmail: { imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } },
  fastmail: { imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465 } },
  icloud: { imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 } },
};

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (field: string, message: string) => json(422, { error: { code: "input_invalid", message, retryable: false, fields: [{ field, reason: "invalid", message }] } });

/** A server keeping `state.account`: GET answers it, PUT keeps the body's (its password dropped, as the server seals it),
 *  DELETE forgets it, and a test answers `tested`. `put`: a PUT's answer in place of the kept account (a refusal).
 *  `hold`: a PUT answers only once it settles (a slow save). */
function server(state: { account: EmailAccount }, opts: { put?: () => Response; tested?: unknown; hold?: Promise<unknown> } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/v2/settings/email" && call.method === "GET") return json(200, state.account);
    if (call.path === "/v2/settings/email" && call.method === "PUT") {
      await opts.hold;
      if (opts.put) return opts.put();
      const b = call.body!;
      const preset = String(b.preset ?? "other");
      const servers = SERVERS[preset] ?? { imap: b.imap as never, smtp: b.smtp as never };
      state.account = { configured: true, preset: preset as EmailAccount["preset"], address: String(b.address), user: String(b.user ?? b.address), ...servers, password_unreadable: false };
      return json(200, state.account);
    }
    if (call.path === "/v2/settings/email" && call.method === "DELETE") { state.account = NONE; return new Response(null, { status: 204 }); }
    if (call.path === "/v2/settings/email/test") return json(200, opts.tested ?? { ok: true, imap: { ok: true, message: "Signed in to imap.gmail.com. INBOX has 3 messages." }, smtp: { ok: true, message: "Signed in to smtp.gmail.com." } });
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, state };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, props: { writable?: boolean } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(EmailPage, { v2, writable: props.writable ?? true })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const input = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
  const type = async (name: string, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value); input(name)!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const pick = async (preset: string) => { await act(async () => { (host.querySelector(`input[type="radio"][value="${preset}"]`) as HTMLInputElement).click(); }); await settle(); };
  /** Everything a person or a script could read off the page: its text and every field's value. */
  const shown = () => `${host.textContent} ${[...host.querySelectorAll("input")].map((i) => i.value).join(" ")}`;
  return { host, button, click, input, type, pick, shown, settle };
}

describe("EmailPage", () => {
  it("saves a Gmail account from its preset and an app password, then shows it without the password", async () => {
    const { v2, calls } = server({ account: NONE });
    const page = await open(v2);
    expect(page.host.textContent).toContain("No email account is saved");
    expect(page.host.querySelector('a[href="https://myaccount.google.com/apppasswords"]')).not.toBeNull();
    await page.type("address", "you@example.com");
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ preset: "gmail", address: "you@example.com", password: PASSWORD });
    expect(page.host.textContent).toContain("you@example.com");
    expect(page.host.textContent).toContain("imap.gmail.com:993");
    expect(page.host.textContent).toContain("smtp.gmail.com:465");
    expect(page.input("password")!.value).toBe("");
    expect(page.shown()).not.toContain(PASSWORD);
  });

  it("reads a saved account back with no password in it: the field is empty and Save waits for one typed again", async () => {
    const { v2 } = server({ account: GMAIL });
    const page = await open(v2);
    expect(page.host.textContent).toContain("you@example.com");
    expect(page.host.textContent).toMatch(/sealed/i);
    expect(page.input("address")!.value).toBe("you@example.com");
    expect(page.input("password")!.value).toBe("");
    expect(page.button(/^Save$/)!.disabled).toBe(true);
    await page.type("password", PASSWORD);
    expect(page.button(/^Save$/)!.disabled).toBe(false);
  });

  it("takes servers of the person's own with Other: IMAP and SMTP host and port, sent as numbers", async () => {
    const { v2, calls } = server({ account: NONE });
    const page = await open(v2);
    expect(page.input("imap_host")).toBeNull();
    await page.pick("other");
    await page.type("address", "me@mail.example.org");
    await page.type("password", PASSWORD);
    await page.type("imap_host", "imap.example.org");
    await page.type("imap_port", "993");
    await page.type("smtp_host", "smtp.example.org");
    await page.type("smtp_port", "587");
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ preset: "other", address: "me@mail.example.org", password: PASSWORD, imap: { host: "imap.example.org", port: 993 }, smtp: { host: "smtp.example.org", port: 587 } });
    expect(page.host.textContent).toContain("imap.example.org:993");
  });

  it("offers the four presets, and says plainly that Outlook isn't one yet", async () => {
    const { v2 } = server({ account: NONE });
    const page = await open(v2);
    expect([...page.host.querySelectorAll('input[type="radio"]')].map((r) => (r as HTMLInputElement).value)).toEqual(["gmail", "fastmail", "icloud", "other"]);
    expect(page.host.textContent).toContain("Outlook needs Microsoft sign-in");
  });

  it("tests the saved account without sending a password, and shows what IMAP and SMTP each said", async () => {
    const { v2, calls } = server({ account: GMAIL }, { tested: { ok: false, imap: { ok: true, message: "Signed in to imap.gmail.com. INBOX has 3 messages." }, smtp: { ok: false, message: "smtp.gmail.com refused the sign-in." } } });
    const page = await open(v2);
    await page.click(/^Test$/);
    const test = calls.find((c) => c.path === "/v2/settings/email/test");
    expect(test?.method).toBe("POST");
    expect(test?.body).not.toHaveProperty("password");
    expect(test?.body).toMatchObject({ preset: "gmail", address: "you@example.com" });
    const said = page.host.querySelector('[aria-label="Test"]')!.textContent!;
    expect(said).toContain("Signed in to imap.gmail.com. INBOX has 3 messages.");
    expect(said).toContain("smtp.gmail.com refused the sign-in.");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("tests what is typed before it is saved, password included, and saves nothing", async () => {
    const { v2, calls } = server({ account: NONE });
    const page = await open(v2);
    expect(page.button(/^Test$/)!.disabled).toBe(true);
    await page.type("address", "you@example.com");
    await page.type("password", PASSWORD);
    await page.click(/^Test$/);
    expect(calls.find((c) => c.path === "/v2/settings/email/test")?.body).toEqual({ preset: "gmail", address: "you@example.com", password: PASSWORD });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(page.host.textContent).toContain("No email account is saved");
  });

  it("keeps a preset account's own sign-in name and servers: Test signs in as them, and a new password changes nothing else", async () => {
    const own: EmailAccount = { ...GMAIL, user: "login@example.com", imap: { host: "imap.example.net", port: 993 }, smtp: { host: "smtp.example.net", port: 465 } };
    const { v2, calls } = server({ account: own });
    const page = await open(v2);
    expect(page.input("user")!.value).toBe("login@example.com");
    await page.click(/^Test$/);
    expect(calls.find((c) => c.path === "/v2/settings/email/test")?.body).toEqual({ preset: "gmail", address: "you@example.com", user: "login@example.com", imap: own.imap, smtp: own.smtp });
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ preset: "gmail", address: "you@example.com", user: "login@example.com", password: PASSWORD, imap: own.imap, smtp: own.smtp });
  });

  it("takes a sign-in name for a preset too, and another preset's servers are the server's", async () => {
    const { v2, calls } = server({ account: GMAIL });
    const page = await open(v2);
    await page.pick("fastmail");
    await page.type("address", "me@fastmail.example");
    await page.type("user", "me@fastmail.com");
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ preset: "fastmail", address: "me@fastmail.example", user: "me@fastmail.com", password: PASSWORD });
  });

  it("drops a test's answer once a field changes, so it never speaks for an account it didn't test", async () => {
    const { v2 } = server({ account: GMAIL });
    const page = await open(v2);
    await page.click(/^Test$/);
    expect(page.host.querySelector('[aria-label="Test"]')).not.toBeNull();
    await page.type("password", PASSWORD);
    expect(page.host.querySelector('[aria-label="Test"]')).toBeNull();
    await page.click(/^Test$/);
    expect(page.host.querySelector('[aria-label="Test"]')).not.toBeNull();
    await page.pick("icloud");
    expect(page.host.querySelector('[aria-label="Test"]')).toBeNull();
  });

  it("locks the fields while a save is out, so its answer can't wipe an edit made meanwhile", async () => {
    let answer!: () => void;
    const hold = new Promise<void>((r) => { answer = r; });
    const { v2 } = server({ account: NONE }, { hold });
    const page = await open(v2);
    await page.type("address", "you@example.com");
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    expect(page.input("address")!.matches(":disabled")).toBe(true);
    expect(page.input("password")!.matches(":disabled")).toBe(true);
    await act(async () => { answer(); });
    await page.settle();
    expect(page.input("address")!.matches(":disabled")).toBe(false);
    expect(page.host.textContent).toContain("imap.gmail.com:993");
  });

  it("shows a refused field under that field, and keeps what was typed", async () => {
    const { v2 } = server({ account: NONE }, { put: () => refused("address", "address is an email address, such as you@example.com") });
    const page = await open(v2);
    await page.type("address", "not-an-address");
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    const alert = page.host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("address is an email address");
    expect(page.input("address")!.value).toBe("not-an-address");
  });

  it("shows a save the servers refused beside the form, in the test's words, and never says saved for it", async () => {
    const said = { imap: { ok: false, message: "imap.gmail.com refused the sign-in." }, smtp: { ok: false, message: "smtp.gmail.com refused the sign-in." } };
    const signInRefused = () => json(424, { error: { code: "upstream_failed", message: "The account was not saved: it did not sign in.", retryable: false, details: said } });
    const { v2, state } = server({ account: NONE }, { put: signInRefused });
    const page = await open(v2);
    await page.type("address", "you@example.com");
    await page.type("password", PASSWORD);
    await page.click(/^Save$/);
    const form = page.host.querySelector('form[aria-label="Account"]')!;
    const refusal = form.querySelector('[aria-label="Not saved"]');
    expect(refusal?.textContent).toContain("imap.gmail.com refused the sign-in.");
    expect(refusal?.textContent).toContain("smtp.gmail.com refused the sign-in.");
    expect(refusal?.textContent).toMatch(/not saved/i);
    expect(page.host.textContent).toContain("No email account is saved");
    expect([...page.host.querySelectorAll("span")].some((s) => s.textContent === "saved")).toBe(false);
    expect(page.input("address")!.value).toBe("you@example.com");
    expect(state.account).toBe(NONE);

    // An account saved before stays shown as it was: the refusal says the new one was not saved.
    const before = server({ account: GMAIL }, { put: signInRefused });
    act(() => root?.unmount());
    const again = await open(before.v2);
    await again.type("address", "new@example.com");
    await again.type("password", PASSWORD);
    await again.click(/^Save$/);
    expect(again.host.querySelector('form[aria-label="Account"] [aria-label="Not saved"]')?.textContent).toMatch(/saved before is as it was/i);
    expect(again.host.querySelector('[aria-label="Email account"]')!.textContent).toContain("you@example.com");
    expect(again.host.querySelector('[aria-label="Email account"]')!.textContent).not.toContain("new@example.com");
    // An edit drops the refusal: it spoke for what was typed then.
    await again.type("address", "newer@example.com");
    expect(again.host.querySelector('[aria-label="Not saved"]')).toBeNull();
  });

  it("removes the account after asking, and says so", async () => {
    const { v2, calls } = server({ account: GMAIL });
    const page = await open(v2);
    await page.click(/^Remove$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.click(/^Remove the account$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(page.host.textContent).toContain("No email account is saved");
  });

  it("says when the saved password can't be opened here", async () => {
    const { v2 } = server({ account: { ...GMAIL, configured: false, password_unreadable: true } });
    const page = await open(v2);
    expect(page.host.textContent).toMatch(/password can't be opened/i);
  });

  it("asks nothing of the server when this session can't change secrets, and says why", async () => {
    const { v2, calls } = server({ account: GMAIL });
    const page = await open(v2, { writable: false });
    expect(calls).toEqual([]);
    expect(page.host.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(10);
  });
});
