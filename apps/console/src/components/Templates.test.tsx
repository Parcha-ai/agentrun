import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { route } from "@/App";
import { TemplatesPage } from "./Templates";
import { ClientError } from "@/lib/client";
import type { TemplateView } from "@/lib/v2";
import { firstPicker, optionsOf, pick } from "@/test/picker";

// The server's templates (GET /v2/templates) and applying one (POST /v2/templates/{name}/apply): the list says what each
// needs; the Apply screen takes its parameters and the owner's consent, one tick per MCP tool, none ticked until the owner
// ticks it. Refusals are the server's words at their fields; a made agent opens, or, with warnings, they show first.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const REVIEWER: TemplateView = {
  name: "pr-reviewer", display_name: "PR reviewer", version: "1.0.0", description: "Reviews a pull request and leaves one review.",
  license: "MIT", author: null, repository: null, output: null, harness: ["claude-agent"], model: { tier: "balanced" }, effort: null, tools: null,
  mcp: [{ server: "github", required: true, tools: [
    { name: "get_pull_request", tool: "mcp:github/get_pull_request", asks: "allow" },
    { name: "create_review", tool: "mcp:github/create_review", asks: "ask" },
  ] }],
  parameters: {
    repo: { type: "string", required: true, description: "The repository, as owner/name", pattern: "^[^/]+/[^/]+$" },
    max_files: { type: "integer", required: false, description: "How many files it reads at most" },
  },
  secrets: ["PARALLEL_API_KEY"], budget: { per_run_usd: 0.5 }, learning: false, approvals_default: "ask", triggers: [{ kind: "github", events: ["pull_request"] }], skills: [], evals: [],
};
const NOTES: TemplateView = { ...REVIEWER, name: "meeting-notes", display_name: null, version: "0.2.0", description: "Turns a transcript into notes.", mcp: [], parameters: {}, secrets: [], budget: null, triggers: [] };

