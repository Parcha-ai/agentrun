import { dollars } from "./format";
import type { FieldIssue } from "./client";
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
  if (mcp && t.mcp.length) out.push(["MCP", t.mcp.map((m) => `${m.server}${m.required ? "" : " (optional)"}`).join(", ")]);
  if (t.triggers.length) out.push(["Triggers", count(t.triggers.length, "trigger")]);
  if (t.budget) out.push(["Budget", `${dollars(t.budget.per_run_usd)} a run`]);
  if (t.harness?.length) out.push(["Harness", t.harness.join(", ")]);
  if (t.model) out.push(["Model", `${t.model.tier}${t.model.prefer ? `, ${t.model.prefer} first` : ""}`]);
  return out;
}

/** The values a parameter takes, as the form's text: its `enum` (the server's closed set), else a pattern that is a plain
 *  anchored alternation of words (`^(crm|slack|none)$`). The form offers those as a choice; a number's choice is sent
 *  as a number (parametersOf). A boolean keeps its checkbox. Any other pattern is the server's to check, and is never
 *  shown. */
export function choicesOf(p: TemplateView["parameters"][string]): string[] | null {
  if (p.type === "boolean") return null;
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

/** The parameters form as it opens: each boolean at its served default ("true"/"false"), unticked with none; text and
 *  numbers empty (their default is shown as a hint, and the server applies it when the field is left out). */
export function startValues(t: TemplateView): ParameterText {
  return Object.fromEntries(Object.entries(t.parameters).flatMap(([key, p]) => (p.type === "boolean" && typeof p.default === "boolean" ? [[key, String(p.default)]] : [])));
}

/** The gate names the owner ticked, in the template's order: the consent an apply sends (`grants`), nothing else. */
export const grantsOf = (t: TemplateView, ticked: ReadonlySet<string>) => t.mcp.flatMap((m) => m.tools.map((x) => x.tool)).filter((g) => ticked.has(g));

/** A refusal's issues at one field. */
export const issuesAt = (issues: readonly FieldIssue[], field: string) => issues.filter((i) => i.field === field);

type Parameter = TemplateView["parameters"][string];
/** A parameter's label, as the Apply form shows it: the template serves no display label, so its key. */
export const paramLabel = (key: string): string => key;

/** What the Apply form says of a refused parameter: from the served issue's `reason` and the field's label, never the
 *  server's words, which name the raw path ("parameters.risk_appetite is required: …"). A reason with no words here (or
 *  a parameter the template doesn't have) keeps the server's. */
export function paramIssueWords(issue: FieldIssue, key: string, p: Parameter | undefined): string {
  const label = paramLabel(key);
  if (!p) return issue.message;
  switch (issue.reason) {
    case "missing": return `${label} is required.`;
    case "wrong_type": return `${label} takes ${p.type === "integer" ? "a whole number" : p.type === "number" ? "a number" : p.type === "boolean" ? "yes or no" : "text"}.`;
    case "not_an_option": return `${label} takes one of: ${(choicesOf(p) ?? []).join(", ")}.`;
    case "bad_format": return `${label} isn't in the form its description asks for.`;
    default: return issue.message;
  }
}

/** Whether a parameter's value, as typed or picked, is one the server takes: an issue at it goes once it is. Empty is
 *  valid only when the parameter isn't required; a choice is one of its choices; a number parses (an integer whole);
 *  text matches its pattern. The server checks again on Apply. */
export function paramValid(p: Parameter, text: string): boolean {
  if (text === "") return !p.required;
  const choices = choicesOf(p);
  if (choices) return choices.includes(text);
  if (p.type === "integer") return /^-?\d+$/.test(text.trim());
  if (p.type === "number") return text.trim() !== "" && Number.isFinite(Number(text));
  if (p.type === "boolean") return text === "true" || text === "false";
  if (p.pattern) { try { return new RegExp(p.pattern, "u").test(text); } catch { return true; } }
  return true;
}
