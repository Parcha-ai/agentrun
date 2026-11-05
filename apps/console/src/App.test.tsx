import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, route, runsHash } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";
import { agentHash } from "@/components/AgentPage";
import { agentsList, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { runLabel } from "@/lib/format";
import type { Run, TimelinePage } from "@/lib/v2";

// Mission Control is the first page: the bare address and the old start page's both open it, so no link dead-ends.
describe("route", () => {
  it("opens Mission Control for the bare address and the old start page", () => {
    for (const h of ["", "#", "#/", "#/start"]) expect(route(h).section, h).toBe("mission");
  });
  it("still opens the runs list, a run, and an agent's runs at their own addresses", () => {
    expect(route("#/runs")).toEqual({ section: "runs" });
    expect(route("#/runs/r1")).toEqual({ section: "runs", run: "r1" });
    expect(route("#/runs?agent=calc")).toEqual({ section: "runs", runsOf: "calc" });
  });
  it("keeps the selected agent in a Playground link", () => {
    expect(route("#/playground?agent=agent%20two")).toEqual({ section: "playground", playgroundAgent: "agent two" });
    expect(route("#/playground")).toEqual({ section: "playground" });
  });
  it("keeps creation and editing requests separate from starting a run", () => {
    expect(route("#/playground?operation=create-agent&draft=%7B%7D")).toEqual({ section: "playground", operation: "create-agent", draft: "{}" });
    expect(route("#/playground?operation=edit-agent&agent=agent%20two")).toEqual({ section: "playground", operation: "edit-agent", playgroundAgent: "agent two" });
  });
  it("keeps the scope of a read-only query playground link", () => {
    expect(route("#/playground?operation=list-runs&agent=agent%20two&status=failed&archived=true")).toEqual({ section: "playground", operation: "list-runs", playgroundAgent: "agent two", status: "failed", archived: true });
  });
  it("opens Settings → Tool keys at its own address, and at #/settings", () => {
    expect(route("#/settings/keys")).toEqual({ section: "settings", settings: "keys" });
    expect(route("#/settings")).toEqual({ section: "settings", settings: "keys" });
    expect(route("#/settings/webhook")).toEqual({ section: "settings", settings: "webhook" });
  });
  it("reads the runs list's filters from the address and writes them back the same way, so a reload keeps them", () => {
    expect(route("#/runs?status=failed")).toEqual({ section: "runs", status: "failed" });
    expect(route("#/runs?agent=calc&status=input_required&archived=true")).toEqual({ section: "runs", runsOf: "calc", status: "input_required", archived: true });
    expect(route("#/runs?status=sleeping&archived=yes")).toEqual({ section: "runs" });
    expect(runsHash({ runsOf: "calc", status: "failed", archived: true })).toBe("#/runs?agent=calc&status=failed&archived=true");
    for (const f of [{}, { status: "failed" as const }, { archived: true }, { runsOf: "c a", status: "completed" as const, archived: true }]) expect(route(runsHash(f))).toEqual({ section: "runs", ...f });
  });
  it("opens an agent's page at its address, and its editor under /edit; a new agent and the archived list are unchanged", () => {
    expect(route("#/agents/x")).toEqual({ section: "agents", agent: "x" });
    expect(route("#/agents/x/workflow")).toEqual({ section: "agents", agent: "x", tab: "workflow" });
    expect(route("#/agents/x/learning")).toEqual({ section: "agents", agent: "x", tab: "learning" });
    // A run's chip points at the notes it read or kept: the Learning tab, each note named.
    expect(route("#/agents/refund%20finder/learning?note=a.md&note=b.md")).toEqual({ section: "agents", agent: "refund finder", tab: "learning", notes: ["a.md", "b.md"] });
    expect(route("#/agents/x/learning?note=a&note=b")).toEqual({ section: "agents", agent: "x", tab: "learning", notes: ["a", "b"] });
    expect(route("#/agents/x/learning?")).toEqual({ section: "agents", agent: "x", tab: "learning", notes: [] });
    expect(route("#/agents/x/edit")).toEqual({ section: "agents", agent: "x", edit: true });
    expect(route("#/agents/new")).toEqual({ section: "agents", agent: null });
    expect(route("#/agents?archived=true")).toEqual({ section: "agents", archived: true });
    expect(route("#/agents")).toEqual({ section: "agents", archived: false });
  });
  it("gives an agent whose id is new addresses that never open the create form", () => {
    expect(route(agentHash("new"))).toEqual({ section: "agents", agent: "new", tab: "runs" });
    expect(route(agentHash("new", "edit"))).toEqual({ section: "agents", agent: "new", edit: true });
    expect(route(agentHash("a b"))).toEqual({ section: "agents", agent: "a b" });
  });
});

// A server without GET /v2/stats (or one that fails it) says so on the page, never a "Loading..." that never ends.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

describe("App, Mission Control when the stats can't be read", () => {
  it("shows the error, not Loading for ever", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/stats") return json(404, { error: { code: "not_found", message: "no route GET /v2/stats", retryable: false } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.textContent?.includes("could not be read") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(host.textContent).toContain("Mission Control could not be read");
    expect(host.textContent).toContain("not_found");
  });
});

