import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// A webhook or GitHub trigger's filter (serve's trigger-accept.ts): `accept` rules, each an event, its actions and
// conditions on the body (a JSON pointer and one test: `in`, `prefix`, `exists`). The webhook form takes an optional
// filter, the GitHub form adds conditions to its picked events, and a trigger's page edits its filter with a PATCH of its
// source (its kind and signature as they were). The console checks the filter's shape and limits; a 422 says each issue
// under the field it names, in the server's words.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: Trigger = {
  id: "trg_w", name: "on issue", enabled: true, source: { kind: "webhook", signature: "standard" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Look at the issue." }, max_cost_usd: 1 },
  catchup_window_s: 0, max_active_runs: null, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: null, last_firing: null,
};
const FILTERED: Trigger = {
  ...BASE, id: "trg_f", name: "on push", source: { kind: "webhook", signature: "github", accept: [{ event: "push", where: [{ pointer: "/ref", in: ["refs/heads/main"] }] }] },
};
const PRS: Trigger = {
  ...BASE, id: "trg_g", name: "review PRs",
  source: { kind: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"] }, { event: "issues", actions: ["opened"] }] },
};
const fired = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "webhook", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", reason: null, error: null, ...over });
const AGENTS = [{ agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null }];

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server({ triggers = [BASE, FILTERED, PRS], create, patch }: { triggers?: Trigger[]; create?: (call: Call) => Response; patch?: (call: Call) => Response | Promise<Response> | undefined } = {}) {
  const calls: Call[] = [];
  triggers = triggers.map((t) => structuredClone(t));
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    if (call.path === "/v2/integrations/github") return json(200, { app_id: "1", slug: "agentrun-test", installations: [{ id: 7, account: "acme" }] });
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") return create ? create(call) : json(201, { ...BASE, ...(call.body as object), id: "trg_new", signing_secret: "CANARY-VALUE-1d2e3f4a" });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
    if (m?.[2] === "/firings") return json(200, { firings: [fired({})] });
    if (m && call.method === "PATCH") { const refused = patch?.(call); if (refused) return refused; Object.assign(t!, call.body); return json(200, t); }
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
  const buttons = (label: RegExp, scope: ParentNode = host) => [...scope.querySelectorAll("button")].filter((b) => label.test((b.textContent ?? "").trim()) || label.test(b.getAttribute("aria-label") ?? ""));
  const button = (label: RegExp, scope: ParentNode = host) => buttons(label, scope)[0];
  const click = async (label: RegExp, scope: ParentNode = host) => {
    const b = button(label, scope);
    expect(b, `a button ${label}`).toBeDefined();
    await act(async () => { b!.click(); });
    await settle();
  };
  const field = (name: string) => host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  const set = async (name: string, value: string) => {
    if (name === "agent") return pick(picker(host, "Agent")!, value);
    const el = field(name);
    expect(el, `the field ${name}`).not.toBeNull();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  // A condition's test is a radio of its own group: "in", "prefix", "exists" or "missing".
  const choose = async (name: string, value: string) => {
    const el = host.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null;
    expect(el, `the choice ${name}=${value}`).not.toBeNull();
    await act(async () => { el!.click(); });
    await settle();
  };
  const scope = (selector: string) => host.querySelector(selector) ?? host;
  const issue = (field: string) => host.querySelector(`[data-issue="${field}"]`)?.textContent ?? null;
  const fill = async () => { await set("name", "on issue"); await set("agent", "triage"); await set("content", "Look at the issue."); await set("maxCost", "1"); };
  return { host, went, button, buttons, click, set, choose, field, scope, issue, fill, settle, text: () => host.textContent ?? "" };
}

const posted = (calls: Call[]) => calls.find((c) => c.method === "POST" && c.path === "/v2/triggers")?.body as { source: Record<string, unknown> } | undefined;
const patched = (calls: Call[]) => calls.filter((c) => c.method === "PATCH").map((c) => c.body);

describe("Triggers: a webhook's filter", () => {
  it("a webhook made with one rule (an event and a starts-with condition) sends it as source.accept", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.fill();
    await t.click(/^Add a rule$/);
    await t.set("accept-0-event", "issue.opened");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-0-pointer", "/title");
    await t.choose("accept-0-where-0-op", "prefix");
    await t.set("accept-0-where-0-value", "[agent]");
    await t.click(/^Create webhook$/);
    expect(posted(s.calls)?.source).toEqual({ kind: "webhook", signature: "standard", accept: [{ event: "issue.opened", where: [{ pointer: "/title", prefix: "[agent]" }] }] });
  });

  it("with no rule, every signed request fires: no accept is sent, and the form says what a filter changes", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    expect(t.text()).toContain("Every signed request starts a run.");
    await t.fill();
    await t.click(/^Add a rule$/);
    expect(t.text()).toContain("With a filter, each request it takes starts its own run, even while an earlier run is still going.");
    await t.click(/^Remove rule 1$/);
    await t.click(/^Create webhook$/);
    expect(posted(s.calls)?.source).toEqual({ kind: "webhook", signature: "standard" });
  });

  it("reads an is-one-of list a value a line (a number, true/false/null or a quoted line is JSON, else text), actions by comma, and is-missing as exists: false", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.fill();
    await t.click(/^Add a rule$/);
    await t.set("accept-0-event", "issue");
    await t.set("accept-0-actions", "opened, edited");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-0-pointer", "/label");
    await t.set("accept-0-where-0-value", "bug\n42\n\"42\"\ntrue\n\n  needs triage  \nnull");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-1-pointer", "/draft");
    await t.choose("accept-0-where-1-op", "missing");
    await t.click(/^Create webhook$/);
    expect(posted(s.calls)?.source.accept).toEqual([{ event: "issue", actions: ["opened", "edited"], where: [{ pointer: "/label", in: ["bug", 42, "42", true, "needs triage", null] }, { pointer: "/draft", exists: false }] }]);
  });

  it("says, per signature, what the event is and where conditions read", async () => {
    const t = await open(server().v2, { trigger: null, kind: "webhook" });
    await t.click(/^Add a rule$/);
    expect(t.text()).toContain("the JSON body's top-level type");
    await t.choose("signature", "github");
    expect(t.text()).toContain("the X-GitHub-Event header");
  });

  it("checks the filter's shape before it sends: a pointer starts with /, a value list and a prefix have their limits", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.fill();
    await t.click(/^Add a rule$/);
    await t.click(/^Create webhook$/);
    expect(t.issue("source.accept[0].event")).toBe("Name the event.");
    await t.set("accept-0-event", "issue opened");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-0-pointer", "title");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-1-pointer", "/body");
    await t.choose("accept-0-where-1-op", "prefix");
    await t.set("accept-0-where-1-value", "x".repeat(201));
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-2-pointer", "/n");
    await t.set("accept-0-where-2-value", Array.from({ length: 21 }, (_, i) => String(i)).join("\n"));
    await t.click(/^Create webhook$/);
    expect(t.issue("source.accept[0].event")).toBe("An event's name has no spaces: printable characters only, at most 200.");
    expect(t.issue("source.accept[0].where[0].pointer")).toBe("A field starts with /: /title, /issue/labels/0/name.");
    expect(t.issue("source.accept[0].where[0].in")).toBe("Give at least one value, one a line.");
    expect(t.issue("source.accept[0].where[1].prefix")).toBe("At most 200 characters.");
    expect(t.issue("source.accept[0].where[2].in")).toBe("At most 20 values.");
    expect(posted(s.calls)).toBeUndefined();
  });

  it("takes at most 20 rules, and at most 20 conditions a rule", async () => {
    const t = await open(server().v2, { trigger: null, kind: "webhook" });
    for (let i = 0; i < 20; i++) await t.click(/^Add a rule$/);
    expect(t.button(/^Add a rule$/)!.disabled).toBe(true);
    expect(t.text()).toContain("20 rules, the most a trigger takes.");
    for (let i = 0; i < 20; i++) await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    expect(t.button(/^Add a condition$/, t.scope('[data-rule="accept-0"]'))!.disabled).toBe(true);
  });

  it("a 422 shows each issue under the field it names, in the server's words", async () => {
    const said = "pointer is a JSON pointer (RFC 6901) into the body, \"\" or \"/\" and its tokens (~0 for ~, ~1 for /), at most 512 characters";
    const s = server({ create: () => json(422, { error: { code: "input_invalid", message: "source.accept[0].where[0].pointer: invalid", retryable: false, fields: [{ field: "source.accept[0].where[0].pointer", reason: "invalid", message: said }] } }) });
    const t = await open(s.v2, { trigger: null, kind: "webhook" });
    await t.fill();
    await t.click(/^Add a rule$/);
    await t.set("accept-0-event", "issue.opened");
    await t.click(/^Add a condition$/, t.scope('[data-rule="accept-0"]'));
    await t.set("accept-0-where-0-pointer", "/title");
    await t.choose("accept-0-where-0-op", "exists");
    await t.click(/^Create webhook$/);
    expect(t.issue("source.accept[0].where[0].pointer")).toBe(said);
    // Said once, there: not again in the list of issues the form has no field for.
    expect([...t.host.querySelectorAll('[role="alert"]')].filter((a) => !a.querySelector("[data-issue]")).map((a) => a.textContent).join(" ")).not.toContain(said);
  });
});

