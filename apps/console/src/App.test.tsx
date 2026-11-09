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
  it("opens the triggers list, a new schedule, a new webhook, one trigger, and a schedule's editor at their own addresses", () => {
    expect(route("#/triggers")).toEqual({ section: "triggers" });
    expect(route("#/triggers/new")).toEqual({ section: "triggers", trigger: null, kind: "schedule" });
    expect(route("#/triggers/new-webhook")).toEqual({ section: "triggers", trigger: null, kind: "webhook" });
    expect(route("#/triggers/new-github")).toEqual({ section: "triggers", trigger: null, kind: "github" });
    expect(route("#/triggers/trg_1")).toEqual({ section: "triggers", trigger: "trg_1" });
    expect(route("#/triggers/trg_1/edit")).toEqual({ section: "triggers", trigger: "trg_1", edit: true });
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
// The Playground's pickers watch their field's size; jsdom has no ResizeObserver (not a stub: the tests' own globals
// are unstubbed after each).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
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
      if (path === "/v2/settings/mcp-servers") return json(200, { servers: [] });
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

  it("has Settings in the nav on a server with no features.tool_keys too: every server has MCP servers", async () => {
    const page = await open({}, "#/runs");
    expect(page.nav()).toContain("Runs");
    expect(page.nav()).toContain("Settings");
    await act(async () => { [...page.host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Navigation"] button')].find((b) => b.textContent?.trim() === "Settings")!.click(); });
    expect(location.hash).toBe("#/settings/mcp");
  });

  it("#/settings/tools opens Tools, with a tab for each settings page, when the server offers a choice of provider", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/tools", choiceTools);
    expect(page.host.querySelector("h1")?.textContent).toBe("Tools");
    expect([...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent, a.getAttribute("aria-current")])).toEqual([["Tool keys", null], ["Tools", "page"], ["MCP servers", null], ["GitHub", null]]);
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
    expect([...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => a.textContent?.trim())).toEqual(["Tools", "MCP servers", "GitHub"]);
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
    expect(tabs).toEqual([["Tool keys", "#/settings/keys", null], ["MCP servers", "#/settings/mcp", null], ["GitHub", "#/settings/github", null], ["Webhook", "#/settings/webhook", "page"]]);
  });

  it("has a tab for each settings page on a server with tool keys, a choice of provider and the webhook routes", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" }, webhooks: { routes: true, events: ["run.needs_input", "run.ended"], signing: "standard-webhooks/v1", at_rest: "sealed" } }, "#/settings/webhook", choiceTools);
    expect(page.host.querySelector("h1")?.textContent).toBe("Webhook");
    const tabs = [...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.getAttribute("aria-current")]);
    expect(tabs).toEqual([["Tool keys", "#/settings/keys", null], ["Tools", "#/settings/tools", null], ["MCP servers", "#/settings/mcp", null], ["GitHub", "#/settings/github", null], ["Webhook", "#/settings/webhook", "page"]]);
  });

  it("has no Webhook tab on a server without the webhook routes", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    const tabs = [...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => a.textContent?.trim());
    expect(tabs).toEqual(["Tool keys", "MCP servers", "GitHub"]);
  });

  it("lists MCP servers in Settings on every server, its capabilities naming no MCP routes, and opens the page there", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" }, mcp_client: { transports: ["streamable-http"], auth: ["none", "bearer"], at_rest: "sealed", harnesses: ["pi"] } }, "#/settings/mcp");
    const tabs = [...page.host.querySelectorAll('nav[aria-label="Settings"] a')].map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.getAttribute("aria-current")]);
    expect(tabs).toEqual([["Tool keys", "#/settings/keys", null], ["MCP servers", "#/settings/mcp", "page"], ["GitHub", "#/settings/github", null]]);
    expect(page.asked).toContain("GET /v2/settings/mcp-servers");
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

