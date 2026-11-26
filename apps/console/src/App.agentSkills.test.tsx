import { SERVED_AGENT } from "@/test/agent";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Agent } from "@/lib/agentForm";
import type { NativeBinding } from "@/lib/native";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: Root | undefined;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  vi.unstubAllGlobals(); localStorage.clear(); location.hash = "";
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
});
const readme = "---\nname: reviewing\ndescription: Review a result.\n---\n\nCheck the evidence.\n";
const files = { "reviewing/SKILL.md": readme, "reviewing/references/checklist.md": "Keep every evidence link.\n", "reviewing/scripts/check.sh": "#!/bin/sh\nprintf 'checked\\n'\n" };
const managed: Agent = { ...SERVED_AGENT, agent_id: "review/a + b", kind: "agentic", revision: "rev/2 + original", revisions: 2, archived_at: null,
  definition: { version: 2, name: "Reviewer", instructions: "Review carefully.", harness: "pi", tools: [], skills: ["reviewing"] } };
const agentPath = `/v2/agents/${encodeURIComponent(managed.agent_id)}`;
const skillsPath = `${agentPath}/revisions/${encodeURIComponent(managed.revision)}/skills`;
const settingsHash = `#/agents/${encodeURIComponent(managed.agent_id)}/settings`;
const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(control => control.getAttribute("aria-label") === name || control.textContent?.trim() === name);
const section = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Agent settings sections"] ul button')].find(control => control.textContent?.trim().startsWith(name));
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
async function until(ok: () => boolean) {
  const end = Date.now() + 4000;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(ok()).toBe(true);
}
async function open({ skillRead, conflict = false, agent = managed, hash = `${settingsHash}?section=skills` }: {
  skillRead?: () => Response | Promise<Response>; conflict?: boolean; agent?: Agent; hash?: string;
} = {}) {
  let current = agent;
  let savedFiles: Record<string, string> = { ...files };
  const reads: string[] = [];
  const writes: { path: string; etag: string | null; body: { definition: Agent["definition"]; skills?: Record<string, string> } }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method && init.method !== "GET") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, etag: new Headers(init.headers).get("if-match"), body });
      if (conflict) return json({ error: { code: "precondition_failed", message: "A newer revision was saved elsewhere.", retryable: false } }, 412);
      if (init.method === "PUT" && path === `${agentPath}/definition`) {
        current = { ...current, definition: body.definition, revision: "r3", revisions: 3 };
        if (body.skills) savedFiles = body.skills;
        return json(current, 200, '"r3"');
      }
      return json({ error: { code: "unexpected_write", message: path, retryable: false } }, 400);
    }
    reads.push(path);
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (path === "/v2/capabilities") return json({ models: { ready: true }, harnesses: [{ id: "pi", available: true }], tools: [], features: {} });
    if (path === "/v2/agents") return json({ agents: [current], next_cursor: null });
    if (path === agentPath) return json(current, 200, JSON.stringify(current.revision));
    if (path === `${agentPath}/revisions`) return json({ revisions: [{ revision: current.revision, version: current.definition.version, current: true, note: null, created_at: "2026-11-20T00:00:00Z", definition: current.definition }], next_cursor: null });
    if (path === skillsPath) return skillRead ? skillRead() : json({ revision: managed.revision, skills: files });
    if (path === `${agentPath}/revisions/r3/skills`) return json({ revision: "r3", skills: savedFiles });
    if (path === "/v2/runs" || path === `${agentPath}/runs`) return json({ runs: [], next_cursor: null });
    if (path === "/v2/computers") return json({ kinds: [] });
    if (path === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await until(() => !!host.querySelector('header[aria-label="Agent toolbar"]'));
  const content = () => host.querySelector<HTMLTextAreaElement>("#agent-skill-content");
  return { host, reads, writes, content };
}
async function editSkill(page: Awaited<ReturnType<typeof open>>) {
  await until(() => button(page.host, "Edit skill reviewing")?.disabled === false);
  await act(async () => button(page.host, "Edit skill reviewing")!.click());
  await until(() => !!page.content());
}

