import { validateWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import { LEARNING_ID, RUN_ID } from "./layout.js";
import { NO_TOOL_LIST } from "./tools.js";

type Head = { fields: Map<string, string>; nested: Map<string, Map<string, string>>; body: string };

/** `---` front matter of `key: value` lines, one level of two-space nesting, a `#` after a space starting a comment.
 *  A string is the reason it is out of shape. */
function frontMatter(text: string): Head | string {
  if (!text.startsWith("---\n")) return "it does not start with front matter";
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return "its front matter is not closed";
  const fields = new Map<string, string>();
  const nested = new Map<string, Map<string, string>>();
  let parent: string | undefined;
  for (const raw of text.slice(4, end).split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "") continue;
    const inner = line.startsWith("  ");
    const match = /^([A-Za-z_]+):(?: (.*))?$/.exec(inner ? line.slice(2) : line);
    if (!match) return `the front matter line ${JSON.stringify(raw.slice(0, 40))} is not "key: value"`;
    const [, key, value = ""] = match as unknown as [string, string, string | undefined];
    const into = inner ? (parent === undefined ? undefined : nested.get(parent)) : fields;
    if (!into) return `${key} is nested under nothing`;
    if (into.has(key)) return `${inner ? `${parent}.` : ""}${key} appears twice`;
    into.set(key, value.trim());
    if (!inner) {
      parent = value.trim() === "" ? key : undefined;
      if (parent !== undefined) nested.set(key, new Map());
    }
  }
  return { fields, nested, body: text.slice(end + 5) };
}

