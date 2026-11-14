import { dollars } from "./format";
import type { FieldIssue } from "./client";
import type { FieldSpec } from "./inputForm";
import { type McpServer, SOURCE_LABEL } from "./mcp";
import { browserZone } from "./schedules";
import type { TemplateView } from "./v2";

// The server's templates (GET /v2/templates), as the Templates page reads them. (lib/templates.ts is Mission Control's
// first-run starters, made in the console; these are the server's.)

/** A template's title: its display name, else its name. A display name's `${parameters.<name>}` (filled by the server at
 *  apply) reads as the value typed for it so far (`values`), else "…": never as the raw placeholder. */
export const titleOf = (t: TemplateView, values: ParameterText = {}) =>
  (t.display_name || t.name).replace(/\$\{parameters\.([A-Za-z0-9_]+)\}/g, (_, key: string) => (Object.hasOwn(values, key) ? values[key].trim() : "") || "…");
/** A template's Apply screen. */
export const templateHash = (name: string) => `#/templates/${encodeURIComponent(name)}`;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What a template needs and makes, in words, by line: its keys by name, its MCP servers (required or optional), its
 *  triggers, its budget a run, the harness and model it runs on. `secrets` / `mcp` false leave those lines out (the Apply
 *  screen shows them as their own rows). */
export function needsOf(t: TemplateView, { secrets = true, mcp = true } = {}): [string, string][] {
  const out: [string, string][] = [];
  if (secrets && t.secrets.length) out.push(["Keys", t.secrets.join(", ")]);
  if (mcp && t.mcp.length) out.push(["MCP", t.mcp.map((m) => `${m.toolkit} (${SOURCE_LABEL[m.source]}${m.required ? "" : ", optional"})`).join(", ")]);
  if (t.triggers.length) out.push(["Triggers", count(t.triggers.length, "trigger")]);
  if (t.budget?.per_run_usd) out.push(["Budget", `${dollars(t.budget.per_run_usd)} a run`]);
  if (t.budget?.tool_calls) out.push(["Tool calls", `${count(t.budget.tool_calls, "call")} a conversation`]);
  if (t.harness?.length) out.push(["Harness", t.harness.join(", ")]);
  if (t.model) out.push(["Model", `${t.model.tier}${t.model.prefer ? `, ${t.model.prefer} first` : ""}`]);
  return out;
}

/** The values a parameter takes, as the form's text: its `enum` (the server's closed set), else a pattern that is a plain
 *  anchored alternation of words (`^(crm|slack|none)$`). The form offers those as a choice; a number's choice is sent
 *  as a number (parametersOf). A boolean keeps its checkbox, and a list its lines (each line is held to the choices).
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

/** The parameters as the template types them: a number or an integer as a number, a string as typed, and a boolean as
 *  its checkbox shows it, always (an untouched box is false, and sent so). A text field left empty is not sent (the
 *  server says when a required one is missing). Text that is no number is sent as typed, for the server to refuse in its
 *  own words. */
export function parametersOf(t: TemplateView, text: ParameterText): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(t.parameters)) {
    const v = text[key];
    if (p.type === "boolean") { out[key] = v === "true"; continue; }
    if (v === undefined || v === "") continue;
    if (p.type === "number" || p.type === "integer") out[key] = Number.isFinite(Number(v)) ? Number(v) : v;
    else out[key] = v;
  }
  return out;
}

/** The parameters form as it opens: each boolean at its served default ("true"/"false"), unticked with none; a
 *  `format: timezone` one at the browser's zone and a `format: cron` one at its default; other text and numbers empty
 *  (their default is shown as a hint, and the server applies it when the field is left out). */
export const startValues = (t: TemplateView): ParameterText => startText(t.parameters);

/** Any form of fields as it opens, as startValues says it: an agent's typed input starts the same way. */
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
 *  toolkit and its actions, GitHub's server on the GitHub App, or a server under the toolkit's name. */
export function setUpHref(need: McpNeed): string {
  const toolkit = encodeURIComponent(need.toolkit);
  if (need.source === "composio") return `#/settings/mcp?add=${toolkit}&preset=composio&toolkit=${toolkit}&tools=${need.tools.map((x) => encodeURIComponent(x.name)).join(",")}`;
  return need.source === "github" ? "#/settings/mcp?add=github&auth=github_app" : `#/settings/mcp?add=${toolkit}`;
}

/** The gate names the owner ticked, in the template's order: the consent an apply sends (`grants`), nothing else. */
export const grantsOf = (t: TemplateView, ticked: ReadonlySet<string>) => t.mcp.flatMap((m) => m.tools.map((x) => x.tool)).filter((g) => ticked.has(g));

/** A refusal's issues at one field. */
export const issuesAt = (issues: readonly FieldIssue[], field: string) => issues.filter((i) => i.field === field);

/** A parameter, or any field drawn the same way (an agent's typed input field, lib/inputForm.ts). */
type Parameter = FieldSpec;
/** A parameter's label, as the Apply form shows it: the template serves no display label, so its key, except for a format
 *  the form picks in words: a cron line is "Schedule" and a zone "Time zone", never CRON or TIMEZONE. */
export const paramLabel = (key: string, p?: Parameter): string =>
  p?.type === "string" && p.format === "cron" ? "Schedule" : p?.type === "string" && p.format === "timezone" ? "Time zone" : key;

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

/** A parameter's choices as the Apply form's picker lists them, each value once. Its empty option is left out of the
 *  apply, so the server applies the default: an optional parameter's default is that option, marked on its own entry in
 *  the list's order ("none (default)"), never a second "none". A required parameter opens with "Choose one"; an optional
 *  one whose default is not among its choices (or that has none) opens with its default's words or "None chosen".
 *  `sent`: a run's typed input field, whose empty option sends nothing at all: each choice keeps its own value. */
export function choiceOptions(p: Parameter, { sent = false }: { sent?: boolean } = {}): { value: string; label: string }[] | null {
  const choices = choicesOf(p);
  if (!choices) return null;
  const fallback = p.default === undefined ? undefined : String(p.default);
  // A run's typed input: nothing fills in a field left out, so its default is offered by its own value, named as such.
  if (sent) return [{ value: "", label: p.required ? "Choose one" : "None chosen" }, ...choices.map((c) => ({ value: c, label: c === fallback ? `${c} (default)` : c }))];
  const own = !p.required && fallback !== undefined && choices.includes(fallback);
  const head = own ? [] : [{ value: "", label: p.required ? "Choose one" : fallback !== undefined ? `${fallback} (default)` : "None chosen" }];
  return [...head, ...choices.map((c) => (own && c === fallback ? { value: "", label: `${c} (default)` } : { value: c, label: c }))];
}

/** What the Apply form says of a refused parameter: from the served issue's `reason` and the field's label, never the
 *  server's words, which name the raw path ("parameters.risk_appetite is required: …"). A reason with no words here (or
 *  a parameter the template doesn't have) keeps the server's. */
export function paramIssueWords(issue: FieldIssue, key: string, p: Parameter | undefined, label = paramLabel(key, p)): string {
  if (!p) return issue.message;
  switch (issue.reason) {
    case "missing": return `${label} is required.`;
    case "wrong_type": return `${label} takes ${p.type === "integer" ? "a whole number" : p.type === "number" ? "a number" : p.type === "boolean" ? "yes or no" : "text"}.`;
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
 *  sends (parametersOf: Number(text)), so "3.0" and "1e2" are whole and 2^53 is not a safe one; a boolean is one its
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
