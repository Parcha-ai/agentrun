import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { Client } from "@/lib/client";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import { pick, picker } from "@/test/picker";
import type { NativeBinding } from "@/lib/native";
import { AgentPage, agentHash } from "./AgentPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: Root | undefined;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
  location.hash = "";
});
const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
const managed: Agent = { ...SERVED_AGENT, agent_id: "inspect/a + b", kind: "agentic", revision: "r2", revisions: 2, archived_at: null,
  definition: { version: 2, name: "Inspector", instructions: "Current instructions.", harness: "pi", skills: [], tools: [] } };
const native: NativeBinding = {
  runtime: "claude-code", machine_id: "source-machine", project: "/workspace/project", selector: { kind: "project" }, state: "ready",
  version: "1.0.0", model: "claude-test", fingerprint: "editor-route-fixture", configuration: [], skills: [], mcp_servers: [], issues: [],
  connected: true, verified_at: "2026-11-12T00:00:00Z",
  capabilities: { launch: true, learning: true, workflows: false, approval: "native", usage: true },
};
const revisions = (agent: Agent) => [
  { revision: "r2", version: 2, created_at: "2026-11-12T00:00:00Z", current: agent.revision === "r2", note: "Current revision", definition: managed.definition },
  { revision: "r1", version: 1, created_at: "2026-11-11T00:00:00Z", current: agent.revision === "r1", note: "Earlier revision", definition: { ...managed.definition, version: 1, instructions: "Earlier instructions." } },
];
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const settingsButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('header[aria-label="Agent toolbar"] button[aria-label="Agent settings"]');
const settingsSection = (host: HTMLElement, name: string) => [...settingsMenu(host)!.querySelectorAll<HTMLButtonElement>("ul button")].find(control => control.textContent?.trim().startsWith(name));
const settingsMenu = (host: HTMLElement) => host.querySelector<HTMLElement>('nav[aria-label="Agent settings sections"]');
function expectSettingsOpen(host: HTMLElement) {
  expect(settingsButton(host)).toBeNull();
  expect(host.querySelector('header[aria-label="Agent toolbar"] nav[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent).toBe("Settings");
  expect(host.querySelector('[role="region"][aria-label="Agent settings"]')).toBeTruthy();
  expect(host.querySelector('[role="tab"]')).toBeNull();
}
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
async function until(ok: () => boolean) {
  const end = Date.now() + 4000;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(ok()).toBe(true);
}
async function openApp(archived = false, view = "versions", skills: string[] = [], description?: string) {
  let current: Agent = { ...managed, definition: { ...managed.definition, skills, ...(description ? { description } : {}) }, archived_at: archived ? "2026-11-13T00:00:00Z" : null };
  const writes: { method: string; path: string; body: unknown }[] = [];
  const savedEtags: (string | null)[] = [];
  const path = `/v2/agents/${encodeURIComponent(current.agent_id)}`;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const at = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, path: at, body: JSON.parse(String(init?.body)) });
      if (method === "PUT" && at === `${path}/definition`) {
        savedEtags.push(new Headers(init?.headers).get("if-match"));
        const body = JSON.parse(String(init?.body));
        current = { ...current, revision: "r3", revisions: 3, definition: body.definition };
        return json(current, 200, current.revision);
      }
      if (method === "POST" && at === `${path}/current`) {
        expect(archived).toBe(false);
        expect(writes.at(-1)?.body).toEqual({ revision: "r1" });
        current = { ...current, revision: "r1", definition: revisions(current)[1].definition };
        return json(current);
      }
      return json({ error: { code: "unexpected_write", message: at, retryable: false } }, 400);
    }
    if (at === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (at === "/v2/capabilities") return json({ models: { source: "providers", ready: true }, harnesses: [{ id: "pi", available: true }], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (at === "/v2/agents") return json({ agents: [current], next_cursor: null });
    if (at === path) return json(current, 200, current.revision);
    if (at === `${path}/revisions/${encodeURIComponent(current.revision)}/skills`) return json({ revision: current.revision, skills: Object.fromEntries(current.definition.skills.map(name => [`${name}/SKILL.md`, `---\nname: ${name}\ndescription: Review results.\n---\n\nReview the evidence.\n`])) });
    if (at === `${path}/revisions`) return json({ revisions: current.revision === "r3" ? [{ revision: "r3", version: 3, current: true, note: "Changed instructions", created_at: "2026-11-13T00:00:00Z", definition: current.definition }, ...revisions(current)] : revisions(current), next_cursor: null });
    if (at === `${path}/runs` || at === "/v2/runs") return json({ runs: [], next_cursor: null });
    if (at === "/v2/computers") return json({ kinds: [] });
    if (at === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: at, retryable: false } }, 404);
  });
  location.hash = view === "list" ? archived ? "#/agents?archived=true" : "#/agents" : agentHash(current.agent_id, view);
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await until(() => !!host.querySelector(view === "list" ? '[data-testid="agent-card-actions"]' : 'section[aria-label="Agent detail"]'));
  if (view === "versions") await until(() => !!host.querySelector('section[aria-label="Agent versions"] table'));
  return { host, writes, path, savedEtags };
}

