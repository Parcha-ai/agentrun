import { dollars } from "./format";
import type { Client, FieldIssue } from "./client";
import { type FieldSpec, fieldValues, schemaFields } from "./inputForm";
import { MCP_URL_PRESETS, type McpServer } from "./mcp";
import { browserZone } from "./schedules";
import type { TemplateApply, TemplateView } from "./v2";

// The server's templates (GET /v2/templates), as the Templates page reads them. (lib/templates.ts is Mission Control's
// first-run starters, made in the console; these are the server's.)

/** A template's title: its display name, else its name. A display name's `${parameters.<name>}` (filled by the server at
 *  apply) reads as the value typed for it so far (`values`), else "…": never as the raw placeholder. */
export const titleOf = (t: TemplateView, values: ParameterText = {}) =>
  (t.display_name || t.name).replace(/\$\{parameters\.([A-Za-z0-9_]+)\}/g, (_, key: string) => (Object.hasOwn(values, key) ? linesOf(values[key]).join(", ") : "") || "…");

/** The Suggested page's scanner (serve's SCOUT_TEMPLATE): shipped so a scan can run it, not a template to start from, and
 *  not on the marketplace. The catalog (the Templates and Build pages) leaves it out so it lists what the marketplace
 *  lists; the API playground, which lists what an apply takes, keeps it. */
export const SCOUT_TEMPLATE = "agent-scout";
export const inCatalog = (t: Pick<TemplateView, "bundled" | "name">): boolean => !(t.bundled && t.name === SCOUT_TEMPLATE);

/** A catalog card's title, as the marketplace's card reads it: a display name up to its first parameter, cut at the ":" or
 *  "(" before it ("Code review: ${parameters.owner}/…" is "Code review"). One that starts with a parameter reads as
 *  `titleOf`. The template's own page fills the parameters in. */
