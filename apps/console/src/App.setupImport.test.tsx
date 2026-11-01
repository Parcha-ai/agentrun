import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

// Setup's box: offered with the counts of a server on this machine (GET /v2/setup/import), never ticked, sent only when
// ticked, and absent where the route answers nothing. Ticked, the console shows the import running, then done.
describe("App, setup's import of this machine's sessions", () => {
  // Setup's twelve characters, and a value the source export knows for a test's own.
  const PASSWORD = "not-a-secret";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const missing = (path: string) => ({ error: { code: "not_found", message: path, retryable: false } });
  /** A server before its owner: `offer` answers GET /v2/setup/import until setup, then `after` in turn (its last again). */
  function server({ offer, after = [] }: { offer: [number, unknown]; after?: [number, unknown][] }) {
    const sent: Record<string, unknown>[] = [];
    let agentsRead = 0;
    let statsRead = 0;
    let set = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: set, signed_in: set });
      if (path === "/v2/setup") { set = true; const body = JSON.parse(String(init?.body)); sent.push(body); return json(201, { signed_in: true, ...(body.import ? { importing: true } : {}) }); }
      if (path === "/v2/setup/import") {
        if (!set) return json(offer[0], offer[1]);
        const [status, body] = (after.length > 1 ? after.shift() : after[0]) ?? [404, missing(path)];
        return json(status, body);
      }
      if (path === "/v2/agents") { agentsRead += 1; return json(200, { agents: [], next_cursor: null }); }
      if (path === "/v2/stats") statsRead += 1;
      return json(404, missing(path));
    });
    return { sent, agentsRead: () => agentsRead, statsRead: () => statsRead };
  }
  async function until(host: HTMLElement, found: () => unknown, ms = 3000) {
    const end = Date.now() + ms;
    while (!found() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return found();
  }
  async function render() {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    await until(host, () => host.querySelector("form"));
    return host;
  }
  const box = (host: HTMLElement) => host.querySelector<HTMLInputElement>("input[type=checkbox][name=import]");
  async function setPassword(host: HTMLElement) {
    for (const input of host.querySelectorAll<HTMLInputElement>("input[type=password]")) {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, PASSWORD); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
  }
  const submit = (host: HTMLElement) => act(async () => { host.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); });

  it("shows the box with the server's counts, unticked", async () => {
    server({ offer: [200, { projects: 3, sessions: 12 }] });
    const host = await render();
    expect(await until(host, () => box(host))).toBeTruthy();
    expect(box(host)!.checked).toBe(false);
    expect(host.textContent).toContain("Import this machine's Claude Code, Codex and pi sessions");
    expect(host.textContent).toContain("12 sessions in 3 projects");
  });

  it("sends no import unless the box is ticked", async () => {
    const { sent } = server({ offer: [200, { projects: 1, sessions: 2 }] });
    const host = await render();
    await until(host, () => box(host));
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD }]);
  });

  it("sends import: true when ticked, then shows the import running, then done (a failed read tried again), and reads the page and the agents again", async () => {
    const failed = [500, { error: { code: "internal", message: "busy", retryable: true } }] as [number, unknown];
    const { sent, agentsRead, statsRead } = server({ offer: [200, { projects: 1, sessions: 2 }], after: [[200, { state: "running" }], failed, [200, { state: "done", agents: 1, runs: 2, skipped: 0 }]] });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host)!.click(); });
    expect(box(host)!.checked).toBe(true);
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD, import: true }]);
    expect(await until(host, () => /Importing this machine's sessions/.test(host.textContent ?? ""))).toBe(true);
    const [names, stats] = [agentsRead(), statsRead()];
    expect(await until(host, () => /Imported 2 sessions into 1 agent\./.test(host.textContent ?? ""), 6000)).toBe(true);
    expect(await until(host, () => agentsRead() > names && statsRead() > stats)).toBe(true);
  }, 15_000);

  it.each([[404, "a server that offers no import"], [403, "a read the server refuses"]])("shows no box for %i, %s", async (status) => {
    server({ offer: [status, missing("/v2/setup/import")] });
    const host = await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(box(host)).toBeNull();
    expect(host.textContent).not.toContain("Import this machine's");
  });
});