describe("AgentPage settings navigation", () => {
  it("labels the editable description when the overview also has a description", async () => {
    const { host } = await openApp(false, "settings", [], "Reviews the source files.");
    await until(() => !!host.querySelector('input#agent-description'));
    const field = host.querySelector<HTMLInputElement>('input#agent-description')!;
    const label = host.querySelector<HTMLLabelElement>('label[for="agent-description"]')!;
    expect(label.control).toBe(field);
    expect([...field.labels!]).toContain(label);
    expect(field.value).toBe("Reviews the source files.");
  });

  it("links the Settings breadcrumb back to the agent and guards unsaved changes", async () => {
    const { host, writes } = await openApp(false, "settings");
    await until(() => !!host.querySelector("#agent-instructions"));
    const breadcrumb = host.querySelector<HTMLElement>('header[aria-label="Agent toolbar"] nav[aria-label="Breadcrumb"]');
    expect(breadcrumb).toBeTruthy();
    const agentLink = breadcrumb!.querySelector<HTMLAnchorElement>("a")!;
    expect(agentLink.textContent).toBe("Inspector");
    expect(agentLink.getAttribute("href")).toBe("#/agents/inspect%2Fa%20%2B%20b");
    expect(breadcrumb!.querySelector('[aria-current="page"]')?.textContent).toBe("Settings");
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe("Settings");
    const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Keep this draft.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => agentLink.click());
    await until(() => !!button(document.body, "Stay"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    await act(async () => button(document.body, "Stay")!.click());
    expect(instructions.value).toBe("Keep this draft.");
    await act(async () => agentLink.click());
    await until(() => !!button(document.body, "Leave"));
    await act(async () => button(document.body, "Leave")!.click());
    await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Runs");
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b");
    expect(host.querySelector('header[aria-label="Agent toolbar"] nav[aria-label="Breadcrumb"]')).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Inspector");
    expect(writes).toEqual([]);
  });

  // An agent this server runs edits in the console: its card's Edit links to Settings. An archived one keeps the prompt-based Edit.
  it.each([false, true])("opens Settings from an agent card (archived=%s), Edit linking there or, archived, keeping its prompt-based action", async (archived) => {
    const copied = vi.fn(async (_text: string) => {});
    localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const { host, writes } = await openApp(archived, "list");
    const cardActions = host.querySelector<HTMLElement>('[data-testid="agent-card-actions"]')!;
    if (archived) {
      expect(button(cardActions, "Edit Inspector")).toBeTruthy();
      expect(button(cardActions, "Choose coding agent for Edit Inspector")).toBeTruthy();
    } else {
      expect(cardActions.querySelector('a[aria-label="Edit Inspector"]')?.getAttribute("href")).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
      expect(button(cardActions, "Choose coding agent for Edit Inspector")).toBeUndefined();
    }
    const card = cardActions.closest("li")!;
    const settings = button(card, "Settings for Inspector");
    expect(settings).toBeTruthy();
    expect(settings?.textContent?.trim()).toBe("");
    expect(settings?.getAttribute("title")).toBe("Settings");
    expect(cardActions.contains(settings!)).toBe(true);
    expect([...cardActions.querySelectorAll("button")].at(-1)).toBe(settings);
    expect(settings?.classList.contains("border-border")).toBe(true);
    expect(button(card, "Archive Inspector")).toBeUndefined();
    expect(button(card, "Unarchive Inspector")).toBeUndefined();
    const title = card.querySelector("[data-agent-card-icon]")!.closest("button")!;
    expect(title.contains(settings!)).toBe(false);
    if (archived) {
      await act(async () => button(cardActions, "Edit Inspector")!.click());
      expect(copied).toHaveBeenCalledTimes(1);
      expect(copied.mock.calls[0][0]).toContain(JSON.stringify(managed.agent_id));
    }
    expect(location.hash).toBe(archived ? "#/agents?archived=true" : "#/agents");
    await act(async () => settings!.click());
    await until(() => !!host.querySelector("#agent-instructions"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expectSettingsOpen(host);
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Current instructions.");
    const archive = button(host, archived ? "Unarchive" : "Archive");
    expect(archive).toBeTruthy();
    expect(archive?.textContent?.trim()).toBe("");
    expect(archive?.getAttribute("title")).toBe(archived ? "Unarchive" : "Archive");
    expect(copied).toHaveBeenCalledTimes(archived ? 1 : 0);
    expect(writes).toEqual([]);
  });

  it("keeps Edit agent in the toolbar, copies the latest settings draft, and forgets it after discard", async () => {
    const copied = vi.fn(async (_text: string) => {});
    localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const { host, writes } = await openApp(false, "runs");
    const toolbar = () => host.querySelector<HTMLElement>('header[aria-label="Agent toolbar"]')!;
    const actions = () => [...toolbar().querySelectorAll("button")]
      .map(control => control.getAttribute("aria-label") ?? control.textContent?.trim())
      .filter(label => !label?.startsWith("Back"));
    expect(host.querySelector("[data-run-here]")).toBeTruthy();
    const before = actions();
    expect(before).toEqual(["Agent settings", "Refresh agent", "Edit agent", "Choose coding agent for Edit agent"]);
    const edit = () => toolbar().querySelector<HTMLButtonElement>('[role="group"][aria-label="Edit agent options"] button')!;
    await act(async () => edit().click());
    const overviewPrompt = copied.mock.calls.at(-1)![0];
    expect(overviewPrompt).toContain(JSON.stringify(managed.agent_id));
    await act(async () => settingsButton(host)!.click());
    await until(() => !!host.querySelector("#agent-instructions"));
    expect(actions()).toEqual(before.filter(label => label !== "Agent settings"));
    expect(host.querySelector("[data-run-here]")).toBeNull();
    expect(settingsButton(host)).toBeNull();
    expect(host.querySelectorAll('[role="group"][aria-label="Edit agent options"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Use your agent options"]')).toBeNull();
    expect(button(host, "Use your agent")).toBeUndefined();
    const type = async (value: string) => act(async () => {
      const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, value);
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("First unsaved instructions.");
    await act(async () => edit().click());
    expect(copied.mock.calls.at(-1)![0]).toContain("First unsaved instructions.");
    expect(writes).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await type("Latest unsaved instructions.");
    await act(async () => edit().click());
    expect(copied.mock.calls.at(-1)![0]).toContain("Latest unsaved instructions.");
    expect(copied.mock.calls.at(-1)![0]).not.toContain("First unsaved instructions.");
    expect(writes).toEqual([]);
    await act(async () => button(host, "Back")!.click());
    await until(() => !!button(document.body, "Leave"));
    await act(async () => button(document.body, "Leave")!.click());
    await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Runs");
    await act(async () => edit().click());
    expect(copied.mock.calls.at(-1)![0]).toBe(overviewPrompt);
    expect(copied.mock.calls.at(-1)![0]).not.toContain("Latest unsaved instructions.");
    expect(copied).toHaveBeenCalledTimes(4);
    expect(writes).toEqual([]);
  });

  it("separates Tools and Skills while preserving saved skills and the unsaved draft", async () => {
    const { host, writes } = await openApp(false, "settings", ["reviewing"]);
    await until(() => !!host.querySelector("#agent-instructions"));
    const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Check every result carefully.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const panel = host.querySelector<HTMLElement>('[role="region"][aria-label="Agent settings"]')!;
    await act(async () => settingsSection(host, "Tools")!.click());
    expect(panel.querySelector("h2")?.textContent).toBe("Tools");
    expect(panel.querySelector('fieldset[aria-label="Tool approvals"]')).toBeTruthy();
    expect(panel.textContent).not.toContain("reviewing");
    expect(settingsSection(host, "Skills")).toBeTruthy();
    await act(async () => settingsSection(host, "Skills")!.click());
    expect(panel.querySelector("h2")?.textContent).toBe("Skills");
    expect(panel.textContent).toContain("reviewing");
    expect(panel.querySelector('fieldset[aria-label="Tool approvals"]')).toBeNull();
    expect(settingsMenu(host)?.querySelector('[aria-current="page"]')?.textContent?.trim()).toMatch(/^Skills/);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toEqual([]);
    await act(async () => settingsSection(host, "General")!.click());
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Check every result carefully.");
    await act(async () => button(host, "Save revision")!.click());
    await until(() => !!button(host, "Saved · rev 3"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PUT", body: { definition: { instructions: "Check every result carefully.", skills: ["reviewing"] } } });
  });

  it("opens Tools directly from the Tools card and preserves that section on reload without writing", async () => {
    const { host, writes } = await openApp(false, "runs");
    const tools = [...host.querySelectorAll("dt")].find(term => term.textContent?.trim().startsWith("Tools"))?.parentElement;
    expect(tools).toBeTruthy();
    const edit = button(tools!, "Edit tools");
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await until(() => !!host.querySelector('nav[aria-label="Agent settings sections"] [aria-current="page"]')?.textContent?.includes("Tools"));
    const destination = "#/agents/inspect%2Fa%20%2B%20b/settings?section=tools";
    expect(location.hash).toBe(destination);
    expectSettingsOpen(host);
    expect(host.querySelector('[role="region"][aria-label="Agent settings"] h2')?.textContent).toBe("Tools");
    expect(writes).toEqual([]);
    // A fresh mount reads only the address, as a reload or a shared deep link does.
    await act(async () => root!.unmount());
    root = createRoot(host);
    await act(async () => root!.render(createElement(App)));
    await until(() => !!host.querySelector('nav[aria-label="Agent settings sections"] [aria-current="page"]')?.textContent?.includes("Tools"));
    expect(location.hash).toBe(destination);
    expectSettingsOpen(host);
    expect(writes).toEqual([]);
  });

  it("keeps an existing edit link working as Settings without rewriting the address or saving", async () => {
    const { host, writes } = await openApp(false, "edit");
    await until(() => !!host.querySelector("#agent-instructions"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/edit");
    expectSettingsOpen(host);
    expect(host.querySelector('nav[aria-label="Agent settings sections"] [aria-current="page"]')?.textContent?.trim()).toMatch(/^General/);
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Current instructions.");
    expect(writes).toEqual([]);
    // A focused link reached while the form is already mounted still opens the requested section.
    await act(async () => {
      location.hash = "#/agents/inspect%2Fa%20%2B%20b/settings?section=tools";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await until(() => !!host.querySelector('nav[aria-label="Agent settings sections"] [aria-current="page"]')?.textContent?.includes("Tools"));
    expect(writes).toEqual([]);
  });


  it("discards only confirmed edits when leaving a legacy edit address and guards the next settings change", async () => {
    const { host, writes } = await openApp(false, "edit");
    await until(() => !!host.querySelector("#agent-instructions"));
    const type = async (value: string) => act(async () => {
      const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, value);
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("Changes to discard.");
    await act(async () => { location.hash = "#/agents/inspect%2Fa%20%2B%20b/settings"; });
    await until(() => !!button(document.body, "Leave"));
    await until(() => location.hash === "#/agents/inspect%2Fa%20%2B%20b/edit");
    await act(async () => button(document.body, "Leave")!.click());
    await until(() => location.hash === "#/agents/inspect%2Fa%20%2B%20b/settings" && host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value === "Current instructions.");
    expect(writes).toEqual([]);
    await type("Changes to keep.");
    await act(async () => button(host, "Back")!.click());
    await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Leave without saving?") === true);
    await act(async () => button(document.body, "Stay")!.click());
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Changes to keep.");
    expect(writes).toEqual([]);
  });

  it("opens full configuration from the header Settings button and saves instructions with the loaded revision", async () => {
    const { host, writes, path, savedEtags } = await openApp();
    const editor = settingsButton(host);
    expect(editor).toBeTruthy();
    expect(editor?.textContent?.trim()).toBe("Settings");
    expect(editor?.disabled).toBe(false);
    expect([...host.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === "Settings")).toBe(false);
    await act(async () => editor!.click());
    await until(() => !!host.querySelector("#agent-instructions"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expectSettingsOpen(host);
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe("Settings");
    const menu = settingsMenu(host)!;
    expect(menu).toBeTruthy();
    expect([...menu.querySelectorAll("ul button")].map(control => control.textContent?.trim())).toEqual([/^General/, /^Computer/, /^Tools/, /^Skills/, /^Model & runtime/, /^History/].map(pattern => expect.stringMatching(pattern)));
    expect(menu.querySelector('[aria-current="page"]')?.textContent?.trim()).toMatch(/^General/);
    expect(menu.querySelector('[aria-current="step"], .lucide-check')).toBeNull();
    const panel = host.querySelector<HTMLElement>('[role="region"][aria-label="Agent settings"]')!;
    expect(panel.textContent).not.toMatch(/Step \d/);
    expect(button(panel, "Previous")).toBeUndefined();
    expect(button(panel, "Next")).toBeUndefined();
    expect(writes).toEqual([]);
    const instructions = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Explain every result.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(host, "Save revision")!.click());
    await until(() => !!button(host, "Saved · rev 3"));
    expect(savedEtags).toEqual(["r2"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PUT", path: `${path}/definition`, body: { definition: { version: 3, instructions: "Explain every result." } } });
    expectSettingsOpen(host);
    // Back returns to Versions, where Settings was opened; the saved revision needs no full-page reload.
    await act(async () => button(host, "Back")!.click());
    await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Versions");
    const revision = [...host.querySelectorAll("dt")].find(term => term.textContent === "Revision");
    expect(revision?.nextElementSibling?.textContent).toBe("rev 3 of 3");
    const details = host.querySelector<HTMLElement>("[data-agent-details]")!;
    details.dispatchEvent(new Event("scroll"));
    expect(details.hasAttribute("data-scrolling")).toBe(true);
  });

  it("keeps edits across settings sections and asks before returning to the agent", async () => {
    const { host, writes } = await openApp();
    const editor = settingsButton(host);
    expect(editor).toBeTruthy();
    await act(async () => editor!.click());
    await until(() => !!host.querySelector("#agent-instructions"));
    const setInstructions = (value: string) => {
      const field = host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => setInstructions("Unsaved instructions."));
    const section = (name: string) => settingsSection(host, name)!;
    for (const name of ["Computer", "Tools", "Skills", "Model & runtime", "History", "General"]) {
      expect(section(name)).toBeTruthy();
      await act(async () => section(name).click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(settingsMenu(host)?.querySelector('[aria-current="page"]')?.textContent?.trim().startsWith(name)).toBe(true);
      expect(host.querySelector('[role="region"][aria-label="Agent settings"] h2')?.textContent).toBe(name);
    }
    // The compact menu used on phones shares the same draft and selected section.
    const compactMenu = picker(settingsMenu(host)!, "Settings section")!;
    await pick(compactMenu, "tools");
    expect(compactMenu.textContent).toBe("Tools");
    expect(settingsMenu(host)?.querySelector('[aria-current="page"]')?.textContent).toContain("Tools");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await pick(compactMenu, "context");
    expect(compactMenu.textContent).toBe("General");
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Unsaved instructions.");
    expect(writes).toEqual([]);
    await act(async () => button(host, "Back")!.click());
    await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Leave without saving?") === true);
    await act(async () => button(document.body, "Stay")!.click());
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe("Unsaved instructions.");
    await act(async () => button(host, "Back")!.click());
    await until(() => !!button(document.body, "Leave"));
    await act(async () => button(document.body, "Leave")!.click());
    await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Versions");
    expect(writes).toEqual([]);
  });

  it("opens Settings from Versions and makes a selected saved revision current only on request", async () => {
    const { host, writes, path } = await openApp();
    expect(button(host, "Choose coding agent for Edit agent")).toBeTruthy();
    const versions = host.querySelector<HTMLElement>('section[aria-label="Agent versions"]')!;
    expect(button(versions, "Make current")).toBeUndefined();
    await act(async () => button(versions, "View configuration for version 1")!.click());
    expect(versions.querySelector("pre")?.textContent).toContain("Earlier instructions.");
    expect(versions.querySelector("input, textarea")).toBeNull();
    expect(writes).toEqual([]);
    const edit = settingsButton(host);
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await until(() => !!host.querySelector("#agent-name"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expect(writes).toEqual([]);
    const history = settingsSection(host, "History");
    expect(history).toBeTruthy();
    await act(async () => history!.click());
    const makeCurrent = button(host, "Make current");
    expect(makeCurrent?.disabled).toBe(false);
    await act(async () => makeCurrent!.click());
    await until(() => !!host.querySelector('[aria-label="About this agent"]')?.textContent?.includes("rev 1 current"));
    expect(writes).toEqual([{ method: "POST", path: `${path}/current`, body: { revision: "r1" } }]);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Earlier instructions.");
  });

  it("retains Settings access for an archived managed agent without offering Run or performing a write", async () => {
    const { host, writes } = await openApp(true);
    expect(button(host, "Choose coding agent for Run agent")).toBeUndefined();
    const edit = settingsButton(host);
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await until(() => !!button(host, "Unarchive"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/settings");
    expect(writes).toEqual([]);
  });

  for (const [name, binding, expected] of [
    ["native", { native }, "Edit the original native setup"],
    ["claude-agent-sdk", { sdk: { runtime: "claude-agent-sdk" as const } }, "using Claude Agent SDK"],
    ["codex-sdk", { sdk: { runtime: "codex-sdk" as const } }, "using Codex SDK"],
  ] as const) {
    it(`keeps ${name} editing source-owned and its Versions view read-only`, async () => {
      const agent = { ...managed, definition: { ...managed.definition, ...binding } };
      const writes = vi.fn(async () => { throw new Error("Inspecting or copying must not dispatch"); });
      const copied = vi.fn(async (_text: string) => {});
      const go = vi.fn();
      const renderEditor = vi.fn(() => createElement("p", null, "Unexpected editor"));
      const v2 = { getAgent: async () => ({ agent, etag: null }), statsOver: async () => { throw new Error("No analytics"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }), listRevisions: async () => ({ revisions: [{ ...revisions(agent)[0], definition: agent.definition }], next_cursor: null }), updateDefinition: writes, setCurrent: writes, startRun: writes } as unknown as Client;
      localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
      const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
      await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go, tab: "versions", renderEditor })));
      await settle();
      expect(settingsButton(host)).toBeTruthy();
      expect(renderEditor).not.toHaveBeenCalled();
      expect(button(host, "Make current")).toBeUndefined();
      expect(button(host, "Choose coding agent for Edit agent")).toBeTruthy();
      await act(async () => button(host, "View configuration for version 2")!.click());
      expect(host.querySelector('section[aria-label="Agent versions"] pre')?.textContent).toBe(JSON.stringify(agent.definition, null, 2));
      await act(async () => button(host, "Edit agent")!.click());
      expect(copied.mock.calls.at(-1)?.[0]).toContain(expected);
      expect(copied.mock.calls.at(-1)?.[0]).toContain(JSON.stringify(agent.agent_id));
      expect(copied.mock.calls.at(-1)?.[0]).not.toContain("agents_revise");
      expect(writes).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled();
      await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go, tab: "settings", renderEditor })));
      await settle();
      expectSettingsOpen(host);
      expect(renderEditor).not.toHaveBeenCalled();
      expect(host.querySelector('[role="region"][aria-label="Agent settings"] h2')?.textContent).toBe("Skills");
      expect(button(host, "Add skill")).toBeUndefined();
      expect(button(host, "Save revision")).toBeUndefined();
      expect(writes).not.toHaveBeenCalled();
      const agentLink = host.querySelector<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')!;
      expect(agentLink.textContent).toBe(agent.definition.name);
      expect(agentLink.getAttribute("href")).toBe(agentHash(agent.agent_id));
      await act(async () => agentLink.click());
      expect(go).toHaveBeenCalledExactlyOnceWith(agentHash(agent.agent_id));
    });
  }

  it("opens a managed workflow's Settings through the supplied navigation callback", async () => {
    const agent = agentFixture("lead-scorer");
    const go = vi.fn();
    const v2 = { getAgent: async () => ({ agent, etag: null }), statsOver: async () => { throw new Error("No analytics"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }) } as unknown as Client;
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go })));
    await settle();
    const edit = settingsButton(host);
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    expect(go).toHaveBeenCalledExactlyOnceWith("#/agents/lead-scorer/settings");
  });
});
