import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// The agent editor holds unsaved changes: leaving it in the console (the sidebar, its back arrow, any address) asks first,
// and Cancel stays with the edit kept; a tab close or reload gets the browser's own question. Nothing changed, or all of it
// saved, nothing asks; the editor's own steps never do.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
const LEAVE = "You have unsaved changes. Leave and discard them?";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const definition = { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] };
const RUN = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null };
let calc: { agent_id: string; kind: string; revision: string; revisions: number; archived_at: null; definition: typeof definition };
let asked: string[];
let answer: boolean;
let confirms: string[];
// The server's tools and places (capabilities): none by default; a test of a new agent's defaults serves some.
let capsTools: unknown[];
let capsPlaces: unknown;
// A Create the test holds open: POST /v2/agents answers only once `release` is called.
let hold: Promise<void> | null;
let release: () => void;

beforeEach(() => {
  calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { ...definition } };
  asked = []; confirms = []; answer = false; hold = null; capsTools = []; capsPlaces = undefined;
  vi.stubGlobal("confirm", (message: string) => { confirms.push(message); return answer; });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (path === "/v2/capabilities") return json(200, { harnesses: [{ id: "pi", available: true }], tools: capsTools, thinking: ["low"], ...(capsPlaces ? { places: capsPlaces } : {}), features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (path === "/v2/agents" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { definition: typeof definition };
      if (hold) await hold;
      return json(201, { agent_id: "made", kind: "agentic", revision: "m1", revisions: 1, archived_at: null, definition: body.definition });
    }
    if (path === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
    if (path === "/v2/runs/r1") return json(200, RUN);
    if (path === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: [], complete: true, truncated: false });
    if (path === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
    if (path === "/v2/agents/calc/definition" && method === "PUT") {
      const body = JSON.parse(String(init!.body)) as { definition: Partial<typeof definition> };
      calc = { ...calc, revision: "r2", revisions: 2, definition: { ...calc.definition, ...body.definition } };
      return new Response(JSON.stringify(calc), { status: 200, headers: { "content-type": "application/json", etag: '"r2"' } });
    }
    if (path === "/v2/agents/calc") return new Response(JSON.stringify(calc), { status: 200, headers: { "content-type": "application/json", etag: `"${calc.revision}"` } });
    if (path.endsWith("/runs") || path.endsWith("/revisions")) return json(200, { runs: [], revisions: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

// `strict`: under StrictMode, as main.tsx renders the console (in development each effect is set up, cleaned up and set up
// again).
async function open(hash: string, { strict = false } = {}) {
  location.hash = hash;
  await new Promise((r) => setTimeout(r, 20));
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(strict ? createElement(StrictMode, null, createElement(App)) : createElement(App)));
  const wait = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 4000;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  // A moment for an address change, and the console's answer to it, to land.
  const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
  const type = async (el: Element | null, value: string) => {
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const sidebar = (label: string) => [...host.querySelectorAll('nav[aria-label="Navigation"] button')].find((b) => b.textContent?.trim() === label);
  // The editor's own steps (its step rail), apart from the sidebar, which has a Settings of its own on every server.
  const step = (label: RegExp) => [...host.querySelectorAll("main ol button")].find((b) => label.test(b.textContent?.trim() ?? ""));
  const instructions = () => host.querySelector<HTMLTextAreaElement>("#agent-instructions");
  // Whether a tab close or reload is asked about: the page's beforeunload handler cancels the event.
  const unloadAsks = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  return { host, wait, settle, button, click, type, sidebar, step, instructions, unloadAsks };
}

async function editing() {
  const page = await open("#/agents/calc/edit");
  await page.wait(() => !!page.instructions(), "the editor is open");
  return page;
}

describe("App, leaving the agent editor with unsaved changes", () => {
  it("asks when a sidebar link would leave it; Cancel stays, the address and the edit kept", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    await page.click(page.sidebar("Agents"));
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "the address is the editor's again");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
    expect(page.button(/^Save revision$/)).toBeTruthy();
  });

  it("Leave goes, and the edit is dropped", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    answer = true;
    await page.click(page.sidebar("Agents"));
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => !page.instructions(), "the editor is gone");
    expect(location.hash).toBe("#/agents");
  });

  it("asks for the editor's own back arrow, and for an address typed or linked", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    await page.click(page.button(/^Back to agents$/));
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    await act(async () => { location.hash = "#/runs"; });
    await page.settle();
    expect(confirms).toEqual([LEAVE, LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });

  it("never asks for the editor's own steps", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    expect(page.step(/Settings/)).toBeTruthy();
    expect(page.step(/Context/)).toBeTruthy();
    await page.click(page.step(/Settings/));
    await page.click(page.step(/Context/));
    expect(confirms).toEqual([]);
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });

  it("asks the browser before a tab close or reload only while there are unsaved changes", async () => {
    const page = await editing();
    expect(page.unloadAsks()).toBe(false);
    await page.type(page.instructions(), "Answer, then check the sum.");
    expect(page.unloadAsks()).toBe(true);
    await page.type(page.instructions(), "Answer.");
    expect(page.unloadAsks()).toBe(false);
  });
});

describe("App, leaving the agent editor with nothing unsaved", () => {
  it("leaves without asking when nothing changed", async () => {
    const page = await editing();
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "on the agents list");
    expect(confirms).toEqual([]);
  });

  it("leaves without asking right after a save", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    await page.click(page.button(/^Save revision$/));
    await page.wait(() => asked.includes("PUT /v2/agents/calc/definition") && !!page.host.textContent?.includes("Saved"), "saved");
    expect(page.unloadAsks()).toBe(false);
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "on the agents list");
    expect(confirms).toEqual([]);
  });

  it("a new agent's Create opens its page without asking", async () => {
    const page = await open("#/agents/new");
    await page.wait(() => !!page.instructions(), "the new agent's editor");
    await page.type(page.host.querySelector("#agent-name"), "Made");
    await page.type(page.instructions(), "Answer.");
    await page.click(page.button(/^Create$/));
    await page.wait(() => location.hash === "#/agents/made", "on the new agent's page");
    expect(confirms).toEqual([]);
  });

  it("a new agent's Create opens its page under StrictMode too, as main.tsx renders the console", async () => {
    const page = await open("#/agents/new", { strict: true });
    await page.wait(() => !!page.instructions(), "the new agent's editor");
    await page.type(page.host.querySelector("#agent-name"), "Made");
    await page.type(page.instructions(), "Answer.");
    await page.click(page.button(/^Create$/));
    await page.wait(() => location.hash === "#/agents/made", "on the new agent's page");
    expect(asked.filter((a) => a === "POST /v2/agents")).toHaveLength(1);
    expect(confirms).toEqual([]);
  });
});

