import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";

// The Playground's "No model" bar while capabilities say no model is ready: a Claude Code login that is on and reads
// signed in is a model for an agent on Claude Agent (claude-agent), which runs on it, so the bar is gone then, ChatGPT's
// offer included. An agent on another harness still has no model, and keeps the bar. Signed out, or with the mode off,
// the bar says what it said. Each read of the login runs `claude auth status` on the server, so the console reads it
// once, again on leaving Settings (where a sign-in finishes) and after a run starts, never on every move between pages.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { models: { source: "providers", default: null, ready: false, needs: "key" }, harnesses: [], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, tool_keys: { routes: true, at_rest: "sealed" }, claude_login: true } };
const LOGIN = { place: "agentrun", command: "claude auth login", can_start: false, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" } };
const SIGNED_IN = { ...LOGIN, state: "signed_in", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
const agentOn = (harness: string): Agent => ({ ...SERVED_AGENT, agent_id: `on-${harness}`, kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: `On ${harness}`, instructions: "Answer.", harness, skills: [], tools: [] } });
const CLAUDE_AGENT = agentOn("claude-agent");
// An agent's revisions as the server lists them: the current one first, with `current`'s fields, and an older one with
// `older`'s. Null is a revision listed without its definition, which the page then does not hold.
type Rev = { revision: string; version: number; current: boolean; note: string | null; definition?: Record<string, unknown> };
const revOn = (revision: string, version: number, current: boolean, definition: Record<string, unknown> | null): Rev =>
  ({ revision, version, current, note: null, ...(definition ? { definition: { version: 1, name: "Rev", instructions: "Answer.", skills: [], tools: [], ...definition } } : {}) });
const twoRevisions = (current: Record<string, unknown> | null, older: Record<string, unknown> | null) => [revOn("r2", 2, true, current), revOn("r1", 1, false, older)];

const settle = async () => { for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); await settle(); };
// Picks the first ("Home": the current revision) or last ("End": the older one) entry of the Playground's Revision
// picker, as a person does with the keyboard.
const pickRevision = async (host: Element, at: "Home" | "End") => {
  await act(async () => { (host.querySelector('button[aria-haspopup="listbox"][aria-label="Revision"]') as HTMLButtonElement).click(); });
  await settle();
  const list = document.querySelector('[role="listbox"]')!;
  await key(list, at);
  await key(list, "Enter");
};

async function open(login: unknown, caps: unknown = CAPS, agents: Agent[] = [CLAUDE_AGENT], revisions: Rev[] = []) {
  let reads = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method === "POST" && path.startsWith("/v2/agents/") && path.endsWith("/runs")) return json(422, { error: { code: "scripted_refusal", message: "Scripted refusal", retryable: false } });
    if (path === "/v2/auth/session") return json(200, { accounts: false, secrets_writable: true });
    if (path === "/v2/capabilities") return json(200, caps);
    if (path === "/v2/settings/claude-login") { reads++; return json(200, login); }
    if (path === "/v2/settings/chatgpt") return json(200, { state: "signed_out" });
    if (path === "/v2/settings/tool-keys") return json(200, { keys: [], reenter: null });
    if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents, next_cursor: null });
    if (path.startsWith("/v2/agents/") && path.endsWith("/revisions")) return json(200, { revisions, next_cursor: null });
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  location.hash = "#/playground";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  await settle();
  return { host, bar: () => host.querySelector('[aria-label="No model"]'), reads: () => reads };
}

const go = async (hash: string) => {
  location.hash = hash;
  await settle();
};

