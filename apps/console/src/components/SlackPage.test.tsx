import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SlackPage } from "./SlackPage";
import { SETTINGS_PAGES } from "./Settings";
import { createClient } from "@/lib/client";
import type { Slack, SlackAttempt } from "@/lib/v2";

// Settings → Slack over /v2/settings/slack and its deliveries: the URL saved from the field and never read back (only
// its last four characters show), the event switches (saved at once once Slack is set), a test send, Remove behind an
// inline confirm, and the last attempts with Slack's answer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake: no Slack has it. Built from its parts, so no secret scanner reads a whole Slack URL in the source. */
const URL_TYPED = ["https://hooks.slack.com/services", "TTEST0000", "BTEST0000", "CANARYCANARYCANARY123456"].join("/");
const EVENTS = { "run.ended": true, "run.needs_input": true, "trigger.failed": true };
const NONE: Slack = { configured: false, secret: { name: "slack:outbound", set: false, source: null, changed_at: null }, events: EVENTS };
const SET: Extract<Slack, { configured: true }> = { configured: true, url: "https://hooks.slack.com/…3456", url_state: "sealed", secret: { name: "slack:outbound", set: true, source: "console", changed_at: "2026-11-18T12:00:00.000Z" }, events: EVENTS, disabled: null, updated_at: "2026-11-18T12:00:00.000Z" };
const attempt = (extra: Partial<SlackAttempt>): SlackAttempt => ({ webhook_id: "msg_0123456789abcdef0123456789abcdef", type: "run.ended", at: "2026-11-18T12:01:00.000Z", status_code: 200, latency_ms: 42, error: null, retry_at: null, redelivery: false, ...extra });

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server holding Slack as `state`: GET answers it, PUT saves the URL (201 the first time) or the events, DELETE removes
 *  it; a test answers a slack.test attempt and adds it to the log. */
function server(state: { slack: Slack; attempts: SlackAttempt[] }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(call.path, "http://serve.test").pathname;
    if (path === "/v2/settings/slack" && call.method === "GET") return json(200, state.slack);
    if (path === "/v2/settings/slack" && call.method === "PUT") {
      const body = call.body as { url?: string; events?: Partial<typeof EVENTS> };
      const created = !state.slack.configured;
      state.slack = { ...SET, events: { ...state.slack.events, ...body.events } };
      return json(created ? 201 : 200, state.slack);
    }
    if (path === "/v2/settings/slack" && call.method === "DELETE") { state.slack = NONE; return new Response(null, { status: 204 }); }
    if (path === "/v2/settings/slack/deliveries") return json(200, { attempts: state.attempts });
    if (path === "/v2/settings/slack/test") {
      const tried = attempt({ type: "slack.test" });
      state.attempts = [tried, ...state.attempts];
      return json(200, tried);
    }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, state };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, writable = true) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SlackPage, { v2, writable })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const input = () => host.querySelector('input[name="url"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const switchOf = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement;
  const flip = async (label: string) => { await act(async () => { switchOf(label).click(); }); await settle(); };
  return { host, button, click, input, type, switchOf, flip, settle };
}

describe("SlackPage", () => {
  it("is a Settings page of its own, named Slack", () => {
    expect(SETTINGS_PAGES.some((p) => p.id === "slack" && p.label === "Slack")).toBe(true);
  });

  it("saves the URL typed, with the events as switched; shows only its last four characters after, and empties the field", async () => {
    const { v2, calls } = server({ slack: NONE, attempts: [] });
    const page = await open(v2);
    expect(page.host.textContent).toContain("Slack is not set");
    await page.flip("A trigger fails");
    expect(calls.some((c) => c.method === "PUT"), "a switch before the first save saves nothing").toBe(false);
    await page.type(URL_TYPED);
    await page.click(/^Save$/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ url: URL_TYPED, events: { ...EVENTS, "trigger.failed": false } });
    expect(page.host.textContent).toContain("https://hooks.slack.com/…3456");
    expect(page.host.textContent).not.toContain("CANARYCANARY");
    expect(page.input().value).toBe("");
    expect(page.host.textContent).toContain("on");
  });

  it("switches an event of a saved Slack at once, sending the event alone and no URL", async () => {
    const { v2, calls } = server({ slack: SET, attempts: [] });
    const page = await open(v2);
    expect(page.switchOf("A run needs you").getAttribute("aria-checked")).toBe("true");
    await page.flip("A run needs you");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ events: { "run.needs_input": false } }]);
    expect(page.switchOf("A run needs you").getAttribute("aria-checked")).toBe("false");
  });

  it("sends a test and shows how it went, and lists the deliveries with Slack's answer", async () => {
    const { v2 } = server({ slack: SET, attempts: [attempt({ status_code: 404, error: "answered 404 no_service" })] });
    const page = await open(v2);
    const log = page.host.querySelector('[aria-label="Deliveries"]')!;
    expect(log.textContent).toContain("answered 404 no_service");
    await page.click(/^Send a test$/);
    expect(page.host.querySelector('[aria-label="Test send"]')?.textContent).toContain("200, 42 ms");
    expect(page.host.querySelector('[aria-label="Deliveries"]')!.textContent).toContain("slack.test");
  });

  it("removes Slack only after its inline confirm; Cancel keeps it", async () => {
    const { v2, calls } = server({ slack: SET, attempts: [] });
    const page = await open(v2);
    await page.click(/^Remove$/);
    expect(page.host.querySelector('[role="alertdialog"]')).not.toBeNull();
    await page.click(/^Cancel$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.click(/^Remove$/);
    await page.click(/^Remove Slack$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(page.host.textContent).toContain("Slack is not set");
  });

  it("says why Slack is off, and lets a session that can't write secrets see but not save the URL", async () => {
    const { v2 } = server({ slack: { ...SET, disabled: { at: "2026-11-18T12:02:00.000Z", reason: "Slack answered 404 no_service: the URL posts nowhere now" } }, attempts: [] });
    const page = await open(v2, false);
    expect(page.host.textContent).toContain("Off: Slack answered 404 no_service");
    expect(page.input().disabled).toBe(true);
    expect(page.button(/^Save$/)!.disabled).toBe(true);
    expect(page.button(/^Remove$/)).toBeUndefined();
  });
});