describe("Triggers: a GitHub trigger's conditions", () => {
  it("a picked event gains conditions, sent on its rule", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "github" });
    await t.fill();
    await t.click(/^Add a condition$/, t.scope('[data-github-event="pull_request"]'));
    await t.set("github-pull_request-where-0-pointer", "/pull_request/draft");
    await t.set("github-pull_request-where-0-value", "false");
    await t.click(/^Create GitHub trigger$/);
    expect(posted(s.calls)?.source).toEqual({ kind: "github", accept: [{ event: "pull_request", actions: ["opened"], where: [{ pointer: "/pull_request/draft", in: [false] }] }] });
  });
});

describe("Triggers: editing a filter from the trigger's page", () => {
  it("a webhook's page reads its conditions in the editor's words, and offers Edit filter", async () => {
    const hook: Trigger = { ...BASE, source: { kind: "webhook", signature: "standard", accept: [{ event: "issue", actions: ["opened"], where: [{ pointer: "/title", prefix: "[agent]" }, { pointer: "/draft", exists: false }, { pointer: "/assignee", exists: true }, { pointer: "/label", in: ["bug", 42, "42"] }] }] } };
    const t = await open(server({ triggers: [hook] }).v2, { trigger: "trg_w" });
    expect(t.text()).toContain('issue (opened) where /title starts with "[agent]" and /draft is missing and /assignee exists and /label is one of bug, 42, "42"');
    await t.click(/^Edit filter$/);
    expect(t.went).toEqual(["#/triggers/trg_w/edit"]);
  });

  it("edits a webhook's filter with a PATCH of its source, its kind and signature as they were", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_f", edit: true });
    expect((t.field("accept-0-event") as HTMLInputElement).value).toBe("push");
    expect((t.field("accept-0-where-0-value") as HTMLTextAreaElement).value).toBe("refs/heads/main");
    await t.choose("accept-0-where-0-op", "exists");
    await t.click(/^Save filter$/);
    expect(patched(s.calls)).toEqual([{ source: { kind: "webhook", signature: "github", accept: [{ event: "push", where: [{ pointer: "/ref", exists: true }] }] } }]);
    expect(t.went).toEqual(["#/triggers/trg_f"]);
  });

  it("takes a webhook's filter away: the PATCH sends its source with no accept", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_f", edit: true });
    await t.click(/^Remove rule 1$/);
    expect(t.text()).toContain("Every signed request starts a run.");
    await t.click(/^Save filter$/);
    expect(patched(s.calls)).toEqual([{ source: { kind: "webhook", signature: "github" } }]);
  });

  it("edits a GitHub trigger's conditions and keeps a rule the picker doesn't offer", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_g", edit: true });
    expect((t.host.querySelector('input[name="event"][value="pull_request:synchronize"]') as HTMLInputElement).checked).toBe(true);
    expect((t.field("other-0-event") as HTMLInputElement).value).toBe("issues");
    await t.click(/^Add a condition$/, t.scope('[data-github-event="pull_request"]'));
    await t.set("github-pull_request-where-0-pointer", "/pull_request/base/ref");
    await t.set("github-pull_request-where-0-value", "main");
    await t.click(/^Save filter$/);
    expect(patched(s.calls)).toEqual([{ source: { kind: "github", accept: [{ event: "pull_request", actions: ["opened", "synchronize"], where: [{ pointer: "/pull_request/base/ref", in: ["main"] }] }, { event: "issues", actions: ["opened"] }] } }]);
  });

  // A filter made through the API comes back as it came: a rule or a field the owner didn't touch is sent exactly as read
  // (a pointer as it was, spaces and all; an action list as its values; the rules and actions in their order; a pointer to
  // the whole body), so a save that changes nothing sends nothing.
  const MADE: Trigger = { ...BASE, source: { kind: "webhook", signature: "standard", accept: [{ event: "issue", actions: ["foo,bar"], where: [{ pointer: "/label ", in: ["bug"] }, { pointer: "", exists: true }, { pointer: "/title", prefix: "  [agent]" }] }] } };

  it("a filter made through the API, saved unchanged, sends nothing: a pointer ending in a space, an action with a comma, a whole-body pointer, a prefix with leading spaces", async () => {
    const s = server({ triggers: [MADE] });
    const t = await open(s.v2, { trigger: "trg_w", edit: true });
    await t.click(/^Save filter$/);
    expect(t.issue("source.accept[0].where[1].pointer")).toBeNull();
    expect(patched(s.calls)).toEqual([]);
    expect(t.went).toEqual(["#/triggers/trg_w"]);
  });

  it("one condition edited: the rest of the filter goes back as it came, and the edited pointer as typed", async () => {
    const s = server({ triggers: [MADE] });
    const t = await open(s.v2, { trigger: "trg_w", edit: true });
    await t.set("accept-0-where-0-value", "bug\nfeature");
    await t.click(/^Save filter$/);
    expect(patched(s.calls)).toEqual([{ source: { kind: "webhook", signature: "standard", accept: [{ event: "issue", actions: ["foo,bar"], where: [{ pointer: "/label ", in: ["bug", "feature"] }, { pointer: "", exists: true }, { pointer: "/title", prefix: "  [agent]" }] }] } }]);
  });

  it("a GitHub filter whose rules and actions are in another order than the picker's, saved unchanged, sends nothing; edited, keeps its order", async () => {
    const reordered: Trigger = { ...BASE, id: "trg_r", source: { kind: "github", accept: [{ event: "issue_comment", actions: ["created"] }, { event: "pull_request", actions: ["synchronize", "opened"] }] } };
    const s = server({ triggers: [reordered] });
    const t = await open(s.v2, { trigger: "trg_r", edit: true });
    await t.click(/^Save filter$/);
    expect(patched(s.calls)).toEqual([]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const again = server({ triggers: [reordered] });
    const u = await open(again.v2, { trigger: "trg_r", edit: true });
    await u.click(/^Add a condition$/, u.scope('[data-github-event="pull_request"]'));
    await u.set("github-pull_request-where-0-pointer", "/pull_request/base/ref");
    await u.set("github-pull_request-where-0-value", "main");
    await u.click(/^Save filter$/);
    expect(patched(again.calls)).toEqual([{ source: { kind: "github", accept: [{ event: "issue_comment", actions: ["created"] }, { event: "pull_request", actions: ["synchronize", "opened"], where: [{ pointer: "/pull_request/base/ref", in: ["main"] }] }] } }]);
  });

  it("a save that answers after the person left the editor opens nothing", async () => {
    let answer!: (r: Response) => void;
    const s = server({ patch: () => new Promise<Response>((r) => { answer = r; }) });
    const t = await open(s.v2, { trigger: "trg_f", edit: true });
    await t.choose("accept-0-where-0-op", "exists");
    await t.click(/^Save filter$/);
    // Left the editor (Cancel, the back link, the sidebar): the page goes, and the save answers after.
    act(() => root?.unmount());
    await act(async () => { answer(json(200, FILTERED)); });
    await t.settle();
    expect(t.went).toEqual([]);
  });

  it("an edit refused with a 422 shows the issue on the condition, and stays", async () => {
    const said = "prefix is a string of 1 to 200 characters: the value at pointer is a string whose first line, trimmed, starts with it, ignoring case";
    const s = server({ patch: () => json(422, { error: { code: "input_invalid", message: "invalid", retryable: false, fields: [{ field: "source.accept[0].where[0].prefix", reason: "invalid", message: said }] } }) });
    const t = await open(s.v2, { trigger: "trg_f", edit: true });
    await t.choose("accept-0-where-0-op", "prefix");
    await t.set("accept-0-where-0-value", "refs/heads/");
    await t.click(/^Save filter$/);
    expect(t.issue("source.accept[0].where[0].prefix")).toBe(said);
    expect(t.went).toEqual([]);
  });
});
