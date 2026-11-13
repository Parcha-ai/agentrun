import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";

// (Adapted for GitHub triggers.) Triggers of every kind (serve's trigger/1): the list shows schedules and webhooks side by side; a webhook is made
// from the console, its URL and signing secret shown once on the create (POST /v2/triggers answers `secret` that once,
// and a retry under the same Idempotency-Key answers `note` in its place); its page shows its URL, its firings, and
// Rotate secret (POST /v2/triggers/{id}/secret, the new secret shown once), Pause and Delete.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "UTC" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T01:30:00Z", last_firing: null,
};
const HOOK: Trigger = {
  ...NIGHTLY, id: "trg_w", name: "on deploy", next_at: null, source: { kind: "webhook", signature: "standard" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Check the deploy." }, max_cost_usd: 1 },
};
// A canary, not a secret shape: the console shows whatever the server sends, once.
const SECRET = "CANARY-VALUE-7f3a9c1e";
const fired = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "github", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", reason: null, error: null, ...over });
const AGENTS = [{ agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null }];

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// `held`: the new secret's answer waits for it (a rotation still out).
function server({ triggers = [NIGHTLY, HOOK], create, held }: { triggers?: Trigger[]; create?: (call: Call) => Response; held?: Promise<void> } = {}) {
  const calls: Call[] = [];
  // Its own copies: a PATCH here never leaks into the next test's triggers.
  triggers = triggers.map((t) => structuredClone(t));
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") return create ? create(call) : json(201, { ...HOOK, ...(call.body as object), id: "trg_new", secret: SECRET });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings|\/secret|\/fire)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
    if (m?.[2] === "/firings") return json(200, { firings: [fired({})] });
    if (m?.[2] === "/secret") { await held; return json(200, { secret: "CANARY-VALUE-0b2d4e6f" }); }
    if (m?.[2] === "/fire") return json(201, fired({ key: "fir_2", by: "manual" }));
    if (m && call.method === "PATCH") { Object.assign(t!, call.body); return json(200, t); }
    if (m && call.method === "DELETE") return new Response(null, { status: 204 });
    if (m) return json(200, t);
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
let writes: string[] = [];
beforeEach(() => {
  writes = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (t: string) => { writes.push(t); }) } });
});
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
  const set = async (name: string, value: string) => {
    const el = host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  return { host, went, button, click, set, settle, text: () => host.textContent ?? "" };
}

describe("a GitHub trigger's page", () => {
  const PRS: Trigger = { ...HOOK, id: "trg_g", name: "review PRs", source: { kind: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"], where: [{ pointer: "/pull_request/base/ref", in: ["main"] }] }] } };

  it("opens: the events it takes, its firings, Pause and Delete; no URL, no secret, no Edit", async () => {
    const s = server({ triggers: [NIGHTLY, PRS] });
    const t = await open(s.v2, { trigger: "trg_g" });
    expect(t.text()).not.toContain("this page doesn't open it");
    expect(t.host.querySelector("h1")!.textContent).toContain("review PRs");
    expect(t.text()).toContain('pull_request (opened, synchronize) where /pull_request/base/ref is one of "main"');
    expect(t.host.querySelector("[data-firing]")!.textContent).toContain("On a GitHub event");
    expect(t.text()).not.toContain("/v2/hooks/");
    expect(t.button(/^Rotate secret$/)).toBeUndefined();
    expect(t.button(/^Edit$/)).toBeUndefined();
    await t.click(/^Pause$/);
    expect(s.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: false });
    await t.click(/^Delete$/);
    await t.click(/^Yes, delete$/);
    expect(s.calls.some((c) => c.method === "DELETE" && c.path === "/v2/triggers/trg_g")).toBe(true);
  });

  it("one a Disconnect turned off can be turned back on: Resume", async () => {
    const s = server({ triggers: [{ ...PRS, enabled: false }] });
    const t = await open(s.v2, { trigger: "trg_g" });
    await t.click(/^Resume$/);
    expect(s.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: true });
  });
});
