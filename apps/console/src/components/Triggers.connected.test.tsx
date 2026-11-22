import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage, type ScheduleView } from "./Schedules";
import { createClient } from "@/lib/client";
import { CONNECTED_NO_CAP } from "@/lib/schedules";
import type { Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// A trigger that starts a connected agent (its definition names a `native` source) takes no cost cap and no effort: the
// server refuses either on its target (422 not_allowed, serve's trigger target check), since the agent's own CLI keeps
// its limits. So every trigger form asks such an agent for no cap, says why, and sends none; for any other agent each
// form asks for the cap as it always has.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NATIVE = { runtime: "codex", project: "app", selector: { kind: "project" }, machine_id: "source", connected: true, state: "ready", capabilities: { launch: true }, issues: [] };
const AGENTS = [
  { agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null },
  { agent_id: "local", kind: "agentic", definition: { name: "Local", native: NATIVE }, archived_at: null },
];
const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", every_s: 300, start_at: "2026-11-04T00:00:00Z" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2, effort: "high" },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T01:30:00Z", last_firing: null,
};
const ON_LOCAL: Trigger = { ...NIGHTLY, id: "trg_l", name: "local sweep", target: { kind: "start_run", agent_id: "local", input: { content: "Sweep." } } };
const EVENT = { slug: "GITHUB_ISSUE_ADDED_EVENT", name: "Issue Added Event", description: "A new issue.", polled: false, config: { type: "object", required: ["repo"], properties: { repo: { type: "string", title: "Repo" } } } };
const COMPOSIO = { name: "gh", url: "https://backend.composio.test/v3/mcp/srv_1/mcp", auth: { type: "headers", headers: ["x-api-key"] }, source: "composio", toolkit: "github", credential: "sealed", tools: [], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" };

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// `down`: the agents whose own read (GET /v2/agents/{id}) fails.
function server({ down = [] as string[] } = {}) {
  const calls: Call[] = [];
  const triggers = [NIGHTLY, ON_LOCAL].map((t) => structuredClone(t));
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    const agent = /^\/v2\/agents\/([^/]+)$/.exec(call.path);
    if (agent && down.includes(agent[1]!)) return json(503, { error: { code: "unavailable", message: "try again", retryable: true } });
    if (agent) return json(200, AGENTS.find((a) => a.agent_id === agent[1]));
    if (call.path === "/v2/integrations/github") return json(200, { app_id: "1", slug: "agentrun-test", installations: [{ id: 7, account: "acme" }] });
    if (call.path === "/v2/settings/mcp-servers") return json(200, { servers: [COMPOSIO] });
    if (call.path === "/v2/settings/mcp-servers/gh/composio/events") return json(200, { server: "gh", toolkit: "github", events: [EVENT] });
    if (call.path === "/v2/triggers" && call.method === "POST") return json(201, { ...NIGHTLY, ...(call.body as object), id: "trg_new" });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === m[1]);
    if (m?.[2]) return json(200, { firings: [] });
    if (t && call.method === "PATCH") { Object.assign(t, call.body); return json(200, t); }
    if (t) return json(200, t);
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  const sent = (method: string) => calls.filter((c) => c.method === method && c.path.startsWith("/v2/triggers")).map((c) => c.body as { target?: Record<string, unknown> });
  return { v2: createClient({ fetch }), sent, triggers };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, view: ScheduleView, refreshMs?: number) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName: (id: string) => id, ...(refreshMs ? { refreshMs } : {}) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const click = async (label: RegExp) => {
    const b = [...host.querySelectorAll("button")].find((x) => label.test((x.textContent ?? "").trim()));
    if (!b) throw new Error(`no button ${label}`);
    await act(async () => { b.click(); });
    await settle();
  };
  const set = async (name: string, value: string) => {
    const el = host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) throw new Error(`no field ${name}`);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const choose = async (label: string, value: string) => { await pick(picker(host, label)!, value); await settle(); };
  const issue = (field: string) => host.querySelector(`[data-issue="${field}"]`)?.textContent ?? null;
  return { host, went, click, set, choose, issue, settle, cap: () => host.querySelector('[name="maxCost"]'), noCap: () => host.querySelector("[data-no-cap]")?.textContent ?? null };
}
type Page = Awaited<ReturnType<typeof open>>;

