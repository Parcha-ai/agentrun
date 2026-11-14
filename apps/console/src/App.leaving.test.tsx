import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// The agent editor holds unsaved changes: leaving it in the console (the sidebar, its back arrow, any address) asks first,
// and Cancel stays with the edit kept; a tab close or reload gets the browser's own question. Nothing changed, or all of it
// saved, nothing asks; the editor's own steps never do.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
const LEAVE = "Leave without saving?";
// The person at the editor's "Leave without saving?" dialog: each time it opens, the question is logged in `confirms` and
// answered by `answer` (Leave, else Stay), as a confirm() would be.
let answering: MutationObserver | undefined;
const answered = new WeakSet<Element>();
function answerTheDialog() {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (answered.has(dialog) || !dialog.textContent?.includes(LEAVE)) continue;
    const choice = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === (answer ? "Leave" : "Stay"));
    if (!choice) continue;
    answered.add(dialog);
    confirms.push(LEAVE);
    choice.click();
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const definition = { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] };
const RUN = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null, place: { mode: "runner" } };
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
// A Create the server refuses (500), once it answers.
let createFails: boolean;
// The definition the last Create sent.
let posted: typeof definition | null;

beforeEach(() => {
  calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { ...definition } };
  asked = []; confirms = []; answer = false; hold = null; createFails = false; posted = null; capsTools = []; capsPlaces = undefined;
  answering = new MutationObserver(answerTheDialog);
  answering.observe(document.body, { childList: true, subtree: true });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (path === "/v2/capabilities") return json(200, { models: { source: "providers", ready: true }, harnesses: [{ id: "pi", available: true }], tools: capsTools, thinking: ["low"], ...(capsPlaces ? { places: capsPlaces } : {}), features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (path === "/v2/agents" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { definition: typeof definition };
      posted = body.definition;
      if (hold) await hold;
      if (createFails) return json(500, { error: { code: "internal", message: "The store is busy.", retryable: true } });
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
afterEach(() => { answering?.disconnect(); act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

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
  it("asks before Sign out; Stay sends no sign-out, Leave signs out", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    const before = asked.length;
    await page.click(page.button(/^Sign out$/));
    expect(confirms).toEqual([LEAVE]);
    expect(asked.slice(before).filter((r) => !r.startsWith("GET "))).toEqual([]);
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
    answer = true;
    await page.click(page.button(/^Sign out$/));
    expect(confirms).toEqual([LEAVE, LEAVE]);
    await page.wait(() => asked.slice(before).includes("POST /v2/auth/sign-out"), "the sign-out is sent");
    // This server refuses it (the fixture answers 404): the editor stays, and its edits are still guarded.
    await page.wait(() => !!page.host.textContent?.includes("Not signed out"), "the failed sign-out is said");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
    answer = false;
    await page.click(page.sidebar("Agents"));
    expect(confirms).toEqual([LEAVE, LEAVE, LEAVE]);
    expect(location.hash).toBe("#/agents/calc/edit");
  });

  it("asks before Sign out everywhere too; Cancel keeps the editor and the edit, and sends no sign-out", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    const before = asked.length;
    await page.click(page.button(/^Sign out everywhere$/));
    await page.click([...page.host.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === "Sign out everywhere"));
    expect(confirms).toEqual([LEAVE]);
    expect(asked.slice(before).filter((r) => !r.startsWith("GET "))).toEqual([]);
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });

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

  it("opens the new-agent handoff without creating an agent, and leaves its empty brief freely", async () => {
    const page = await open("#/agents/new");
    await page.wait(() => !!page.host.querySelector('textarea[placeholder]'), "the brief composer");
    expect(asked.filter((request) => request === "POST /v2/agents")).toEqual([]);
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "the connected agents list");
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

  it("opens a blank create request from the new-agent page without sending it", async () => {
    const page = await open("#/agents/new");
    const blank = () => [...page.host.querySelectorAll("a")].find((link) => link.textContent === "start from a blank agent");
    await page.wait(() => !!blank(), "the blank request link");
    await page.click(blank());
    await page.wait(() => !!page.host.querySelector('[aria-label="Name"]'), "the create request form");
    expect(location.hash).toContain("operation=create-agent");
    expect(asked.filter((request) => request === "POST /v2/agents")).toEqual([]);
    expect(confirms).toEqual([]);
  });

  it("builds the handoff under StrictMode without posting a definition", async () => {
    const page = await open("#/agents/new", { strict: true });
    await page.wait(() => !!page.host.querySelector('textarea[placeholder]'), "the brief composer");
    await page.type(page.host.querySelector('textarea[placeholder]'), "Answer carefully.");
    expect(page.host.querySelector('textarea[readonly]')?.textContent).toContain("Answer carefully.");
    expect(asked.filter((request) => request === "POST /v2/agents")).toEqual([]);
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

// Creation now uses an explicit API request. It stays on the response, with an Open agent link; it never
// navigates automatically. The historical builder's in-flight Create rules are exercised at this current surface.
describe("App, creating through the API playground", () => {
  const pending = async ({ strict = false } = {}) => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    const page = await open("#/playground?operation=create-agent", { strict });
    await page.wait(() => !!page.host.querySelector('[aria-label="Name"]'), "the create request");
    await page.type(page.host.querySelector('[aria-label="Name"]'), "Made");
    await page.type(page.host.querySelector('[aria-label="Instructions"]'), "Answer.");
    await act(async () => page.button(/^Send request$/)!.click());
    await page.wait(() => asked.includes("POST /v2/agents"), "the request is under way");
    return page;
  };
  it("leaves another editor's unsaved changes guarded when a detached creation request finishes", async () => {
    const page = await pending();
    // Detach deliberately: the unsaved request now asks before leaving, even while it is pending.
    answer = true;
    await act(async () => { location.hash = "#/agents/calc/edit"; });
    await page.wait(() => !!page.instructions(), "another agent's editor");
    expect(confirms).toEqual([LEAVE]);
    answer = false;
    await page.type(page.instructions(), "Answer, then check the sum.");
    await act(async () => release()); await page.settle();
    expect(location.hash).toBe("#/agents/calc/edit");
    await page.click(page.sidebar("Runs"));
    expect(confirms).toEqual([LEAVE, LEAVE]);
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });
  for (const strict of [false, true]) it(`sends no duplicate while pending and links the created agent after the response${strict ? " under StrictMode" : ""}`, async () => {
    const page = await pending({ strict });
    expect(page.button(/^Sending$/)?.disabled).toBe(true);
    await act(async () => page.button(/^Sending$/)!.click());
    expect(asked.filter((request) => request === "POST /v2/agents")).toHaveLength(1);
    await act(async () => release());
    await page.wait(() => !!page.host.querySelector('a[href="#/agents/made"]'), "the result's agent link");
    expect(location.hash).toBe("#/playground?operation=create-agent");
    expect(posted?.instructions).toBe("Answer.");
    expect(page.button(/^Send request$/)?.disabled).toBe(true);
    await page.click(page.host.querySelector('a[href="#/agents/made"]'));
    await page.wait(() => location.hash === "#/agents/made", "the created agent page");
  });
  it("leaves an untouched blank request freely after its defaults arrive", async () => {
    const page = await open("#/playground?operation=create-agent");
    await page.wait(() => !!page.host.querySelector('[aria-label="Instructions"]'), "the blank creation request");
    await page.settle();
    expect(page.unloadAsks()).toBe(false);
    await page.click(page.sidebar("Agents"));
    await page.wait(() => location.hash === "#/agents", "the agents list");
    expect(confirms).toEqual([]);
    expect(asked.filter((request) => request === "POST /v2/agents")).toEqual([]);
  });
  it("keeps newer edits dirty when an earlier creation request finishes", async () => {
    const page = await pending();
    await page.type(page.host.querySelector('[aria-label="Instructions"]'), "Answer, then check the sum.");
    await act(async () => release());
    await page.wait(() => !!page.host.querySelector('a[href="#/agents/made"]'), "the earlier request's response");
    expect(posted?.instructions).toBe("Answer.");
    expect(page.host.querySelector<HTMLTextAreaElement>('[aria-label="Instructions"]')?.value).toBe("Answer, then check the sum.");
    expect(page.unloadAsks()).toBe(true);
    await page.click(page.sidebar("Runs"));
    expect(confirms).toEqual([LEAVE]);
    expect(location.hash).toBe("#/playground?operation=create-agent");
  });
  it("reports an uncertain server failure and requires reconciliation before another Create", async () => {
    createFails = true;
    const page = await pending();
    await act(async () => release());
    await page.wait(() => !!page.host.textContent?.includes("The store is busy."), "the server's failure");
    expect(page.host.textContent).toContain("may have succeeded");
    expect(page.button(/^Send request$/)?.disabled).toBe(true);
    expect(page.host.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("Made");
    expect(asked.filter((request) => request === "POST /v2/agents")).toHaveLength(1);
  });
});

// Two more ways the editor holds unsaved changes, pinned against the one guard: a typed default spend cap, and an edit
// left for the focused-tool address (#/agents/<id>/edit?tool=<name>), which opens the editor afresh.
describe("App, the guard on a typed cap and on the focused-tool address", () => {
  const rail = (page: Awaited<ReturnType<typeof open>>, label: RegExp) => [...page.host.querySelectorAll("main ol button")].find((b) => label.test(b.textContent ?? ""));

  it("a typed default spend cap asks before leaving; Cancel keeps it", async () => {
    const page = await editing();
    await page.click(rail(page, /Settings/));
    const cap = () => page.host.querySelector<HTMLInputElement>("#agent-max-cost");
    await page.wait(() => !!cap(), "the cap field");
    await page.type(cap(), "2.5");
    await page.click(page.sidebar("Agents"));
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "still the editor");
    expect(cap()?.value).toBe("2.5");
  });

  it("an edit asks before the focused-tool address opens the editor afresh; Cancel keeps the edit and the address", async () => {
    const page = await editing();
    await page.type(page.instructions(), "Answer, then check the sum.");
    await act(async () => { location.hash = "#/agents/calc/edit?tool=read"; });
    await page.settle();
    expect(confirms).toEqual([LEAVE]);
    await page.wait(() => location.hash === "#/agents/calc/edit", "the editor's address again");
    expect(page.instructions()?.value).toBe("Answer, then check the sum.");
  });
});