// The first screen asks for a model key while the server says an agent that names no model can't run, and the card
// goes once a key saved through its route makes the capabilities say ready.
describe("App, the model key card on the first screen", () => {
  it("shows while models.ready is false, saves the key, reads the capabilities again, and goes once they say ready", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const features = { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" } };
    const keys = { keys: [{ id: "anthropic", kind: "model", label: "Anthropic", fields: [{ name: "ANTHROPIC_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi"] }], reenter: null };
    const asked: string[] = [];
    let ready = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features, models: { source: "providers", default: ready ? "anthropic/claude-sonnet-5-5" : null, ready, needs: ready ? null : "key" } });
      if (path === "/v2/settings/tool-keys/anthropic") { ready = true; return new Response(null, { status: 204 }); }
      if (path === "/v2/settings/tool-keys") return json(200, keys);
      if (path === "/v2/stats") return json(404, { error: { code: "not_found", message: "no route GET /v2/stats", retryable: false } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const card = () => host.querySelector('section[aria-label="Model key"]');
    const until = async (done: () => boolean) => { const end = Date.now() + 4000; while (!done() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
    await until(() => !!card()?.querySelector("button"));
    expect(card()?.textContent).toContain("Add a model key to run agents");
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!;
    await act(async () => { button(/^Anthropic$/).click(); });
    await until(() => !!host.querySelector('input[name="ANTHROPIC_API_KEY"]'));
    const input = host.querySelector('input[name="ANTHROPIC_API_KEY"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "not-a-real-key-0123"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { button(/^Save$/).click(); });
    await until(() => !card());
    expect(asked).toContain("PUT /v2/settings/tool-keys/anthropic");
    expect(asked.filter((a) => a === "GET /v2/capabilities").length).toBe(2);
    expect(card()).toBeNull();
    expect(host.innerHTML).not.toContain("not-a-real-key-0123");
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
    const page = (r: Run): TimelinePage => ({ cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, run_id: r.run_id, status: r.status, state: r.state, rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
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
    const { host, until, button, type, rows } = await open("#/agents/new");
    // Create it from the editor, as a person does: its name and instructions, then Create.
    await until(() => !!host.querySelector('input[placeholder="e.g., Invoice checker"]'));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="e.g., Invoice checker"]')!, made.definition.name!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Describe what the agent does"]')!, made.definition.instructions!);
    await act(async () => { button(/^Create$/)!.click(); });
    // Its page, then a run of it from the run bar: the run's page opens.
    await until(() => location.hash === `#/agents/${encodeURIComponent(made.agent_id)}` && !!host.querySelector('section[aria-label="Start a run"] textarea'));
    await type(host.querySelector<HTMLTextAreaElement>('section[aria-label="Start a run"] textarea')!, "Check the 2.3.0 entry.");
    await act(async () => { button(/^Run$/)!.click(); });
    await until(() => location.hash === `#/runs/${encodeURIComponent(started.run_id)}` && !!host.querySelector("h1"));
    // The run's page names its agent in its breadcrumb.
    await until(() => host.textContent!.includes(made.definition.name!));
    expect(host.textContent).not.toContain(made.agent_id);
    // Runs names it too.
    await act(async () => { location.hash = "#/runs"; });
    await until(() => rows().some((r) => r.includes(made.definition.name!)));
    expect(rows().join("\n")).not.toContain(made.agent_id);
  });

  it("names an agent made here, not by its id, on its first run in the Playground", async () => {
    server();
    const { host, until, button, type } = await open("#/agents/new");
    await until(() => !!host.querySelector('input[placeholder="e.g., Invoice checker"]'));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="e.g., Invoice checker"]')!, made.definition.name!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Describe what the agent does"]')!, made.definition.instructions!);
    await act(async () => { button(/^Create$/)!.click(); });
    await until(() => location.hash === `#/agents/${encodeURIComponent(made.agent_id)}`);
    // Straight to the Playground, as a person tries a new agent: it is offered there, picked, and run.
    await act(async () => { location.hash = "#/playground"; });
    // The Agent picker: opened, the agent made here is among its options, and picked.
    const pick = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-label="Agent"]');
    await until(() => !!pick());
    await act(async () => { pick()!.click(); });
    const option = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((o) => o.textContent === made.definition.name) as HTMLElement | undefined;
    await until(() => !!option());
    await act(async () => { option()!.click(); });
    await until(() => !!pick()?.textContent?.includes(made.definition.name!));
    await type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Check the 2.3.0 entry.");
    await act(async () => { button(/send request/i)!.click(); });
    // The run panel's breadcrumb names the agent, as the run's page does.
    const crumb = () => host.querySelector('nav[aria-label="Breadcrumb"]')?.textContent ?? "";
    await until(() => crumb().includes(`Run ${runLabel(started.run_id)}`));
    await until(() => crumb().includes(made.definition.name!));
    expect(crumb()).not.toContain(made.agent_id);
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

// QA's first run with no model key gave no sign until a run failed: every page but the first screen (which has the key
// card) shows a bar while capabilities say no model is ready, and it goes by itself once they say ready.
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

  it("says what to set on a page that is not the first screen, leading with the Settings link, and goes once the server says ready, read again when the page comes back into view", async () => {
    let ready = false;
    const asked = serve(() => ({ source: "providers", default: ready ? "anthropic/claude-sonnet-5-5" : null, ready, needs: ready ? null : "key" }));
    const host = await mount("#/runs");
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

  it("sits above the page, outside its scrolling main, so a full-height page (the agent editor) keeps its footer in view", async () => {
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }));
    const host = await mount("#/agents/new");
    await until(() => !!bar(host) && !!host.querySelector("main"));
    const main = host.querySelector("main")!;
    // The bar is not inside main: main's height is what is left under it, and the editor fills main, not main plus the bar.
    expect(main.contains(bar(host))).toBe(false);
    expect(bar(host)!.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
    expect(main.className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "min-h-0"]));
  });

  it("reads the capabilities again on its own while no model is ready, and stops once one is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let ready = false;
    const asked = serve(() => ({ source: "providers", default: null, ready, needs: ready ? null : "key" }));
    const host = await mount("#/agents");
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
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("says to set a key and restart, with no Settings link, where the server has key routes but no seal key to keep one", async () => {
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. Set OPENROUTER_API_KEY (one key gives every harness its model), or ANTHROPIC_API_KEY or OPENAI_API_KEY, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  // Settings → Model keys holds only some providers' keys, so for a named default the bar names no Settings path at all.
  for (const model of ["anthropic/claude-sonnet-5-5", "deepseek/deepseek-v4-pro"])
    it(`names the server's default model ${model} and says to set its provider's key and restart, with no Settings link or OpenRouter promise, where the server keeps keys`, async () => {
      serve(() => ({ source: "providers", default: model, ready: false, needs: "key" }));
      const host = await mount("#/runs");
      await until(() => !!bar(host));
      expect(bar(host)?.textContent).toBe(`No model yet. This server's default model is ${model}: set its provider's key where AgentRun starts, and restart.`);
      expect(bar(host)?.querySelector("a")).toBeNull();
    });

  it("names the server's default model and says to set its provider's key and restart where the server can't keep a key", async () => {
    serve(() => ({ source: "providers", default: "anthropic/claude-sonnet-5-5", ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server's default model is anthropic/claude-sonnet-5-5: set its provider's key where AgentRun starts, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("says to name the gateway's model in AGENT_MODEL, or add a model key in Settings, with no OpenRouter promise, where the server sends its models to a gateway", async () => {
    serve(() => ({ source: "gateway", default: null, ready: false, needs: "key" }));
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server sends its models to a gateway: name the gateway's model in AGENT_MODEL where AgentRun starts, and restart, or add a model key in Settings → Model keys.");
    expect(bar(host)?.querySelector("a")?.textContent).toBe("add a model key in Settings → Model keys");
    expect(bar(host)?.querySelector("a")?.getAttribute("href")).toBe("#/settings/keys");
  });

  it("says only to name the gateway's model in AGENT_MODEL, with no Settings link, on a gateway server that can't keep a key", async () => {
    serve(() => ({ source: "gateway", default: null, ready: false, needs: "key" }), "unavailable");
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("No model yet. This server sends its models to a gateway: name the gateway's model in AGENT_MODEL where AgentRun starts, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
  });

  it("names AGENT_MODEL when it is the problem, has no Settings link where the server keeps no keys, and is not on the first screen, which has the key card", async () => {
    serve(() => ({ source: "providers", default: "acme/unknown", ready: false, needs: "model" }), false);
    const host = await mount("#/runs");
    await until(() => !!bar(host));
    expect(bar(host)?.textContent).toBe("This server's default model doesn't run here: set AGENT_MODEL to a model it knows, and restart.");
    expect(bar(host)?.querySelector("a")).toBeNull();
    act(() => root!.unmount()); root = undefined;
    const first = await mount("");
    await until(() => !!first.querySelector('section[aria-label="Model key"]'));
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
    const host = await mount("#/runs");
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

  // QA: the first screen's start-here step told the person to restart with AGENT_MODEL and reload, under a key card
  // that saves a key with no restart. Where the server keeps keys it points at the card; where it keeps none, the env.
  it("points the first screen's model step at the key card above where the server keeps keys, and keeps the env text where it keeps none", async () => {
    const step = (host: HTMLElement) => host.querySelector('section[aria-label="Start here"]');
    // Nothing of the owner's has run yet, so the first screen shows the start-here panel.
    const fresh = { agents: 0, runs: { total: 0, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 0 }, archived: { agents: 0, runs: 0 }, analytics: { ...ANALYTICS, by_source: [] } };
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), "sealed", fresh);
    const keys = await mount("");
    await until(() => !!step(keys)?.textContent?.includes("Add a model key"));
    expect(keys.querySelector('section[aria-label="Model key"]')).not.toBeNull();
    expect(step(keys)?.textContent).toContain("Add a model key in the card above, and the templates here run in one click.");
    expect(step(keys)?.textContent).not.toContain("AGENT_MODEL");
    expect(step(keys)?.textContent).not.toContain("reload");
    act(() => root!.unmount()); root = undefined;
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), false, fresh);
    const none = await mount("");
    await until(() => !!step(none)?.textContent?.includes("Add a model key"));
    expect(step(none)?.textContent).toContain("AGENT_MODEL");
    expect(step(none)?.textContent).toContain("Then reload this page");
    expect(step(none)?.textContent).not.toContain("card above");
    act(() => root!.unmount()); root = undefined;
    // Key routes but no seal key: the server refuses every save (no_sealing_key), so the card can't take one.
    serve(() => ({ source: "providers", default: null, ready: false, needs: "key" }), "unavailable", fresh);
    const unsealed = await mount("");
    await until(() => !!step(unsealed)?.textContent?.includes("Add a model key"));
    expect(step(unsealed)?.textContent).toContain("AGENT_MODEL");
    expect(step(unsealed)?.textContent).toContain("Then reload this page");
    expect(step(unsealed)?.textContent).not.toContain("card above");
    act(() => root!.unmount()); root = undefined;
    // A gateway with no AGENT_MODEL: a provider's key saved in the card names no gateway model, so the env text stays.
    serve(() => ({ source: "gateway", default: null, ready: false, needs: "key" }), "sealed", fresh);
    const gateway = await mount("");
    await until(() => !!step(gateway)?.textContent?.includes("Add a model key"));
    expect(step(gateway)?.textContent).toContain("AGENT_MODEL_BASE_URL");
    expect(step(gateway)?.textContent).not.toContain("card above");
    act(() => root!.unmount()); root = undefined;
    // AGENT_MODEL names a default whose provider's key the card may not offer: the step keeps the env text.
    serve(() => ({ source: "providers", default: "deepseek/deepseek-v4-pro", ready: false, needs: "key" }), "sealed", fresh);
    const named = await mount("");
    await until(() => !!step(named)?.textContent?.includes("Add a model key"));
    expect(step(named)?.textContent).toContain("AGENT_MODEL");
    expect(step(named)?.textContent).not.toContain("card above");
    act(() => root!.unmount()); root = undefined;
    // AGENT_MODEL is the problem, which the card says no key fixes: the step keeps the env text.
    serve(() => ({ source: "providers", default: "acme/unknown", ready: false, needs: "model" }), "sealed", fresh);
    const model = await mount("");
    await until(() => !!step(model)?.textContent?.includes("Add a model key"));
    expect(step(model)?.textContent).toContain("AGENT_MODEL");
    expect(step(model)?.textContent).not.toContain("card above");
  });

  it("shows nothing while a model is ready", async () => {
    const asked = serve(() => ({ source: "providers", default: "anthropic/claude-sonnet-5-5", ready: true, needs: null }));
    const host = await mount("#/runs");
    await until(() => asked.includes("GET /v2/capabilities"));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(bar(host)).toBeNull();
  });
});

// A run page's back arrow goes back: to the console page the person came from (the runs list, the agent's page), or, on a
// run opened at its own address (a link from elsewhere), to its agent's page. The breadcrumb's agent name links there too.
describe("App, a run page's back arrow", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const run = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null };
  const calc = { agent_id: "calc", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
  const serve = () => vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: [run], next_cursor: null });
    if (u.pathname === "/v2/runs/r1") return json(200, run);
    if (u.pathname === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: [], complete: true, truncated: false });
    if (u.pathname === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  const wait = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 4000;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  const mount = () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    return host;
  };
  const back = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('nav[aria-label="Breadcrumb"] button[aria-label="Back"]');
  // Each test starts as a page load would: an address the console never numbered.
  // (The address's own hashchange is let through first, before the console is there to number it.)
  const fresh = async (hash: string) => { location.hash = hash; await new Promise((r) => setTimeout(r, 20)); history.replaceState(null, ""); };

  it("goes back to the runs list a run was opened from", async () => {
    serve(); await fresh("#/runs");
    const host = mount();
    await wait(() => !!host.textContent?.includes("What is two and two?"), "the run is listed");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /What is two and two\?/.test(b.textContent ?? ""))!.click(); });
    await wait(() => !!back(host), "the run's page has a back arrow");
    expect(location.hash).toBe("#/runs/r1");
    await act(async () => { back(host)!.click(); });
    await wait(() => location.hash === "#/runs", "back on the runs list");
  });

  it("goes back to the agent's page a run was opened from", async () => {
    serve(); await fresh("#/agents/calc");
    const host = mount();
    await act(async () => { location.hash = "#/runs/r1"; });
    await wait(() => !!back(host), "the run's page has a back arrow");
    await act(async () => { back(host)!.click(); });
    await wait(() => location.hash === "#/agents/calc", "back on the agent's page");
  });

  it("a run opened at its own address goes to its agent's page, whose name in the breadcrumb links there too", async () => {
    serve(); await fresh("#/runs/r1");
    const host = mount();
    await wait(() => !!back(host), "the run's page has a back arrow");
    const name = host.querySelector<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a');
    expect(name?.textContent).toBe("Calc");
    expect(name?.getAttribute("href")).toBe("#/agents/calc");
    await act(async () => { back(host)!.click(); });
    await wait(() => location.hash === "#/agents/calc", "on the agent's page");
  });
});
