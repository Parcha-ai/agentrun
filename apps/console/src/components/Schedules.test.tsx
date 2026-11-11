import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulesPage, type ScheduleView } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// Schedules (serve's trigger/1): the list, the form that makes or edits one with the server's 422 under the field it
// names, and one schedule's page: pause, resume, edit, delete, run now (once per click), and its firings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  catchup_window_s: 300, max_active_runs: null, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T09:30:00Z",
  last_firing: { key: "fir_a", by: "schedule", nominal_at: "2026-11-04T09:30:00Z", status: "skipped", at: "2026-11-04T09:30:01Z", run_id: null, reason: "The last run is still working.", error: null },
};
const firing = (over: Partial<Firing>): Firing => ({ key: "fir_x", by: "schedule", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: null, reason: null, error: null, ...over });
const AGENTS = [
  { agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null },
  { agent_id: "flow", kind: "workflow", definition: { name: "Refund flow" }, archived_at: null },
  // An agent with a default cap per run (definition.max_cost_usd): a schedule on it may leave its own cap out.
  { agent_id: "story", kind: "agentic", definition: { name: "Story", max_cost_usd: 0.5 }, archived_at: null },
];

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (fields: { field: string; reason: string; message: string }[]) => json(422, { error: { code: "input_invalid", message: fields[0].message, retryable: false, fields } });

/** A server with `triggers` and their `firings`: a create or an edit answers `write` when given, else takes it; a run
 *  now answers once `release` is called (so a second click lands while the first is out). While `hold.on`, a read of a
 *  schedule or its firings answers as things stood when it was asked, but only once `releaseHeld` is called: a late,
 *  stale background read. */
