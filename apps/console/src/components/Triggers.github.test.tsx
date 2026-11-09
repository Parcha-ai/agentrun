import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";

// Making a GitHub trigger (serve's trigger-github): a trigger of kind github takes the events its `accept` names from the
// server's one GitHub App, keeps no secret and has no URL of its own (its page: Triggers.githubDetail.test). The console offers one only while GitHub is connected
// (GET /v2/integrations/github names the App, its app_id); with none (a 404, or {connected: false}) it says to connect
// GitHub first and links Settings → GitHub.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "UTC" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T01:30:00Z", last_firing: null,
};
const PRS: Trigger = {
  ...NIGHTLY, id: "trg_g", name: "review PRs", next_at: null,
  source: { kind: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"] }] },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Review the pull request." }, max_cost_usd: 1 },
};
const fired = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "github", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", reason: null, error: null, ...over });
const AGENTS = [{ agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null }];
const NOT_CONNECTED = { error: { code: "github_not_connected", message: "No GitHub App is connected to this server: connect one in Settings → GitHub.", retryable: false } };

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// `connected`: true (200 with the App), false (404, no App), or "answer" (200 {connected: false}: the later shape of no App).
function server({ triggers = [NIGHTLY, PRS], connected = true, create }: { triggers?: Trigger[]; connected?: boolean | "answer"; create?: (call: Call) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  triggers = triggers.map((t) => structuredClone(t));
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    if (call.path === "/v2/integrations/github") return connected === "answer" ? json(200, { connected: false }) : connected ? json(200, { app_id: "1", slug: "agentrun-test", installations: [{ id: 7, account: "acme" }] }) : json(404, NOT_CONNECTED);
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") return create ? create(call) : json(201, { ...PRS, ...(call.body as object), id: "trg_new" });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
    if (m?.[2] === "/firings") return json(200, { firings: [fired({})] });
    if (m) return json(200, t);
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, view: Parameters<typeof SchedulesPage>[0]["view"]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName: (id: string) => (id === "triage" ? "Triage" : id) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const tick = async (value: string) => { await act(async () => { (host.querySelector(`input[name="event"][value="${value}"]`) as HTMLInputElement).click(); }); };
  const set = async (name: string, value: string) => {
    const el = host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  const fill = async () => { await set("name", "review PRs"); await set("agent", "triage"); await set("content", "Review the pull request."); await set("maxCost", "1"); };
  return { host, went, button, click, tick, set, fill, settle, text: () => host.textContent ?? "" };
}

describe("Triggers: GitHub", () => {
  it("lists a GitHub trigger by the events it takes, and offers a new one", async () => {
    const t = await open(server().v2, {});
    const row = t.host.querySelector('[data-trigger="trg_g"]')!;
    expect(row.textContent).toContain("GitHub");
    expect(row.textContent).toContain("On GitHub pull_request (opened, synchronize)");
    await t.click(/^New GitHub trigger$/);
    expect(t.went).toEqual(["#/triggers/new-github"]);
  });

  it("while GitHub is connected, makes one from the picked events with an Idempotency-Key, and opens it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "github" });
    // pull_request opened is picked to start with.
    expect((t.host.querySelector('input[name="event"][value="pull_request:opened"]') as HTMLInputElement).checked).toBe(true);
    await t.tick("pull_request:synchronize");
    await t.tick("issue_comment:created");
    await t.fill();
    await t.click(/^Create GitHub trigger$/);
    const made = s.calls.find((c) => c.method === "POST" && c.path === "/v2/triggers")!;
    expect(made.key).toMatch(/.+/);
    expect(made.body).toEqual({
      name: "review PRs",
      source: { kind: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"] }, { event: "issue_comment", actions: ["created"] }] },
      target: { kind: "start_run", agent_id: "triage", input: { content: "Review the pull request." }, max_cost_usd: 1 },
    });
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });

  it("with no event picked, says so at the events and sends nothing", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "github" });
    await t.tick("pull_request:opened");
    await t.fill();
    await t.click(/^Create GitHub trigger$/);
    expect(t.host.querySelector('[data-issue="source.accept"]')!.textContent).toBe("Pick at least one event.");
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("with GitHub not connected (404), says to connect it first and links Settings → GitHub, with no form", async () => {
    const t = await open(server({ connected: false }).v2, { trigger: null, kind: "github" });
    expect(t.text()).toContain("Connect GitHub first: Settings → GitHub");
    expect(t.host.querySelector('a[href="#/settings/github"]')).not.toBeNull();
    expect(t.button(/^Create GitHub trigger$/)).toBeUndefined();
  });

  it("a 200 that names no App ({connected: false}) is not connected either: Connect GitHub first, with no form", async () => {
    const t = await open(server({ connected: "answer" }).v2, { trigger: null, kind: "github" });
    expect(t.text()).toContain("Connect GitHub first: Settings → GitHub");
    expect(t.host.querySelector('a[href="#/settings/github"]')).not.toBeNull();
    expect(t.button(/^Create GitHub trigger$/)).toBeUndefined();
  });

  it("a create refused with 409 github_not_connected shows the server's words", async () => {
    const s = server({ create: () => json(409, NOT_CONNECTED) });
    const t = await open(s.v2, { trigger: null, kind: "github" });
    await t.fill();
    await t.click(/^Create GitHub trigger$/);
    expect(t.text()).toContain(NOT_CONNECTED.error.message);
  });

  it("a create that answers after the person left the form opens nothing", async () => {
    let answer!: (r: Response) => void;
    const s = server({ create: () => new Promise<Response>((r) => { answer = r; }) });
    const t = await open(s.v2, { trigger: null, kind: "github" });
    await t.fill();
    await t.click(/^Create GitHub trigger$/);
    // Left the form (Cancel, the back link, the sidebar): the page goes, and the create answers after.
    act(() => root?.unmount());
    await act(async () => { answer(json(201, { ...PRS, id: "trg_new" })); });
    await t.settle();
    expect(t.went).not.toContain("#/triggers/trg_new");
  });
});