/** `[a, b]`, items bare or in double quotes; undefined when it is not a list. */
function list(value: string | undefined): string[] | undefined {
  const match = /^\[(.*)\]$/.exec(value ?? "");
  if (!match) return undefined;
  if (match[1]!.trim() === "") return [];
  const items = match[1]!.split(",").map((item) => item.trim());
  const out: string[] = [];
  for (const item of items) {
    if (/^"[^"\\]*"$/.test(item)) out.push(item.slice(1, -1));
    else if (/^[^\s"'[\]{},]+$/.test(item)) out.push(item);
    else return undefined;
  }
  return out;
}

const unknownKeys = (map: Map<string, string>, known: readonly string[]) => [...map.keys()].filter((key) => !known.includes(key));

const NOTE_KEYS = ["id", "type", "status", "runs", "supersedes", "scope", "provenance", "uses", "supersededBy"];
const PROVENANCE_KEYS = ["runs", "sha", "untrusted", "shaFrom"];
const SCOPE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type Note = { id: string; runs: string[] };

/** A note, or the reasons it is out of shape. */
export function parseNote(text: string): Note | string[] {
  if (text.includes("\r")) return ["it holds a carriage return"];
  const head = frontMatter(text);
  if (typeof head === "string") return [head];
  const { fields, nested } = head;
  const out: string[] = [];
  for (const key of unknownKeys(fields, NOTE_KEYS)) out.push(`unknown key ${key}`);
  for (const key of nested.keys()) if (key !== "provenance") out.push(`${key} holds nested keys`);
  for (const key of ["id", "type", "status", "supersedes"]) if (!fields.has(key)) out.push(`${key} is missing`);
  const id = fields.get("id") ?? "";
  if (fields.has("id") && !LEARNING_ID.test(id)) out.push("id is not L- and 12 lowercase hex digits");
  if (fields.has("type") && !["lesson", "fact", "correction"].includes(fields.get("type")!)) out.push("type is not lesson, fact or correction");
  const status = fields.get("status");
  if (status !== undefined && !["active", "superseded", "archived", "retired"].includes(status)) out.push("status is not active, superseded, archived or retired");
  const provenance = nested.get("provenance");
  if (fields.has("provenance") && !provenance) out.push("provenance holds nested keys");
  if (provenance) {
    for (const key of unknownKeys(provenance, PROVENANCE_KEYS)) out.push(`unknown key provenance.${key}`);
    for (const key of ["runs", "sha", "untrusted"]) if (!provenance.has(key)) out.push(`provenance.${key} is missing`);
    if (provenance.has("sha") && !COMMIT_SHA.test(provenance.get("sha")!)) out.push("provenance.sha is not a commit id");
    if (provenance.has("untrusted") && !["true", "false"].includes(provenance.get("untrusted")!)) out.push("provenance.untrusted is not true or false");
    if (provenance.has("shaFrom") && provenance.get("shaFrom") !== "branch-base") out.push("provenance.shaFrom is not branch-base");
  }
  const runSources = [fields.has("runs") ? ["runs", fields.get("runs")] : undefined, provenance?.has("runs") ? ["provenance.runs", provenance.get("runs")] : undefined].filter((s) => s !== undefined) as [string, string][];
  if (!runSources.length) out.push("runs is missing, at the top or under provenance");
  const runs = new Set<string>();
  for (const [field, value] of runSources) {
    const items = list(value);
    if (!items || items.length === 0 || !items.every((run) => RUN_ID.test(run))) out.push(`${field} is not a list of run ids`);
    else if (new Set(items).size !== items.length) out.push(`${field} repeats a run`);
    else items.forEach((run) => runs.add(run));
  }
  const supersedes = list(fields.get("supersedes"));
  if (fields.has("supersedes") && (!supersedes || !supersedes.every((s) => LEARNING_ID.test(s)))) out.push("supersedes is not a list of note ids");
  if (supersedes?.includes(id)) out.push("a note cannot supersede itself");
  if (fields.has("scope") && !SCOPE.test(fields.get("scope")!)) out.push("scope is not a short lowercase name");
  if (fields.has("uses") && !/^(?:0|[1-9][0-9]{0,15})$/.test(fields.get("uses")!)) out.push("uses is not a whole number");
  if (fields.has("supersededBy")) {
    const by = fields.get("supersededBy")!;
    if (!LEARNING_ID.test(by) || by === id) out.push("supersededBy is not another note's id");
    if (status !== "superseded" && status !== "retired") out.push("only a superseded or retired note names what superseded it");
  }
  if (head.body.trim() === "") out.push("the rule after the front matter is empty");
  return out.length ? out : { id, runs: [...runs] };
}

const MEMO_KEYS = ["run", "base", "harness", "outcome", "cost_usd"];
export const MEMO_SECTIONS = Object.freeze(["What happened", "What I learned", "What could be better", "Proposed changes"]);

export type Memo = { run: string; base: string; proposed: string[] };

/** A memo, or the reasons it is out of shape. */
export function parseMemo(text: string): Memo | string[] {
  const head = frontMatter(text);
  if (typeof head === "string") return [head];
  const { fields, nested } = head;
  const out: string[] = [];
  for (const key of unknownKeys(fields, MEMO_KEYS)) out.push(`unknown key ${key}`);
  for (const key of nested.keys()) out.push(`${key} holds nested keys`);
  for (const key of ["run", "base", "outcome"]) if (!fields.get(key)) out.push(`${key} is missing`);
  const run = fields.get("run") ?? "";
  const base = fields.get("base") ?? "";
  if (run && !RUN_ID.test(run)) out.push("run is not a run id");
  if (base && !/^[0-9a-f]{12,64}$/.test(base)) out.push("base is not a commit id, in full or its first 12 digits or more");
  if (fields.get("outcome") && !["completed", "failed", "stopped"].includes(fields.get("outcome")!)) out.push("outcome is not completed, failed or stopped");
  if (fields.has("harness") && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(fields.get("harness")!)) out.push("harness is not a short lowercase name");
  if (fields.has("cost_usd") && !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(fields.get("cost_usd")!)) out.push("cost_usd is not a number of dollars, 0 or more");
  const sections: { title: string; lines: string[] }[] = [];
  const lead: string[] = [];
  for (const line of head.body.split("\n")) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1]!, lines: [] });
    else (sections.at(-1)?.lines ?? lead).push(line);
  }
  if (lead.some((line) => line.trim() !== "")) out.push("text comes before the first section");
  const titles = sections.map((section) => section.title);
  if (titles.join("\n") !== MEMO_SECTIONS.join("\n")) out.push(`the sections are not ${MEMO_SECTIONS.map((title) => `"## ${title}"`).join(", ")}, each once, in that order`);
  else if (sections[0]!.lines.every((line) => line.trim() === "")) out.push("What happened is empty");
  if (out.length) return out;
  const proposed = sections[3]!.lines.map((line) => /^\s*[-*]\s+`?([^\s`]+)`?/.exec(line)?.[1]).filter((path): path is string => path !== undefined);
  return { run, base, proposed };
}

/** The note ids `learnings/INDEX.md` names, or the reasons it is out of shape. */
export function parseIndex(text: string): string[] | { problems: string[] } {
  const ids: string[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((line, at) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    const match = /^- (L-[0-9a-f]{12}): \S/.exec(line);
    if (!match) problems.push(`line ${at + 1} is not "- L-<12 hex>: <the rule in one line>"`);
    else if (ids.includes(match[1]!)) problems.push(`line ${at + 1} names ${match[1]} again`);
    else ids.push(match[1]!);
  });
  return problems.length ? { problems } : ids;
}

/** Why a `SKILL.md` for the skill `name` is out of shape; empty when it is not. */
export function skillProblems(text: string, name: string): string[] {
  if (!text.startsWith("---\n")) return ["it does not start with front matter"];
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return ["its front matter is not closed"];
  const lines = text.slice(4, end).split("\n");
  const value = (key: string): string | undefined => {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const own = lines[at]!.slice(key.length + 1).trim();
    const more = [];
    for (const line of lines.slice(at + 1)) if (/^\s+\S/.test(line)) more.push(line.trim()); else break;
    return (/^[>|][-+]?$/.test(own) ? more.join(" ") : own).replace(/^(["'])(.*)\1$/, "$2").trim();
  };
  const out: string[] = [];
  if (value("name") !== name) out.push(`name is not the folder's name, ${name}`);
  if (!value("description")) out.push("description is missing or empty");
  return out;
}

export type DraftProblem = { rule: "workflow" | "no_tool_list"; detail: string };

const issuesOf = (doc: unknown, tools?: readonly string[]) => {
  const valid = validateWorkflow(doc as Workflow, { executeCode: false, ...(tools ? { tools } : {}) });
  return valid.ok ? [] : valid.issues;
};

/** Why `workflows/<name>/workflow.json` is not a draft every harness can run; empty when it is. The DSL's own
 *  `validateWorkflow` judges it, with `executeCode: false` so no code it holds is run (a code node is syntax-checked) and
 *  with the host's `tools`, so a node that names a tool outside them is its error. With no list it fails closed: a draft
 *  the DSL refuses only once given an empty list names a tool. */
export function draftProblems(text: string, name: string, tools?: readonly string[]): DraftProblem[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ rule: "workflow", detail: "it does not parse as JSON" }];
  }
  const issues = issuesOf(doc, tools);
  if (issues.length) return issues.slice(0, 5).map((issue) => ({ rule: "workflow", detail: `the workflow DSL refuses it: ${issue.code} at ${issue.path || "/"}: ${issue.message.slice(0, 200)}` }));
  if (!tools && issuesOf(doc, []).length) return [{ rule: "no_tool_list", detail: NO_TOOL_LIST }];
  return (doc as { name?: unknown }).name === name ? [] : [{ rule: "workflow", detail: `its name is not the folder's name, ${name}` }];
}