function server({ triggers = [NIGHTLY], firings = {} as Record<string, Firing[]>, write }: { triggers?: Trigger[]; firings?: Record<string, Firing[]>; write?: (call: Call) => Response | undefined } = {}) {
  const calls: Call[] = [];
  let release: () => void = () => {};
  const hold = { on: false };
  const held: (() => void)[] = [];
  const later = async (answer: Response) => { await new Promise<void>((r) => held.push(r)); return answer; };
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    const m = /^\/v2\/triggers\/([^/]+)(\/fire|\/firings)?$/.exec(call.path);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    const agentRead = /^\/v2\/agents\/([^/]+)$/.exec(call.path);
    if (agentRead) { const a = AGENTS.find((x) => x.agent_id === decodeURIComponent(agentRead[1])); return a ? json(200, a) : json(404, { error: { code: "not_found", message: "no agent", retryable: false } }); }
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") {
      const answer = write?.(call);
      if (answer) return answer;
      const made = { ...NIGHTLY, ...(call.body as Partial<Trigger>), id: "trg_new", last_firing: null };
      triggers.push(made);
      return json(201, made);
    }
    if (m && !m[2]) {
      const t = triggers.find((x) => x.id === decodeURIComponent(m[1]));
      if (!t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
      if (call.method === "PATCH") {
        const answer = write?.(call);
        if (answer) return answer;
        Object.assign(t, call.body);
        return json(200, t);
      }
      if (call.method === "DELETE") { triggers.splice(triggers.indexOf(t), 1); return new Response(null, { status: 204 }); }
      return hold.on ? later(json(200, t)) : json(200, t);
    }
    if (m?.[2] === "/firings") { const answer = json(200, { firings: firings[decodeURIComponent(m[1])] ?? [] }); return hold.on ? later(answer) : answer; }
    if (m?.[2] === "/fire") {
      await new Promise<void>((r) => { release = r; });
      const made = firing({ key: `fir_${call.key}`, by: "manual", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b" });
      firings[m[1]] = [made, ...(firings[m[1]] ?? [])];
      return json(202, made);
    }
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, release: () => release(), hold, releaseHeld: () => held.splice(0).forEach((r) => r()) };
}

let root: ReturnType<typeof createRoot> | undefined;
// The page's clock, fixed: whether a one time has passed is read against it, never the wall clock.
const NOW = Date.parse("2026-11-10T00:00:00Z");
// A one-time "at" is typed in the browser's own zone: the tests pin it.
beforeEach(() => { vi.stubEnv("TZ", "UTC"); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllEnvs(); });

async function open(v2: ReturnType<typeof createClient>, view: ScheduleView, minEvery?: number, refreshMs?: number) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  const agentName = (id: string) => (id === "triage" ? "Triage" : id);
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName, minEvery, now: () => NOW, ...(refreshMs ? { refreshMs } : {}) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const field = (name: string) => host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement;
  // The agent and the every's unit are pickers (picked by their names); every other field is typed into.
  const PICKERS: Record<string, string> = { agent: "Agent", everyUnit: "Unit" };
  const set = async (name: string, value: string) => {
    if (PICKERS[name]) return pick(picker(host, PICKERS[name])!, value);
    const el = field(name);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const choose = async (kind: string) => { await act(async () => { (host.querySelector(`input[name="kind"][value="${kind}"]`) as HTMLInputElement).click(); }); };
  const issue = (field: string) => host.querySelector(`[data-issue="${field}"]`)?.textContent ?? null;
  return { host, went, button, click, set, choose, issue, settle, text: () => host.textContent ?? "" };
}

describe("the schedules list", () => {
  it("names each schedule, its agent, when it fires, its next time, whether it is paused, and how its last firing went", async () => {
    const paused: Trigger = { ...NIGHTLY, id: "trg_2", name: "every five", enabled: false, next_at: null, source: { kind: "schedule", every_s: 300, start_at: "2026-11-04T00:00:00Z" }, last_firing: null };
    const t = await open(server({ triggers: [NIGHTLY, paused] }).v2, {});
    const rows = [...t.host.querySelectorAll("[data-trigger]")];
    expect(rows.map((r) => r.getAttribute("data-trigger"))).toEqual(["trg_1", "trg_2"]);
    expect(rows[0].textContent).toContain("nightly triage");
    expect(rows[0].textContent).toContain("Triage");
    expect(rows[0].textContent).toContain("At 01:30 · America/Los_Angeles");
    expect(rows[0].textContent).toContain("Nov 5, 9:30 AM");
    expect(rows[0].textContent).toContain("Skipped: The last run is still working.");
    expect(rows[0].querySelector('a[href="#/triggers/trg_1"]')).not.toBeNull();
    expect(rows[1].textContent).toContain("Every 5 minutes");
    expect(rows[1].textContent).toContain("Paused");
    expect(rows[1].textContent).toContain("Not fired yet");
    await t.click(/^New schedule$/);
    expect(t.went).toEqual(["#/triggers/new"]);
  });
  // A schedule fires while its page is open: the page reads again on its own, so a new firing shows with no reload.
  it("reads the schedules again while it is open", async () => {
    const triggers = [NIGHTLY];
    const t = await open(server({ triggers }).v2, {}, undefined, 30);
    expect(t.host.querySelectorAll("[data-trigger]")).toHaveLength(1);
    triggers.push({ ...NIGHTLY, id: "trg_2", name: "every five" });
    for (let i = 0; i < 20 && t.host.querySelectorAll("[data-trigger]").length < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(t.host.querySelectorAll("[data-trigger]")).toHaveLength(2);
  });
  // GET /triggers lists every kind: schedules and webhooks each show as a row with its kind, and a schedule that sends a
  // message to a run shows too, its target said, never a broken row.
  it("shows every trigger: schedules, webhooks and messages to a run", async () => {
    const hook = { ...NIGHTLY, id: "trg_hook", name: "on push", source: { kind: "webhook" } } as unknown as Trigger;
    const message = { ...NIGHTLY, id: "trg_msg", name: "nudge", target: { kind: "message_run", run_id: "r1", input: { content: "Go on." } } } as unknown as Trigger;
    const t = await open(server({ triggers: [NIGHTLY, hook, message] }).v2, {});
    expect([...t.host.querySelectorAll("[data-trigger]")].map((r) => r.getAttribute("data-trigger"))).toEqual(["trg_1", "trg_hook", "trg_msg"]);
    expect(t.text()).not.toContain("not shown here");
    expect(t.text()).not.toContain("undefined");
  });
  it("says there are none yet, with the way to make one", async () => {
    const t = await open(server({ triggers: [] }).v2, {});
    expect(t.text()).toContain("No triggers yet");
    expect(t.button(/^New schedule$/)).toBeTruthy();
    // The three things that can start a run, each with its own way in.
    const panel = t.host.querySelector('section[aria-labelledby="first-trigger"]')!;
    expect(panel.querySelector("h2")?.textContent).toBe("Start runs without being here");
    expect([...panel.querySelectorAll("li button")].map((b) => b.textContent)).toEqual(["New schedule", "New webhook", "New GitHub trigger"]);
    // Each is on the page once: the header's three show when there is a trigger.
    for (const name of ["New schedule", "New webhook", "New GitHub trigger"]) expect([...t.host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === name).length, name).toBe(1);
  });
});

describe("a new schedule", () => {
  it("every field's label names its one control, so a click on the label goes to it", async () => {
    const t = await open(server().v2, { trigger: null });
    const named = Object.fromEntries([...t.host.querySelectorAll("label")].filter((l) => l.control).map((l) => [l.textContent, (l.control as HTMLInputElement).name || l.control!.getAttribute("aria-label")]));
    // The agent's control is the picker's field (a button; its value goes in a hidden input named "agent").
    expect(named).toMatchObject({ Name: "name", "Cron line": "cron", "Time zone": "timezone", Agent: "Agent", "Each run is asked": "content" });
  });
  it("the Every form's amount and unit are two controls with two ids; the label names the amount", async () => {
    const t = await open(server().v2, { trigger: null });
    await t.choose("every");
    const ids = [...t.host.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // "Every" is also the kind's own choice above; the field's label is the one whose control is the amount.
    const every = [...t.host.querySelectorAll("label")].find((l) => l.textContent === "Every" && (l.control as HTMLInputElement | null)?.name === "every")!;
    expect(every).toBeTruthy();
    const unit = t.host.querySelector('button[aria-label="Unit"]')!;
    expect(unit.id).toBe("schedule-every-unit");
    expect(unit.id).not.toBe(every.control!.id);
  });
  it("sends the cron line in its zone, the agent, the input and the cap, then opens the schedule", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: null });
    await t.set("name", "nightly triage");
    await t.set("cron", "30 1 * * *");
    await t.set("timezone", "America/Los_Angeles");
    await t.set("agent", "triage");
    await t.set("content", "Triage last night's issues.");
    await t.set("maxCost", "2");
    await t.click(/^Create schedule$/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/triggers", key: expect.stringMatching(/.+/), body: {
      name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
      target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
    } }]);
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });
  it("sends every N minutes, or one time, as the kind picked", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: null });
    await t.choose("every");
    await t.set("every", "5");
    await t.set("agent", "triage");
    await t.set("content", "Look.");
    await t.set("maxCost", "0.5");
    await t.click(/^Create schedule$/);
    expect((calls.find((c) => c.method === "POST")!.body as { source: unknown }).source).toEqual({ kind: "schedule", every_s: 300 });
  });
  it("takes one time in the browser's own zone, says the instant it becomes, and asks no zone for it", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const { v2, calls } = server();
    const t = await open(v2, { trigger: null });
    await t.choose("at");
    expect(t.host.querySelector('[name="timezone"]')).toBeNull();
    await t.set("at", "2026-11-05T01:30");
    expect(t.text()).toContain("= Nov 5, 9:30 AM UTC");
    await t.set("agent", "triage");
    await t.set("content", "Look.");
    await t.set("maxCost", "1");
    await t.click(/^Create schedule$/);
    expect((calls.find((c) => c.method === "POST")!.body as { source: unknown }).source).toEqual({ kind: "schedule", at: "2026-11-05T09:30:00Z" });
  });
  it("says the shortest interval the server takes, from what it serves", async () => {
    const t = await open(server().v2, { trigger: null }, 120);
    await t.choose("every");
    expect(t.text()).toContain("At least 2 minutes.");
  });
  // The server takes no cap when the agent has a default (each firing uses the agent's): the field is optional then.
  it("leaves the cap out on an agent with a default cap, and says the default under the field", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: null });
    await t.set("cron", "* * * * *");
    await t.set("agent", "story");
    await t.set("content", "Say hello.");
    expect(t.text()).toContain("Uses the agent's default ($0.50) if empty.");
    await t.click(/^Create schedule$/);
    expect(t.issue("target.max_cost_usd")).toBeNull();
    const posted = calls.find((c) => c.method === "POST")?.body as { target: Record<string, unknown> } | undefined;
    expect(posted?.target).toEqual({ kind: "start_run", agent_id: "story", input: { content: "Say hello." } });
  });
  it("says the server's refusal under the cap when the agent's default was taken away meanwhile", async () => {
    const message = "Every run a trigger starts is capped: give the trigger's target a max_cost_usd or set the agent's.";
    const { v2 } = server({ write: () => refuse([{ field: "target.max_cost_usd", reason: "missing", message }]) });
    const t = await open(v2, { trigger: null });
    await t.set("cron", "* * * * *");
    await t.set("agent", "story");
    await t.set("content", "Say hello.");
    await t.click(/^Create schedule$/);
    expect(t.issue("target.max_cost_usd")).toBe(message);
  });
  it("says a missing cap under its field and sends nothing", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: null });
    await t.set("cron", "30 1 * * *");
    await t.set("agent", "triage");
    await t.set("content", "Triage.");
    await t.click(/^Create schedule$/);
    expect(t.issue("target.max_cost_usd")).toBe("A cost cap is needed: every run a schedule starts is capped.");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
  it("says a one time already passed in words on the time field, and clears it once a time ahead is picked (#2248)", async () => {
    const message = "Pick a time in the future: 2026-11-09T09:30:00Z has already passed.";
    const { v2 } = server({ write: () => refuse([{ field: "source.at", reason: "invalid", message }]) });
    const t = await open(v2, { trigger: null });
    await t.choose("at");
    await t.set("at", "2026-11-09T09:30");
    await t.set("agent", "triage");
    await t.set("content", "Look.");
    await t.set("maxCost", "1");
    await t.click(/^Create schedule$/);
    expect(t.issue("source.at")).toBe(message);
    expect(t.text()).not.toContain("at is in the past");
    // Still past (the page's clock is 2026-11-10T00:00Z): the issue stays.
    await t.set("at", "2026-11-09T23:59");
    expect(t.issue("source.at")).toBe(message);
    await t.set("at", "2026-11-12T09:30");
    expect(t.issue("source.at")).toBeNull();
    expect(t.went).toEqual([]);
  });

  it("shows each issue of the server's 422 under the field it names: an agent with no revision under the agent", async () => {
    const message = "the agent flow has no current revision";
    const { v2 } = server({ write: () => refuse([{ field: "target.agent_id", reason: "invalid", message }, { field: "source.cron", reason: "invalid", message: "cron is five fields" }]) });
    const t = await open(v2, { trigger: null });
    await t.set("cron", "30 1 * *");
    await t.set("agent", "flow");
    await t.set("content", "Refund.");
    await t.set("maxCost", "1");
    await t.click(/^Create schedule$/);
    expect(t.issue("target.agent_id")).toBe(message);
    expect(t.issue("source.cron")).toBe("cron is five fields");
    expect(t.went).toEqual([]);
  });
});