describe("the Playground's No model bar and Claude Code's login on this machine", () => {
  it("a login that is on and signed in is a model for an agent on Claude Agent: no bar, and no offer of ChatGPT in its place", async () => {
    const page = await open(SIGNED_IN);
    expect(page.bar()?.textContent ?? null).toBeNull();
    expect(page.host.textContent).not.toContain("No model yet");
  });

  it("an agent on another harness has no model from the login, signed in or not: the bar stays", async () => {
    const page = await open(SIGNED_IN, CAPS, [agentOn("pi")]);
    expect(page.bar()?.textContent, "the bar over an agent on pi while the login reads signed in").toContain("No model yet.");
  });

  it("a login that is on and signed out, or the mode off, leaves the bar as it was", async () => {
    for (const login of [{ ...LOGIN, state: "signed_out" }, { ...LOGIN, state: "off" }]) {
      const page = await open(login);
      expect(page.bar()?.textContent, login.state).toContain("No model yet.");
      act(() => root?.unmount());
      root = undefined;
      document.body.innerHTML = "";
    }
    // A server with the mode switched off is never asked, and says what it said.
    const off = await open(SIGNED_IN, { ...CAPS, features: { ...CAPS.features, claude_login: false } });
    expect(off.bar()?.textContent).toContain("No model yet.");
  });

  it("the login is read once, not again on each move between pages, and again on leaving Settings, where a sign-in finishes", async () => {
    const page = await open(SIGNED_IN);
    const first = page.reads();
    expect(first).toBeGreaterThan(0);
    for (const hash of ["#/runs", "#/agents", "#/playground"]) await go(hash);
    expect(page.reads(), "a move between pages read the login again, which runs the CLI on the server").toBe(first);
    await go("#/settings/keys");
    const inSettings = page.reads();
    await go("#/playground");
    expect(page.reads(), "back from Settings, the login is read again").toBeGreaterThan(inSettings);
    expect(page.bar()?.textContent ?? null).toBeNull();
  });

  it("the login is read again after a run starts in the Playground, refused or not, since a run checks it", async () => {
    const page = await open(SIGNED_IN);
    const before = page.reads();
    const message = page.host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea');
    expect(message, "the Playground's request box").not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(message!), "value")!.set!.call(message!, "Answer this.");
      message!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send request");
    expect(send, "the Send request button").toBeDefined();
    await act(async () => send!.click());
    await settle();
    expect(page.host.textContent).toContain("Scripted refusal");
    expect(page.reads(), "a run started, and the login was not read again").toBeGreaterThan(before);
  });
});

// The bar describes the run the Playground will start, and a picked revision runs its own definition: its harness (and
// whether it runs natively) decides, not the agent's current one. A picked revision whose definition the page does not
// hold is not known to run on the login, so the bar stays.
describe("the Playground's No model bar follows the picked revision", () => {
  it("an older revision on Claude Agent has a model from a signed-in login though the current one is on pi: the bar goes, and comes back for the current one", async () => {
    const page = await open(SIGNED_IN, CAPS, [agentOn("pi")], twoRevisions({ harness: "pi" }, { harness: "claude-agent" }));
    expect(page.bar()?.textContent, "the bar over the current revision, on pi").toContain("No model yet.");
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent ?? null, "the bar over a picked revision on Claude Agent while the login reads signed in").toBeNull();
    await pickRevision(page.host, "Home");
    expect(page.bar()?.textContent, "the bar over the current revision again").toContain("No model yet.");
  });

  it("an older revision on pi has no model from the login though the current one is on Claude Agent: the bar comes up", async () => {
    const page = await open(SIGNED_IN, CAPS, [CLAUDE_AGENT], twoRevisions({ harness: "claude-agent" }, { harness: "pi" }));
    expect(page.bar()?.textContent ?? null, "the bar over the current revision, on Claude Agent").toBeNull();
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent, "the bar over a picked revision on pi").toContain("No model yet.");
  });

  it("a picked revision whose definition the page does not hold keeps the bar, signed in or not", async () => {
    const page = await open(SIGNED_IN, CAPS, [CLAUDE_AGENT], twoRevisions(null, null));
    expect(page.bar()?.textContent ?? null, "the bar over the current revision, on Claude Agent").toBeNull();
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent, "the bar over a picked revision the page holds no definition for").toContain("No model yet.");
  });

  it("an older revision that runs here, not natively, needs a model though the current one runs on its source machine: the bar comes up", async () => {
    const native = { runtime: "claude-code", machine_id: "source-machine", project: "/workspace/project", selector: { kind: "project" }, state: "ready", connected: true, capabilities: { launch: true } } as NonNullable<Agent["definition"]["native"]>;
    const agent: Agent = { ...agentOn("pi"), agent_id: "native", definition: { ...agentOn("pi").definition, native } };
    const page = await open(SIGNED_IN, CAPS, [agent], twoRevisions({ harness: "pi", native }, { harness: "pi" }));
    expect(page.bar()?.textContent ?? null, "the bar over a native agent's current revision").toBeNull();
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent, "the bar over a picked revision that runs on this server").toContain("No model yet.");
  });
});

// The login is a model only for a run on the runner (serve's loginForRun): a run in a sandbox box goes on the model keys
// whatever the login says, so with no key it still needs one, and the bar stays. Where the run goes is its definition's
// own place, else where the server runs a revision that names none: its default place when the revision names a shell
// tool (bash), else the runner (serve's defaultPlaceOf). The server sends its default place in capabilities' `places`.
const placesWith = (place: Record<string, unknown>) => ({ ...CAPS, places: { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true, state: "ready" }], default_place: place } });
const SANDBOX_DEFAULT = placesWith({ mode: "sandbox", box: "docker" });
const RUNNER_DEFAULT = placesWith({ mode: "runner" });
const claudeAgentWith = (definition: Record<string, unknown>): Agent => ({ ...CLAUDE_AGENT, agent_id: "placed", definition: { ...CLAUDE_AGENT.definition, ...definition } as Agent["definition"] });
const BAR = "No model yet.";