describe("App, Mission Control after a failed read", () => {
  it("Try again reads the stats and the latest runs again, and shows them", async () => {
    let statsCalls = 0;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/stats") return ++statsCalls === 1
        ? json(503, { error: { code: "store_busy", message: "the store is busy", retryable: true } })
        : json(200, { agents: 3, runs: { total: 9, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 9 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
    await wait(() => !!host.textContent?.includes("could not be read"));
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""))!.click(); });
    await wait(() => !host.textContent?.includes("could not be read"));
    expect(statsCalls).toBe(2);
    expect(host.textContent).toContain("Mission Control");
    expect(host.textContent).not.toContain("could not be read");
  });
});

// Settings shows only on a server with the tool keys routes, so the console never offers a page its server lacks.
describe("App, Settings", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const keys = { keys: [{ id: "monid", label: "Monid", fields: [{ name: "MONID_API_KEY", set: false, source: null }], unlocks: ["monid.run"], harnesses: ["pi"] }], reenter: null };
  // capabilities.tools with a choice of provider (web_search, web_fetch), as a server with tool settings lists them.
  const choiceTools = [
    { name: "web_search", summary: "Search the web", nodes: true, calls: true, available: true, harnesses: ["pi"], providers: ["auto", "native", "exa-keyless", "parallel"], provider: "auto", default_provider: "auto", resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } },
    { name: "web_fetch", summary: "Fetch a page", nodes: true, calls: true, available: true, harnesses: ["pi"], providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } },
  ];
  async function open(features: Record<string, unknown>, hash: string, tools: unknown[] = []) {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path.startsWith("/v2/settings/tool-keys/")) return new Response(null, { status: 204 });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], tools, features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, ...features } });
      if (path === "/v2/settings/tools") return json(200, { web_search: { provider: "auto" }, web_fetch: { provider: "kernel" } });
      if (path === "/v2/settings/tool-keys") return json(200, keys);
      if (path === "/v2/settings/webhook") return json(200, { configured: false });
      if (path === "/v2/settings/webhook/deliveries") return json(200, { attempts: [] });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = hash;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.querySelector('nav[aria-label="Navigation"] button') && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const nav = () => [...host.querySelectorAll('nav[aria-label="Navigation"] button')].map((b) => b.textContent?.trim());
    return { host, nav, asked };
  }

  it("two saves in a row: only the newest capabilities read lands, so an older resolution never comes back", async () => {
    const tool = (provider: string, resolved: string) => [{ ...choiceTools[0], provider, resolves: { pi: resolved, "claude-agent": resolved, codex: resolved } }];
    let caps = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") {
        const n = ++caps;
        const body = (tools: unknown[]) => json(200, { harnesses: [], tools, features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
        // The read after the first save answers last, with what was true before the second save.
        if (n === 2) { await new Promise((r) => setTimeout(r, 300)); return body(tool("native", "native")); }
        return body(n === 1 ? tool("auto", "exa-keyless") : tool("parallel", "parallel"));
      }
      if (path === "/v2/settings/tools") return json(200, init?.method === "PUT" ? JSON.parse(String(init.body)) : { web_search: { provider: "auto" } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "#/settings/tools";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean) => { const end = Date.now() + 3000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
    const select = () => host.querySelector<HTMLSelectElement>('tr[data-tool="web_search"] select');
    await wait(() => !!select());
    const choose = async (p: string) => { await act(async () => { const s = select()!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, p); s.dispatchEvent(new Event("change", { bubbles: true })); }); };
    await choose("native");
    await choose("parallel");
    await wait(() => caps >= 3 && !!host.querySelector('tr[data-tool="web_search"]')?.textContent?.includes("Parallel"));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    const row = host.querySelector('tr[data-tool="web_search"]')!.textContent!;
    expect(row).toContain("pi: Parallel");
    expect(row).not.toContain("pi: native");
  });

  it("has no Settings in the nav when the server has no features.tool_keys", async () => {
    const page = await open({}, "#/runs");
    expect(page.nav()).toContain("Runs");
    expect(page.nav()).not.toContain("Settings");
  });

  it("#/settings/tools opens Tools, with a tab for each settings page, when the server offers a choice of provider", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/tools", choiceTools);
    expect(page.host.querySelector("h1")?.textContent).toBe("Tools");
    expect([...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent, a.getAttribute("aria-current")])).toEqual([["Tool keys", null], ["Tools", "page"]]);
    expect(page.host.querySelector('tr[data-tool="web_search"] select')).toBeTruthy();
    expect(page.asked).toContain("GET /v2/settings/tools");
  });

  it("a server with a choice of provider and no tool keys has Settings, which opens on Tools", async () => {
    const page = await open({}, "#/runs", choiceTools);
    expect(page.nav()).toContain("Settings");
    await act(async () => { [...page.host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Navigation"] button')].find((b) => b.textContent?.trim() === "Settings")!.click(); });
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(location.hash).toBe("#/settings/tools");
    expect(page.host.querySelector("h1")?.textContent).toBe("Tools");
    expect(page.host.querySelector('nav[aria-label="Settings"]')).toBeNull();
  });

  it("shows Settings when the server has the routes, and #/settings/keys opens Tool keys", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    expect(page.nav()).toContain("Settings");
    expect(page.host.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Settings");
    expect(page.host.querySelector("h1")?.textContent).toBe("Keys");
    expect(page.host.textContent).toContain("MONID_API_KEYnot set");
  });

  it("opens Settings → Webhook at #/settings/webhook on a server with the webhook routes, with a tab to each settings page", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" }, webhooks: { routes: true, events: ["run.needs_input", "run.ended"], signing: "standard-webhooks/v1", at_rest: "sealed" } }, "#/settings/webhook");
    expect(page.host.querySelector("h1")?.textContent).toBe("Webhook");
    expect(page.asked).toContain("GET /v2/settings/webhook");
    const tabs = [...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.getAttribute("aria-current")]);
    expect(tabs).toEqual([["Tool keys", "#/settings/keys", null], ["Webhook", "#/settings/webhook", "page"]]);
  });

  it("has a tab for each of the three settings pages on a server with tool keys, a choice of provider and the webhook routes", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" }, webhooks: { routes: true, events: ["run.needs_input", "run.ended"], signing: "standard-webhooks/v1", at_rest: "sealed" } }, "#/settings/webhook", choiceTools);
    expect(page.host.querySelector("h1")?.textContent).toBe("Webhook");
    const tabs = [...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.getAttribute("aria-current")]);
    expect(tabs).toEqual([["Tool keys", "#/settings/keys", null], ["Tools", "#/settings/tools", null], ["Webhook", "#/settings/webhook", "page"]]);
  });

  it("has no Webhook tab on a server without the webhook routes", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    expect(page.host.querySelector('nav[aria-label="Settings"]')).toBeNull();
  });

  it("reads the capabilities again after a key is saved, so the tools it unlocks are offered without a reload", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const button = (label: RegExp) => [...page.host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!;
    const caps = () => page.asked.filter((a) => a === "GET /v2/capabilities").length;
    expect(caps()).toBe(1);
    await act(async () => { button(/^Add key$/).click(); }); await settle();
    const input = page.host.querySelector('input[name="MONID_API_KEY"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "not-a-real-key-0123"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { button(/^Save$/).click(); }); await settle();
    expect(page.asked).toContain("PUT /v2/settings/tool-keys/monid");
    expect(caps()).toBe(2);
  });
});