describe("one schedule", () => {
  it("lists its firings, newest first: what came of each, its time, by hand or not, and its run", async () => {
    const firings = { trg_1: [
      firing({ key: "f3", status: "started", by: "manual", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b" }),
      firing({ key: "f2", status: "missed", count: 3, reason: "The server was down or its timer late." }),
      firing({ key: "f1", status: "failed", error: { code: "agent_not_runnable", message: "No model." } }),
    ] };
    const t = await open(server({ firings }).v2, { trigger: "trg_1" });
    expect(t.text()).toContain("nightly triage");
    expect(t.text()).toContain("At 01:30 · America/Los_Angeles");
    expect(t.text()).toContain("$2.00 a run");
    const rows = [...t.host.querySelectorAll("[data-firing]")];
    expect(rows.map((r) => r.getAttribute("data-firing"))).toEqual(["f3", "f2", "f1"]);
    expect(rows[0].textContent).toContain("Started");
    expect(rows[0].textContent).toContain("Run now");
    expect(rows[0].querySelector('a[href="#/runs/01a1a88f-5f5c-7ce4-a912-fb765b62e88b"]')?.textContent).toContain("62e88b");
    expect(rows[1].textContent).toContain("Missed 3 times: The server was down or its timer late.");
    expect(rows[2].textContent).toContain("Failed: No model.");
  });
  // The console says every time in the viewer's own zone; only a one time's input names UTC (the instant it sends).
  it("says its times in the viewer's own zone, with no UTC on them", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const firings = { trg_1: [firing({ key: "f1", status: "started", run_id: "r1" })] };
    const t = await open(server({ firings }).v2, { trigger: "trg_1" });
    expect(t.text()).toContain("next Nov 5, 1:30 AM");
    expect(t.host.querySelector("[data-firing]")?.textContent).toContain("Nov 4, 1:30 AM");
    expect(t.text()).not.toContain("UTC");
  });
  it("reads its firings again while it is open, so a timed firing and its run show with no reload", async () => {
    const firings: Record<string, Firing[]> = {};
    const t = await open(server({ firings }).v2, { trigger: "trg_1" }, undefined, 30);
    expect(t.host.querySelectorAll("[data-firing]")).toHaveLength(0);
    firings.trg_1 = [firing({ key: "f9", status: "started", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b" })];
    for (let i = 0; i < 20 && !t.host.querySelector("[data-firing]"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(t.host.querySelector("[data-firing]")?.textContent).toContain("On schedule");
    expect(t.host.querySelector('[data-firing] a[href="#/runs/01a1a88f-5f5c-7ce4-a912-fb765b62e88b"]')).not.toBeNull();
  });
  // As SWR's refreshInterval with refreshWhenHidden off: a hidden tab reads nothing, and reads once when it shows again.
  it("reads nothing while the tab is hidden, and once when it shows again", async () => {
    let hidden = true;
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")!;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    try {
      const firings: Record<string, Firing[]> = {};
      const s = server({ firings });
      const t = await open(s.v2, { trigger: "trg_1" }, undefined, 30);
      const reads = () => s.calls.filter((c) => c.method === "GET" && c.path === "/v2/triggers/trg_1/firings").length;
      expect(reads()).toBe(1);
      firings.trg_1 = [firing({ key: "f9", status: "started", run_id: "r9" })];
      await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
      expect(reads()).toBe(1);
      expect(t.host.querySelector("[data-firing]")).toBeNull();
      hidden = false;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await t.settle();
      expect(reads()).toBeGreaterThanOrEqual(2);
      expect(t.host.querySelector("[data-firing]")?.textContent).toContain("On schedule");
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
  });
  it("says a schedule with no cap of its own runs under the agent's default, never an undefined cap", async () => {
    const own: Trigger = { ...NIGHTLY, target: { kind: "start_run", agent_id: "story", input: { content: "Say hello." } } };
    const t = await open(server({ triggers: [own] }).v2, { trigger: "trg_1" });
    expect(t.text()).toContain("Agent's default ($0.50)");
    expect(t.text()).not.toContain("undefined");
  });
  it("says a trigger that messages a run is not one this page opens, with nothing to change it", async () => {
    const message = { ...NIGHTLY, id: "trg_msg", name: "nudge", target: { kind: "message_run", run_id: "r1", input: { content: "Go on." } } } as unknown as Trigger;
    const t = await open(server({ triggers: [message] }).v2, { trigger: "trg_msg" });
    expect(t.text()).toContain("This trigger sends its firings to a run: this page doesn't open it yet.");
    expect(t.button(/^Pause$|^Resume$|^Edit$|^Run now$|^Delete$/)).toBeUndefined();
    expect(t.text()).not.toContain("undefined");
  });
  it("pauses and resumes by enabled alone", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: "trg_1" });
    await t.click(/^Pause$/);
    await t.click(/^Resume$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
  });
  // A background read asked before an action, answered after it, says how things stood before: it is dropped.
  it("keeps a Pause when a read asked before it answers after it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1" }, undefined, 30);
    const reads = () => s.calls.filter((c) => c.method === "GET" && c.path === "/v2/triggers/trg_1").length;
    const before = reads();
    s.hold.on = true;
    for (let i = 0; i < 20 && reads() === before; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(reads()).toBe(before + 1);
    s.hold.on = false;
    await t.click(/^Pause$/);
    expect(t.button(/^Resume$/)).toBeTruthy();
    // The stale read answers; reads after it are held, so no later read can put the page right by itself.
    await act(async () => { s.releaseHeld(); s.hold.on = true; });
    await t.settle();
    expect(t.button(/^Resume$/)).toBeTruthy();
    expect(t.host.querySelector("h1")?.textContent).toContain("Paused");
  });
  it("keeps Run now's firing when a read asked before it answers after it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1" }, undefined, 30);
    const reads = () => s.calls.filter((c) => c.method === "GET" && c.path === "/v2/triggers/trg_1/firings").length;
    const before = reads();
    s.hold.on = true;
    for (let i = 0; i < 20 && reads() === before; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    s.hold.on = false;
    await act(async () => { t.button(/^Run now$/)!.click(); });
    await act(async () => s.release());
    await t.settle();
    expect(t.host.querySelector("[data-firing]")?.textContent).toContain("Run now");
    // The stale read answers; reads after it are held, so no later read can put the page right by itself.
    await act(async () => { s.releaseHeld(); s.hold.on = true; });
    await t.settle();
    expect(t.host.querySelector("[data-firing]")?.textContent).toContain("Run now");
    expect(t.host.querySelector('[data-firing] a[href^="#/runs/"]')).not.toBeNull();
  });
  it("runs now once per click: a second click while the first is out sends nothing, the next click a new key", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1" });
    await act(async () => { t.button(/^Run now$/)!.click(); t.button(/^Run now|^Starting/)!.click(); });
    await t.settle();
    const fires = () => s.calls.filter((c) => c.method === "POST" && c.path.endsWith("/fire"));
    expect(fires()).toHaveLength(1);
    expect(fires()[0].key).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => s.release());
    await t.settle();
    expect(t.host.querySelector("[data-firing]")?.textContent).toContain("Started");
    await act(async () => { t.button(/^Run now$/)!.click(); });
    await t.settle();
    expect(fires()).toHaveLength(2);
    expect(fires()[1].key).not.toBe(fires()[0].key);
    await act(async () => s.release());
  });
  it("deletes after a confirm, and goes back to the list", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: "trg_1" });
    await t.click(/^Delete$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await t.click(/^Yes, delete$/);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v2/triggers/trg_1"]);
    expect(t.went).toEqual(["#/triggers"]);
  });
});

