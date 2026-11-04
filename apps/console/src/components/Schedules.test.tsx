import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulesPage, type ScheduleView } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";

// Schedules (serve's trigger/1): the list, the form that makes or edits one with the server's 422 under the field it
// names, and one schedule's page: pause, resume, edit, delete, run now (once per click), and its firings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T09:30:00Z", overlap: "skip",
  last_firing: { key: "fir_a", by: "schedule", nominal_at: "2026-11-04T09:30:00Z", status: "skipped", at: "2026-11-04T09:30:01Z", run_id: null, reason: "The last run is still working.", error: null },
};
const firing = (over: Partial<Firing>): Firing => ({ key: "fir_x", by: "schedule", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: null, reason: null, error: null, ...over });
const AGENTS = [
  { agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null },
  { agent_id: "flow", kind: "workflow", definition: { name: "Refund flow" }, archived_at: null },
];

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (fields: { field: string; reason: string; message: string }[]) => json(422, { error: { code: "input_invalid", message: fields[0].message, retryable: false, fields } });

/** A server with `triggers` and their `firings`: a create or an edit answers `write` when given, else takes it; a run
 *  now answers once `release` is called (so a second click lands while the first is out). */
function server({ triggers = [NIGHTLY], firings = {} as Record<string, Firing[]>, write }: { triggers?: Trigger[]; firings?: Record<string, Firing[]>; write?: (call: Call) => Response | undefined } = {}) {
  const calls: Call[] = [];
  let release: () => void = () => {};
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    const m = /^\/v2\/triggers\/([^/]+)(\/fire|\/firings)?$/.exec(call.path);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
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
      return json(200, t);
    }
    if (m?.[2] === "/firings") return json(200, { firings: firings[decodeURIComponent(m[1])] ?? [] });
    if (m?.[2] === "/fire") {
      await new Promise<void>((r) => { release = r; });
      const made = firing({ key: `fir_${call.key}`, by: "manual", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b" });
      firings[m[1]] = [made, ...(firings[m[1]] ?? [])];
      return json(202, made);
    }
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, release: () => release() };
}

let root: ReturnType<typeof createRoot> | undefined;
// A one-time "at" is typed in the browser's own zone: the tests pin it.
beforeEach(() => { vi.stubEnv("TZ", "UTC"); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllEnvs(); });

async function open(v2: ReturnType<typeof createClient>, view: ScheduleView, minEvery?: number) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  const agentName = (id: string) => (id === "triage" ? "Triage" : id);
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName, minEvery })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const field = (name: string) => host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const set = async (name: string, value: string) => {
    const el = field(name);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  const choose = async (kind: string) => { await act(async () => { (host.querySelector(`input[name="kind"][value="${kind}"]`) as HTMLInputElement).click(); }); };
  const issue = (field: string) => host.querySelector(`[data-issue="${field}"]`)?.textContent ?? null;
  return { host, went, button, click, set, choose, issue, settle, text: () => host.textContent ?? "" };
}

describe("the schedules list", () => {
  it("names each schedule, its agent, when it fires, its next time, whether it is paused, and how its last firing went", async () => {
    const paused: Trigger = { ...NIGHTLY, id: "trg_2", name: "every five", enabled: false, next_at: null, source: { kind: "schedule", every_s: 300, start_at: "2026-11-04T00:00:00Z" }, last_firing: null };
    const t = await open(server({ triggers: [NIGHTLY, paused] }).v2, {});
    const rows = [...t.host.querySelectorAll("[data-schedule]")];
    expect(rows.map((r) => r.getAttribute("data-schedule"))).toEqual(["trg_1", "trg_2"]);
    expect(rows[0].textContent).toContain("nightly triage");
    expect(rows[0].textContent).toContain("Triage");
    expect(rows[0].textContent).toContain("Cron 30 1 * * * · America/Los_Angeles");
    expect(rows[0].textContent).toContain("Nov 5, 9:30 AM");
    expect(rows[0].textContent).toContain("Skipped: The last run is still working.");
    expect(rows[0].querySelector('a[href="#/schedules/trg_1"]')).not.toBeNull();
    expect(rows[1].textContent).toContain("Every 5 minutes");
    expect(rows[1].textContent).toContain("Paused");
    expect(rows[1].textContent).toContain("Not fired yet");
    await t.click(/^New schedule$/);
    expect(t.went).toEqual(["#/schedules/new"]);
  });
  it("says there are none yet, with the way to make one", async () => {
    const t = await open(server({ triggers: [] }).v2, {});
    expect(t.text()).toContain("No schedules yet.");
    expect(t.button(/^New schedule$/)).toBeTruthy();
  });
});

