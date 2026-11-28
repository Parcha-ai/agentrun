import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { picker } from "@/test/picker";

// The API playground's operation field, with Start a run picked, is drawn before the page has read the agents, and a
// person can open it then. The read landing must not swap it for another field: an open list would close under them.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reviewer: Agent = { ...SERVED_AGENT, agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "reviewer", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** The playground at Start a run, its agents read held until `answer`. */
async function open() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  let answer!: (agents: Agent[]) => void;
  const held = new Promise<Agent[]>((done) => { answer = done; });
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "https://console.example.test"), path = u.pathname;
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true });
    if (path === "/v2/setup/import") return json({ offer: false });
    if (path === "/v2/capabilities") return json({ harnesses: [], models: { ready: true }, features: { efforts: ["high"] } });
    if (path === "/v2/agents") return json({ agents: u.searchParams.get("archived") === "true" ? [] : await held, next_cursor: null });
    if (path.endsWith("/revisions")) return json({ revisions: [{ revision: "r1", version: 1, current: true, note: null }], next_cursor: null });
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  history.replaceState(null, "", "#/playground");
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await settle();
  return { host, land: async (agents: Agent[]) => { await act(async () => answer(agents)); await settle(); } };
}

for (const [what, agents] of [["agents", [reviewer]], ["no agent", []]] as const) {
  it(`keeps the operation field, and its open list, when the agents read lands (${what})`, async () => {
    const page = await open();
    const before = picker(page.host, "API operation");
    expect(before, "the operation field is drawn while the agents are read").not.toBeNull();
    expect(before!.getAttribute("data-value")).toBe("run");
    await act(async () => before!.click());
    await settle();
    expect(document.querySelector('[role="listbox"]'), "the list opens").not.toBeNull();

    await page.land([...agents]);

    expect(page.host.querySelector('section[aria-label="Request"]'), "the read landed").not.toBeNull();
    const after = picker(page.host, "API operation");
    expect(after === before, "the operation field is the same element after the read").toBe(true);
    expect(document.querySelector('[role="listbox"]'), "its list is still open").not.toBeNull();
    // One row, not two: with agents, the operation and the agent share the Playground's row.
    expect(page.host.querySelectorAll("#api-operation")).toHaveLength(1);
    if (agents.length) expect(page.host.querySelector('[aria-label="Playground agent"] #api-operation')).not.toBeNull();
  });
}