describe("editing a schedule", () => {
  // A schedule with no cap of its own (the agent's default applies) edits like any other: its cap stays left out.
  it("saves a name alone on a schedule with no cap of its own", async () => {
    const own: Trigger = { ...NIGHTLY, target: { kind: "start_run", agent_id: "story", input: { content: "Say hello." } } };
    const { v2, calls } = server({ triggers: [own] });
    const t = await open(v2, { trigger: "trg_1", edit: true });
    expect((t.host.querySelector('[name="maxCost"]') as HTMLInputElement).value).toBe("");
    await t.set("name", "nightly");
    await t.click(/^Save changes$/);
    expect(t.issue("target.max_cost_usd")).toBeNull();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ name: "nightly" }]);
  });
  // The server starts a schedule again from now whenever an edit names its source: an edit of the name alone must not.
  it("saves a name alone with no source in the PATCH, so the schedule keeps its times", async () => {
    // A start the server set when it was made (to the second) reads back to the second.
    const every: Trigger = { ...NIGHTLY, source: { kind: "schedule", every_s: 300, start_at: "2026-11-04T00:07:31Z" } };
    const { v2, calls } = server({ triggers: [every] });
    const t = await open(v2, { trigger: "trg_1", edit: true });
    await t.set("name", "nightly");
    expect(t.text()).not.toContain("Changing when restarts the schedule from now.");
    await t.click(/^Save changes$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ name: "nightly" }]);
  });
  // The hint under a time says the instant the save sends: for a time left alone in a clock change's repeated hour, the
  // instant it was read with, not the first pass its wall time reads as.
  it("says under a time left alone the instant the save keeps", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const once: Trigger = { ...NIGHTLY, source: { kind: "schedule", at: "2027-11-07T09:30:00Z" } };
    const t = await open(server({ triggers: [once] }).v2, { trigger: "trg_1", edit: true });
    expect(t.text()).toContain("= Nov 7, 9:30 AM UTC");
    act(() => root?.unmount());
    const every: Trigger = { ...NIGHTLY, source: { kind: "schedule", every_s: 300, start_at: "2027-11-07T09:30:00Z" } };
    const u = await open(server({ triggers: [every] }).v2, { trigger: "trg_1", edit: true });
    expect(u.text()).toContain("= Nov 7, 9:30 AM UTC");
  });
  it("says a changed when restarts the schedule from now", async () => {
    const t = await open(server().v2, { trigger: "trg_1", edit: true });
    await t.set("cron", "0 2 * * *");
    expect(t.text()).toContain("Changing when restarts the schedule from now.");
  });
  it("opens with its fields, and saves only what changed", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { trigger: "trg_1", edit: true });
    expect((t.host.querySelector('[name="cron"]') as HTMLInputElement).value).toBe("30 1 * * *");
    expect((t.host.querySelector('[name="maxCost"]') as HTMLInputElement).value).toBe("2");
    await t.set("maxCost", "3");
    await t.click(/^Save changes$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 3 } }]);
    expect(t.went).toEqual(["#/triggers/trg_1"]);
  });
});