describe("managed agent skill settings", () => {
  it("loads the exact revision, adds and edits skills, and saves every support file with If-Match", async () => {
    const page = await open();
    await editSkill(page);
    expect(page.reads).toContain(skillsPath);
    expect(page.content()?.value).toBe(readme);
    const edited = `${readme}\nExplain each finding.\n`;
    await type(page.content()!, edited);
    await act(async () => button(page.host, "Add skill")!.click());
    await type(page.host.querySelector<HTMLInputElement>("#agent-skill-name")!, "reporting");
    await act(async () => button(page.host, "Create skill")!.click());
    const added = "---\nname: reporting\ndescription: Write a report.\n---\n\nSummarize the findings.\n";
    await type(page.content()!, added);
    expect(page.writes).toEqual([]);
    await act(async () => button(page.host, "Save revision")!.click());
    await until(() => !!button(page.host, "Saved · rev 3"));
    expect(page.writes).toEqual([{ path: `${agentPath}/definition`, etag: JSON.stringify(managed.revision), body: expect.objectContaining({
      definition: expect.objectContaining({ version: 3, skills: ["reporting", "reviewing"] }),
      skills: { ...files, "reviewing/SKILL.md": edited, "reporting/SKILL.md": added },
    }) }]);
    expect(page.writes[0].body.definition).not.toHaveProperty("skillFiles");
  });

  it("does not create a revision when a skill edit is put back to its original contents", async () => {
    const page = await open();
    await editSkill(page);
    await type(page.content()!, `${readme}\nTemporary change.\n`);
    expect(button(page.host, "Save revision")?.disabled).toBe(false);
    await type(page.content()!, readme);
    expect(button(page.host, "Saved · rev 2")?.disabled).toBe(true);
    await act(async () => button(page.host, "Back")!.click());
    await until(() => !page.content());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(page.writes).toEqual([]);
  });

  it("keeps the edited files after a revision conflict and never retries the write automatically", async () => {
    const page = await open({ conflict: true });
    await editSkill(page);
    const edited = `${readme}\nKeep my unsaved revision.\n`;
    await type(page.content()!, edited);
    await act(async () => button(page.host, "Save revision")!.click());
    await until(() => !!button(page.host, "Reload"));
    expect(page.content()?.value).toBe(edited);
    expect(page.writes).toHaveLength(1);
    expect(page.writes[0]).toMatchObject({ etag: JSON.stringify(managed.revision), body: { skills: { ...files, "reviewing/SKILL.md": edited } } });
    expect(page.reads.filter(path => path.endsWith("/skills"))).toEqual([skillsPath]);
  });

  it("blocks skill changes until the complete revision bundle loads, while other settings remain usable", async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const page = await open({ skillRead: () => response });
    await until(() => !!button(page.host, "Add skill"));
    expect(button(page.host, "Add skill")?.disabled).toBe(true);
    expect(button(page.host, "Edit skill reviewing")?.disabled).toBe(true);
    await act(async () => section(page.host, "General")!.click());
    expect(page.host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.disabled).toBe(false);
    await act(async () => finish(json({ revision: managed.revision, skills: files })));
    await act(async () => section(page.host, "Skills")!.click());
    await until(() => button(page.host, "Edit skill reviewing")?.disabled === false);
    expect(page.writes).toEqual([]);
  });

  it("keeps failed skill reads visible and lets an unrelated setting save without replacing files", async () => {
    const page = await open({ skillRead: () => json({ error: { code: "store_busy", message: "Skill files could not be read.", retryable: true } }, 503) });
    await until(() => !!button(page.host, "Retry skills"));
    expect(button(page.host, "Add skill")?.disabled).toBe(true);
    expect(button(page.host, "Edit skill reviewing")?.disabled).toBe(true);
    await act(async () => section(page.host, "General")!.click());
    await type(page.host.querySelector<HTMLTextAreaElement>("#agent-instructions")!, "Review twice.");
    await act(async () => button(page.host, "Save revision")!.click());
    await until(() => !!button(page.host, "Saved · rev 3"));
    expect(page.writes).toHaveLength(1);
    expect(page.writes[0].body.definition.instructions).toBe("Review twice.");
    expect(page.writes[0].body).not.toHaveProperty("skills");
  });

  it("refuses skill contents from a different revision instead of editing them as the loaded agent", async () => {
    const page = await open({ skillRead: () => json({ revision: "a-newer-revision", skills: files }) });
    await until(() => !!button(page.host, "Retry skills"));
    expect(page.host.textContent).toContain("do not match the revision");
    expect(button(page.host, "Add skill")?.disabled).toBe(true);
    expect(button(page.host, "Edit skill reviewing")?.disabled).toBe(true);
    expect(page.writes).toEqual([]);
  });

  it("keeps a skill draft across sections, includes its latest text in Edit agent, and guards leaving", async () => {
    const copied = vi.fn(async (_text: string) => {});
    localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const page = await open();
    await editSkill(page);
    await type(page.content()!, `${readme}\nInitial draft.\n`);
    await act(async () => section(page.host, "Tools")!.click());
    await act(async () => section(page.host, "Skills")!.click());
    await editSkill(page);
    expect(page.content()?.value).toContain("Initial draft.");
    await type(page.content()!, `${readme}\nLatest skill draft.\n`);
    const toolbar = page.host.querySelector<HTMLElement>('header[aria-label="Agent toolbar"]')!;
    await act(async () => button(toolbar, "Edit agent")!.click());
    expect(copied.mock.calls.at(-1)![0]).toContain("Latest skill draft.");
    expect(copied.mock.calls.at(-1)![0]).toContain("reviewing/references/checklist.md");
    expect(copied.mock.calls.at(-1)![0]).not.toContain("Initial draft.");
    await act(async () => button(page.host, "Back")!.click());
    await until(() => !!button(document.body, "Stay"));
    await act(async () => button(document.body, "Stay")!.click());
    expect(page.content()?.value).toContain("Latest skill draft.");
    expect(page.writes).toEqual([]);
  });
});

