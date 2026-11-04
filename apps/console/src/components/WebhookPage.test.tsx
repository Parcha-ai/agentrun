import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebhookPage } from "./WebhookPage";
import { createClient } from "@/lib/client";
import type { Webhook, WebhookAttempt } from "@/lib/v2";

// Settings → Webhook over /v2/settings/webhook and its deliveries: the URL and whether it signs here, the secret shown
// once when the first save makes it, a test send, and the last attempts with why each failed and a redelivery of any.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake: not a secret anywhere. */
const SECRET = "whsec_bm90LWEtcmVhbC1zZWNyZXQtMDEyMzQ1Njc4OWFi";
const SET: Extract<Webhook, { configured: true }> = { configured: true, url: "https://hooks.example.test/agentrun", signing: "sealed", disabled: null, updated_at: "2026-11-03T12:00:00.000Z" };
const attempt = (extra: Partial<WebhookAttempt>): WebhookAttempt => ({ webhook_id: "msg_0123456789abcdef0123456789abcdef", type: "run.ended", at: "2026-11-03T12:01:00.000Z", status_code: 200, latency_ms: 42, error: null, retry_at: null, redelivery: false, ...extra });

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server with the webhook `state`: GET answers it, PUT sets it (201 with the secret the first time), DELETE removes
 *  it; the deliveries are `attempts`; a test or a redelivery answers `sent` and adds it to the log. */
function server(state: { webhook: Webhook; attempts: WebhookAttempt[]; readsFail?: boolean }, sent: () => Response = () => json(200, attempt({ type: "webhook.test" }))) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(call.path, "http://serve.test").pathname;
    if (state.readsFail && call.method === "GET") return json(500, { error: { code: "internal", message: "the read failed", retryable: true } });
    if (path === "/v2/settings/webhook" && call.method === "GET") return json(200, state.webhook);
    if (path === "/v2/settings/webhook" && call.method === "PUT") {
      const created = !state.webhook.configured;
      state.webhook = { ...SET, url: (call.body as { url: string }).url };
      return json(created ? 201 : 200, { ...state.webhook, ...(created ? { secret: SECRET } : {}) });
    }
    if (path === "/v2/settings/webhook" && call.method === "DELETE") { state.webhook = { configured: false }; return new Response(null, { status: 204 }); }
    if (path === "/v2/settings/webhook/deliveries") return json(200, { attempts: state.attempts });
    if (path === "/v2/settings/webhook/test" || path.endsWith("/redeliver")) {
      const answer = sent();
      if (answer.ok) state.attempts = [(await answer.clone().json()) as WebhookAttempt, ...state.attempts];
      return answer;
    }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, state };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, atRest: "sealed" | "unavailable" = "sealed") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(WebhookPage, { v2, atRest })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp, within: Element = host) => [...within.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp, within: Element = host) => { await act(async () => { button(label, within)!.click(); }); await settle(); };
  const input = () => host.querySelector('input[name="url"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const rows = () => [...host.querySelectorAll('[aria-label="Deliveries"] li')];
  return { host, button, click, input, type, rows, settle };
}