// A move the guard cancels never happened: it is no page in the console's history (lib/back numbers only the moves that
// land), so a later back arrow goes to the page before, never to the page the person said no to.
describe("App, a cancelled move and the run page's back arrow", () => {
  it("goes back to the editor the run was opened from, not to the page the cancel kept you from", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    await page.click(page.sidebar("Agents"));
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    await page.type(page.instructions(), "Answer.");
    await act(async () => { location.hash = "#/runs/r1"; });
    const arrow = () => page.host.querySelector<HTMLButtonElement>('nav[aria-label="Breadcrumb"] button[aria-label="Back"]');
    await page.wait(() => !!arrow(), "the run's page");
    await page.click(arrow());
    await page.wait(() => location.hash === "#/agents/calc/edit", "back on the editor");
    expect(confirms).toEqual([LEAVE]);
  });
});

// Cancel on the browser's own Back or Forward undoes the move: the browser goes back to the editor's entry, every other
// entry as it was (none rewritten), and the back arrow's count of where the console is stays right.
describe("App, Back or Forward cancelled with unsaved changes", () => {
  const traverse = async (page: Awaited<ReturnType<typeof open>>, step: () => void) => { await act(async () => { step(); }); await page.settle(); await page.settle(); };

  it("Back, then Cancel: the editor stays and the list's entry is still there, Back and Forward reach both", async () => {
    const page = await open("#/agents");
    await page.wait(() => !!page.sidebar("Agents"), "the console is open");
    await act(async () => { location.hash = "#/agents/calc/edit"; });
    await page.wait(() => !!page.instructions(), "the editor is open");
    const entries = history.length;
    await page.type(page.instructions(), "Answer, then check the sum.");
    await traverse(page, () => history.back());
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "back on the editor");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
    expect(history.length).toBe(entries);
    // The list's entry is where it was: Back (now leaving) reaches it, Forward the editor again.
    answer = true;
    await traverse(page, () => history.back());
    await page.wait(() => location.hash === "#/agents", "Back reaches the list");
    await traverse(page, () => history.forward());
    await page.wait(() => location.hash === "#/agents/calc/edit", "Forward reaches the editor");
  });

  it("Forward, then Cancel: the editor stays and the next entry is still there", async () => {
    const page = await editing();
    await act(async () => { location.hash = "#/runs"; });
    await page.wait(() => !page.instructions(), "on the runs list");
    await traverse(page, () => history.back());
    await page.wait(() => !!page.instructions(), "the editor again");
    await page.type(page.instructions(), "Answer, then check the sum.");
    await traverse(page, () => history.forward());
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
    answer = true;
    await traverse(page, () => history.forward());
    await page.wait(() => location.hash === "#/runs", "Forward reaches the runs list");
  });

  it("after a cancelled Back, the run page's back arrow knows where the console is", async () => {
    const page = await open("#/agents");
    await page.wait(() => !!page.sidebar("Agents"), "the console is open");
    await act(async () => { location.hash = "#/agents/calc/edit"; });
    await page.wait(() => !!page.instructions(), "the editor is open");
    await page.type(page.instructions(), "Answer, then check the sum.");
    await traverse(page, () => history.back());
    await page.wait(() => location.hash === "#/agents/calc/edit", "Cancel kept the editor");
    await page.type(page.instructions(), "Answer.");
    await act(async () => { location.hash = "#/runs/r1"; });
    const arrow = () => page.host.querySelector<HTMLButtonElement>('nav[aria-label="Breadcrumb"] button[aria-label="Back"]');
    await page.wait(() => !!arrow(), "the run's page");
    await page.click(arrow());
    await page.wait(() => location.hash === "#/agents/calc/edit", "the arrow goes back to the editor");
    await page.click(page.button(/^Back to agents$/));
    await page.wait(() => location.hash === "#/agents", "and on to the list");
  });
});

