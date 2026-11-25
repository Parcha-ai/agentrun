import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage } from "./Schedules";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { Firing, Trigger } from "@/lib/v2";
import { optionsOf, pick, picker } from "@/test/picker";
import { searchPick, searchPicker, shownIn } from "@/test/search-picker";

// A trigger from an app (serve's composio source): it names a saved Composio server, one of its toolkit's events
// (GET /v2/settings/mcp-servers/{name}/composio/events) and that event's config, drawn from the event's schema with the
// required fields marked; an optional filter on the event's delivery; then the agent each event starts a capped run of.
// The server makes the trigger instance (and the project's webhook subscription) on Composio, and says in its own words
// what stops it: a subscription at another address (moved here only when the person says so), an account not connected
// (with the link to connect it), no public address. The trigger's page shows the app, the event, its config, the filter,
// the firings and whether its event is on at Composio; Pause and Delete say what Composio could not do.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE_ADDED = {
  slug: "GITHUB_ISSUE_ADDED_EVENT", name: "Issue Added Event", description: "Triggered when a new issue is added to the repository.", polled: false,
  config: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string", title: "Owner", description: "Owner of the repository" }, repo: { type: "string", title: "Repo", description: "Repository name" } } },
};
const STAR_ADDED = {
  slug: "GITHUB_STAR_ADDED_EVENT", name: "Star Added", description: "Triggered when a star is added to the repository.", polled: true,
  config: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string", title: "Owner" }, repo: { type: "string", title: "Repo" }, interval: { type: "number", default: 2, deprecated: true, title: "Interval" } } },
};
const SERVERS = [
  { name: "docs", url: "https://docs.example.test/mcp", auth: { type: "none" }, source: "url", toolkit: null, credential: null, tools: [], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" },
  { name: "gh", url: "https://backend.composio.test/v3/mcp/srv_1/mcp?user_id=agentrun-qa", auth: { type: "headers", headers: ["x-api-key"] }, source: "composio", toolkit: "github", credential: "sealed", tools: [], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" },
];
const NIGHTLY: Trigger = {
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "UTC" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T01:30:00Z", last_firing: null,
};
const HOOK_ID = "cph_0123456789abcdef01234567";
const ISSUES: Trigger = {
  ...NIGHTLY, id: "trg_c", name: "new issues", next_at: null, hook_url: `https://agents.example.test/v2/hooks/composio/${HOOK_ID}`,
  source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" }, accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/title", prefix: "[agent]" }] }], instance_id: "ti_1", hook: HOOK_ID },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage this issue." }, max_cost_usd: 0.5 },
} as Trigger;
const fired = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "composio", nominal_at: "2026-11-04T09:30:00Z", status: "started", at: "2026-11-04T09:30:01Z", run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", reason: null, error: null, ...over } as Firing);
const AGENTS = [{ agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null }];
const ELSEWHERE = "https://elsewhere.example/hooks/composio";

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, retryable: false, ...extra } });

function server({ triggers = [NIGHTLY, ISSUES], servers = SERVERS, create, update, remove, onComposio = "on", events: listed = [ISSUE_ADDED, STAR_ADDED] }: {
  triggers?: Trigger[]; servers?: unknown[]; create?: (call: Call, n: number) => Response; update?: (call: Call) => Response | undefined; remove?: () => Response; onComposio?: string; events?: unknown[];
} = {}) {
  const calls: Call[] = [];
  triggers = triggers.map((t) => structuredClone(t));
  let creates = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    if (call.path === "/v2/settings/mcp-servers") return json(200, { servers });
    const events = /^\/v2\/settings\/mcp-servers\/([^/]+)\/composio\/events$/.exec(call.path);
    if (events) return json(200, { server: events[1], toolkit: "github", events: listed });
    if (call.path === "/v2/settings/mcp-servers/gh/composio/triggers") return json(200, { triggers: triggers.filter((t) => t.source.kind === "composio").map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, event: (t.source as { event: string }).event, instance_id: (t.source as { instance_id: string }).instance_id, on_composio: onComposio })), subscription: { ours: true, webhook_url: ISSUES.hook_url } });
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") return create ? create(call, ++creates) : json(201, { ...ISSUES, ...(call.body as object), id: "trg_new" });
    const m = /^\/v2\/triggers\/([^/]+)(\/firings)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return refusal(404, "not_found", "no trigger");
    if (m?.[2] === "/firings") return json(200, { firings: [fired({})] });
    if (m && call.method === "PATCH") { const own = update?.(call); if (own) return own; Object.assign(t!, call.body); return json(200, t); }
    if (m && call.method === "DELETE") return remove ? remove() : new Response(null, { status: 204 });
    if (m) return json(200, t);
    return refusal(404, "not_found", call.path);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls, posts: () => calls.filter((c) => c.method === "POST" && c.path === "/v2/triggers") };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