export function cardTitleOf(t: TemplateView): string {
  const name = t.display_name || t.name;
  const at = name.indexOf("${");
  if (at < 0) return name.trim();
  return /^(.*?\S)\s*[:(]/.exec(name.slice(0, at))?.[1] ?? titleOf(t);
}

/** A template's Apply screen. */
export const templateHash = (id: string) => `#/templates/${encodeURIComponent(id)}`;

/** Only the selected setup request travels in the fragment. Secrets are resolved by name on the server. */
export function templatePlaygroundHref(t: TemplateView, body?: TemplateApply): string {
  return `#/playground?${new URLSearchParams({ operation: "apply-template", template: t.id,
    ...(body ? { draft: JSON.stringify({ template: t.id, version: t.version, ...(t.sha ? { sha: t.sha } : {}), body }) } : {}) })}`;
}

/** Reject stale or malformed prepared requests rather than silently applying different choices. */
export function readTemplateDraft(raw: string | undefined, t: TemplateView): { body?: TemplateApply; error?: string } {
  if (raw === undefined) return {};
  const invalid = { error: "This prepared template request is invalid. Open a fresh request to review its settings." };
  try {
    const draft = JSON.parse(raw);
    const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
    if (!object(draft) || draft.template !== t.id || typeof draft.version !== "string") return invalid;
    if (draft.version !== t.version) return { error: "This template's version changed. Open a fresh request to review the current package before applying." };
    if (t.sha && draft.sha !== t.sha) return { error: "This template's commit changed. Open a fresh request to review the current package before applying." };
    const b = draft.body;
    const scalar = (type: unknown, value: unknown) => type === "boolean" ? typeof value === "boolean"
      : type === "string" ? typeof value === "string"
      : (type === "number" || type === "integer") && typeof value === "number" && Number.isFinite(value);
    if (!object(b) || Object.keys(b).some((k) => !["parameters", "grants", "servers", "overrides"].includes(k))
      || !object(b.parameters)
      || (b.grants !== undefined && (!Array.isArray(b.grants) || b.grants.some((g) => typeof g !== "string" || !t.mcp.some((m) => m.tools.some((tool) => tool.tool === g)))))
      || (b.servers !== undefined && (!object(b.servers) || Object.entries(b.servers).some(([toolkit, name]) => !t.mcp.some((m) => m.toolkit === toolkit) || typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name))))
      || !object(b.overrides) || Object.keys(b.overrides).some((k) => k !== "approvals" && k !== "choice" && k !== "model") || (b.overrides.approvals !== "ask" && b.overrides.approvals !== "never")
      // The agent's model (the Free shelf's Use free) takes the package's place, so it never comes with a choice.
      || (b.overrides.model !== undefined && (typeof b.overrides.model !== "string" || !/^[^\s\p{Cc}]{1,200}$/u.test(b.overrides.model) || b.overrides.choice !== undefined))
      || (b.overrides.choice !== undefined && (typeof b.overrides.choice !== "string" || !t.model?.choices?.map((choice) => choice.id).includes(b.overrides.choice)))) return invalid;
    const fields = schemaFields(t.parameters);
    if (!fields) return invalid;
    const byName = new Map(fields);
    const parameters: [string, unknown][] = [];
    for (const [key, value] of Object.entries(b.parameters)) {
      const field = byName.get(key);
      // Validate the allowlist before omitting a blank: unknown blank keys are still invalid.
      if (!field) return invalid;
      if (value === "") continue;
      if (field.array ? !Array.isArray(value) || !value.every((item) => scalar(field.type, item)) : !scalar(field.type, value)) return invalid;
      const text = Array.isArray(value) ? value.map(String).join("\n") : String(value);
      // A restored choice must survive the shared field conversion without silently changing its type or items.
      const restored = fieldValues({ fields: [[key, field]], contentRequired: false }, { [key]: text })[key];
      if (JSON.stringify(restored) !== JSON.stringify(value)) return invalid;
      parameters.push([key, value]);
    }
    return { body: { ...b, parameters: Object.fromEntries(parameters) } as TemplateApply };
  } catch { return invalid; }
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What a template needs and makes, in words, by line: its keys by name, its triggers, its budget a run, the harness and
 *  model it runs on. Its MCP servers are no line here: a card shows them as icons (ToolkitIcons), the Apply screen as
 *  rows of their own. `secrets` false leaves the keys out (the Apply screen shows them as their own rows too). */
export function needsOf(t: TemplateView, { secrets = true } = {}): [string, string][] {
  const out: [string, string][] = [];
  if (secrets && t.secrets.length) out.push(["Keys", t.secrets.join(", ")]);
  if (t.triggers.length) out.push(["Triggers", count(t.triggers.length, "trigger")]);
  if (t.budget?.per_run_usd) out.push(["Budget", `${dollars(t.budget.per_run_usd)} a run`]);
  // A dollar cap can't stop a free model, so the package may cap its requests (the server's limit still holds).
  if (t.budget?.max_requests) out.push(["Free-model requests", `at most ${t.budget.max_requests} a run`]);
  // A workflow package's agent is its workflow: each step runs on this server's model for its tier, so it names no model.
  if (t.workflow) out.push(["Workflow", `${t.workflow}, each step on this server's model for its tier`]);
  if (t.harness?.length) out.push(["Harness", t.harness.join(", ")]);
  if (t.model) out.push(["Model", `${t.model.tier}${t.model.prefer ? `, ${t.model.prefer} first` : ""}`]);
  return out;
}

/** The values a parameter takes, as the form's text: its `enum` (the server's closed set), else a pattern that is a plain
 *  anchored alternation of words (`^(crm|slack|none)$`). The form offers those as a choice; a number's choice is sent
 *  as a number. A boolean keeps its checkbox, and a list its lines (each line is held to the choices).
 *  Any other pattern is the server's to check, and is never shown. */
export function choicesOf(p: FieldSpec): string[] | null {
  if (p.type === "boolean" || p.array) return null;
  if (p.enum?.length) return p.enum.map(String);
  // Letters, digits, _ and - only: a "." (any character to the server) or anything else is no fixed list.
  const m = p.pattern ? /^\^\(([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+)\)\$$/.exec(p.pattern) : null;
  return m ? m[1].split("|") : null;
}

/** The parameters form's text, by parameter name ("true"/"false" for a boolean). */
export type ParameterText = Record<string, string>;

/** A form of fields as it opens (a template's parameters, an agent's typed input): each boolean at its default
 *  ("true"/"false"), unticked with none; a `format: timezone` one at the browser's zone and a `format: cron` one at its
 *  default; other text and numbers empty (their default is shown as a hint). */
export function startText(fields: Record<string, FieldSpec>): ParameterText {
  return Object.fromEntries(Object.entries(fields).flatMap(([key, p]): [string, string][] => {
    if (p.array) return [];
    if (p.type === "boolean") return typeof p.default === "boolean" ? [[key, String(p.default)]] : [];
    // A schedule's zone starts at the browser's own, as a new schedule on the Triggers page does; its cron line at the
    // package's default, shown in words. One with its own list of choices starts at none of them: the owner picks.
    if (choicesOf(p)) return [];
    if (p.format === "timezone") return [[key, browserZone()]];
    if (p.format === "cron") return typeof p.default === "string" ? [[key, p.default]] : [];
    return [];
  }));
}

type McpNeed = TemplateView["mcp"][number];
/** The saved servers a template's MCP need matches, by name: those whose source and toolkit are the need's. Mirrors the
 *  server's mapping, for display: the apply maps them itself. */
export const matchesOf = (need: McpNeed, saved: readonly Pick<McpServer, "name" | "source" | "toolkit">[]): string[] =>
  saved.filter((s) => s.source === need.source && s.toolkit === need.toolkit).map((s) => s.name).sort();
/** Where a need not set up here is set up (Settings → MCP servers, its add form filled): the Composio preset with the
 *  toolkit and its actions, GitHub's server on the GitHub App, or a server under the toolkit's name, with the URL preset
 *  whose toolkit it is (MCP_URL_PRESETS: github is GitHub (token)) filled when there is one. */
export function setUpHref(need: McpNeed): string {
  const toolkit = encodeURIComponent(need.toolkit);
  if (need.source === "composio") return `#/settings/mcp?add=${toolkit}&preset=composio&toolkit=${toolkit}&tools=${need.tools.map((x) => encodeURIComponent(x.name)).join(",")}`;
  if (need.source === "github") return "#/settings/mcp?add=github&auth=github_app";
  const preset = MCP_URL_PRESETS.find((p) => p.name === need.toolkit);
  return `#/settings/mcp?add=${toolkit}${preset ? `&preset=${preset.id}` : ""}`;
}

/** A template whose setup is only its parameters: no MCP tool to tick, no server to pick, no key to save. The console
 *  applies one itself (Apply is its main action); one with more to set up is run with a coding agent. */
export const isPlain = (t: Pick<TemplateView, "mcp" | "secrets">) => t.mcp.length === 0 && t.secrets.length === 0;

/** Something the server checks at apply that the Apply screen reads first, so Apply waits for it instead of being refused:
 *  whether a template needs it, how it is read, and what the screen says while it is unmet. A new one is one more entry in
 *  APPLY_REQUIREMENTS. */
export type ApplyRequirement = {
  id: string;
  /** What is read, as "the …": the screen says it couldn't be read, or that it is being read. */
  what: string;
  needs: (t: TemplateView) => boolean;
  /** Resolves true when it is met; a failed read rejects. */
  met: (v2: Client) => Promise<boolean>;
  /** The line beside Apply while it is unmet: its words around one link to where it is set up. */
  unmet: { before: string; link: string; href: string; after: string };
};

const kindOf = (trigger: Record<string, unknown>) => {
  const source = trigger.source;
  return typeof source === "object" && source !== null && "kind" in source ? source.kind : undefined;
};

export const APPLY_REQUIREMENTS: readonly ApplyRequirement[] = [
  // An email tool or an email trigger reads the server's one mail account (Settings → Email): the apply refuses one
  // with none saved.
  {
    id: "email",
    what: "the email account",
    needs: (t) => (t.tools ?? []).some((tool) => tool.startsWith("email_")) || t.triggers.some((x) => kindOf(x) === "email"),
    met: async (v2) => (await v2.emailAccount()).configured,
    unmet: { before: "Connect your mailbox under ", link: "Settings → Email", href: "#/settings/email", after: " first." },
  },
];

/** The gate names the owner ticked, in the template's order: the consent an apply sends (`grants`), nothing else. */
export const grantsOf = (t: TemplateView, ticked: ReadonlySet<string>) => t.mcp.flatMap((m) => m.tools.map((x) => x.tool)).filter((g) => ticked.has(g));

/** A refusal's issues at one field. */
export const issuesAt = (issues: readonly FieldIssue[], field: string) => issues.filter((i) => i.field === field);

/** A parameter, or any field drawn the same way (an agent's typed input field, lib/inputForm.ts). */
type Parameter = FieldSpec;

/** The help under a parameter's label: its own words. A cron line's and a zone's description opens by saying the format
 *  ("when the digest runs, as a cron line (minute hour …): …", "the IANA time zone … (Europe/Madrid, …): …"), which their
 *  pickers say in words, so only what follows that opening's colon is kept ("Monday 08:00 unless you set it; set
 *  lookback_days to its gap"), and nothing when it has none. Any other parameter's description is kept whole. */
export function paramHelp(p: Parameter): string | undefined {
  if (p.type !== "string" || (p.format !== "cron" && p.format !== "timezone") || !p.description) return p.description;
  // A time zone needs no help: the picker names the zone, and the form always sends one (the browser's to start), so a
  // template's "UTC unless you set it" never applies here.
  if (p.format === "timezone") return undefined;
  const colon = p.description.indexOf(": ");
  return colon < 0 ? undefined : p.description.slice(colon + 2).trim() || undefined;
}

/** A field's choices as its picker lists them, each value once: an empty option ("Choose one" when it is required, else
 *  "None chosen"), which sends nothing, then each choice by its own value, its default named as such. */
export function choiceOptions(p: Parameter): { value: string; label: string }[] | null {
  const choices = choicesOf(p);
  if (!choices) return null;
  const fallback = p.default === undefined ? undefined : String(p.default);
  return [{ value: "", label: p.required ? "Choose one" : "None chosen" }, ...choices.map((c) => ({ value: c, label: c === fallback ? `${c} (default)` : c }))];
}

/** What a form says of a refused field: from the served issue's `reason` and the field's label, never the server's
 *  words, which name the raw path ("parameters.risk_appetite is required"). A reason with no words here (or a field the
 *  form doesn't have) keeps the server's. */
export function paramIssueWords(issue: FieldIssue, key: string, p: Parameter | undefined, label = key): string {
  if (!p) return issue.message;
  switch (issue.reason) {
    case "missing": return `${label} is required.`;
    case "wrong_type": return p.array ? `${label} takes a list, one item a line.` : `${label} takes ${p.type === "integer" ? "a whole number" : p.type === "number" ? "a number" : p.type === "boolean" ? "yes or no" : "text"}.`;
    case "not_an_option": return `${label} takes one of: ${allowedOf(p).join(", ")}.`;
    case "bad_format": return `${label} isn't in the form its description asks for.`;
    default: return issue.message;
  }
}

/** The values a parameter takes, as its refusal names them: its served `enum` when it has one (a boolean's too, which
 *  renders as a box, not a picker), else the choices its picker lists. */
const allowedOf = (p: Parameter): string[] => (p.enum?.length ? p.enum.map(String) : choicesOf(p) ?? []);

/** Whether a parameter's value, as typed or picked, is one the server takes: an issue at it goes once it is. Empty is
 *  valid only when the parameter isn't required; a choice is one of its choices; a number is judged as the number Apply
 *  sends (Number(text)), so "3.0" and "1e2" are whole and 2^53 is not a safe one; a boolean is one its
 *  enum allows; text matches its pattern. A field's bounds (minimum, maximum, minLength, maxLength) hold too, and a list
 *  is judged a line at a time. The server checks again on Apply. */
export function paramValid(p: Parameter, text: string): boolean {
  if (p.array) {
    const items = linesOf(text);
    return items.length ? items.every((item) => paramValid({ ...p, array: false, required: true }, item)) : !p.required;
  }
  if (text === "") return !p.required;
  const choices = choicesOf(p);
  if (choices) return choices.includes(text);
  const n = Number(text);
  const inBounds = (p.minimum === undefined || n >= p.minimum) && (p.maximum === undefined || n <= p.maximum);
  if (p.type === "integer") return text.trim() !== "" && Number.isSafeInteger(n) && inBounds;
  if (p.type === "number") return text.trim() !== "" && Number.isFinite(n) && inBounds;
  if (p.type === "boolean") return (text === "true" || text === "false") && (!p.enum?.length || allowedOf(p).includes(text));
  // A length is in characters as JSON Schema counts them (code points), not UTF-16 units.
  const length = [...text].length;
  if ((p.minLength !== undefined && length < p.minLength) || (p.maxLength !== undefined && length > p.maxLength)) return false;
  if (p.pattern) { try { return new RegExp(p.pattern, "u").test(text); } catch { return true; } }
  return true;
}

/** A list field's items as typed, one a line: each trimmed, a blank line none. */
export const linesOf = (text: string | undefined): string[] => (text ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