// Tester findings on the New schedule form (11-09): an empty cost cap means the agent's own default, so the field's
// placeholder says that default as served (definition.max_cost_usd), never a made-up example; and a one time is to the
// minute, so its field asks for no seconds.
describe("the New schedule form's cost cap and one time", () => {
  const cap = (host: Element) => host.querySelector<HTMLInputElement>('input[name="maxCost"]')!;

  it("an agent with a default cap: the cap field's placeholder is that default, as money", async () => {
    const t = await open(server().v2, { trigger: null });
    await t.set("agent", "story");
    expect(cap(t.host).getAttribute("placeholder")).toBe("$0.50, the agent's default");
  });

  it("an agent with none: no placeholder at all, never an example", async () => {
    const t = await open(server().v2, { trigger: null });
    expect(cap(t.host).hasAttribute("placeholder")).toBe(false);
    await t.set("agent", "triage");
    expect(cap(t.host).hasAttribute("placeholder")).toBe(false);
  });

  it("a one time and an interval's start are to the minute; the time sent keeps its shape", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null });
    await t.choose("at");
    expect(t.host.querySelector<HTMLInputElement>('input[name="at"]')!.step).toBe("60");
    await t.set("name", "kyb-once");
    await t.set("at", "2026-11-09T15:43");
    await t.set("agent", "triage");
    await t.set("content", "Run KYB.");
    await t.set("maxCost", "2");
    await t.click(/^Create schedule$/);
    expect((s.calls.find((c) => c.method === "POST")!.body as { source: unknown }).source).toEqual({ kind: "schedule", at: "2026-11-09T15:43:00Z" });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const every = await open(server().v2, { trigger: null });
    await every.choose("every");
    expect(every.host.querySelector<HTMLInputElement>('input[name="startAt"]')!.step).toBe("60");
  });

  it("the webhook form says the agent's default the same way (the GitHub form shares the helper)", async () => {
    const t = await open(server().v2, { trigger: null, kind: "webhook" });
    await t.set("agent", "story");
    expect(cap(t.host).getAttribute("placeholder")).toBe("$0.50, the agent's default");
  });

  it("the cap field is wide enough for its placeholder (16rem: 26 characters of 13px monospace and the padding)", async () => {
    const t = await open(server().v2, { trigger: null });
    await t.set("agent", "story");
    expect(cap(t.host).classList.contains("max-w-64")).toBe(true);
    expect(cap(t.host).classList.contains("max-w-40")).toBe(false);
  });
});