describe("the Playground's No model bar heeds the login only for a run on the runner", () => {
  it("an agent on Claude Agent placed in a sandbox box needs a model though the login reads signed in: the bar stays", async () => {
    const page = await open(SIGNED_IN, RUNNER_DEFAULT, [claudeAgentWith({ place: { mode: "sandbox", box: "docker" }, tools: ["bash"] })]);
    expect(page.bar()?.textContent ?? "", "the bar over a Claude Agent run in a sandbox box").toContain(BAR);
  });

  it("an agent on Claude Agent that names no place, with a shell tool, on a server whose default place is a sandbox box needs a model: the bar stays", async () => {
    const page = await open(SIGNED_IN, SANDBOX_DEFAULT, [claudeAgentWith({ tools: ["bash"] })]);
    expect(page.bar()?.textContent ?? "", "the bar over a Claude Agent run in the server's default sandbox box").toContain(BAR);
  });

  it("an agent on Claude Agent that names no place, with a shell tool, before the server's places are known is not known to run on the runner: the bar stays", async () => {
    const page = await open(SIGNED_IN, CAPS, [claudeAgentWith({ tools: ["bash"] })]);
    expect(page.bar()?.textContent ?? "", "the bar over a Claude Agent run whose place is not known yet").toContain(BAR);
  });

  it("an older revision placed in a sandbox box needs a model though the current one runs on the runner: the bar comes up", async () => {
    const page = await open(SIGNED_IN, RUNNER_DEFAULT, [CLAUDE_AGENT], twoRevisions({ harness: "claude-agent", place: { mode: "runner" } }, { harness: "claude-agent", place: { mode: "sandbox", box: "docker" }, tools: ["bash"] }));
    expect(page.bar()?.textContent ?? null, "the bar over the current revision, on the runner").toBeNull();
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent ?? "", "the bar over a picked revision in a sandbox box").toContain(BAR);
  });

  it("a run on the runner goes on the login: placed there, naming no place on a server whose default is the runner, or naming no shell tool on one whose default is a sandbox box; no bar", async () => {
    const cases: [string, unknown, Record<string, unknown>][] = [
      ["placed on the runner", SANDBOX_DEFAULT, { place: { mode: "runner" }, tools: [] }],
      ["no place, a shell tool, the runner by default", RUNNER_DEFAULT, { tools: ["bash"] }],
      ["no place, no shell tool, a sandbox box by default", SANDBOX_DEFAULT, { tools: [] }],
    ];
    for (const [what, caps, definition] of cases) {
      const page = await open(SIGNED_IN, caps, [claudeAgentWith(definition)]);
      expect(page.bar()?.textContent ?? null, what).toBeNull();
      act(() => root?.unmount());
      root = undefined;
      document.body.innerHTML = "";
    }
  });
});

// The login serves only Anthropic's own models (serve's providerFor): a claude-agent run that names one, or names none
// (the login's default is Anthropic's), goes on it. One that names an OpenRouter model, Anthropic's through OpenRouter
// included, goes to OpenRouter on its key whatever the login says, so with no key it still needs one, and the bar stays.
describe("the Playground's No model bar heeds the login only for a model it serves", () => {
  it("an agent on Claude Agent on the runner that names an OpenRouter model needs its key though the login reads signed in: the bar stays", async () => {
    const page = await open(SIGNED_IN, RUNNER_DEFAULT, [claudeAgentWith({ model: "openrouter/anthropic/claude-opus-5.5" })]);
    expect(page.bar()?.textContent ?? "", "the bar over a Claude Agent run on an OpenRouter model").toContain(BAR);
  });

  it("an agent on Claude Agent on the runner that names Anthropic's model, or none, goes on the login: no bar", async () => {
    for (const [what, definition] of [["Anthropic's model", { model: "anthropic/claude-opus-5-5" }], ["no model", {}]] as const) {
      const page = await open(SIGNED_IN, RUNNER_DEFAULT, [claudeAgentWith(definition)]);
      expect(page.bar()?.textContent ?? null, what).toBeNull();
      act(() => root?.unmount());
      root = undefined;
      document.body.innerHTML = "";
    }
  });

  it("an older revision that names an OpenRouter model needs its key though the current one goes on the login: the bar comes up", async () => {
    const page = await open(SIGNED_IN, RUNNER_DEFAULT, [CLAUDE_AGENT], twoRevisions({ harness: "claude-agent" }, { harness: "claude-agent", model: "openrouter/anthropic/claude-opus-5.5" }));
    expect(page.bar()?.textContent ?? null, "the bar over the current revision, naming no model").toBeNull();
    await pickRevision(page.host, "End");
    expect(page.bar()?.textContent ?? "", "the bar over a picked revision on an OpenRouter model").toContain(BAR);
  });
});