// A Create that answers after its editor is gone neither opens the new agent's page nor lifts another editor's guard.
describe("App, a Create that lands after its editor is gone", () => {
  it("leaves the next editor's unsaved changes guarded, and moves nowhere", async () => {
    hold = new Promise<void>((r) => { release = r; });
    const page = await open("#/agents/new");
    await page.wait(() => !!page.instructions(), "the new agent's editor");
    await page.type(page.host.querySelector("#agent-name"), "Made");
    await page.type(page.instructions(), "Answer.");
    await act(async () => { page.button(/^Create$/)!.click(); });
    await page.wait(() => asked.includes("POST /v2/agents"), "the Create is under way");
    answer = true;
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "left the new agent's editor");
    await act(async () => { location.hash = "#/agents/calc/edit"; });
    await page.wait(() => !!page.instructions(), "another agent's editor");
    await page.type(page.instructions(), "Answer, then check the sum.");
    await act(async () => { release(); });
    await page.settle(); await page.settle();
    expect(location.hash).toBe("#/agents/calc/edit");
    answer = false;
    const before = confirms.length;
    await page.click(page.sidebar("Runs"));
    expect(confirms.length).toBe(before + 1);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });
});

// A new agent's form fills in the server's defaults (its tools, and the place a new agent gets, a box when the server
// serves one) as the capabilities arrive: they are no edit, so leaving an untouched new agent asks nothing.
describe("App, an untouched new agent", () => {
  it("leaves without asking, its defaults filled in", async () => {
    capsTools = [{ name: "read", available: true }, { name: "write", available: true }, { name: "bash", available: true, sandbox_only: true }];
    capsPlaces = { modes: ["runner", "sandbox"], default: "runner", boxes: [{ id: "docker", available: true }], default_place: { mode: "sandbox", box: "docker" } };
    const page = await open("#/agents/new");
    await page.wait(() => !!page.instructions(), "the new agent's editor");
    await page.settle();
    // The editor's own Settings step (the rail inside the page; the sidebar has a Settings of its own).
    await page.click([...page.host.querySelectorAll("main ol button")].find((b) => /Settings/.test(b.textContent ?? "")));
    await page.wait(() => !!page.host.querySelector<HTMLInputElement>('input[name="place"][value="sandbox"]')?.checked, "the served default place is filled in");
    expect(page.unloadAsks()).toBe(false);
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "on the agents list");
    expect(confirms).toEqual([]);
  });
});

// An edit made while Create is under way was never sent: the new agent's page opens only through the question, and
// Cancel keeps the form with the edit.
describe("App, an edit made while Create is under way", () => {
  it("asks before opening the new agent's page; Cancel stays on the form with the edit", async () => {
    hold = new Promise<void>((r) => { release = r; });
    const page = await open("#/agents/new");
    await page.wait(() => !!page.instructions(), "the new agent's editor");
    await page.type(page.host.querySelector("#agent-name"), "Made");
    await page.type(page.instructions(), "Answer.");
    await act(async () => { page.button(/^Create$/)!.click(); });
    await page.wait(() => asked.includes("POST /v2/agents"), "the Create is under way");
    await page.type(page.instructions(), "Answer, then check the sum.");
    await act(async () => { release(); });
    await page.settle(); await page.settle();
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/new", "still the form");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });
});