type PageExtra = Omit<Partial<Parameters<typeof SchedulesPage>[0]>, "v2" | "view" | "go" | "agentName">;
async function open(v2: ReturnType<typeof createClient>, view: Parameters<typeof SchedulesPage>[0]["view"], extra: PageExtra = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName: (id: string) => (id === "triage" ? "Triage" : id), ...extra })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  // A button by its words, or by its aria-label when it shows an icon alone (Remove condition 1).
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()) || label.test(b.getAttribute("aria-label") ?? ""));
  const click = async (label: RegExp) => {
    const b = button(label);
    if (!b) throw new Error(`no button ${label}; buttons: ${[...host.querySelectorAll("button")].map((x) => JSON.stringify(x.textContent)).join(", ")}`);
    await act(async () => { b.click(); });
    await settle();
  };
  const set = async (name: string, value: string) => {
    const el = host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement;
    if (!el) throw new Error(`no field ${name}`);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  // The Event field is a search picker; every other one a Picker.
  const choose = async (label: string, value: string) => { const search = searchPicker(host, label); await (search ? searchPick(search, value) : pick(picker(host, label)!, value)); await settle(); };
  /** The form filled for GitHub's new-issue event on many-drop/agentrun-scratch. */
  const fill = async () => {
    await choose("Composio server", "gh");
    await choose("Event", "GITHUB_ISSUE_ADDED_EVENT");
    await set("name", "new issues");
    await set("config-owner", "many-drop");
    await set("config-repo", "agentrun-scratch");
    await choose("Agent", "triage");
    await set("content", "Triage this issue.");
    await set("maxCost", "0.5");
  };
  return { host, went, button, click, set, choose, fill, settle, text: () => host.textContent ?? "" };
}

const BODY = {
  name: "new issues",
  source: { kind: "composio", server: "gh", event: "GITHUB_ISSUE_ADDED_EVENT", config: { owner: "many-drop", repo: "agentrun-scratch" } },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage this issue." }, max_cost_usd: 0.5 },
};