// Observation works before a server-managed run or model credential exists.
describe("App, Mission Control with imported history and no model key", () => {
  it("shows imported runs and analytics without asking for provider keys", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const run = { run_id: "history-1", agent_id: "project", agent_version: 1, revision: "rev-1", kind: "agentic", status: "completed", state: "idle", title: "Existing coding session", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, imported_from: { source: "codex", session_id: "local-1" } };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url, "http://serve.test");
      asked.push(u.pathname);
      if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true });
      if (u.pathname === "/v2/capabilities") return json({ harnesses: [{ id: "pi", available: true, default_model: null }], features: { tool_keys: { routes: true, at_rest: "sealed" } }, models: { source: "providers", default: null, ready: false, needs: "key" } });
      if (u.pathname === "/v2/stats") return json({ agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [{ agent_id: "project", name: "Existing project", runs: 1 }], cost: { usd: null, basis: null, unknown_runs: 1 }, archived: { agents: 0, runs: 0 }, analytics: { ...ANALYTICS, by_source: [{ source: "codex", ...ANALYTICS.totals, runs: 1 }] } });
      if (u.pathname === "/v2/runs") return json({ runs: u.searchParams.has("status") ? [] : [run], next_cursor: null });
      if (u.pathname === "/v2/agents") return json({ agents: [], next_cursor: null });
      return new Response("{}", { status: 404 });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.querySelector('[aria-label="Start here"]') && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(host.textContent).toContain("Existing coding session");
    expect(host.querySelector('[aria-label="Analytics"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Model key"]')).toBeNull();
    expect(host.querySelector('[aria-label="No model"]')).toBeNull();
    expect(asked).not.toContain("/v2/settings/tool-keys");
    expect(host.querySelector('[aria-label="Start here"]')?.textContent).toContain("No model key needed");
  });
});

