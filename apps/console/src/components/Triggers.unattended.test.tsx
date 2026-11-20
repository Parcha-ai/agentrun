import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// A trigger starts runs with no one there. A tool whose permission is ask parks such a run until someone answers, and
// a schedule's later firings are skipped while it waits (serve's triggers.ts); with accounts off no one can answer, so
// the call is refused at once (tool-gate.ts noApproverText). The trigger forms and the trigger's page say so when the
// picked agent has a tool that asks (GET /v2/agents/{id}'s tools, each with its permission in force), and offer Run
// unattended: the agent's approvals set to "never" (PUT /v2/agents/{id}/definition, as the agent editor saves it).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Tool = { name: string; permission: "allow" | "ask" | "deny"; permission_from: string; default_permission: string; permissions: string[] };
const tool = (name: string, permission: Tool["permission"]): Tool => ({ name, permission, permission_from: "default", default_permission: permission, permissions: ["allow", "ask", "deny"] });
type FakeAgent = { agent_id: string; kind: "agentic" | "workflow"; revision: string; revisions: number; archived_at: null; definition: Record<string, unknown>; tools: Tool[] };
const agentOf = (id: string, name: string, tools: Tool[], approvals?: "ask" | "never"): FakeAgent => ({
  agent_id: id, kind: "agentic", revision: `rev_${id}_1`, revisions: 1, archived_at: null, tools,
  definition: { name, instructions: "Do the task.", harness: "pi", tools: tools.map((t) => t.name), version: 1, ...(approvals ? { approvals } : {}) },
});

const MAILER = () => agentOf("mailer", "Mailer", [tool("web_search", "allow"), tool("mcp:gmail/send_email", "ask"), tool("mcp:github/create_issue", "ask")]);
const READER = () => agentOf("reader", "Reader", [tool("web_search", "allow"), tool("mcp:github/list_issues", "allow")]);
const UNATTENDED = () => agentOf("night", "Night shift", [tool("mcp:gmail/send_email", "ask")], "never");

const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly mail", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "UTC" },
  target: { kind: "start_run", agent_id: "mailer", input: { content: "Send the digest." }, max_cost_usd: 2 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T01:30:00Z", last_firing: null,
};

// The inbox assistant's new-mail trigger: an email trigger (made by a template's apply, through the API), its agent the
// mailer, whose email_send asks; its last check and the first check's note, as the server writes them.
const NEW_MAIL: Trigger = {
  id: "trg_mail", name: "new-mail", enabled: true, source: { kind: "email", account: "default", mailbox: "INBOX", every_s: 60 },
  target: { kind: "start_run", agent_id: "mailer", input: { content: "Sort the new mail." }, max_cost_usd: 0.5 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: "r_mail",
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T00:01:00Z", last_firing: null,
  last_check: { at: "2026-11-05T00:00:00Z", ok: true, message: "Watching INBOX: 3 messages." },
} as Trigger;
const MAIL_FIRINGS = [{ key: "f_mail", by: "email", status: "started", nominal_at: "2026-11-05T00:00:30Z", run_id: "r_mail", catch_up: false, reason: null }];

type Call = { method: string; path: string; body: unknown; ifMatch: string | null };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function server(agents: FakeAgent[] = [MAILER(), READER(), UNATTENDED()], { accounts = true }: { accounts?: boolean } = {}) {
  const calls: Call[] = [];
  const byId = new Map(agents.map((a) => [a.agent_id, structuredClone(a)]));
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init?.headers).get("if-match") };
    calls.push(call);
    if (call.path === "/v2/auth/session") return json(200, accounts ? { accounts: true, signed_in: true, setup_needed: false } : { accounts: false });
    if (call.path === "/v2/agents") return json(200, { agents: [...byId.values()].map(({ tools: _t, ...a }) => a), next_cursor: null });
    const a = /^\/v2\/agents\/([^/]+)(\/definition)?$/.exec(call.path);
    const agent = a && byId.get(decodeURIComponent(a[1]!));
    if (a && !agent) return json(404, { error: { code: "not_found", message: "no agent", retryable: false } });
    if (agent && a?.[2] && call.method === "PUT") {
      const definition = (call.body as { definition: Record<string, unknown> }).definition;
      agent.definition = definition;
      agent.revisions += 1;
      agent.revision = `rev_${agent.agent_id}_${agent.revisions}`;
      // Under approvals never the gate allows what would ask (tool-gate.ts permissionFrom's last step).
      if (definition.approvals === "never") agent.tools = agent.tools.map((t) => (t.permission === "ask" ? { ...t, permission: "allow", permission_from: "unattended" } : t));
      const { tools: _t, ...view } = agent;
      return json(200, { ...view, warnings: [] }, { etag: `"${agent.revision}"` });
    }
    if (agent) return json(200, agent, { etag: `"${agent.revision}"` });
    // A connected GitHub App, and one saved Composio server with no events: the GitHub and app forms show their agent picker.
    if (call.path === "/v2/integrations/github") return json(200, { app_id: "1", slug: "agentrun-test", installations: [{ id: 7, account: "acme" }] });
    if (call.path === "/v2/settings/mcp-servers") return json(200, { servers: [{ name: "gh", url: "https://backend.composio.test/mcp", auth: { type: "headers", headers: ["x-api-key"] }, source: "composio", toolkit: "github", credential: "sealed", tools: [], listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" }] });
    if (call.path === "/v2/settings/mcp-servers/gh/composio/events") return json(200, { events: [] });
    if (call.path === "/v2/settings/email") return json(200, { configured: true, preset: "gmail", address: "inbox@example.com", user: "inbox@example.com", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, password_unreadable: false });
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers: [NIGHTLY, NEW_MAIL] });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings)?$/.exec(call.path);
    if (m?.[2]) return json(200, { firings: decodeURIComponent(m[1]!) === NEW_MAIL.id ? MAIL_FIRINGS : [] });
    if (m && decodeURIComponent(m[1]!) === NIGHTLY.id) return json(200, NIGHTLY);
    if (m && decodeURIComponent(m[1]!) === NEW_MAIL.id) return json(200, NEW_MAIL);
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, byId };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, view: Parameters<typeof SchedulesPage>[0]["view"]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: () => {}, agentName: (id: string) => id })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const warning = () => host.querySelector<HTMLElement>("[data-unattended-warning]");
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const agent = async (id: string) => { await pick(picker(host, "Agent")!, id); await settle(); };
  // Every submit of the page's form, prevented so a submit can't leave the page: the fix must never submit the form.
  const submits: Event[] = [];
  host.addEventListener("submit", (e) => { submits.push(e); e.preventDefault(); }, true);
  return { host, warning, button, click, agent, submits };
}