// A one-time schedule that has run (its source is a one time `at`, it has a last firing, and no next time) is done: it
// reads "Done · ran <when>" on the list and its page, with no Resume. A paused recurring schedule keeps Resume: done is
// never read from `enabled` alone.
describe("a one-time schedule that has run", () => {
  const ONCE: Trigger = { ...NIGHTLY, id: "trg_once", name: "kyb-once", enabled: false, next_at: null, source: { kind: "schedule", at: "2026-11-09T20:43:00Z" }, last_firing: firing({ nominal_at: "2026-11-09T20:43:00Z", at: "2026-11-09T20:43:01Z" }) };
  const PAUSED: Trigger = { ...NIGHTLY, id: "trg_paused", name: "nightly, paused", enabled: false, next_at: null, last_firing: firing({}) };

  it("reads Done with when it ran on the list, never Paused or no next time", async () => {
    const t = await open(server({ triggers: [ONCE, PAUSED] }).v2, {});
    const once = t.host.querySelector('[data-trigger="trg_once"]')!;
    expect(once.textContent).toContain("Done · ran Nov 9, 8:43 PM");
    expect(once.textContent).not.toContain("Paused");
    expect(once.textContent).not.toContain("No next time");
    expect(t.host.querySelector('[data-trigger="trg_paused"]')!.textContent).toContain("Paused");
  });

  it("on its page: Done with when it ran, no Resume or Pause; Delete stays", async () => {
    const t = await open(server({ triggers: [ONCE] }).v2, { trigger: "trg_once" });
    expect(t.text()).toContain("Done · ran Nov 9, 8:43 PM");
    expect(t.text()).not.toContain("no next time");
    expect(t.button(/^(Resume|Pause)$/)).toBeUndefined();
    expect(t.button(/^Delete$/)).toBeDefined();
  });

  it("a one time still to come (edited to a new time, or run by hand) is not done and keeps Resume", async () => {
    const future: Trigger[] = [
      // Edited to a new time after it ran: its last firing is for the old time.
      { ...ONCE, id: "trg_edited", source: { kind: "schedule", at: "2026-11-20T09:00:00Z" } },
      // A paused one time in the future, run by hand.
      { ...ONCE, id: "trg_manual", source: { kind: "schedule", at: "2026-11-20T09:00:00Z" }, last_firing: firing({ by: "manual", nominal_at: "2026-11-09T21:00:00Z" }) },
    ];
    const list = await open(server({ triggers: future }).v2, {});
    for (const t of future) expect(list.host.querySelector(`[data-trigger="${t.id}"]`)!.textContent).not.toMatch(/Done|time passed/);
    act(() => root?.unmount()); document.body.innerHTML = "";
    for (const t of future) {
      const page = await open(server({ triggers: [t] }).v2, { trigger: t.id });
      expect(page.button(/^Resume$/), t.id).toBeDefined();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("a one time whose time passed by the page's clock with no run known (its firing due or failed) never reads ran, and keeps Resume: only the server's started firing hides it", async () => {
    const passed: Trigger[] = [
      { ...ONCE, id: "trg_due", last_firing: firing({ nominal_at: "2026-11-09T20:43:00Z", status: "due" }) },
      { ...ONCE, id: "trg_failed", last_firing: firing({ nominal_at: "2026-11-09T20:43:00Z", status: "failed", error: { code: "run_failed", message: "no model" } }) },
    ];
    const list = await open(server({ triggers: passed }).v2, {});
    for (const t of passed) {
      const row = list.host.querySelector(`[data-trigger="${t.id}"]`)!.textContent;
      expect(row).not.toContain("Done · ran");
      expect(row).toContain("Its time passed");
    }
    act(() => root?.unmount()); document.body.innerHTML = "";
    for (const t of passed) {
      const page = await open(server({ triggers: [t] }).v2, { trigger: t.id });
      expect(page.text()).not.toContain("Done · ran");
      // The browser's clock may run ahead of the server's: Resume stays where only it says the time passed.
      expect(page.button(/^Resume$/), t.id).toBeDefined();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("run by hand after it was done: its page still reads Done from its firings (no Resume); the list says its time passed", async () => {
    const scheduled = firing({ key: "fir_s", nominal_at: "2026-11-09T20:43:00Z", at: "2026-11-09T20:43:01Z" });
    const manual = firing({ key: "fir_m", by: "manual", nominal_at: "2026-11-09T22:00:00Z", at: "2026-11-09T22:00:01Z" });
    const after: Trigger = { ...ONCE, last_firing: manual };
    const page = await open(server({ triggers: [after], firings: { trg_once: [manual, scheduled] } }).v2, { trigger: "trg_once" });
    expect(page.text()).toContain("Done · ran Nov 9, 8:43 PM");
    expect(page.button(/^(Resume|Pause)$/)).toBeUndefined();
    act(() => root?.unmount()); document.body.innerHTML = "";
    const list = await open(server({ triggers: [after] }).v2, {});
    const row = list.host.querySelector('[data-trigger="trg_once"]')!.textContent;
    expect(row).toContain("Its time passed");
    expect(row).not.toContain("Paused");
  });

  it("a paused recurring schedule keeps Resume", async () => {
    const t = await open(server({ triggers: [PAUSED] }).v2, { trigger: "trg_paused" });
    expect(t.button(/^Resume$/)).toBeDefined();
    expect(t.text()).not.toContain("Done");
  });
});
