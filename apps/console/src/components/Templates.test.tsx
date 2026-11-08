import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { route } from "@/App";
import { TemplatesPage } from "./Templates";
import { ClientError } from "@/lib/client";
import type { TemplateView } from "@/lib/v2";

// The server's templates (GET /v2/templates) and applying one (POST /v2/templates/{name}/apply): the list says what each
// needs; the Apply screen takes its parameters and the owner's consent, one tick per MCP tool, none ticked until the owner
// ticks it. Refusals are the server's words at their fields; a made agent opens, or, with warnings, they show first.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const REVIEWER: TemplateView = {
  name: "pr-reviewer", display_name: "PR reviewer", version: "1.0.0", description: "Reviews a pull request and leaves one review.",
  license: "MIT", repository: null, harness: ["claude-agent"], model: { tier: "balanced" }, effort: null, tools: null,
  mcp: [{ server: "github", required: true, tools: [
    { name: "get_pull_request", tool: "mcp:github/get_pull_request", asks: "allow" },
    { name: "create_review", tool: "mcp:github/create_review", asks: "ask" },
  ] }],
  parameters: {
    repo: { type: "string", required: true, description: "The repository, as owner/name", pattern: "^[^/]+/[^/]+$" },
    max_files: { type: "integer", required: false, description: "How many files it reads at most" },
  },
  secrets: ["PARALLEL_API_KEY"], budget: { per_run_usd: 0.5 }, learning: false, triggers: [{ kind: "github", events: ["pull_request"] }], skills: [], evals: [],
};
const NOTES: TemplateView = { ...REVIEWER, name: "meeting-notes", display_name: null, version: "0.2.0", description: "Turns a transcript into notes.", mcp: [], parameters: {}, secrets: [], budget: null, triggers: [] };

type Fake = { apply?: (name: string, body: unknown, key: string) => Promise<unknown>; servers?: string[] };
async function open(name?: string, fake: Fake = {}) {
  const went: string[] = [];
  const sent: { name: string; body: { parameters?: Record<string, unknown>; grants?: string[]; overrides?: Record<string, unknown> }; key: string }[] = [];
  const v2 = {
    listTemplates: async () => ({ templates: [REVIEWER, NOTES] }),
    listMcpServers: async () => ({ servers: (fake.servers ?? ["github"]).map((n) => ({ name: n, url: `https://${n}.example/mcp`, auth: { type: "none" }, tools: [], credential: null })) }),
    applyTemplate: async (n: string, body: never, key: string) => { sent.push({ name: n, body, key }); return (fake.apply ?? (async () => ({ template: n, version: "1.0.0", agent_id: "pr-reviewer-1", trigger_ids: [], warnings: [] })))(n, body, key); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(TemplatesPage, { v2: v2 as never, name, go: (h: string) => went.push(h) })); });
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
  const type = async (el: Element | null, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const tick = (tool: string) => host.querySelector<HTMLInputElement>(`[data-tool="${tool}"] input[type="checkbox"]`);
  return { host, went, sent, button, click, type, tick, settle };
}

describe("the Templates page", () => {
  it("lists each template with its name, version, description and what it needs", async () => {
    const t = await open();
    const cards = [...t.host.querySelectorAll("article")];
    expect(cards).toHaveLength(2);
    const reviewer = cards[0].textContent ?? "";
    expect(reviewer).toContain("PR reviewer");
    expect(reviewer).toContain("1.0.0");
    expect(reviewer).toContain("Reviews a pull request and leaves one review.");
    expect(reviewer).toContain("PARALLEL_API_KEY");
    expect(reviewer).toContain("github");
    expect(reviewer).toContain("1 trigger");
    expect(reviewer).toContain("$0.50 a run");
    // No display name: the template's name.
    expect(cards[1].textContent).toContain("meeting-notes");
    await t.click(cards[0].querySelector("button"));
    expect(t.went).toEqual(["#/templates/pr-reviewer"]);
  });

  it("routes #/templates to the list and #/templates/<name> to its Apply screen", () => {
    expect(route("#/templates")).toEqual({ section: "templates" });
    expect(route("#/templates/pr-reviewer")).toEqual({ section: "templates", template: "pr-reviewer" });
  });
});