describe("a new schedule", () => {
  it("sends the cron line in its zone, the agent, the input and the cap, then opens the schedule", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { schedule: null });
    await t.set("name", "nightly triage");
    await t.set("cron", "30 1 * * *");
    await t.set("timezone", "America/Los_Angeles");
    await t.set("agent", "triage");
    await t.set("content", "Triage last night's issues.");
    await t.set("maxCost", "2");
    await t.click(/^Create schedule$/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/triggers", key: null, body: {
      name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
      target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
    } }]);
    expect(t.went).toEqual(["#/schedules/trg_new"]);
  });
  it("sends every N minutes, or one time, as the kind picked", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { schedule: null });
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
    const t = await open(v2, { schedule: null });
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
    const t = await open(server().v2, { schedule: null }, 120);
    await t.choose("every");
    expect(t.text()).toContain("At least 2 minutes.");
  });
  it("says a missing cap under its field and sends nothing", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { schedule: null });
    await t.set("cron", "30 1 * * *");
    await t.set("agent", "triage");
    await t.set("content", "Triage.");
    await t.click(/^Create schedule$/);
    expect(t.issue("target.max_cost_usd")).toBe("A cost cap is needed: every run a schedule starts is capped.");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
  it("shows each issue of the server's 422 under the field it names: a workflow agent under the agent", async () => {
    const message = "A trigger's runs are capped, and a workflow run's spend is not capped here: name an agent that is not a workflow.";
    const { v2 } = server({ write: () => refuse([{ field: "target.agent_id", reason: "not_allowed", message }, { field: "source.cron", reason: "invalid", message: "cron is five fields" }]) });
    const t = await open(v2, { schedule: null });
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
    const t = await open(server({ firings }).v2, { schedule: "trg_1" });
    expect(t.text()).toContain("nightly triage");
    expect(t.text()).toContain("Cron 30 1 * * * · America/Los_Angeles");
    const rows = [...t.host.querySelectorAll("[data-firing]")];
    expect(rows.map((r) => r.getAttribute("data-firing"))).toEqual(["f3", "f2", "f1"]);
    expect(rows[0].textContent).toContain("Started");
    expect(rows[0].textContent).toContain("Run now");
    expect(rows[0].querySelector('a[href="#/runs/01a1a88f-5f5c-7ce4-a912-fb765b62e88b"]')?.textContent).toContain("62e88b");
    expect(rows[1].textContent).toContain("Missed 3 times: The server was down or its timer late.");
    expect(rows[2].textContent).toContain("Failed: No model.");
  });
  it("pauses and resumes by enabled alone", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { schedule: "trg_1" });
    await t.click(/^Pause$/);
    await t.click(/^Resume$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
  });
  it("runs now once per click: a second click while the first is out sends nothing, the next click a new key", async () => {
    const s = server();
    const t = await open(s.v2, { schedule: "trg_1" });
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
    const t = await open(v2, { schedule: "trg_1" });
    await t.click(/^Delete$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await t.click(/^Yes, delete$/);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v2/triggers/trg_1"]);
    expect(t.went).toEqual(["#/schedules"]);
  });
});

describe("editing a schedule", () => {
  // The server starts a schedule again from now whenever an edit names its source: an edit of the name alone must not.
  it("saves a name alone with no source in the PATCH, so the schedule keeps its times", async () => {
    const every: Trigger = { ...NIGHTLY, source: { kind: "schedule", every_s: 300, start_at: "2026-11-04T00:07:00Z" } };
    const { v2, calls } = server({ triggers: [every] });
    const t = await open(v2, { schedule: "trg_1", edit: true });
    await t.set("name", "nightly");
    expect(t.text()).not.toContain("Changing when restarts the schedule from now.");
    await t.click(/^Save changes$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ name: "nightly" }]);
  });
  it("says a changed when restarts the schedule from now", async () => {
    const t = await open(server().v2, { schedule: "trg_1", edit: true });
    await t.set("cron", "0 2 * * *");
    expect(t.text()).toContain("Changing when restarts the schedule from now.");
  });
  it("opens with its fields, and saves only what changed", async () => {
    const { v2, calls } = server();
    const t = await open(v2, { schedule: "trg_1", edit: true });
    expect((t.host.querySelector('[name="cron"]') as HTMLInputElement).value).toBe("30 1 * * *");
    expect((t.host.querySelector('[name="maxCost"]') as HTMLInputElement).value).toBe("2");
    await t.set("maxCost", "3");
    await t.click(/^Save changes$/);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 3 } }]);
    expect(t.went).toEqual(["#/schedules/trg_1"]);
  });
});