describe("Triggers: from an app (Composio)", () => {
  it("lists one by its event and server, and offers a new one at #/triggers/new-composio", async () => {
    const t = await open(server().v2, {});
    const row = t.host.querySelector('[data-trigger="trg_c"]')!;
    expect(row.textContent).toContain("App");
    expect(row.textContent).toContain("On GITHUB_ISSUE_ADDED_EVENT from gh");
    await t.click(/^New app trigger$/);
    expect(t.went).toEqual(["#/triggers/new-composio"]);
    expect(route("#/triggers/new-composio")).toMatchObject({ section: "triggers", trigger: null, kind: "composio" });
  });

  it("with no trigger yet, the first-trigger panel offers one from an app too", async () => {
    const t = await open(server({ triggers: [] }).v2, {});
    expect(t.text()).toContain("From an app");
    await t.click(/^New app trigger$/);
    expect(t.went).toEqual(["#/triggers/new-composio"]);
  });

  it("with no public address, New app trigger stays in sight but off, with the line that says how to give one; the other kinds stay on", async () => {
    const LINE = "App triggers need this server's public address: set AGENTRUN_PUBLIC_URL and restart.";
    const off = (t: Awaited<ReturnType<typeof open>>) => (t.button(/^New app trigger$/) as HTMLButtonElement).disabled;
    let t = await open(server().v2, {}, { publicUrl: false });
    expect(off(t)).toBe(true);
    expect(t.text()).toContain(LINE);
    expect((t.button(/^New webhook$/) as HTMLButtonElement).disabled).toBe(false);
    await t.click(/^New app trigger$/);
    expect(t.went).toEqual([]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    // The first-trigger panel's card says it too.
    t = await open(server({ triggers: [] }).v2, {}, { publicUrl: false });
    expect(off(t)).toBe(true);
    expect(t.text()).toContain(LINE);
    expect((t.button(/^New webhook$/) as HTMLButtonElement).disabled).toBe(false);
    act(() => root?.unmount()); document.body.innerHTML = "";
    // Reached by its address all the same (Settings → MCP servers links it): the form says it, and Create stays off.
    t = await open(server().v2, { trigger: null, kind: "composio" }, { publicUrl: false });
    expect(t.text()).toContain(LINE);
    expect((t.button(/^Create app trigger$/) as HTMLButtonElement).disabled).toBe(true);
    act(() => root?.unmount()); document.body.innerHTML = "";
    for (const triggers of [undefined, []]) {
      t = await open(server(triggers ? { triggers } : {}).v2, {}, { publicUrl: true });
      expect(off(t)).toBe(false);
      expect(t.text()).not.toContain(LINE);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("offers the saved Composio servers, their events with each one's description, and its config's fields from the schema, the required ones marked", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    expect((await optionsOf(picker(t.host, "Composio server")!)).filter((o) => o.value).map((o) => o.value)).toEqual(["gh"]);
    await t.choose("Composio server", "gh");
    expect(s.calls.some((c) => c.path === "/v2/settings/mcp-servers/gh/composio/events")).toBe(true);
    expect((await shownIn(searchPicker(t.host, "Event")!)).options.map((o) => [o.value, o.text])).toEqual([["GITHUB_ISSUE_ADDED_EVENT", "Issue Added Event"], ["GITHUB_STAR_ADDED_EVENT", "Star Added"]]);
    await t.choose("Event", "GITHUB_ISSUE_ADDED_EVENT");
    expect(t.text()).toContain("Triggered when a new issue is added to the repository.");
    const owner = t.host.querySelector('[data-config-field="owner"]')!;
    expect(owner.textContent).toContain("Owner");
    expect(owner.textContent).toContain("Owner of the repository");
    expect(owner.textContent).not.toMatch(/optional/i);
    expect(t.host.querySelector('[name="config-repo"]')).not.toBeNull();
    // A polled event says Composio checks for it; a deprecated field of its schema is left off.
    await t.choose("Event", "GITHUB_STAR_ADDED_EVENT");
    expect(t.text()).toMatch(/Composio checks for it every few minutes/);
    expect(t.host.querySelector('[name="config-interval"]')).toBeNull();
  });

  it("lists the events A to Z in one Event field that is its own search: typing filters its open list by name, slug or description (QA #162), and an event's Markdown description renders, never its marks", async () => {
    const BRANCH = {
      ...ISSUE_ADDED, slug: "GITHUB_BRANCH_CHANGED_TRIGGER", name: "Branch Changed",
      description: "Triggers when a GitHub branch changes.\n\n**Payload details:**\n- ``head_sha`` -- the new head commit\n- ``protected`` -- whether the branch is protected",
      instructions: "This trigger fires whenever a GitHub branch changes, including:\n\n- **New commits pushed** (head commit SHA changes)\n- **Protection status toggled**",
    };
    const ZEN = { ...ISSUE_ADDED, slug: "GITHUB_ZEN_EVENT", name: "zen Event", description: "Zen." };
    const s = server({ events: [STAR_ADDED, ZEN, ISSUE_ADDED, BRANCH] });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.choose("Composio server", "gh");
    // No filter box of its own outside the field: the field is the search.
    expect(t.host.querySelector('input[aria-label="Filter events"]')).toBeNull();
    const field = searchPicker(t.host, "Event")!;
    expect(field, "the Event field is a search box").not.toBeNull();
    expect(t.host.querySelector(`label[for="${field.id}"]`)?.textContent, "the Event label names the search").toMatch(/^Event/);
    expect(t.host.querySelectorAll('input[placeholder="Filter by name, slug or description"]').length, "no second box").toBe(0);
    const listed = async (query?: string) => (await shownIn(field, query)).options.map((o) => o.text);
    expect(await listed(), "A to Z, case aside").toEqual(["Branch Changed", "Issue Added Event", "Star Added", "zen Event"]);
    expect(await listed("added")).toEqual(["Issue Added Event", "Star Added"]);
    expect(await listed("star_added"), "by slug").toEqual(["Star Added"]);
    expect(await listed("head_sha"), "by description").toEqual(["Branch Changed"]);
    expect((await shownIn(field, "nothing-like-it")).nothing).toBe("No event matches “nothing-like-it”");
    // Enter in the search never sends the form.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(s.posts()).toEqual([]);
    await searchPick(field, "GITHUB_BRANCH_CHANGED_TRIGGER", "branch");
    expect([field.value, field.getAttribute("data-value")], "the picked event's words fill the field").toEqual(["Branch Changed", "GITHUB_BRANCH_CHANGED_TRIGGER"]);
    const said = t.host.querySelector("[data-event-description]")!;
    expect(said.querySelector("strong")?.textContent).toBe("Payload details:");
    expect([...said.querySelectorAll("li code")].map((c) => c.textContent)).toEqual(["head_sha", "protected"]);
    expect(said.textContent).not.toMatch(/\*\*|``/);
    // Its instructions are Composio's Markdown too.
    const told = t.host.querySelector("[data-event-instructions]");
    expect([...(told?.querySelectorAll("li strong") ?? [])].map((b) => b.textContent), "instructions rendered").toEqual(["New commits pushed", "Protection status toggled"]);
    expect(t.text()).not.toContain("**New commits pushed**");
  });

  it("marks the run's fields its save refuses empty (Agent, Each run is asked, and the cap with no agent default) with *, on every new trigger form", async () => {
    // GitHub's form, shown once GitHub is connected, is checked in Triggers.github.test.tsx.
    for (const kind of ["composio", "schedule", "webhook", "feed"] as const) {
      const t = await open(server().v2, { trigger: null, kind } as Parameters<typeof SchedulesPage>[0]["view"]);
      const labels = [...t.host.querySelectorAll("label, span.caps")].map((l) => (l.textContent ?? "").trim());
      for (const label of ["Agent *", "Each run is asked *", "Cost cap, US dollars a run *"]) expect(labels, `${kind}: ${label}`).toContain(label);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
    // Composio's own case: Create with nothing said names the field the * marks.
    const t = await open(server().v2, { trigger: null, kind: "composio" });
    await t.click(/^Create app trigger$/);
    expect(t.host.querySelector('[data-issue="target.input"]')?.textContent).toBe("Say what each run is asked.");
  });

  it("makes one from the picked server, event and config, with a filter on the event's data, under an Idempotency-Key, and opens it", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Add a condition$/);
    await t.set("composio-where-0-pointer", "/data/title");
    await act(async () => { (t.host.querySelector('[name="composio-where-0-op"][value="prefix"]') as HTMLInputElement).click(); });
    await t.set("composio-where-0-value", "[agent]");
    await t.click(/^Create app trigger$/);
    const [made] = s.posts();
    expect(made!.key).toMatch(/.+/);
    expect(made!.body).toEqual({ ...BODY, source: { ...BODY.source, accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/title", prefix: "[agent]" }] }] } });
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });

  it("a required config field left empty is said under it, and nothing is sent", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.set("config-repo", "");
    await t.click(/^Create app trigger$/);
    expect(t.host.querySelector('[data-issue="source.config.repo"]')?.textContent).toMatch(/Repo is required/);
    expect(s.posts()).toEqual([]);
  });

  it("with no saved Composio server, says to save one first and links Settings → MCP servers, with no form", async () => {
    const t = await open(server({ servers: [SERVERS[0]] }).v2, { trigger: null, kind: "composio" });
    expect(t.text()).toContain("Save a Composio server first");
    expect(t.host.querySelector('a[href="#/settings/mcp"]')).not.toBeNull();
    expect(t.button(/^Create app trigger$/)).toBeUndefined();
  });

  it("a subscription at another address is named, and moved here only once the person says so", async () => {
    const s = server({ create: (call, n) => (n === 1 ? refusal(409, "composio_subscription_elsewhere", `This Composio project's webhook subscription sends its events to ${ELSEWHERE}, not to this server.`, { details: { webhook_url: ELSEWHERE } }) : json(201, { ...ISSUES, ...(call.body as object), id: "trg_new" })) });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Create app trigger$/);
    const ask = t.host.querySelector('[role="alertdialog"][aria-label="Move the subscription here?"]')!;
    // Only another server or a tool of the person's can hold it: the question says what a move stops, in the server's words.
    expect(ask.textContent).toContain(`Composio sends this project's events to ${ELSEWHERE} now. Moving them here stops them arriving there: anything listening at ${ELSEWHERE} (another AgentRun server, or a tool of yours) gets no more events.`);
    expect(t.went).toEqual([]);
    await t.click(/^Move it here$/);
    const [, moved] = s.posts();
    expect(moved!.body).toEqual({ ...BODY, source: { ...BODY.source, move_subscription: true } });
    expect(moved!.key).not.toBe(s.posts()[0]!.key);
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });

  it("a move asked about one create is withdrawn once the server, event or config changes: Move it here never sends another", async () => {
    const OTHER = { ...SERVERS[1], name: "gh-other", url: "https://backend.composio.test/v3/mcp/srv_2/mcp?user_id=agentrun-qa" };
    const elsewhere = () => refusal(409, "composio_subscription_elsewhere", `Sends its events to ${ELSEWHERE}.`, { details: { webhook_url: ELSEWHERE } });
    const s = server({ servers: [...SERVERS, OTHER], create: elsewhere });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    const asked = () => t.host.querySelector('[role="alertdialog"][aria-label="Move the subscription here?"]');
    await t.fill();
    await t.click(/^Create app trigger$/);
    expect(asked()).not.toBeNull();
    // Another server: another project, whose subscription nobody asked about.
    await t.choose("Composio server", "gh-other");
    expect(asked()).toBeNull();
    expect(t.button(/^Move it here$/)).toBeUndefined();
    // Another config of the same server: the confirmation was for the create as it was refused.
    await t.choose("Composio server", "gh");
    await t.choose("Event", "GITHUB_ISSUE_ADDED_EVENT");
    await t.set("config-owner", "many-drop");
    await t.set("config-repo", "agentrun-scratch");
    await t.click(/^Create app trigger$/);
    expect(asked()).not.toBeNull();
    await t.set("config-repo", "another-repo");
    expect(asked()).toBeNull();
    expect(s.posts()).toHaveLength(2);
    expect(s.posts().every((p) => (p.body as { source: Record<string, unknown> }).source.move_subscription === undefined)).toBe(true);
  });

  it("Keep it there sends nothing more, and the form stays", async () => {
    const s = server({ create: () => refusal(409, "composio_subscription_elsewhere", `Sends its events to ${ELSEWHERE}.`, { details: { webhook_url: ELSEWHERE } }) });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Create app trigger$/);
    await t.click(/^Keep it there$/);
    expect(s.posts()).toHaveLength(1);
    expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.button(/^Create app trigger$/)).toBeDefined();
  });

  it("an account not connected is said in the server's words, with the link to connect it", async () => {
    const message = "gh's Composio user agentrun-qa has no connected github account: connect it at https://connect.composio.test/link/ac_1, then make the trigger again.";
    const s = server({ create: () => refusal(409, "composio_not_connected", message, { details: { server: "gh", user_id: "agentrun-qa", connect_url: "https://connect.composio.test/link/ac_1" } }) });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Create app trigger$/);
    expect(t.text()).toContain(message);
    const link = [...t.host.querySelectorAll("a")].find((a) => /Connect the account/.test(a.textContent ?? ""));
    expect(link?.getAttribute("href")).toBe("https://connect.composio.test/link/ac_1");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("no public address, and a config Composio refuses, are said in the server's words", async () => {
    const noUrl = server({ create: () => refusal(409, "composio_no_public_url", "Composio can't reach this server: set its public URL first (AGENTRUN_PUBLIC_URL), then make the trigger.") });
    let t = await open(noUrl.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Create app trigger$/);
    expect(t.text()).toContain("Composio can't reach this server");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const bad = server({ create: () => refusal(422, "input_invalid", "invalid", { fields: [{ field: "source.config", reason: "refused", message: "Composio refused the request while turning on GITHUB_ISSUE_ADDED_EVENT on Composio (400): repo not found." }] }) });
    t = await open(bad.v2, { trigger: null, kind: "composio" });
    await t.fill();
    await t.click(/^Create app trigger$/);
    expect(t.host.querySelector('[data-issue="source.config"]')?.textContent).toContain("repo not found");
  });
});

describe("A trigger from an app: its page", () => {
  it("shows the app, the event, its config, the filter, the firings and whether its event is on at Composio", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_c" });
    expect(t.text()).toContain("App · On GITHUB_ISSUE_ADDED_EVENT from gh");
    const dl = t.host.querySelector("dl")!;
    expect(dl.textContent).toContain("gh");
    expect(dl.textContent).toContain("GITHUB_ISSUE_ADDED_EVENT");
    expect(dl.textContent).toContain("owner: many-drop");
    expect(dl.textContent).toContain("repo: agentrun-scratch");
    expect(dl.textContent).toContain('GITHUB_ISSUE_ADDED_EVENT where /data/title starts with "[agent]"');
    expect(t.host.querySelector("[data-on-composio]")?.getAttribute("data-on-composio")).toBe("on");
    expect(t.host.querySelector("[data-on-composio]")?.textContent).toMatch(/On/);
    expect(t.host.querySelector('[data-firing="fir_1"]')?.textContent).toContain("On an app event");
    expect(t.button(/^Edit filter$/)).toBeDefined();
  });

  it("an event Composio no longer has is said", async () => {
    const t = await open(server({ onComposio: "missing" }).v2, { trigger: "trg_c" });
    expect(t.host.querySelector("[data-on-composio]")?.getAttribute("data-on-composio")).toBe("missing");
    expect(t.host.querySelector("[data-on-composio]")?.textContent).toMatch(/Composio no longer has it/);
  });

  it("a pause Composio could not follow says what to do there by hand", async () => {
    const note = "Composio didn't turn the trigger instance ti_1 off: turn it off there yourself: https://platform.composio.dev";
    const s = server({ update: (call) => json(200, { ...ISSUES, ...(call.body as object), composio: { done: false, note } }) });
    const t = await open(s.v2, { trigger: "trg_c" });
    await t.click(/^Pause$/);
    expect(s.calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false });
    expect(t.host.querySelector("[data-composio-note]")?.textContent).toContain(note);
  });

  it("a delete Composio could not follow says what to remove there, and stays to say it", async () => {
    const note = "Composio didn't delete the trigger instance ti_1: remove it there yourself: https://platform.composio.dev";
    const t = await open(server({ remove: () => json(200, { deleted: true, composio: { done: false, note } }) }).v2, { trigger: "trg_c" });
    await t.click(/^Delete$/);
    await t.click(/^Yes, delete$/);
    expect(t.host.querySelector("[data-composio-note]")?.textContent).toContain(note);
    expect(t.went).toEqual([]);
    expect(t.host.querySelector('a[href="#/triggers"]')).not.toBeNull();
  });

  it("Edit filter changes only its accept: the server, event, config and what was made on Composio are sent as they are", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_c", edit: true });
    expect((t.host.querySelector('[name="composio-where-0-pointer"]') as HTMLInputElement).value).toBe("/data/title");
    await t.set("composio-where-0-value", "[bot]");
    await t.click(/^Save filter$/);
    const patch = s.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ source: { ...ISSUES.source, accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/title", prefix: "[bot]" }] }] } });
    expect(t.went).toEqual(["#/triggers/trg_c"]);
  });

  it("a filter made through the API, saved unchanged, sends nothing; one condition edited sends the rest back as it came", async () => {
    // A pointer ending in a space, a whole-body pointer, a prefix with leading spaces, an action with a comma in a later rule.
    const where = [{ pointer: "/data/label ", in: ["bug"] }, { pointer: "", exists: true }, { pointer: "/data/title", prefix: "  [agent]" }];
    const later = { event: "GITHUB_ISSUE_ADDED_EVENT", actions: ["foo,bar"] };
    const accept = [{ event: "GITHUB_ISSUE_ADDED_EVENT", where }, later];
    const made = { ...ISSUES, source: { ...ISSUES.source, accept } } as Trigger;
    const s = server({ triggers: [NIGHTLY, made] });
    const t = await open(s.v2, { trigger: "trg_c", edit: true });
    await t.click(/^Save filter$/);
    expect(t.host.querySelector('[data-issue="source.accept[0].where[1].pointer"]')).toBeNull();
    expect(s.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(t.went).toEqual(["#/triggers/trg_c"]);
    const s2 = server({ triggers: [NIGHTLY, made] });
    const t2 = await open(s2.v2, { trigger: "trg_c", edit: true });
    await t2.set("composio-where-0-value", "bug\nfeature");
    await t2.click(/^Save filter$/);
    expect(s2.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ source: { ...made.source, accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/label ", in: ["bug", "feature"] }, where[1], where[2]] }, later] } }]);
  });

  it("a filter emptied takes every event of its instance again: the source is sent without accept", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: "trg_c", edit: true });
    await t.click(/^Remove condition 1$/);
    await t.click(/^Save filter$/);
    const { accept: _gone, ...rest } = ISSUES.source as Record<string, unknown>;
    expect(s.calls.find((c) => c.method === "PATCH")!.body).toEqual({ source: rest });
  });
});