// A schedule skips its later firings while a run is active; a trigger of a pushed or polled source may start more runs.
const WAITS = "A run from this trigger stops and waits for you when it calls mcp:gmail/send_email and mcp:github/create_issue; later firings are skipped while it waits.";
const WAITS_ONLY = "A run from this trigger stops and waits for you when it calls mcp:gmail/send_email and mcp:github/create_issue.";
const REFUSED = "A run from this trigger is refused each call of mcp:gmail/send_email and mcp:github/create_issue: each needs your approval, and this server has accounts off, so no one can give it.";
const FIX = "Run unattended: this agent's tools run without asking when no one is there.";

describe("Triggers: an agent whose tools ask", () => {
  it("a new schedule for an agent with a tool that asks warns, naming each tool that asks", async () => {
    const t = await open(server().v2, { trigger: null });
    expect(t.warning()).toBeNull();
    await t.agent("mailer");
    const shown = t.warning();
    expect(shown).not.toBeNull();
    expect(shown!.textContent).toContain("Waits for your approval");
    expect(shown!.textContent).toContain(WAITS);
    expect(shown!.textContent).toContain(FIX);
    // A tool that runs (allow) is not named.
    expect(shown!.textContent).not.toContain("web_search");
    expect(t.button(/^Run unattended$/)).toBeDefined();
  });

  it("Run unattended saves the agent with approvals never, on the revision it read, and the warning goes", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null });
    await t.agent("mailer");
    await t.click(/^Run unattended$/);
    const put = s.calls.find((c) => c.method === "PUT" && c.path === "/v2/agents/mailer/definition");
    expect(put).toBeDefined();
    expect(put!.ifMatch).toBe('"rev_mailer_1"');
    const sent = (put!.body as { definition: Record<string, unknown> }).definition;
    expect(sent.approvals).toBe("never");
    // Every other field of the definition is kept as it was.
    expect(sent).toMatchObject({ name: "Mailer", instructions: "Do the task.", harness: "pi", tools: ["web_search", "mcp:gmail/send_email", "mcp:github/create_issue"] });
    expect(s.byId.get("mailer")!.definition.approvals).toBe("never");
    expect(t.warning()).toBeNull();
    // The schedule itself is not made by the fix: the form was not submitted, and nothing was posted.
    expect(t.submits).toHaveLength(0);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Run unattended never submits a trigger form, filled in or not", async () => {
    for (const kind of ["schedule", "webhook", "github", "composio", "feed"] as const) {
      const s = server();
      const t = await open(s.v2, kind === "schedule" ? { trigger: null } : { trigger: null, kind });
      await t.agent("mailer");
      // The form's own fields filled in where the form has them, so a submit would get as far as a save.
      const content = t.host.querySelector<HTMLTextAreaElement>("textarea[name=content]");
      if (content) await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; set.call(content, "Send the digest."); content.dispatchEvent(new Event("input", { bubbles: true })); });
      await t.click(/^Run unattended$/);
      expect(t.button(/^Run unattended$/)?.type ?? "button", kind).toBe("button");
      expect(t.submits, kind).toHaveLength(0);
      expect(s.calls.filter((c) => c.method === "POST").map((c) => c.path), kind).toEqual([]);
      expect(s.byId.get("mailer")!.definition.approvals, kind).toBe("never");
      act(() => root?.unmount());
      document.body.innerHTML = "";
    }
  });

  it("with accounts off, says each call is refused rather than waiting, and the same fix clears it", async () => {
    const s = server(undefined, { accounts: false });
    const t = await open(s.v2, { trigger: null });
    await t.agent("mailer");
    const shown = t.warning();
    expect(shown?.textContent).toContain("Refused without your approval");
    expect(shown?.textContent).toContain(REFUSED);
    expect(shown?.textContent).not.toContain("waits for you");
    expect(shown?.textContent).toContain(FIX);
    await t.click(/^Run unattended$/);
    expect(s.byId.get("mailer")!.definition.approvals).toBe("never");
    expect(t.warning()).toBeNull();
  });

  it("says nothing for an agent that already runs unattended, or whose tools all run", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null });
    await t.agent("night");
    expect(s.calls.some((c) => c.path === "/v2/agents/night")).toBe(true);
    expect(t.warning()).toBeNull();
    await t.agent("reader");
    expect(s.calls.some((c) => c.path === "/v2/agents/reader")).toBe(true);
    expect(t.warning()).toBeNull();
    // Picking the agent that asks after one that doesn't shows it; picking away hides it again.
    await t.agent("mailer");
    expect(t.warning()).not.toBeNull();
    await t.agent("reader");
    expect(t.warning()).toBeNull();
  });

  it("the webhook, GitHub, app and feed forms warn the same way, without claiming later firings are skipped", async () => {
    for (const kind of ["webhook", "github", "composio", "feed"] as const) {
      const t = await open(server().v2, { trigger: null, kind });
      await t.agent("mailer");
      expect(t.warning()?.textContent, kind).toContain(WAITS_ONLY);
      expect(t.warning()?.textContent, kind).not.toContain("skipped");
      act(() => root?.unmount());
      document.body.innerHTML = "";
    }
  });

  it("the trigger's page warns while its agent has a tool that asks, and Run unattended clears it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_1" });
    expect(t.warning()?.textContent).toContain(WAITS);
    await t.click(/^Run unattended$/);
    expect(s.byId.get("mailer")!.definition.approvals).toBe("never");
    expect(t.warning()).toBeNull();
  });

  it("an email trigger's page opens: what it watches, its agent and runs, and the warning naming the tools that ask", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: NEW_MAIL.id });
    expect(t.host.textContent).not.toContain("this page doesn't open it yet");
    expect(t.host.querySelector("h1")!.textContent).toBe("new-mail");
    expect(t.host.textContent).toContain("Email · On each email in INBOX");
    const dl = t.host.querySelector("dl")!;
    expect(dl.querySelector("[data-mail-account]")!.textContent).toContain("inbox@example.com");
    expect(dl.textContent).toContain("INBOX");
    expect(dl.textContent).toContain("Every minute");
    expect(dl.querySelector('a[href="#/agents/mailer"]')!.textContent).toBe("mailer");
    expect(t.host.querySelector('section[aria-label="Last check"]')!.textContent).toContain("Watching INBOX: 3 messages.");
    expect(t.host.querySelector('[data-firing="f_mail"]')!.textContent).toContain("On an email");
    expect(t.host.querySelector('[data-firing="f_mail"] a[href="#/runs/r_mail"]')).not.toBeNull();
    // No editor for an email trigger here: Pause, Run now and Delete only.
    expect(t.button(/^Edit/)).toBeUndefined();
    expect(t.button(/^Pause$/)).toBeDefined();
    // The warning, as the other kinds' pages say it: a polled source's later mail is not said to be skipped.
    expect(t.warning()?.textContent).toContain("Waits for your approval");
    expect(t.warning()?.textContent).toContain(WAITS_ONLY);
    expect(t.warning()?.textContent).toContain(FIX);
  });

  it("an email trigger's Run unattended saves the agent with approvals never, and the warning goes", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: NEW_MAIL.id });
    await t.click(/^Run unattended$/);
    const put = s.calls.find((c) => c.method === "PUT" && c.path === "/v2/agents/mailer/definition");
    expect(put?.ifMatch).toBe('"rev_mailer_1"');
    expect((put!.body as { definition: Record<string, unknown> }).definition.approvals).toBe("never");
    expect(s.byId.get("mailer")!.definition.approvals).toBe("never");
    expect(t.warning()).toBeNull();
  });

  it("an email trigger's page with accounts off says each call is refused", async () => {
    const t = await open(server(undefined, { accounts: false }).v2, { trigger: NEW_MAIL.id });
    expect(t.warning()?.textContent).toContain("Refused without your approval");
    expect(t.warning()?.textContent).toContain(REFUSED);
  });

  it("the trigger's page says nothing for an agent that runs unattended", async () => {
    const s = server([{ ...UNATTENDED(), agent_id: "mailer" }]);
    const t = await open(s.v2, { trigger: "trg_1" });
    expect(s.calls.some((c) => c.path === "/v2/agents/mailer")).toBe(true);
    expect(t.warning()).toBeNull();
  });
});