const native: NativeBinding = {
  runtime: "claude-code", machine_id: "review-workstation", project: "/workspace/reviewer", selector: { kind: "project" },
  state: "ready", connected: true, version: "1.0.0", model: "claude-test", fingerprint: "skill-inventory-fixture",
  skills: ["reviewing", "location-unknown"],
  configuration: [
    { path: "/workspace/reviewer/.claude/skills/reviewing/SKILL.md", sha256: "a".repeat(64) },
    { path: "/workspace/shared/skills/reviewing/SKILL.md", sha256: "b".repeat(64) },
    { path: "/workspace/reviewer/CLAUDE.md", sha256: "c".repeat(64) },
  ],
  mcp_servers: [], issues: [], capabilities: { launch: true, learning: true, workflows: false, approval: "native", usage: true },
};

describe("connected agent skill settings", () => {
  it("shows reported native skills with their actual source paths and connection provenance", async () => {
    const agent = { ...managed, definition: { ...managed.definition, native, skills: ["unrelated-managed-snapshot"] } };
    const page = await open({ agent, hash: settingsHash });
    await until(() => !!page.host.querySelector('[role="region"][aria-label="Agent settings"] h2'));
    const panel = page.host.querySelector<HTMLElement>('[role="region"][aria-label="Agent settings"]')!;
    expect(panel.querySelector("h2")?.textContent).toBe("Skills");
    expect([...panel.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["reviewing", "location-unknown"]);
    expect(panel.textContent).toContain(native.machine_id);
    expect(panel.textContent).toContain(native.project);
    expect(panel.textContent).toContain(native.configuration[0].path);
    expect(panel.textContent).toContain(native.configuration[1].path);
    expect(panel.textContent).not.toContain(native.configuration[2].path);
    expect(panel.textContent).toContain("The connection reported this skill without its file path.");
    expect(panel.textContent).not.toContain("unrelated-managed-snapshot");
    expect(panel.querySelector("input, textarea")).toBeNull();
    expect(button(page.host, "Add skill")).toBeUndefined();
    expect(button(page.host, "Save revision")).toBeUndefined();
    expect(page.reads.some(path => path.endsWith("/skills"))).toBe(false);
    expect(page.writes).toEqual([]);
  });

  for (const [runtime, label] of [["claude-agent-sdk", "Claude Agent SDK"], ["codex-sdk", "Codex SDK"]] as const) {
    it(`explains that ${runtime} has no reported skill inventory and stays source-owned`, async () => {
      const agent = { ...managed, definition: { ...managed.definition, sdk: { runtime }, skills: ["unrelated-managed-snapshot"] } };
      const page = await open({ agent, hash: settingsHash });
      await until(() => !!page.host.querySelector('[role="region"][aria-label="Agent settings"] h2'));
      const panel = page.host.querySelector<HTMLElement>('[role="region"][aria-label="Agent settings"]')!;
      expect(panel.querySelector("h2")?.textContent).toBe("Skills");
      expect(panel.textContent).toContain(`${label} does not report a skills inventory.`);
      expect(panel.textContent).toContain("Skills are managed in your backend application");
      expect(panel.textContent).not.toContain("unrelated-managed-snapshot");
      expect(panel.querySelector("input, textarea")).toBeNull();
      expect(button(page.host, "Add skill")).toBeUndefined();
      expect(button(page.host, "Save revision")).toBeUndefined();
      expect(button(page.host, "Choose coding agent for Edit agent")).toBeTruthy();
      expect(page.reads.some(path => path.endsWith("/skills"))).toBe(false);
      expect(page.writes).toEqual([]);
    });
  }
});