// A config field named like a key (serve's trigger-composio.ts sealedConfigFields) is sealed at the save: the events list
// names such fields under `sealed`, the form takes them as a password, and a trigger's answer has "[sealed]" in their place
// with each named in `sealed_config`, which its page shows as sealed, never as a value.
const DEAL_STAGE = {
  slug: "HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER", name: "Deal Stage Updated", description: "Triggered when a deal's stage changes.", polled: false, sealed: ["developer_api_key"],
  config: { type: "object", required: ["app_id", "developer_api_key"], properties: { app_id: { type: "string", title: "App Id" }, developer_api_key: { type: "string", title: "Developer Api Key" } } },
};
/** What the server answers in place of a sealed config value. */
const SEALED_MASK = "[sealed]";
const DEALS = {
  ...ISSUES, id: "trg_d", name: "deal stages",
  source: { kind: "composio", server: "gh", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: SEALED_MASK }, sealed_config: ["developer_api_key"], instance_id: "ti_2", hook: HOOK_ID },
} as Trigger;

describe("A trigger from an app: a config field the server seals", () => {
  it("the form takes a field the events list names as sealed as a password, and the others as text", async () => {
    const s = server({ events: [DEAL_STAGE] });
    const t = await open(s.v2, { trigger: null, kind: "composio" });
    await t.choose("Composio server", "gh");
    await t.choose("Event", DEAL_STAGE.slug);
    expect((t.host.querySelector('[name="config-developer_api_key"]') as HTMLInputElement | null)?.type).toBe("password");
    expect((t.host.querySelector('[name="config-app_id"]') as HTMLInputElement | null)?.type).not.toBe("password");
  });

  it("its page shows a sealed field as sealed, never as a value", async () => {
    const t = await open(server({ triggers: [NIGHTLY, DEALS] }).v2, { trigger: "trg_d" });
    const dl = t.host.querySelector("dl")!;
    expect(dl.textContent).toContain("app_id: 4242");
    expect(dl.querySelector('[data-sealed-config="developer_api_key"]')?.textContent).toMatch(/^Sealed/);
    expect(dl.textContent).not.toContain("[sealed]");
  });

  it("Edit filter sends the source back as it came: [sealed] in place, which keeps the key", async () => {
    const s = server({ triggers: [NIGHTLY, DEALS] });
    const t = await open(s.v2, { trigger: "trg_d", edit: true });
    await t.click(/^Add a condition$/);
    await t.set("composio-where-0-pointer", "/data/stage");
    await act(async () => { (t.host.querySelector('[name="composio-where-0-op"][value="prefix"]') as HTMLInputElement).click(); });
    await t.set("composio-where-0-value", "closed");
    await t.click(/^Save filter$/);
    const patch = s.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ source: { ...DEALS.source, accept: [{ event: DEAL_STAGE.slug, where: [{ pointer: "/data/stage", prefix: "closed" }] }] } });
  });
});