type Fake = { apply?: (name: string, body: unknown, key: string) => Promise<unknown>; servers?: string[]; templates?: TemplateView[] };
async function open(name?: string, fake: Fake = {}) {
  const went: string[] = [];
  const sent: { name: string; body: { parameters?: Record<string, unknown>; grants?: string[]; overrides?: Record<string, unknown> }; key: string }[] = [];
  const v2 = {
    listTemplates: async () => ({ templates: fake.templates ?? [REVIEWER, NOTES] }),
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

  it("never shows a display name's unfilled ${parameters.x}: the card reads … in its place, and Apply fills it as typed", async () => {
    const CODE: TemplateView = { ...REVIEWER, name: "code-review", display_name: "Code review: ${parameters.repo}" };
    const list = await open(undefined, { templates: [CODE] });
    const card = list.host.querySelector("article")!;
    expect(card.querySelector("h2")!.textContent).toBe("Code review: …");
    expect(card.getAttribute("aria-label")).toBe("Code review: …");
    expect(list.host.textContent).not.toContain("${");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const apply = await open("code-review", { templates: [CODE] });
    const title = () => apply.host.querySelector("h1")!.textContent ?? "";
    expect(title()).toContain("Code review: …");
    await apply.type(apply.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    expect(title()).toContain("Code review: acme/web");
    expect(apply.host.textContent).not.toContain("${");
  });

  it("reads a placeholder named like an object's own property (constructor) as … too, and the list still shows", async () => {
    const ODD: TemplateView = { ...REVIEWER, name: "odd", display_name: "Odd: ${parameters.constructor}", parameters: { constructor: { type: "string" as const, required: true, description: "x" } } };
    const list = await open(undefined, { templates: [ODD, NOTES] });
    expect([...list.host.querySelectorAll("article h2")].map((h) => h.textContent)).toEqual(["Odd: …", "meeting-notes"]);
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

  it("sends a boolean parameter as its checkbox shows it: false untouched, true once ticked", async () => {
    const FLAGGED: TemplateView = { ...REVIEWER, name: "flagged", parameters: { ...REVIEWER.parameters, strict: { type: "boolean", required: true, description: "Fail on any finding" } } };
    const t = await open("flagged", { templates: [FLAGGED] });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    const box = t.host.querySelector<HTMLInputElement>('[data-field="parameters.strict"] input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    await t.click(t.button(/^Apply/));
    expect(t.sent[0].body.parameters).toEqual({ repo: "acme/web", strict: false });
    await t.click(box);
    await t.click(t.button(/^Apply/));
    expect(t.sent[1].body.parameters).toEqual({ repo: "acme/web", strict: true });
  });

  it("starts a boolean with a default at that default, sends it as shown, and shows a text parameter's default as its hint", async () => {
    const DEFAULTED: TemplateView = { ...REVIEWER, name: "defaulted", parameters: { ...REVIEWER.parameters,
      comment: { type: "boolean", required: false, description: "Comment on the pull request", default: true },
      cron: { type: "string", required: false, description: "When it runs", default: "0 8 * * 1" } } };
    const t = await open("defaulted", { templates: [DEFAULTED] });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    expect(t.host.querySelector<HTMLInputElement>('[data-field="parameters.comment"] input[type="checkbox"]')!.checked).toBe(true);
    expect(t.host.querySelector<HTMLInputElement>('[data-field="parameters.cron"] input')!.placeholder).toBe("0 8 * * 1");
    await t.click(t.button(/^Apply/));
    // The boolean as shown (its default); the untouched text left out, for the server to apply its own default.
    expect(t.sent[0].body.parameters).toEqual({ repo: "acme/web", comment: true });
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
    // A parameter's issue in the form's words, by its served reason and the field's label: never its raw path.
    expect(t.host.querySelector('[data-field="parameters.repo"]')!.textContent).toContain("repo isn't in the form its description asks for.");
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

  it("preselects the template's own approvals: Never ask, with what it grants, for one that runs unattended; Ask me for one that asks", async () => {
    const MONITOR: TemplateView = { ...REVIEWER, name: "market-monitor", approvals_default: "never" };
    const radio = (t: Awaited<ReturnType<typeof open>>, label: RegExp) => [...t.host.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Approvals"] input[type="radio"]')].find((r) => label.test(r.closest("label")?.textContent ?? ""));
    const never = await open("market-monitor", { templates: [MONITOR] });
    expect(radio(never, /^Never ask/)!.checked).toBe(true);
    expect(never.host.querySelector('fieldset[aria-label="Approvals"]')!.textContent).toContain("Never ask: every tool this agent has runs without waiting for you.");
    // Switching still sends the choice.
    await never.click(radio(never, /^Ask me/));
    await never.type(never.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await never.click(never.button(/^Apply/));
    expect(never.sent[0].body.overrides).toEqual({ approvals: "ask" });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const asks = await open("pr-reviewer");
    expect(radio(asks, /^Ask me/)!.checked).toBe(true);
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

  it("titles what was applied with the values sent, not edits made while the apply was under way", async () => {
    const CODE: TemplateView = { ...REVIEWER, name: "code-review", display_name: "Code review: ${parameters.repo}" };
    let answer: (v: unknown) => void = () => {};
    const t = await open("code-review", { templates: [CODE], apply: () => new Promise((r) => { answer = r; }) });
    const repo = () => t.host.querySelector('[data-field="parameters.repo"] input');
    await t.type(repo(), "acme/web");
    await act(async () => { t.button(/^Apply/)!.click(); });
    await t.type(repo(), "acme/api");
    await act(async () => { answer({ template: "code-review", version: "1.0.0", agent_id: "cr-1", trigger_ids: [], warnings: [{ field: "mcp.github", reason: "not_set_up_here", message: "github is not set up here." }] }); });
    await t.settle();
    expect(t.host.querySelector('section[aria-label="Applied"] h1')!.textContent).toContain("Code review: acme/web applied");
  });

  it("a webhook trigger the apply made: the server's warning in its words, with a link to that trigger for its signing secret", async () => {
    const LEAD: TemplateView = { ...REVIEWER, name: "inbound-lead", triggers: [{ name: "lead-webhook", source: { kind: "webhook" } }, { name: "weekly", source: { kind: "schedule" } }] };
    const SAYS = "This webhook trigger's signing secret is not in an apply answer. Open its trigger in the console to get it (Rotate).";
    const t = await open("inbound-lead", { templates: [LEAD], apply: async () => ({ template: "inbound-lead", version: "1.0.0", agent_id: "lead-1", trigger_ids: ["trg_hook", "trg_cron"],
      warnings: [{ field: "triggers.0.secret", reason: "not_allowed", message: SAYS }] }) });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    expect(t.went).toEqual([]);
    const made = t.host.querySelector('section[aria-label="Applied"]')!;
    expect(made.textContent).toContain(SAYS);
    const link = [...made.querySelectorAll("a")].find((a) => a.getAttribute("href") === "#/triggers/trg_hook");
    expect(link?.textContent).toBe("Open lead-webhook to get its signing secret (Rotate)");
    // Only the webhook's: the schedule (trg_cron) has no secret and gets no link.
    expect(made.querySelector('a[href="#/triggers/trg_cron"]')).toBeNull();
    // No secret is shown here any more.
    expect(made.textContent).not.toContain("You won't see this secret again.");
  });

  const LEAD_T: TemplateView = { ...REVIEWER, name: "inbound-lead", triggers: [{ name: "lead-webhook", source: { kind: "webhook" } }, { name: "weekly", source: { kind: "schedule" } }] };
  const META = { name: "trigger:trg_hook", set: true, source: "console" as const, changed_at: "2026-11-10T08:00:00Z" };
  const HOOK_WARNING = { field: "triggers.0.secret", reason: "not_allowed" as const, message: "This webhook trigger's signing secret is shown once." };

  it("shows a webhook trigger's signing secret once, beside its hook URL, when the first answer carries it", async () => {
    const SECRET = "CANARY-VALUE-7c2e91d0aa";
    const t = await open("inbound-lead", { templates: [LEAD_T], apply: async () => ({ template: "inbound-lead", version: "1.0.0", agent_id: "lead-1", trigger_ids: ["trg_hook", "trg_cron"],
      warnings: [HOOK_WARNING], webhook_secrets: [{ trigger_id: "trg_hook", secret: META, signing_secret: SECRET }] }) });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    const made = t.host.querySelector('section[aria-label="Applied"]')!;
    const once = made.querySelector('section[aria-label^="The webhook\'s URL and secret"]')!;
    expect(once).toBeTruthy();
    expect(once.textContent).toContain(`${location.origin}/v2/hooks/trg_hook`);
    expect(once.textContent).toContain(SECRET);
    expect(once.textContent).toContain("You won't see this secret again.");
    expect([...once.querySelectorAll("button")].some((b) => /Copy secret/.test(b.textContent ?? ""))).toBe(true);
    // With the secret here, no link sends the person to rotate it.
    expect(made.querySelector('a[href="#/triggers/trg_hook"]')).toBeNull();
  });

  it("without the value (a replay, a token): the item's note in the server's words, and the link to rotate it", async () => {
    const NOTE = "shown once, in this apply's first answer; rotate it in the console to get a new one.";
    const t = await open("inbound-lead", { templates: [LEAD_T], apply: async () => ({ template: "inbound-lead", version: "1.0.0", agent_id: "lead-1", trigger_ids: ["trg_hook", "trg_cron"],
      warnings: [HOOK_WARNING], webhook_secrets: [{ trigger_id: "trg_hook", secret: META, secret_set: true, note: NOTE }] }) });
    await t.type(t.host.querySelector('[data-field="parameters.repo"] input'), "acme/web");
    await t.click(t.button(/^Apply/));
    const made = t.host.querySelector('section[aria-label="Applied"]')!;
    expect(made.textContent).toContain(NOTE);
    expect(made.textContent).not.toContain("You won't see this secret again.");
    expect([...made.querySelectorAll('a[href="#/triggers/trg_hook"]')].map((a) => a.textContent)).toContain("Open lead-webhook to get its signing secret (Rotate)");
  });

  it("offers a parameter whose pattern is a plain alternation as a choice of its values, and never prints a raw pattern", async () => {
    const LEAD: TemplateView = { ...REVIEWER, name: "inbound-lead", parameters: {
      post_to: { type: "string", required: true, description: "where each brief goes", pattern: "^(crm|slack|none)$" },
      slack_channel: { type: "string", required: false, description: "the Slack channel's id", pattern: "^[CG][A-Z0-9]{8,12}$" },
    } };
    const t = await open("inbound-lead", { templates: [LEAD] });
    const field = t.host.querySelector('[data-field="parameters.post_to"]')!;
    const select = firstPicker(field)!;
    expect(select).toBeTruthy();
    expect(field.querySelector('input[type="text"]')).toBeNull();
    expect((await optionsOf(select)).map((o) => o.value).filter(Boolean)).toEqual(["crm", "slack", "none"]);
    // The help says the parameter's own words, never its pattern.
    const section = t.host.querySelector('section[aria-label="Parameters"]')!.textContent ?? "";
    expect(section).not.toContain("^(");
    expect(section).not.toContain("(as ");
    expect(section).not.toContain("[CG]");
    expect(field.textContent).toContain("where each brief goes");
    await pick(select, "slack");
    await t.click(t.button(/^Apply/));
    expect(t.sent[0].body.parameters).toEqual({ post_to: "slack" });
  });

  it("keeps a pattern with a wildcard as a text field, and names an optional choice's default in its empty option", async () => {
    const T: TemplateView = { ...REVIEWER, name: "mixed", parameters: {
      host: { type: "string", required: true, description: "a host", pattern: "^(foo.bar|other)$" },
      post_to: { type: "string", required: false, description: "where it goes", pattern: "^(crm|slack|none)$", default: "crm" },
    } };
    const t = await open("mixed", { templates: [T] });
    // "." matches any character for the server: not a fixed list, so it stays a text field.
    expect(firstPicker(t.host.querySelector('[data-field="parameters.host"]')!)).toBeNull();
    expect(t.host.querySelector('[data-field="parameters.host"] input[type="text"]')).toBeTruthy();
    // Left on its empty option, the server applies the default: the option says so.
    const empty = (await optionsOf(firstPicker(t.host.querySelector('[data-field="parameters.post_to"]')!)!)).find((o) => o.value === "")!;
    expect(empty.text).toBe("crm (default)");
  });

  it("offers a parameter's enum as a choice of its values, sends an integer one as a number, and shows not_an_option under it", async () => {
    const T: TemplateView = { ...REVIEWER, name: "inbound-lead", parameters: {
      post_to: { type: "string", required: true, description: "where each brief goes", enum: ["crm", "slack", "none"] },
      depth: { type: "integer", required: false, description: "how many pages to read", enum: [1, 3, 7], default: 3 },
    } };
    const refusal = Object.assign(new ClientError(422, "input_invalid", "The template's input is not valid."), { fields: [
      { field: "parameters.post_to", reason: "not_an_option", message: "parameters.post_to is one of crm, slack, none: where each brief goes" },
    ] });
    const t = await open("inbound-lead", { templates: [T], apply: async () => { throw refusal; } });
    const post = firstPicker(t.host.querySelector('[data-field="parameters.post_to"]')!)!;
    expect(post).toBeTruthy();
    expect(t.host.querySelector('[data-field="parameters.post_to"] input:not([type="hidden"])')).toBeNull();
    expect((await optionsOf(post)).map((o) => o.value).filter(Boolean)).toEqual(["crm", "slack", "none"]);
    const depth = firstPicker(t.host.querySelector('[data-field="parameters.depth"]')!)!;
    const depths = await optionsOf(depth);
    expect(depths.map((o) => o.value).filter(Boolean)).toEqual(["1", "3", "7"]);
    expect(depths.find((o) => o.value === "")!.text).toBe("3 (default)");
    await pick(post, "slack");
    await pick(depth, "7");
    await t.click(t.button(/^Apply/));
    expect(t.sent[0].body.parameters).toEqual({ post_to: "slack", depth: 7 });
    expect(t.host.querySelector('[data-field="parameters.post_to"]')!.textContent).toContain("parameters.post_to is one of crm, slack, none: where each brief goes");
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