/** Each form that makes a trigger: its page, its submit button, and its own fields filled (all but the agent and the cap). */
const FORMS: { kind: NonNullable<ScheduleView["kind"]>; submit: RegExp; needed: string; fill: (t: Page) => Promise<void> }[] = [
  { kind: "schedule", submit: /^Create schedule$/, needed: "A cost cap is needed: every run a schedule starts is capped.", fill: async (t) => { await act(async () => { (t.host.querySelector('input[name="kind"][value="every"]') as HTMLInputElement).click(); }); await t.set("every", "5"); } },
  { kind: "webhook", submit: /^Create webhook$/, needed: "A cost cap is needed: every run a webhook starts is capped.", fill: async () => {} },
  { kind: "github", submit: /^Create GitHub trigger$/, needed: "A cost cap is needed: every run a GitHub trigger starts is capped.", fill: async () => {} },
  { kind: "composio", submit: /^Create app trigger$/, needed: "A cost cap is needed: every run a trigger starts is capped.", fill: async (t) => { await t.choose("Composio server", "gh"); await t.choose("Event", EVENT.slug); await t.set("config-repo", "scratch"); } },
  { kind: "feed", submit: /^Create feed trigger$/, needed: "A cost cap is needed: every run a feed trigger starts is capped.", fill: async (t) => { await t.set("urls", "https://status.example.com/history.atom"); } },
  { kind: "email", submit: /^Create email trigger$/, needed: "A cost cap is needed: every run an email trigger starts is capped.", fill: async () => {} },
];

describe("Triggers: a connected agent takes no cost cap", () => {
  for (const form of FORMS) {
    it(`the new ${form.kind} form asks a connected agent for no cap, says why, and sends none`, async () => {
      const s = server();
      const t = await open(s.v2, { trigger: null, kind: form.kind });
      await form.fill(t);
      await t.set("content", "Look.");
      // A cap typed for another agent, and what was said of its cap, go with the field: neither reaches a connected one.
      await t.choose("Agent", "triage");
      await t.click(form.submit);
      expect(t.issue("target.max_cost_usd")).toBe(form.needed);
      await t.set("maxCost", "3");
      await t.choose("Agent", "local");
      expect(t.cap()).toBeNull();
      expect(t.noCap()).toBe(CONNECTED_NO_CAP);
      expect(t.issue("target.max_cost_usd")).toBeNull();
      await t.click(form.submit);
      expect(t.issue("target.max_cost_usd")).toBeNull();
      const [made] = s.sent("POST");
      expect(made!.target).toEqual({ kind: "start_run", agent_id: "local", input: { content: "Look." } });
    });

    it(`the new ${form.kind} form still requires a cap of an agent that is not connected`, async () => {
      const s = server();
      const t = await open(s.v2, { trigger: null, kind: form.kind });
      await form.fill(t);
      await t.set("content", "Look.");
      await t.choose("Agent", "triage");
      expect(t.noCap()).toBeNull();
      await t.click(form.submit);
      expect(t.issue("target.max_cost_usd")).toBe(form.needed);
      expect(s.sent("POST")).toEqual([]);
      await t.set("maxCost", "3");
      await t.click(form.submit);
      expect(s.sent("POST")[0]!.target).toEqual({ kind: "start_run", agent_id: "triage", input: { content: "Look." }, max_cost_usd: 3 });
    });
  }

  it("a schedule edited onto a connected agent drops its cap and its effort", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1", edit: true });
    expect((t.cap() as HTMLInputElement).value).toBe("2");
    await t.choose("Agent", "local");
    expect(t.cap()).toBeNull();
    await t.click(/^Save changes$/);
    expect(s.sent("PATCH")).toEqual([{ target: { kind: "start_run", agent_id: "local", input: { content: "Triage last night's issues." } } }]);
  });

  it("a schedule edited on its own agent keeps the effort the form does not show", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1", edit: true });
    await t.set("maxCost", "4");
    await t.click(/^Save changes$/);
    expect(s.sent("PATCH")).toEqual([{ target: { ...NIGHTLY.target, max_cost_usd: 4 } }]);
  });

  it("a trigger's page says a connected agent's runs have no cap, never the agent's default", async () => {
    const t = await open(server().v2, { trigger: "trg_l" });
    expect(t.noCap()).toBe(CONNECTED_NO_CAP);
    expect(t.host.textContent).not.toContain("Agent's default");
  });

  it("a trigger's page stops saying so once the trigger starts another agent, even while that agent cannot be read", async () => {
    const s = server({ down: ["triage"] });
    const t = await open(s.v2, { trigger: "trg_l" }, 5);
    expect(t.noCap()).toBe(CONNECTED_NO_CAP);
    // Changed elsewhere: the page's next read finds the trigger on an agent that is not connected.
    s.triggers.find((x) => x.id === "trg_l")!.target = { kind: "start_run", agent_id: "triage", input: { content: "Sweep." } };
    await new Promise((r) => setTimeout(r, 30));
    await t.settle();
    expect(t.noCap()).toBeNull();
    expect(t.host.textContent).toContain("Agent's default");
  });
});
