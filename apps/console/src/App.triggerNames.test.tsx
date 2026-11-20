import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { agentsList, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import type { Trigger } from "@/lib/v2";

// Triggers names each trigger's agent. The console reads the agents' names when it opens; an agent made after that (a
// template applied from a URL makes one, with its triggers) must still be named on Triggers, never shown by its id.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const INBOX: Agent = { ...agentsList()[0]!, agent_id: "01a1f9ff-0000-7000-8000-000000000001", definition: { ...agentsList()[0]!.definition, name: "Inbox assistant" } };
const triggerOf = (id: string, name: string, source: Trigger["source"]): Trigger => ({
  id, name, enabled: true, source, target: { kind: "start_run", agent_id: INBOX.agent_id, input: { content: "Sort the new mail." }, max_cost_usd: 0.5 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: null, last_firing: null,
} as Trigger);
const MADE = [
  triggerOf("trg_mail", "new-mail", { kind: "email", account: "default", mailbox: "INBOX", every_s: 60 }),
  triggerOf("trg_eve", "evening-digest", { kind: "schedule", cron: "0 18 * * *", timezone: "UTC" }),
];

/** A server whose agents and triggers grow while the console is open (`state.applied`: the apply has run). */
function server() {
  const state = { applied: false };
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    const [, , what, id, sub] = u.pathname.split("/").map(decodeURIComponent);
    if (what === "auth") return json(200, { password_set: true, signed_in: true, secrets_writable: true });
    if (what === "capabilities") return json(200, recorded("capabilities").body);
    if (what === "stats") return json(200, {});
    if (what === "agents" && !id) return json(200, { agents: u.searchParams.get("archived") || !state.applied ? [] : [INBOX], next_cursor: null });
    if (what === "agents" && id === INBOX.agent_id && state.applied) return json(200, { ...INBOX, tools: [] });
    if (what === "triggers" && !id) return json(200, { triggers: state.applied ? MADE : [] });
    const made = state.applied ? MADE.find((t) => t.id === id) : undefined;
    if (what === "triggers" && made && sub === "firings") return json(200, { firings: [] });
    if (what === "triggers" && made) return json(200, made);
    if (what === "runs" && !id) return json(200, { runs: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  return state;
}

describe("App, Triggers names an agent made after the console opened", () => {
  it("names the agent a template's apply made, on the list and on its trigger's page, never by its id", async () => {
    const state = server();
    location.hash = "#/triggers";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const until = async (ok: () => boolean) => { for (let i = 0; i < 160 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); expect(ok()).toBe(true); };
    await until(() => !!host.textContent?.includes("No triggers yet"));
    // The apply runs (here, as from a URL in another tab): an agent and its triggers made after the names were read.
    state.applied = true;
    await act(async () => { location.hash = "#/templates"; });
    await until(() => !host.textContent?.includes("No triggers yet"));
    await act(async () => { location.hash = "#/triggers"; });
    const rows = () => [...host.querySelectorAll("[data-trigger]")].map((r) => r.textContent ?? "");
    await until(() => rows().length === 2);
    for (let i = 0; i < 40 && !rows().every((r) => r.includes("Inbox assistant")); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(rows().filter((r) => r.includes(INBOX.agent_id))).toEqual([]);
    expect(rows().every((r) => r.includes("Inbox assistant"))).toBe(true);
    await act(async () => { location.hash = "#/triggers/trg_mail"; });
    const agent = () => host.querySelector(`dl a[href="#/agents/${INBOX.agent_id}"]`)?.textContent;
    await until(() => agent() === "Inbox assistant");
  });
});
