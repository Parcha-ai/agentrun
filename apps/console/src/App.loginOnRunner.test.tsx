import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";

// A run of an agent on Claude Agent in a box, refused for its model while Claude Code's login on this machine is on: the
// login runs agents on the runner only, so serve says so and sets details.login_on_runner. The Playground then offers to
// move the agent to the runner, by the edit the agent's Computer step makes for a runner pick: the definition's computer
// set to none (the server writes its place from it) and the tools that run only in a box dropped, saved as a new revision
// on the version just read (If-Match). A refusal without that detail offers nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const TOOLS = [
  { name: "bash", available: true, harnesses: ["claude-agent"], sandbox_only: true },
  { name: "read", available: true, harnesses: ["claude-agent"] },
];
const CAPS = {
  models: { source: "providers", default: null, ready: false, needs: "key" }, harnesses: [], tools: TOOLS,
  places: { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true, state: "ready" }], default_place: { mode: "sandbox", box: "docker" } },
  features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" }, claude_login: true },
};
const SIGNED_IN = { place: "agentrun", command: "claude auth login", can_start: false, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" }, state: "signed_in", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
const BOXED: Agent = {
  ...SERVED_AGENT, agent_id: "boxed", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Boxed", instructions: "Answer.", harness: "claude-agent", skills: [], tools: ["bash", "read"], place: { mode: "sandbox", box: "docker" }, computer: { kind: "sandbox", provider: "docker" } } as Agent["definition"],
};
const RUNNER_ONLY = "No model yet for claude-agent: add an OpenRouter or Anthropic key in Settings → Model keys. Claude Code's login on this machine runs agents on the runner only, and this agent runs in the docker box: move it to the runner to run it on the login, or add a key.";
const MOVE = "Move it to the runner";

const settle = async () => { for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

/** The Playground on BOXED, whose run is refused with `details`; `saved` holds each definition save the page sent. */
async function open(details: Record<string, unknown>) {
  const saved: { body: { definition: Record<string, unknown>; note?: string }; ifMatch: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/v2/agents/boxed/runs") return json(409, { error: { code: "agent_not_runnable", message: RUNNER_ONLY, retryable: false, details } });
    if (method === "PUT" && path === "/v2/agents/boxed/definition") {
      const body = JSON.parse(String(init?.body));
      saved.push({ body, ifMatch: new Headers(init?.headers).get("if-match") });
      return json(200, { ...BOXED, revision: "r2", revisions: 2, definition: { ...body.definition, place: { mode: "runner" } } }, { etag: "\"r2\"" });
    }
    if (path === "/v2/agents/boxed") return json(200, BOXED, { etag: "\"r1\"" });
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return json(200, CAPS);
    if (path === "/v2/settings/claude-login") return json(200, SIGNED_IN);
    if (path === "/v2/settings/chatgpt") return json(200, { state: "signed_out" });
    if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [BOXED], next_cursor: null });
    if (path.startsWith("/v2/agents/") && path.endsWith("/revisions")) return json(200, { revisions: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/playground";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  await settle();
  const message = host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea');
  expect(message, "the Playground's request box").not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(message!), "value")!.set!.call(message!, "Answer this.");
    message!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send request");
  await act(async () => send!.click());
  await settle();
  expect(host.textContent).toContain("runs agents on the runner only");
  const move = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === MOVE);
  return { host, saved, move };
}

describe("the Playground's offer to move an agent in a box to the runner, where Claude Code's login runs it", () => {
  it("a run refused with details.login_on_runner offers the move; taking it saves the agent on the runner, its box-only tools dropped, on the version read", async () => {
    const page = await open({ unbound: [], missing: {}, login_on_runner: true });
    const move = page.move();
    expect(move, "the refusal of a box agent on Claude Agent while the login reads signed in offers no move to the runner").toBeDefined();
    await act(async () => move!.click());
    await settle();
    expect(page.saved.length, "taking the offer saved no definition").toBe(1);
    const [{ body, ifMatch }] = page.saved;
    expect(body.definition.computer, "the agent's computer after the move").toEqual({ kind: "none" });
    expect(body.definition.place, "a definition with a computer goes without its place: the server writes it").toBeUndefined();
    expect(body.definition.tools, "the tools after the move: bash runs only in a box").toEqual(["read"]);
    expect(body.definition.harness).toBe("claude-agent");
    expect(ifMatch, "the save is made on the version read").toBe("\"r1\"");
    expect(page.host.textContent).toContain("Moved to the runner");
    expect(page.move(), "the offer stays after the move").toBeUndefined();
  });

  it("a refusal without details.login_on_runner offers no move", async () => {
    const page = await open({ unbound: [], missing: {} });
    expect(page.move()).toBeUndefined();
  });
});
