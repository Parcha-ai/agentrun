import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// Triggers of every kind (serve's trigger/1): the list shows schedules and webhooks side by side; a webhook is made
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
const fired = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "webhook", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", reason: null, error: null, ...over });
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
    if (call.path === "/v2/triggers" && call.method === "POST") return create ? create(call) : json(201, { ...HOOK, ...(call.body as object), id: "trg_new", signing_secret: SECRET });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings|\/secret|\/fire)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
    if (m?.[2] === "/firings") return json(200, { firings: [fired({})] });
    if (m?.[2] === "/secret") { await held; return json(200, { signing_secret: "CANARY-VALUE-0b2d4e6f" }); }
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
    // The agent is the console's Picker: picked as a person picks it.
    if (name === "agent") return pick(picker(host, "Agent")!, value);
    const el = host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { host, went, button, click, set, settle, text: () => host.textContent ?? "" };
}

describe("Triggers: schedules and webhooks", () => {
  it("lists every kind, each with its kind, and offers a new schedule and a new webhook", async () => {
    const t = await open(server().v2, {});
    expect(t.host.querySelector("h1")!.textContent).toBe("Triggers");
    const rows = [...t.host.querySelectorAll("[data-trigger]")];
    expect(rows.map((r) => r.getAttribute("data-trigger"))).toEqual(["trg_1", "trg_w"]);
    expect(rows[0]!.textContent).toContain("Schedule");
    expect(rows[1]!.textContent).toContain("Webhook");
    expect(rows[1]!.querySelector('a[href="#/triggers/trg_w"]')).not.toBeNull();
    await t.click(/^New webhook$/);
    expect(t.went).toEqual(["#/triggers/new-webhook"]);
  });

  it("makes a webhook with an Idempotency-Key, and shows its URL and secret once, each with Copy", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.set("name", "on deploy");
    await t.set("agent", "triage");
    await t.set("content", "Check the deploy.");
    await t.set("maxCost", "1");
    await t.click(/^Create webhook$/);
    const made = s.calls.find((c) => c.method === "POST" && c.path === "/v2/triggers")!;
    expect(made.key).toMatch(/.+/);
    expect(made.body).toMatchObject({ name: "on deploy", source: { kind: "webhook", signature: "standard" }, target: { kind: "start_run", agent_id: "triage", input: { content: "Check the deploy." }, max_cost_usd: 1 } });
    const shown = t.host.querySelector('[aria-label="The webhook\'s URL and secret"]')!;
    expect(shown.textContent).toContain(SECRET);
    expect(shown.textContent).toContain(`${location.origin}/v2/hooks/trg_new`);
    expect(shown.textContent).toContain("This server's address as this page sees it");
    expect(shown.textContent).toContain("You won't see this secret again.");
    await t.click(/^Copy secret$/);
    await t.click(/^Copy URL$/);
    expect(writes).toEqual([SECRET, `${location.origin}/v2/hooks/trg_new`]);
    await t.click(/^Done$/);
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });

  it("a retry under the same key answers a note in the secret's place: the page says it, never an empty secret", async () => {
    const note = "Its secret was shown once, on the first answer: POST /triggers/{trigger_id}/secret makes a new one.";
    const s = server({ create: (call) => json(201, { ...HOOK, ...(call.body as object), id: "trg_new", note }) });
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.set("name", "on deploy");
    await t.set("agent", "triage");
    await t.set("content", "Check the deploy.");
    await t.set("maxCost", "1");
    await t.click(/^Create webhook$/);
    expect(t.text()).toContain(note);
    expect(t.button(/^Copy secret$/)).toBeUndefined();
  });

  it("says a refused create in the server's words", async () => {
    const s = server({ create: () => json(409, { error: { code: "no_sealing_key", message: "This server was handed no seal key to keep a webhook trigger's secret under.", retryable: false } }) });
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.set("name", "on deploy");
    await t.set("agent", "triage");
    await t.set("content", "Check the deploy.");
    await t.set("maxCost", "1");
    await t.click(/^Create webhook$/);
    expect(t.text()).toContain("This server was handed no seal key to keep a webhook trigger's secret under.");
  });

  it("a webhook's page shows its URL and firings; Rotate secret shows the new one once; Pause and Delete act on it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_w" });
    expect(t.text()).toContain(`${location.origin}/v2/hooks/trg_w`);
    // Until the trigger read serves its hook URL, the page builds it from its own address and says so.
    expect(t.text()).toContain("This server's address as this page sees it");
    expect(t.host.querySelectorAll("[data-firing]")).toHaveLength(1);
    expect(t.host.querySelector("[data-firing]")!.textContent).toContain("On a request");
    await t.click(/^Rotate secret$/);
    // A confirm first: the old secret stops signing at once.
    expect(s.calls.some((c) => c.path === "/v2/triggers/trg_w/secret")).toBe(false);
    await t.click(/^Yes, make a new one$/);
    expect(s.calls.filter((c) => c.method === "POST" && c.path === "/v2/triggers/trg_w/secret")).toHaveLength(1);
    expect(t.text()).toContain("CANARY-VALUE-0b2d4e6f");
    expect(t.text()).toContain("You won't see this secret again.");
    await t.click(/^Pause$/);
    expect(s.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: false });
    await t.click(/^Delete$/);
    await t.click(/^Yes, delete$/);
    expect(s.calls.some((c) => c.method === "DELETE" && c.path === "/v2/triggers/trg_w")).toBe(true);
    expect(t.went).toContain("#/triggers");
  });

  it("one rotation at a time: a Run now that ends while a rotation is out leaves Rotate secret off until the new secret is in", async () => {
    let release!: () => void;
    const s = server({ held: new Promise<void>((r) => { release = r; }) });
    const t = await open(s.v2, { trigger: "trg_w" });
    await t.click(/^Rotate secret$/);
    await t.click(/^Yes, make a new one$/);
    await t.click(/^Run now$/);
    expect(s.calls.some((c) => c.path === "/v2/triggers/trg_w/fire")).toBe(true);
    expect(t.button(/^Rotate secret$/)!.disabled).toBe(true);
    await act(async () => { release(); });
    await t.settle();
    expect(s.calls.filter((c) => c.path === "/v2/triggers/trg_w/secret")).toHaveLength(1);
    expect(t.text()).toContain("CANARY-VALUE-0b2d4e6f");
    expect(t.button(/^Rotate secret$/)!.disabled).toBe(false);
  });

  it("a create sent again unchanged keeps its Idempotency-Key; an edited one gets a new key", async () => {
    const s = server({ create: () => json(503, { error: { code: "unavailable", message: "Try again.", retryable: true } }) });
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.set("name", "on deploy");
    await t.set("agent", "triage");
    await t.set("content", "Check the deploy.");
    await t.set("maxCost", "1");
    await t.click(/^Create webhook$/);
    await t.click(/^Create webhook$/);
    await t.set("name", "on release");
    await t.click(/^Create webhook$/);
    const keys = s.calls.filter((c) => c.method === "POST" && c.path === "/v2/triggers").map((c) => c.key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("with no clipboard (plain http on another host), Copy says to select the text instead of failing silently", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const t = await open(server().v2, { trigger: "trg_w" });
    await t.click(/^Copy URL$/);
    expect(t.text()).toContain("Select it and copy it");
  });

  it("the made page names the scheme the server saved, not the form's pick", async () => {
    const s = server({ create: (call) => json(201, { ...HOOK, ...(call.body as object), id: "trg_new", source: { kind: "webhook", signature: "github" }, signing_secret: SECRET }) });
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.set("name", "on deploy");
    await t.set("agent", "triage");
    await t.set("content", "Check the deploy.");
    await t.set("maxCost", "1");
    await t.click(/^Create webhook$/);
    expect(t.text()).toContain("signed with this secret (GitHub's (X-Hub-Signature-256))");
  });

  it("a webhook with accept filters says what it accepts, in the list and on its page, never that every signed request starts a run", async () => {
    const FILTERED: Trigger = { ...HOOK, id: "trg_f", name: "prod deploys", source: { kind: "webhook", signature: "standard", accept: [{ event: "deploy.finished", actions: ["succeeded"], where: [{ pointer: "/env", in: ["prod"] }, { pointer: "/ref", prefix: "refs/tags/" }] }] } };
    const list = await open(server({ triggers: [FILTERED] }).v2, {});
    const row = list.host.querySelector('[data-trigger="trg_f"]')!.textContent ?? "";
    expect(row).toContain("Only signed requests for deploy.finished (succeeded)");
    expect(row).not.toContain("On each signed request");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const page = await open(server({ triggers: [FILTERED] }).v2, { trigger: "trg_f" });
    expect(page.text()).toContain("deploy.finished (succeeded) where /env is one of \"prod\" and /ref starts with \"refs/tags/\"");
    expect(page.text()).not.toContain("on each signed request");
  });
});