describe("WebhookPage", () => {
  it("sets a webhook, shows its secret this once, and not after the page is read again", async () => {
    const { v2, calls } = server({ webhook: { configured: false }, attempts: [] });
    const page = await open(v2);
    expect(page.host.textContent).toContain("No webhook is set");
    await page.type("https://hooks.example.test/agentrun");
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ url: "https://hooks.example.test/agentrun" });
    const shown = page.host.querySelector('[aria-label="Webhook secret"]');
    expect(shown?.textContent).toContain(SECRET);
    expect(shown?.textContent).toContain("shown this once");
    expect(page.host.textContent).toContain("https://hooks.example.test/agentrun");
    act(() => root!.unmount()); root = undefined;
    const again = await open(v2);
    expect(again.host.textContent).not.toContain(SECRET);
    expect(again.host.textContent).toContain("https://hooks.example.test/agentrun");
  });

  it("lists the last attempts, newest first, with the receiver's answer or why it failed and when it is tried again", async () => {
    const { v2 } = server({ webhook: SET, attempts: [
      attempt({ webhook_id: "msg_failed000000000000000000000000", status_code: 503, error: "answered 503", retry_at: "2026-11-03T12:06:00.000Z", type: "run.needs_input" }),
      attempt({ webhook_id: "msg_gone0000000000000000000000000", status_code: null, error: "not reached: ECONNREFUSED" }),
      attempt({}),
    ] });
    const page = await open(v2);
    const rows = page.rows();
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("run.needs_input");
    expect(rows[0].textContent).toContain("answered 503");
    expect(rows[0].textContent).toContain("tried again");
    expect(rows[1].textContent).toContain("not reached: ECONNREFUSED");
    expect(rows[2].textContent).toContain("200");
    expect(rows[2].textContent).toContain("42 ms");
  });

  it("redelivers a message of the log and shows its new attempt; a test send shows how it went", async () => {
    const { v2, calls } = server({ webhook: SET, attempts: [attempt({ webhook_id: "msg_failed000000000000000000000000", status_code: 503, error: "answered 503" })] },
      () => json(200, attempt({ webhook_id: "msg_failed000000000000000000000000", redelivery: true, at: "2026-11-03T12:10:00.000Z" })));
    const page = await open(v2);
    await page.click(/^Redeliver$/, page.rows()[0]);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/settings/webhook/deliveries/msg_failed000000000000000000000000/redeliver"))).toBe(true);
    expect(page.rows().length).toBe(2);
    expect(page.rows()[0].textContent).toContain("redelivery");
    await page.click(/^Send a test$/);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/settings/webhook/test"))).toBe(true);
    expect(page.host.querySelector('[aria-label="Test send"]')?.textContent).toContain("200");
  });

  it("says why nothing is sent: a webhook a 410 turned off, a secret that doesn't open here, and a refused redelivery", async () => {
    const off: Webhook = { ...SET, signing: "seal_key_missing", disabled: { at: "2026-11-03T12:02:00.000Z", reason: "the receiver answered 410 Gone" } };
    const { v2 } = server({ webhook: off, attempts: [attempt({ status_code: 410, error: "answered 410" })] },
      () => json(409, { error: { code: "webhook_off", message: "the webhook is off (the receiver answered 410 Gone): set it again with PUT /v2/settings/webhook", retryable: false } }));
    const page = await open(v2);
    expect(page.host.textContent).toContain("Off: the receiver answered 410 Gone");
    expect(page.host.textContent).toContain("can't sign here");
    await page.click(/^Redeliver$/, page.rows()[0]);
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("webhook_off");
  });

  it("shows a save's answer at once, and a read after it that fails, beside what is shown", async () => {
    const state = { webhook: { configured: false } as Webhook, attempts: [] as WebhookAttempt[], readsFail: false };
    const { v2 } = server(state);
    const page = await open(v2);
    state.readsFail = true;
    await page.type("https://hooks.example.test/agentrun");
    await page.click(/^Save$/);
    expect(page.host.querySelector('[aria-label="Webhook URL"]')?.textContent).toContain("https://hooks.example.test/agentrun");
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("could not be read");
  });

  it("offers a redelivery of a test message too, under its own webhook-id", async () => {
    const { v2, calls } = server({ webhook: SET, attempts: [attempt({ webhook_id: "msg_test0000000000000000000000000", type: "webhook.test" })] });
    const page = await open(v2);
    await page.click(/^Redeliver$/, page.rows()[0]);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/settings/webhook/deliveries/msg_test0000000000000000000000000/redeliver"))).toBe(true);
  });

  it("drops a secret shown this once when its webhook is removed: it no longer signs anything", async () => {
    const { v2 } = server({ webhook: { configured: false }, attempts: [] });
    const page = await open(v2);
    await page.type("https://hooks.example.test/agentrun");
    await page.click(/^Save$/);
    expect(page.host.querySelector('[aria-label="Webhook secret"]')).not.toBeNull();
    await page.click(/^Remove$/);
    await page.click(/^Remove the webhook$/);
    expect(page.host.querySelector('[aria-label="Webhook secret"]')).toBeNull();
    expect(page.host.textContent).not.toContain(SECRET);
  });

  it("removes the webhook, and says when this server can't keep a secret", async () => {
    const { v2, calls } = server({ webhook: SET, attempts: [] });
    const page = await open(v2);
    await page.click(/^Remove$/);
    await page.click(/^Remove the webhook$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(page.host.textContent).toContain("No webhook is set");
    act(() => root!.unmount()); root = undefined;
    const none = await open(server({ webhook: { configured: false }, attempts: [] }).v2, "unavailable");
    expect(none.host.textContent).toContain("can't keep a webhook secret");
    expect(none.button(/^Save$/)?.disabled).toBe(true);
  });
});

// The deliveries' times read as every other time in the console does (one helper), in the viewer's own zone.
describe("WebhookPage's times, in the viewer's zone (Puerto Rico, UTC-4)", () => {
  let was: string | undefined;
  beforeAll(() => { was = process.env.TZ; process.env.TZ = "America/Puerto_Rico"; });
  afterAll(() => { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; });
  it("shows an attempt at 20:50:47Z, and when it is tried again, as the console's other times", async () => {
    const { v2 } = server({ webhook: SET, attempts: [attempt({ at: "2026-11-04T20:50:47Z", status_code: 503, error: "answered 503", retry_at: "2026-11-04T20:55:47Z" })] });
    const page = await open(v2);
    const row = page.rows()[0]!.textContent ?? "";
    expect(row).toContain("Nov 4, 4:50 PM");
    expect(row).toContain("tried again Nov 4, 4:55 PM");
  });
});