// Archive on a run's page hides it from the runs list and keeps it among the archived runs; the list's filters ask the
// server with its own parameters, and the address keeps them.
describe("App, archiving a run and filtering the runs list", () => {
  it("Archive moves the run out of the default list into the archived one; the state filter asks the server", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const run = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null as string | null };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://serve.test");
      const method = init?.method ?? "GET";
      asked.push(`${method} ${u.pathname}${u.search}`);
      if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
      if (u.pathname === "/v2/runs") {
        const archived = u.searchParams.get("archived") === "true", status = u.searchParams.get("status");
        return json(200, { runs: [run].filter((r) => !!r.archived_at === archived && (!status || r.status === status)), next_cursor: null });
      }
      if (u.pathname === "/v2/runs/r1") return json(200, run);
      if (u.pathname === "/v2/runs/r1/archive" && method === "POST") { run.archived_at = "2026-11-01T07:00:00Z"; return json(200, run); }
      if (u.pathname === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: [], complete: true, truncated: false });
      if (u.pathname === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
      return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
    });
    location.hash = "#/runs";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean, what: string) => {
      const end = Date.now() + 4000;
      while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
      expect(ok(), what).toBe(true);
    };
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
    await wait(() => !!host.textContent?.includes("What is two and two?"), "the run is listed");
    await act(async () => { button(/What is two and two\?/)!.click(); });
    await wait(() => !!button(/^Archive$/), "the run's page offers Archive");
    await act(async () => { button(/^Archive$/)!.click(); });
    await wait(() => !!button(/^Unarchive$/), "the run reads archived");
    expect(asked).toContain("POST /v2/runs/r1/archive");
    expect([...host.querySelectorAll("header")].find((h) => h.textContent?.includes("What is two and two?"))?.textContent).toContain("Archived");
    location.hash = "#/runs";
    await wait(() => !!host.textContent?.includes("No runs yet."), "the default list leaves it out");
    expect(host.textContent).not.toContain("What is two and two?");
    await act(async () => { button(/^Archived$/)!.click(); });
    await wait(() => !!host.textContent?.includes("What is two and two?"), "the archived runs hold it");
    expect(location.hash).toBe("#/runs?archived=true");
    expect(host.querySelector("h1")?.textContent).toBe("Archived runs");
    const select = host.querySelector("select[aria-label='Runs in one state']") as HTMLSelectElement;
    await act(async () => { select.value = "failed"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await wait(() => !!host.textContent?.includes("No run matches."), "no archived run failed");
    expect(location.hash).toBe("#/runs?status=failed&archived=true");
    expect(asked).toContain("GET /v2/runs?limit=50&status=failed&archived=true");
  });
});

