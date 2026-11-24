import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { picker, pick } from "@/test/picker";

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
// A second agent on Claude Agent in the same box, picked after BOXED's run was refused.
const OTHER: Agent = { ...BOXED, agent_id: "other", revision: "o1", definition: { ...BOXED.definition, name: "Other" } };
const RUNNER_ONLY ="No model yet for claude-agent: add an OpenRouter or Anthropic key in Settings → Model keys. Claude Code's login on this machine runs agents on the runner only, and this agent runs in the docker box: move it to the runner to run it on the login, or add a key.";
const MOVE = "Move it to the runner";

const settle = async () => { for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

/** The Playground on BOXED (OTHER beside it), whose runs are refused with `details`, its request naming `revision` when
 *  given; `saved` holds each definition save the page sent and its agent, `runs` each run request's agent and body. A
 *  save makes the next revision the agent's current one, as serve does. */
async function open(details: Record<string, unknown>, { revision }: { revision?: string } = {}) {
  const saved: { agent: string; body: { definition: Record<string, unknown>; note?: string }; ifMatch: string | null }[] = [];
  const runs: { agent: string; body: Record<string, unknown> }[] = [];
  const agents: Record<string, Agent> = { boxed: BOXED, other: OTHER };
  // BOXED's revisions are r1, r2, …; OTHER's o1, o2, ….
  const revisionId = (a: Agent, version: number) => `${a.agent_id === "boxed" ? "r" : "o"}${version}`;
  const revisionsOf = (a: Agent) => Array.from({ length: a.revisions }, (_, i) => a.revisions - i)
    .map((version) => ({ revision: revisionId(a, version), version, current: version === a.revisions, note: null, created_at: "2026-11-24T00:00:00.000Z", kind: "edit", definition: a.definition }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    const id = /^\/v2\/agents\/([^/]+)/.exec(path)?.[1];
    const agent = id ? agents[id] : undefined;
    if (method === "POST" && agent && path === `/v2/agents/${id}/runs`) {
      runs.push({ agent: id!, body: JSON.parse(String(init?.body)) });
      return json(409, { error: { code: "agent_not_runnable", message: RUNNER_ONLY, retryable: false, details } });
    }
    if (method === "PUT" && agent && path === `/v2/agents/${id}/definition`) {
      const body = JSON.parse(String(init?.body));
      saved.push({ agent: id!, body, ifMatch: new Headers(init?.headers).get("if-match") });
      const next = { ...agent, revision: revisionId(agent, agent.revisions + 1), revisions: agent.revisions + 1, definition: { ...body.definition, place: { mode: "runner" } } } as Agent;
      agents[id!] = next;
      return json(200, next, { etag: `"${next.revision}"` });
    }
    if (agent && path === `/v2/agents/${id}/revisions`) return json(200, { revisions: revisionsOf(agent), next_cursor: null });
    if (agent && path === `/v2/agents/${id}`) return json(200, agent, { etag: `"${agent.revision}"` });
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return json(200, CAPS);
    if (path === "/v2/settings/claude-login") return json(200, SIGNED_IN);
    if (path === "/v2/settings/chatgpt") return json(200, { state: "signed_out" });
    if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: Object.values(agents), next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/playground";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  await settle();
  const request = host.querySelector<HTMLElement>('section[aria-label="Request"]');
  const message = request?.querySelector<HTMLTextAreaElement>("textarea");
  expect(message, "the Playground's request box").toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(message!), "value")!.set!.call(message!, "Answer this.");
    message!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (revision) await pick(picker(request!, "Revision")!, revision);
  const send = async () => {
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send request")!.click());
    await settle();
  };
  await send();
  expect(host.textContent).toContain("runs agents on the runner only");
  const move = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === MOVE);
  const agentPicker = () => picker(host.querySelector('[aria-label="Playground agent"]')!, "Agent")!;
  return { host, request: request!, saved, runs, move, send, agentPicker };
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

  it("the offer is the refused agent's: with another agent picked, a click (if anything is offered) leaves that agent unsaved, and the move saves the refused agent only", async () => {
    const page = await open({ unbound: [], missing: {}, login_on_runner: true });
    await pick(page.agentPicker(), "other");
    const offered = page.move();
    if (offered) {
      await act(async () => offered.click());
      await settle();
    }
    expect(page.saved.map((s) => s.agent), "a click under the refusal of boxed saved other, the agent picked since, which was never refused").not.toContain("other");
    expect(page.host.textContent, "the refusal of boxed is still said with other picked").not.toContain("runs agents on the runner only");
    await pick(page.agentPicker(), "boxed");
    const move = page.move();
    expect(move, "boxed picked again: its refusal offers the move").toBeDefined();
    await act(async () => move!.click());
    await settle();
    expect(page.saved.map((s) => s.agent)).toEqual(["boxed"]);
  });

  it("a refusal without details.login_on_runner offers no move", async () => {
    const page = await open({ unbound: [], missing: {} });
    expect(page.move()).toBeUndefined();
  });
});
