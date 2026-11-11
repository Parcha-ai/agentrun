import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// The agent builder with unsaved changes holds a move away and asks "Leave without saving?": a sidebar click, the back
// arrow, the browser's back, an address changed. Stay keeps the page and its edits; Leave makes the move. A clean form, a
// saved one, and the move a new agent's save makes go with no question. Closing or reloading the tab gets the browser's
// own prompt (beforeunload) only while there is something unsaved.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
const made = { ...calc, agent_id: "made", definition: { ...calc.definition, name: "Made" } };

function serve() {
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${u.pathname}`);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true, secrets_writable: true });
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [{ id: "pi", available: true }], features: {} });
    if (u.pathname === "/v2/agents" && method === "POST") return json(201, made);
    if (u.pathname === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
    if (u.pathname === "/v2/agents/calc/definition" && method === "PUT") {
      const body = JSON.parse(String(init!.body)) as { definition: Partial<typeof calc.definition> };
      return json(200, { ...calc, revision: "r2", revisions: 2, definition: { ...calc.definition, ...body.definition } }, { etag: '"r2"' });
    }
    if (u.pathname === "/v2/agents/calc") return json(200, calc, { etag: '"r1"' });
    if (u.pathname === "/v2/agents/made") return json(200, made, { etag: '"r1"' });
    if (/^\/v2\/agents\/[^/]+\/(runs|revisions)$/.test(u.pathname)) return json(200, { runs: [], revisions: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  return writes;
}

const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 100)); });

/** The console opened at `hash` as a page load would (an address the console never numbered), then moved to each of
 *  `then` in turn (the last one the builder). */
async function open(hash: string, ...then: string[]) {
  location.hash = hash;
  await new Promise((r) => setTimeout(r, 20));
  history.replaceState(null, "");
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  for (const next of then) {
    await wait(() => !!host.querySelector('nav[aria-label="Navigation"]'), "the console");
    // Each move's hashchange lands before the next move, as a person's clicks do.
    await act(async () => { location.hash = next; await new Promise((r) => setTimeout(r, 50)); });
  }
  const instructions = () => host.querySelector<HTMLTextAreaElement>("#agent-instructions");
  await wait(() => !!instructions(), "the agent builder");
  const button = (name: string, within: ParentNode = host) => [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  const sidebar = (name: string) => button(name, host.querySelector('nav[aria-label="Navigation"]')!)!;
  const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.textContent?.includes("Leave without saving?"));
  const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const unloadAsks = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  return { host, instructions, button, sidebar, dialog, type, unloadAsks };
}

describe("App, the agent builder's unsaved changes", () => {
  it("a sidebar click on an edited agent asks first: Stay keeps the edits, Leave goes", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    expect(p.dialog()!.textContent).toContain("Your changes to this agent are not saved.");
    expect(location.hash).toBe("#/agents/calc/edit");
    // Stay: the question goes, the builder and its edit stay.
    await act(async () => { p.button("Stay", p.dialog())!.click(); });
    await wait(() => !p.dialog(), "the question is gone");
    await settle();
    expect(location.hash).toBe("#/agents/calc/edit");
    expect(p.instructions()?.value).toBe("Answer in French.");
    // Asked again, Leave: the runs list opens and the edit is dropped.
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => !!p.dialog(), "asked again");
    await act(async () => { p.button("Leave", p.dialog())!.click(); });
    await wait(() => location.hash === "#/runs" && !p.instructions(), "on the runs list");
    expect(p.dialog()).toBeUndefined();
  });

  it("the builder's back arrow on an edited agent asks first", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { p.host.querySelector<HTMLButtonElement>('button[aria-label="Back to agents"]')!.click(); });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    expect(location.hash).toBe("#/agents/calc/edit");
    await act(async () => { p.button("Leave", p.dialog())!.click(); });
    await wait(() => location.hash === "#/agents" && !p.instructions(), "on the agents list");
  });

  it("the browser's back on an edited agent is taken back and asks first: Stay keeps the edits, Leave goes back", async () => {
    serve();
    const p = await open("#/agents/calc", "#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { history.back(); });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    await wait(() => location.hash === "#/agents/calc/edit", "the address is taken back to the builder");
    await act(async () => { p.button("Stay", p.dialog())!.click(); });
    await settle();
    expect(location.hash).toBe("#/agents/calc/edit");
    expect(p.instructions()?.value).toBe("Answer in French.");
    await act(async () => { history.back(); });
    await wait(() => !!p.dialog(), "asked again");
    await act(async () => { p.button("Leave", p.dialog())!.click(); });
    await wait(() => location.hash === "#/agents/calc" && !p.instructions(), "on the agent's page");
  });

  it("Leave on a held Back makes that Back: the next Back goes further back, never into the builder again", async () => {
    serve();
    const p = await open("#/runs", "#/agents/calc", "#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { history.back(); });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    await wait(() => location.hash === "#/agents/calc/edit", "the address is taken back to the builder");
    await act(async () => { p.button("Leave", p.dialog())!.click(); });
    await wait(() => location.hash === "#/agents/calc" && !p.instructions(), "on the agent's page");
    await act(async () => { history.back(); });
    await wait(() => location.hash === "#/runs", "Back goes on to the runs list");
    expect(p.instructions()).toBeNull();
  });

  it("a choice put back to the saved one is no change: approvals switched and switched back go with no question", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    await act(async () => { [...p.host.querySelectorAll<HTMLButtonElement>("ol button")].find((b) => /Tools & skills/.test(b.textContent ?? ""))!.click(); });
    const radio = (value: string) => p.host.querySelector<HTMLInputElement>(`input[name="approvals"][value="${value}"]`);
    await wait(() => !!radio("never"), "the approvals choice");
    await act(async () => { radio("never")!.click(); });
    expect(p.unloadAsks()).toBe(true);
    await act(async () => { radio("ask")!.click(); });
    expect(p.unloadAsks()).toBe(false);
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => location.hash === "#/runs" && !p.instructions(), "on the runs list");
    expect(p.dialog()).toBeUndefined();
  });

  it("an address changed under an edited agent (a link, one typed) is taken back and asks first", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { location.hash = "#/playground"; });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    await wait(() => location.hash === "#/agents/calc/edit", "the address is taken back to the builder");
    expect(p.instructions()?.value).toBe("Answer in French.");
  });

  it("a clean builder goes with no question, and an edit typed back to the saved text is clean", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await p.type(p.instructions()!, "Answer.");
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => location.hash === "#/runs" && !p.instructions(), "on the runs list");
    expect(p.dialog()).toBeUndefined();
  });

  it("a saved edit goes with no question", async () => {
    const writes = serve();
    const p = await open("#/agents/calc/edit");
    await p.type(p.instructions()!, "Answer in French.");
    await act(async () => { p.button("Save revision")!.click(); });
    await wait(() => !!p.host.textContent?.includes("Saved"), "saved");
    expect(writes).toEqual(["PUT /v2/agents/calc/definition"]);
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => location.hash === "#/runs" && !p.instructions(), "on the runs list");
    expect(p.dialog()).toBeUndefined();
  });

  it("a new agent's Create opens its page with no question", async () => {
    const writes = serve();
    const p = await open("#/agents/new");
    await p.type(p.host.querySelector<HTMLInputElement>("#agent-name")!, "Made");
    await act(async () => { p.button("Create")!.click(); });
    await wait(() => location.hash === "#/agents/made" && !p.instructions(), "on the new agent's page");
    expect(writes).toEqual(["POST /v2/agents"]);
    expect(p.dialog()).toBeUndefined();
  });

  it("a new agent's builder, untouched, goes with no question; named, it asks", async () => {
    serve();
    const p = await open("#/agents/new");
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => location.hash === "#/runs" && !p.instructions(), "on the runs list");
    expect(p.dialog()).toBeUndefined();
    await act(async () => { location.hash = "#/agents/new"; });
    await wait(() => !!p.instructions(), "the builder again");
    await p.type(p.host.querySelector<HTMLInputElement>("#agent-name")!, "Made");
    await act(async () => { p.sidebar("Runs").click(); });
    await wait(() => !!p.dialog(), "Leave without saving? is asked");
    expect(p.dialog()!.textContent).toContain("This new agent is not saved yet.");
  });

  it("the browser's own prompt on close or reload is there only while something is unsaved", async () => {
    serve();
    const p = await open("#/agents/calc/edit");
    expect(p.unloadAsks()).toBe(false);
    await p.type(p.instructions()!, "Answer in French.");
    expect(p.unloadAsks()).toBe(true);
    await act(async () => { p.button("Save revision")!.click(); });
    await wait(() => !!p.host.textContent?.includes("Saved"), "saved");
    expect(p.unloadAsks()).toBe(false);
    // A revision note alone is typed text too.
    await p.type(p.host.querySelector<HTMLInputElement>('input[aria-label="Revision note"]')!, "French now");
    expect(p.unloadAsks()).toBe(true);
  });
});
