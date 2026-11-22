import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionsPage } from "./SuggestionsPage";
import { ToastProvider } from "@/components/ui";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import { keepReturn, permissionLabel, RETURN_KEY, scanLine, takeReturn } from "@/lib/suggestions";

// Suggested agents over /v2/suggestions: not connected, the page explains itself and connects GitHub with the write
// permission the pull requests need (opt-out); connected, it lists each scanned repository's suggestions with the lines
// behind them, discards one (gone at once, with an undo) and creates one through a dialog that checks GitHub first,
// says what is missing and where to fix it, then shows the pull request and what the app sets.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let submits = 0;
beforeEach(() => { submits = 0; sessionStorage.clear(); vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => { submits += 1; }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

const REPO = "acme/shop";
const SUGGESTION = {
  id: "sg_0123456789abcdef0123", repo: REPO, key: "ticket-triage", status: "open", title: "Triage support tickets", summary: "Reads a new ticket and answers its category and priority.",
  why: "Every ticket waits as needs_triage for a person to sort it.", impact: "high",
  evidence: [{ path: "src/support/inbox.ts", line: 42, quote: "status: 'needs_triage'", url: `https://github.com/${REPO}/blob/abc/src/support/inbox.ts#L42` }],
  agent: { name: "Support ticket triage", description: "Sorts a ticket.", inputs: [{ name: "subject", type: "string", description: "its subject", required: true }, { name: "body", type: "string", description: "its text", required: false }], output: [{ name: "category", type: "string", description: "its category", enum: ["billing", "bug"] }, { name: "reason", type: "string", description: "why" }], tools: [], tier: "fast" },
  integration: { language: "typescript", path: "src/support/ticket-triage-agent.ts", call_site: { path: "src/support/inbox.ts", line: 42, note: "Call it when a ticket is saved.", url: `https://github.com/${REPO}/blob/abc/src/support/inbox.ts#L42` } },
  scan: { run_id: "run_1", commit: "a".repeat(40), at: "2026-11-21T08:00:00.000Z" }, decided_at: null, created: null,
};
const SCANNED = { repo: REPO, scan: { run_id: "run_1", agent_id: "scout", started_at: "2026-11-21T07:58:00.000Z", status: "completed", ended_at: "2026-11-21T08:00:00.000Z", app: "A shop with a help desk.", commit: "a".repeat(40), found: 1, dropped: [], already_decided: 0, error: null }, counts: { open: 1, created: 0, discarded: 0 } };
const READY = { ready: true, reason: null, message: null, missing: [], install_url: "https://github.com/apps/agentrun-acme/installations/new", permissions_url: "https://github.com/organizations/acme/settings/apps/agentrun-acme/permissions", installation_url: "https://github.com/organizations/acme/settings/installations/7" };
const SHORT = { ...READY, ready: false, reason: "permission_missing", message: "Opening a pull request on acme/shop needs the GitHub App's Contents: Read and write, which its installation on acme does not have yet.", missing: ["contents: write"] };

type Call = { method: string; path: string; query: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Listing = { repositories: { full_name: string; private: boolean; account: string; installation: number }[]; truncated: boolean; unread: { account: string; why: string }[] };
function server(state: { connected: boolean; suggestions: typeof SUGGESTION[]; readiness: typeof READY | typeof SHORT; repos?: Listing }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, query: new URL(String(url), "http://serve.test").search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const one = state.suggestions.find((s) => call.path.startsWith(`/v2/suggestions/${s.id}`));
    if (call.path === "/v2/suggestions" && call.method === "GET") return json(200, { github: state.connected ? { connected: true, app: "agentrun-acme", installations: [{ account: "acme" }], install_url: READY.install_url } : { connected: false, app: null, installations: [], install_url: null }, repositories: state.connected ? [SCANNED] : [], suggestions: state.suggestions.filter((s) => s.status !== "discarded") });
    if (call.path === "/v2/integrations/github/connect") return json(200, { action: "https://github.com/settings/apps/new?state=st_1", manifest: { name: "x" }, state: "st_1" });
    if (call.path === "/v2/integrations/github/repositories") return json(200, state.repos ?? { repositories: [{ full_name: REPO, private: true, account: "acme", installation: 7 }], truncated: false, unread: [] });
    if (one && call.path.endsWith("/discard")) { one.status = "discarded"; return json(200, one); }
    if (one && call.path.endsWith("/restore")) { one.status = "open"; return json(200, one); }
    if (one && call.path.endsWith("/create")) {
      one.status = "created";
      Object.assign(one, { created: { agent_id: "agent_77", template_id: `github:${REPO}/.agentrun/agents/ticket-triage`, branch: "agentrun/ticket-triage", pull_request: { number: 12, url: `https://github.com/${REPO}/pull/12` }, pull_error: null } });
      return json(201, { ...one, warnings: [] });
    }
    if (one && call.method === "GET") return json(200, { ...one, agent: { ...one.agent, instructions: "You triage tickets." }, files: [{ path: ".agentrun/agents/ticket-triage/agent.md", content: "---\nname: ticket-triage\n---\nYou triage tickets.\n" }, { path: "src/support/ticket-triage-agent.ts", content: "export async function runTicketTriage() {}\n" }], problems: [], github: state.readiness });
    return json(404, { error: { code: "not_found", message: "no such route", retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
async function page(v2: ReturnType<typeof createClient>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const go = vi.fn();
  await act(async () => { root!.render(createElement(ToastProvider, null, createElement(SuggestionsPage, { v2, go }))); });
  await settle();
  const button = (name: RegExp) => [...document.querySelectorAll("button")].find((b) => name.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLButtonElement | undefined;
  const click = async (name: RegExp) => { const b = button(name); expect(b, String(name)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  return { host, button, click, go };
}

describe("Suggested agents", () => {
  it("is a page at #/suggestions, with one repository first by ?repo=", () => {
    expect(route("#/suggestions")).toEqual({ section: "suggestions" });
    expect(route("#/suggestions?repo=acme%2Fshop")).toEqual({ section: "suggestions", repo: "acme/shop" });
    expect(route("#/suggestions?repo=../etc")).toEqual({ section: "suggestions" });
  });

  it("not connected, it explains the flow and what GitHub is asked for, and connects with Contents write unless unticked", async () => {
    const { v2, calls } = server({ connected: false, suggestions: [], readiness: READY });
    const { host, click } = await page(v2);
    expect(host.textContent).toContain("Find where agents fit in your app");
    expect(host.querySelector("[aria-labelledby=permissions-title]")?.textContent).toMatch(/ContentsRead and write/);
    await click(/^Connect GitHub$/);
    expect(calls.find((c) => c.path.endsWith("/connect"))?.body).toEqual({ contents: "write" });
    expect(submits).toBe(1);
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("#/suggestions");
  });

  it("unticked, Connect asks for no write, and the permissions say read-only", async () => {
    const { v2, calls } = server({ connected: false, suggestions: [], readiness: READY });
    const { host, click } = await page(v2);
    const box = host.querySelector("input[type=checkbox]") as HTMLInputElement;
    await act(async () => { box.click(); });
    expect(host.querySelector("[aria-labelledby=permissions-title]")?.textContent).toMatch(/ContentsRead-only/);
    await click(/^Connect GitHub$/);
    expect(calls.find((c) => c.path.endsWith("/connect"))?.body).toEqual({});
  });

  it("lists a repository's suggestion with its evidence; Discard takes it away at once and Undo brings it back", async () => {
    const state = { connected: true, suggestions: [structuredClone(SUGGESTION)], readiness: READY };
    const { v2, calls } = server(state);
    const { host, click } = await page(v2);
    const card = host.querySelector(`article[aria-label="${SUGGESTION.title}"]`);
    expect(card?.textContent).toContain("High impact");
    expect(card?.querySelector(`a[href="${SUGGESTION.evidence[0]!.url}"]`)?.textContent).toBe("src/support/inbox.ts:42");
    expect(card?.textContent).toContain("subject, body?");
    await click(/^Discard Triage support tickets$/);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/discard"))).toBe(true);
    expect(host.querySelector(`article[aria-label="${SUGGESTION.title}"]`)).toBeNull();
    expect(host.querySelector("[role=status]")?.textContent).toMatch(/Discarded Triage support tickets\. Later scans of acme\/shop leave it out\./);
    await click(/^Undo$/);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/restore"))).toBe(true);
    expect(host.querySelector(`article[aria-label="${SUGGESTION.title}"]`)).not.toBeNull();
  });

  it("Create checks GitHub first: a missing permission says what to set and where, and the create waits; ready, it opens the pull request and says what the app sets", async () => {
    const state = { connected: true, suggestions: [structuredClone(SUGGESTION)], readiness: SHORT as typeof READY | typeof SHORT };
    const { v2, calls } = server(state);
    const { click, button } = await page(v2);
    await click(/^Create Triage support tickets$/);
    const dialog = () => document.querySelector("[role=dialog]")!;
    expect(dialog().textContent).toContain("GitHub needs one more permission");
    expect(dialog().textContent).toContain("set Contents: Read and write");
    expect(dialog().querySelector(`a[href="${SHORT.permissions_url}"]`)).not.toBeNull();
    expect(dialog().querySelector(`a[href="${SHORT.installation_url}"]`)).not.toBeNull();
    expect(button(/^Create and open pull request$/)?.disabled).toBe(true);
    expect(dialog().textContent).toContain(".agentrun/agents/ticket-triage/agent.md");

    state.readiness = READY;
    await click(/^Check again$/);
    expect(dialog().textContent).toContain("Ready to open the pull request");
    expect(button(/^Create and open pull request$/)?.disabled).toBe(false);
    await click(/^Create and open pull request$/);
    expect(calls.find((c) => c.path.endsWith("/create"))?.body).toEqual({});
    expect(dialog().textContent).toContain("Triage support tickets: created");
    expect(dialog().querySelector(`a[href="https://github.com/${REPO}/pull/12"]`)?.textContent).toContain("Open pull request #12");
    expect(dialog().textContent).toMatch(/AGENTRUN_AGENT_TICKET_TRIAGEagent_77/);
  });

  it("a name typed in Create renders the preview with it, and Create waits for that preview: the files shown are the files pushed", async () => {
    const state = { connected: true, suggestions: [structuredClone(SUGGESTION)], readiness: READY as typeof READY | typeof SHORT };
    const { v2, calls } = server(state);
    const { click, button } = await page(v2);
    await click(/^Create Triage support tickets$/);
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === `/v2/suggestions/${SUGGESTION.id}`).map((c) => c.query);
    expect(reads()).toEqual([""]);
    const input = document.querySelector<HTMLInputElement>("[role=dialog] input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "Ticket sorter"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(button(/^Create and open pull request$/)?.disabled, "not before the preview shows the name").toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    await settle();
    expect(reads()).toEqual(["", "?name=Ticket+sorter"].map((q) => q.replace("+", "%20")));
    expect(button(/^Create and open pull request$/)?.disabled).toBe(false);
    await click(/^Create and open pull request$/);
    expect(calls.find((c) => c.path.endsWith("/create"))?.body).toEqual({ name: "Ticket sorter" });
  });
});

describe("Suggested agents' repositories", () => {
  it("shows a repository's suggestions whatever the case of its name: GitHub reads owner/name without regard to case", async () => {
    const { v2 } = server({ connected: true, suggestions: [{ ...SUGGESTION, repo: "ACME/Shop" }], readiness: READY });
    const { host } = await page(v2);
    expect(host.querySelector("article[aria-label='Triage support tickets']")).toBeTruthy();
  });

  it("Refresh reads the App's repositories again, and a list GitHub cut short still takes a repository typed in", async () => {
    const repos: Listing = { repositories: [{ full_name: "acme/other", private: false, account: "acme", installation: 7 }], truncated: true, unread: [] };
    const { v2, calls } = server({ connected: true, suggestions: [{ ...SUGGESTION }], readiness: READY, repos });
    const { host, click } = await page(v2);
    const reads = () => calls.filter((c) => c.path === "/v2/integrations/github/repositories").length;
    expect(reads()).toBe(1);
    expect(host.textContent).toContain("GitHub listed only some of the App's repositories");
    const typed = host.querySelector<HTMLInputElement>("input[placeholder='owner/name']");
    expect(typed).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(typed!, "acme/unlisted"); typed!.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(/^Scan repository$/);
    expect(calls.find((c) => c.path === "/v2/suggestions/scans")?.body).toEqual({ repo: "acme/unlisted" });

    // A repository added to the App on GitHub shows up on Refresh, with no reload; a whole list offers no typed field.
    repos.repositories.push({ full_name: "acme/added", private: true, account: "acme", installation: 7 });
    repos.truncated = false;
    await click(/Read the suggestions and repositories again/);
    expect(reads()).toBe(2);
    expect(host.textContent).not.toContain("GitHub listed only some of the App's repositories");
    expect(host.querySelector("input[placeholder='owner/name']")).toBeNull();
    await click(/^Scan repository$/);
    expect(calls.filter((c) => c.path === "/v2/suggestions/scans").map((c) => c.body)).toEqual([{ repo: "acme/unlisted" }, { repo: "acme/other" }]);
  });
});

describe("Suggested agents' words", () => {
  it("names GitHub's permissions as its settings page does, and a scan in one line", () => {
    expect(permissionLabel("contents: write")).toBe("Contents: Read and write");
    expect(permissionLabel("pull_requests: write")).toBe("Pull requests: Read and write");
    expect(scanLine({ ...SCANNED, scan: { ...SCANNED.scan, found: 2, already_decided: 1, dropped: ["x"] } } as never)).toBe("2 suggestions · 1 already decided · 1 left out.");
    expect(scanLine({ ...SCANNED, scan: { ...SCANNED.scan, status: "running" } } as never)).toBe("Scanning: reading the code on a read-only copy.");
    expect(scanLine({ ...SCANNED, scan: { ...SCANNED.scan, status: "waiting" } } as never)).toMatch(/stopped before it answered[^]*Open the run to resume it, or scan again\.$/);
  });

  it("goes back after Connect only to a page of this console, once", () => {
    keepReturn("#/suggestions");
    expect(takeReturn()).toBe("#/suggestions");
    expect(takeReturn()).toBeUndefined();
    keepReturn("https://evil.example/");
    expect(takeReturn()).toBeUndefined();
  });
});