describe("applying a template", () => {
  it("asks consent one tool at a time, none ticked until the owner ticks it, and says what an allow means", async () => {
    const t = await open("pr-reviewer");
    for (const tool of ["mcp:github/get_pull_request", "mcp:github/create_review"]) {
      expect(t.tick(tool), tool).toBeTruthy();
      expect(t.tick(tool)!.checked, tool).toBe(false);
    }
    // A tick is always an allow: the server stores every granted tool as permission allow. Each row says so, and says
    // apart what the template asks for; nothing promises an approval before each call.
    const reads = t.host.querySelector('[data-tool="mcp:github/get_pull_request"]')!.textContent ?? "";
    const writes = t.host.querySelector('[data-tool="mcp:github/create_review"]')!.textContent ?? "";
    for (const row of [reads, writes]) expect(row).toContain("Allow: the agent may call this without asking you.");
    expect(reads).toContain("The template asks you to allow this.");
    expect(writes).toContain("The template does not ask for this; unticked, it stays at your setting.");
    expect(t.host.textContent).not.toContain("asks you before each call");
    // The MCP server, set up here or not, and the secrets by name only.
    expect(t.host.querySelector('[data-mcp="github"]')!.textContent).toContain("Set up here");
    expect(t.host.querySelector('[data-secret="PARALLEL_API_KEY"]')!.textContent).toContain("PARALLEL_API_KEY");
  });

  it("sends the parameters as typed and the grants as the ticks, under one Idempotency-Key a retry reuses", async () => {
    let calls = 0;
    const t = await open("pr-reviewer", { apply: async () => { if (calls++ === 0) throw new ClientError(0, "network", "The request did not reach the server."); return { template: "pr-reviewer", version: "1.0.0", agent_id: "pr-reviewer-1", trigger_ids: [], warnings: [] }; } });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.type(t.host.querySelector('[data-field="parameters.max_files"] input'), "3");
    await t.click(t.tick("mcp:github/create_review"));
    await t.click(t.button(/^Apply/));
    expect(t.host.textContent).toContain("The request did not reach the server.");
    await t.click(t.button(/^Apply/));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0].name).toBe("pr-reviewer");
    expect(t.sent[0].body).toEqual({ parameters: { repo: "acme/web", max_files: 3 }, grants: ["mcp:github/create_review"], overrides: { approvals: "ask" } });
    expect(t.sent[0].key).toBeTruthy();
    expect(t.sent[1].key).toBe(t.sent[0].key);
  });

  it("places a 422's issues at their fields: a parameter under its input, a grant at its tool", async () => {
    const refusal = Object.assign(new ClientError(422, "input_invalid", "The template's input is not valid."), { fields: [
      { field: "parameters.repo", reason: "bad_format", message: "repo must look like owner/name." },
      { field: "grants.0", reason: "not_allowed", message: "This tool is not one the template asks for." },
    ] });
    const t = await open("pr-reviewer", { apply: async () => { throw refusal; } });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme");
    await t.click(t.tick("mcp:github/create_review"));
    await t.click(t.button(/^Apply/));
    expect(t.host.querySelector('[data-field="parameters.repo"]')!.textContent).toContain("repo must look like owner/name.");
    expect(t.host.querySelector('[data-tool="mcp:github/create_review"]')!.textContent).toContain("This tool is not one the template asks for.");
    expect(t.went).toEqual([]);
  });

  it("shows a 409's fix at the row it names, and makes nothing", async () => {
    const refusal = Object.assign(new ClientError(409, "agent_not_runnable", "The agent could not run here."), { fields: [
      { field: "secrets.PARALLEL_API_KEY", reason: "not_set_up_here", message: "PARALLEL_API_KEY is not saved on this server.", fix: "Save PARALLEL_API_KEY on the Keys page, then apply again." },
    ] });
    const t = await open("pr-reviewer", { apply: async () => { throw refusal; } });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    const row = t.host.querySelector('[data-secret="PARALLEL_API_KEY"]')!.textContent ?? "";
    expect(row).toContain("PARALLEL_API_KEY is not saved on this server.");
    expect(row).toContain("Save PARALLEL_API_KEY on the Keys page, then apply again.");
    expect(t.went).toEqual([]);
  });

  it("asks by default; Never ask says what it grants and is sent as the agent's approvals", async () => {
    const t = await open("pr-reviewer");
    const radio = (label: RegExp) => [...t.host.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Approvals"] input[type="radio"]')].find((r) => label.test(r.closest("label")?.textContent ?? ""));
    expect(radio(/^Ask me/)!.checked).toBe(true);
    await t.click(radio(/^Never ask/));
    expect(t.host.querySelector('fieldset[aria-label="Approvals"]')!.textContent).toContain("Never ask: every tool this agent has runs without waiting for you. A tool set to deny, and a template's pins, still hold.");
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    expect(t.sent[0].body.overrides).toEqual({ approvals: "never" });
  });

  it("opens the made agent at once when there are no warnings", async () => {
    const t = await open("pr-reviewer");
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    expect(t.went).toEqual(["#/agents/pr-reviewer-1"]);
  });

  it("with warnings, stays to show them in the server's words, with a link to the made agent", async () => {
    const t = await open("pr-reviewer", { apply: async () => ({ template: "pr-reviewer", version: "1.0.0", agent_id: "pr-reviewer-1", trigger_ids: [], warnings: [
      { field: "mcp.github", reason: "not_set_up_here", message: "github is not set up on this server: its tools are left out until it is." },
      { field: "grants.mcp:github/create_review", reason: "not_allowed", message: "The server denies mcp:github/create_review, so it stays denied." },
    ] }) });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    expect(t.went).toEqual([]);
    expect(t.host.textContent).toContain("github is not set up on this server: its tools are left out until it is.");
    expect(t.host.textContent).toContain("The server denies mcp:github/create_review, so it stays denied.");
    const link = [...t.host.querySelectorAll("a")].find((a) => a.textContent?.includes("Open the agent"));
    expect(link?.getAttribute("href")).toBe("#/agents/pr-reviewer-1");
  });
});