describe("App, an agent's address", () => {
  it("opens the agent's page, and /edit opens its editor", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [{ id: "pi", available: true }], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
      if (path === "/v2/agents/calc") return json(200, calc);
      if (path === "/v2/agents/calc/runs" || path === "/v2/agents/calc/revisions") return json(200, { runs: [], revisions: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "#/agents/calc";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
    await wait(() => !!host.textContent?.includes("No runs of this agent yet."));
    expect(host.querySelector('[role="tab"]')?.textContent).toBe("Runs");
    expect(host.textContent).not.toContain("Save revision");
    await act(async () => { location.hash = "#/agents/calc/edit"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await wait(() => !!host.textContent?.includes("Save revision"));
    expect(host.textContent).toContain("Save revision");
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });
});

// An agent made in this console is named at once wherever its runs show, never by its id until a reload.
describe("App, the agents' names", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const made = recorded<Agent>("write.agent-create").body;
  const started: Run = { ...recorded<Run>("start.run").body, agent_id: made.agent_id };
  /** A server over the recorded agents (`active`, a copy, so a create never changes the recording; `archived`) and `runs`:
   *  a create adds the recorded create's agent, and a start of it answers `started` and lists it. `archivedFails`: its read
   *  of the archived agents answers 503. */
  function server({ active = [...agentsList()], archived = [] as Agent[], runs = [] as Run[], archivedFails = false } = {}) {
    const page = (r: Run): TimelinePage => ({ run_id: r.run_id, status: r.status, state: r.state, rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://serve.test");
      const method = init?.method ?? "GET";
      const [, , what, id, sub] = u.pathname.split("/").map(decodeURIComponent);
      if (what === "auth") return json(200, { password_set: true, signed_in: true });
      if (what === "capabilities") return json(200, recorded("capabilities").body);
      if (what === "stats") return json(200, {});
      if (what === "agents" && !id && method === "POST") { active.push(made); return json(201, made); }
      if (what === "agents" && !id && u.searchParams.get("archived") && archivedFails) return json(503, { error: { code: "store_busy", message: "the store is busy", retryable: true } });
      if (what === "agents" && !id) return json(200, { agents: u.searchParams.get("archived") ? archived : active, next_cursor: null });
      if (what === "agents" && !sub) return json(200, [...active, ...archived].find((a) => a.agent_id === id), { etag: `"${made.revision}"` });
      if (what === "agents" && sub === "runs" && method === "POST") { runs.unshift(started); return json(202, started); }
      if (what === "agents" && sub === "runs") return json(200, { runs: runs.filter((r) => r.agent_id === id), next_cursor: null });
      if (what === "runs" && !id) return json(200, { runs, next_cursor: null });
      const run = runs.find((r) => r.run_id === id);
      if (what === "runs" && run && !sub) return json(200, run);
      if (what === "runs" && run && sub === "timeline") return json(200, page(run));
      if (what === "runs" && run && sub === "files") return json(200, { run_id: run.run_id, files: [], complete: true, truncated: false });
      return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
    });
  }
  async function open(hash: string) {
    location.hash = hash;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const until = async (ok: () => boolean) => { for (let i = 0; i < 160 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); expect(ok()).toBe(true); };
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
    const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    const rows = () => [...host.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    return { host, until, button, type, rows };
  }

  it("names an agent made here, not by its id, on its run's page and in Runs, with no reload", async () => {
    server();
    const { host, until, button, type, rows } = await open("#/playground?operation=create-agent");
    // Create through the same API workbench linked from the hosted-style action menu.
    await until(() => !!host.querySelector("input"));
    await type(host.querySelector<HTMLInputElement>("input")!, made.definition.name!);
    await type(host.querySelector<HTMLTextAreaElement>("textarea")!, made.definition.instructions!);
    await act(async () => { button(/send request/i)!.click(); });
    await until(() => !![...host.querySelectorAll("a")].find((a) => a.textContent === "Open agent"));
    await act(async () => { location.hash = `#/playground?agent=${encodeURIComponent(made.agent_id)}`; });
    await until(() => host.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')?.value === made.agent_id);
    await type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Check the 2.3.0 entry.");
    await act(async () => { button(/send request/i)!.click(); });
    await until(() => !!button(/Open this run/));
    await act(async () => { button(/Open this run/)!.click(); });
    await until(() => location.hash === `#/runs/${encodeURIComponent(started.run_id)}` && !button(/Open this run/) && !!host.querySelector('nav[aria-label="Breadcrumb"]'));
    // The run's page names its agent in its breadcrumb.
    await until(() => host.textContent!.includes(made.definition.name!));
    expect(host.textContent).not.toContain(made.agent_id);
    // Runs names it too.
    await act(async () => { location.hash = "#/runs"; });
    await until(() => rows().some((r) => r.includes(made.definition.name!)));
    expect(rows().join("\n")).not.toContain(made.agent_id);
  });

  it("opens the requested agent in the Playground and names its first run correctly", async () => {
    server();
    const { host, until, button, type } = await open("#/playground?operation=create-agent");
    await until(() => !!host.querySelector("input"));
    await type(host.querySelector<HTMLInputElement>("input")!, made.definition.name!);
    await type(host.querySelector<HTMLTextAreaElement>("textarea")!, made.definition.instructions!);
    await act(async () => { button(/send request/i)!.click(); });
    await until(() => !![...host.querySelectorAll("a")].find((a) => a.textContent === "Open agent"));
    // Straight to the Playground, as a person tries a new agent: it is offered there, picked, and run.
    await act(async () => { location.hash = `#/playground?agent=${encodeURIComponent(made.agent_id)}`; });
    const pick = () => host.querySelector<HTMLSelectElement>('select[aria-label="Agent"]');
    await until(() => [...(pick()?.options ?? [])].some((o) => o.value === made.agent_id));
    expect(pick()?.value).toBe(made.agent_id);
    await type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Check the 2.3.0 entry.");
    await act(async () => { button(/send request/i)!.click(); });
    // The run panel's breadcrumb names the agent, as the run's page does.
    const crumb = () => host.querySelector('nav[aria-label="Breadcrumb"]')?.textContent ?? "";
    await until(() => crumb().includes(`Run ${runLabel(started.run_id)}`));
    await until(() => crumb().includes(made.definition.name!));
    expect(crumb()).not.toContain(made.agent_id);
  });

  it("updates the Playground target when its URL changes and never substitutes a missing agent", async () => {
    const [first, second] = agentsList();
    server({ active: [first, second] });
    const { host, until } = await open(`#/playground?agent=${encodeURIComponent(second.agent_id)}`);
    const selected = () => host.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')?.value;
    await until(() => selected() === second.agent_id);
    expect(selected()).toBe(second.agent_id);
    await act(async () => { location.hash = `#/playground?agent=${encodeURIComponent(first.agent_id)}`; });
    await until(() => selected() === first.agent_id);
    expect(selected()).toBe(first.agent_id);
    await act(async () => { location.hash = "#/playground?agent=missing-agent"; });
    await until(() => !!host.querySelector('[role="alert"]'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("selected agent is unavailable or archived");
    expect(host.querySelector('select[aria-label="Agent"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some((b) => /send request/i.test(b.textContent ?? ""))).toBe(false);
  });
  it("edits the agent selected in the run form when it differs from the original link", async () => {
    const [first, second] = agentsList();
    server({ active: [first, second] });
    const { host, until } = await open(`#/playground?agent=${encodeURIComponent(first.agent_id)}`);
    await until(() => !!host.querySelector('select[aria-label="Agent"]'));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')!;
      select.value = second.agent_id; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      const operation = host.querySelector<HTMLSelectElement>("#api-operation")!;
      operation.value = "edit-agent"; operation.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => location.hash.includes(`agent=${encodeURIComponent(second.agent_id)}`) && !!host.querySelector('input[aria-label="Name"]'));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe(second.definition.name);
  });

  it("names a run of an archived agent, which is not gone, and shows the id of one that is", async () => {
    const [kept, ...active] = agentsList();
    const gone = "01a18400-0000-7000-8000-000000000000";
    const run = recorded<Run>("start.run").body;
    server({ active, archived: [{ ...kept, archived_at: "2026-11-02T12:00:00Z" }], runs: [{ ...run, agent_id: kept.agent_id }, { ...run, run_id: `${run.run_id}-2`, agent_id: gone }] });
    const { until, rows } = await open("#/runs");
    await until(() => rows().length === 2 && rows()[0].includes(kept.definition.name!));
    expect(rows()[1]).toContain(gone);
  });

  it("keeps the active agents' names when the read of the archived ones fails, and shows no id as gone meanwhile", async () => {
    const [mine, ...rest] = agentsList();
    const [kept] = rest;
    const run = recorded<Run>("start.run").body;
    server({ active: [mine], archived: [{ ...kept, archived_at: "2026-11-02T12:00:00Z" }], archivedFails: true, runs: [{ ...run, agent_id: mine.agent_id }, { ...run, run_id: `${run.run_id}-2`, agent_id: kept.agent_id }] });
    const { until, rows } = await open("#/runs");
    await until(() => rows().length === 2 && rows()[0].includes(mine.definition.name!));
    // The archived agent's name could not be read: its run shows neither a name nor an id that would read as gone.
    expect(rows()[1]).not.toContain(kept.agent_id);
    expect(rows()[1]).not.toContain(kept.definition.name!);
  });
});

describe("App, the playground when its agents can't be read", () => {
  it("says the server's refusal in words, with its own message", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/agents") return json(400, { error: { code: "invalid_cursor", message: "that cursor is not one this server gave", retryable: false } });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "#/playground";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.textContent?.includes("could not be read") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(host.querySelector('[role="alert"] p')?.textContent).toBe("The agents could not be read: The server turned the request down. Its words say why: change what they name, then try again. (that cursor is not one this server gave)");
  });
});

// Execution setup is shown in the Playground only. Browsing history and agents needs no provider key.
describe("App, the no-model bar", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  // `keys`: how the server keeps tool keys (features.tool_keys): sealed, routes with no seal key, or no key routes at all.
  const serve = (models: () => Record<string, unknown>, keys: "sealed" | "unavailable" | false = "sealed", stats?: unknown) => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, ...(keys ? { tool_keys: { routes: true, at_rest: keys } } : {}) }, models: models() });
      if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
      if (path === "/v2/stats") return stats ? json(200, stats) : json(404, { error: { code: "not_found", message: "no route GET /v2/stats", retryable: false } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    return asked;
  };
  const mount = async (hash: string) => {
    location.hash = hash;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    return host;
  };
  const until = async (done: () => boolean) => { const end = Date.now() + 4000; while (!done() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
  const bar = (host: HTMLElement) => host.querySelector('[aria-label="No model"]');

  it("says what to set in the Playground, leading with the Settings link, and goes once the server says ready, read again when the page comes back into view", async () => {
    let ready = false;
    const asked = serve(() => ({ source: "providers", default: ready ? "anthropic/claude-sonnet-5-5" : null, ready, needs: ready ? null : "key" }));
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. Add a key in Settings → Model keys (one OpenRouter key gives every harness its model), and it takes effect at once. Or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY where AgentRun starts, and restart.");
    expect(bar(host)?.querySelector("a")?.textContent).toBe("Add a key in Settings → Model keys");
    expect(bar(host)?.querySelector("a")?.getAttribute("href")).toBe("#/settings/keys");
    ready = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await until(() => !bar(host));
    expect(bar(host)).toBeNull();
    expect(asked.filter((a) => a === "GET /v2/capabilities").length).toBeGreaterThanOrEqual(2);
  });

  it("reads the capabilities again on its own while no model is ready, and stops once one is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let ready = false;
    const asked = serve(() => ({ source: "providers", default: null, ready, needs: ready ? null : "key" }));
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    const reads = () => asked.filter((a) => a === "GET /v2/capabilities").length;
    const before = reads();
    ready = true;
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await until(() => !bar(host));
    expect(reads()).toBe(before + 1);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(reads()).toBe(before + 1);
    vi.useRealTimers();
  });

  it("says to set a key and restart where the server keeps no keys, one OpenRouter key giving every harness its model", async () => {
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), false);
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("says to set a key and restart, with no Settings link, where the server has key routes but no seal key to keep one", async () => {
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  // Settings → Model keys holds only some providers' keys, so for a named default the bar names no Settings path at all.
  for (const model of ["anthropic/claude-sonnet-5-5", "deepseek/deepseek-v4-pro"])
    it(`names the server's default model ${model} and says to set its provider's key and restart, with no Settings link or OpenRouter promise, where the server keeps keys`, async () => {
      serve(() => ({ source: "providers", default: model, ready: false, needs: "key" }));
      const host = await mount("#/playground");
      await until(() => !!bar(host));
      expect(bar(host)?.textContent).toBe(`No model yet. This server's default model is ${model}: set its provider's key where AgentRun starts, and restart.`);
      expect(bar(host)?.querySelector("a")).toBeNull();
    });

  it("names the server's default model and says to set its provider's key and restart where the server can't keep a key", async () => {
    serve(() => ({ source: "providers", default: "anthropic/claude-sonnet-5-5", ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server's default model is anthropic/claude-sonnet-5-5: set its provider's key where AgentRun starts, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("says to name the gateway's model in AGENT_MODEL, or add a model key in Settings, with no OpenRouter promise, where the server sends its models to a gateway", async () => {
    serve(() => ({ source: "gateway", default: null, ready: false, needs: "key" }));
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server sends its models to a gateway: name the gateway's model in AGENT_MODEL where AgentRun starts, and restart, or add a model key in Settings → Model keys.");
    expect(bar(host)?.querySelector("a")?.textContent).toBe("add a model key in Settings → Model keys");
    expect(bar(host)?.querySelector("a")?.getAttribute("href")).toBe("#/settings/keys");
  });

  it("says only to name the gateway's model in AGENT_MODEL, with no Settings link, on a gateway server that can't keep a key", async () => {
    serve(() => ({ source: "gateway", default: null, ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server sends its models to a gateway: name the gateway's model in AGENT_MODEL where AgentRun starts, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("names AGENT_MODEL for execution when it is the problem, with no key request on the first screen", async () => {
    serve(() => ({ source: "providers", default: "acme/unknown", ready: false, needs: "model" }), false);
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("This server's default model doesn't run here: set AGENT_MODEL to a model it knows, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
    act(() => root!.unmount()); root = undefined;
    const first = await mount("");
    await until(() => !!first.textContent?.includes("Mission Control could not be read"));
    expect(first.querySelector('section[aria-label="Model key"]')).toBeNull();
    expect(bar(first)).toBeNull();
  });

  // Every capabilities read goes through one guarded reader: a read the page made earlier that answers after a newer
  // one (a slow poll, then the next) never puts the older answer back.
  it("never puts back an older capabilities answer that comes after a newer one", async () => {
    let ready = false;
    let hold: ((r: Response) => void) | undefined;
    let held = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") {
        const body = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" } }, models: { source: "providers", default: ready ? "anthropic/claude-sonnet-5-5" : null, ready, needs: ready ? null : "key" } };
        if (held) { held = false; return new Promise<Response>((resolve) => { hold = resolve; }); }
        return json(200, body);
      }
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    const host = await mount("#/playground");
    await until(() => !!bar(host));
    held = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    ready = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await until(() => !bar(host));
    expect(bar(host)).toBeNull();
    await act(async () => { hold!(json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } }, models: { source: "providers", default: null, ready: false, needs: "key" } })); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(bar(host)).toBeNull();
  });

  it("does not ask for model credentials while browsing agents, runs or Settings", async () => {
    for (const hash of ["#/agents", "#/runs", "#/settings/keys"]) {
      serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }));
      const host = await mount(hash);
      await until(() => !!host.querySelector('[aria-label="Navigation"]'));
      expect(bar(host)).toBeNull();
      expect(host.querySelector('[aria-label="Model key"]')).toBeNull();
      act(() => root!.unmount()); root = undefined;
    }
  });

});
