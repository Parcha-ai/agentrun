import type { TriggerSource } from "./v2";

/** A webhook or GitHub trigger's filter (serve's trigger-accept.ts): its `accept` rules, each an event, the actions it
 *  takes (the body's top-level `action`; any, when it names none), and conditions on the body, each a JSON pointer and
 *  one test. A request fires when any rule takes it. The form holds a rule as typed (RuleDraft) and checks its shape and
 *  the server's limits before it sends; the server stays the judge, and names a refused part by the same field
 *  (`source.accept[i].where[j].pointer`) the form shows its own issues under. */

type HookSource = Extract<TriggerSource, { kind: "webhook" }>;
export type Accept = NonNullable<HookSource["accept"]>[number];
export type Where = NonNullable<Accept["where"]>[number];

/** The server's bounds (trigger-accept.ts's ACCEPT_LIMITS): rules; conditions a rule; actions and `in` values a list; a
 *  pointer's characters; an event's, an action's and a prefix's; each `in` value's as JSON. */
export const ACCEPT_LIMITS = { rules: 20, conditions: 20, list: 20, pointer: 512, text: 200, value: 1024 } as const;
const L = ACCEPT_LIMITS;

/** A condition's test as the form names it: `in` (is one of), `prefix` (starts with), `exists` (exists: true) and
 *  `missing` (exists: false). */
export type Op = "in" | "prefix" | "exists" | "missing";
export const OP_WORDS: Record<Op, string> = { in: "is one of", prefix: "starts with", exists: "exists", missing: "is missing" };
export const OPS = Object.keys(OP_WORDS) as Op[];

/** A condition as typed: its field (a JSON pointer), its test, and its value (`in`: one a line; `prefix`: the text). */
export type ConditionDraft = { key: string; pointer: string; op: Op; value: string };
/** A rule as typed: its event, its actions (names split by commas or spaces) and its conditions. */
export type RuleDraft = { key: string; event: string; actions: string; where: ConditionDraft[] };

let made = 0;
/** A key for a row React keeps across a removal above it. */
const nextKey = () => `r${++made}`;
export const emptyCondition = (): ConditionDraft => ({ key: nextKey(), pointer: "", op: "in", value: "" });
export const emptyRule = (): RuleDraft => ({ key: nextKey(), event: "", actions: "", where: [] });

// An `in` list, a value a line. A line that reads as JSON is that value: a number, true, false, null, a "quoted" string
// (text that would read as one of those, or that keeps spaces at its ends), an {object} or a [list]. Any other line is its
// text, trimmed. The summary (whereWords) and an edited rule write each value back so it reads the same.

/** One line of an `in` list, trimmed, as the value it stands for. */
export function valueOfLine(line: string): unknown {
  const text = line.trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A value as a line of an `in` list: text as it is, unless it would read back as something else (it reads as JSON,
 *  keeps spaces at its ends, is empty, or holds a comma or a line break, which the summary would split), then quoted;
 *  any other value as JSON. */
export function lineOfValue(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  const plain = value !== "" && value === value.trim() && !/[,\r\n]/.test(value) && valueOfLine(value) === value;
  return plain ? value : JSON.stringify(value);
}

/** A condition in words, as the editor names its test: "/title starts with "[agent]"", "/draft is missing", "/label is
 *  one of bug, 42, "42"". */
export const whereWords = (w: Where): string =>
  "in" in w ? `${w.pointer} is one of ${w.in.map(lineOfValue).join(", ")}`
  : "exists" in w ? `${w.pointer} ${w.exists ? "exists" : "is missing"}`
  : `${w.pointer} starts with ${JSON.stringify(w.prefix)}`;

/** One rule: its event, its actions, and its conditions when it has them (`conditions`). */
export const acceptWords = (a: Accept, conditions = true): string =>
  `${a.event}${a.actions?.length ? ` (${a.actions.join(", ")})` : ""}${conditions && a.where?.length ? ` where ${a.where.map(whereWords).join(" and ")}` : ""}`;

/** A condition as the form holds it, to edit. */
export function conditionDraftOf(w: Where): ConditionDraft {
  const key = nextKey();
  if ("in" in w) return { key, pointer: w.pointer, op: "in", value: w.in.map(lineOfValue).join("\n") };
  if ("exists" in w) return { key, pointer: w.pointer, op: w.exists ? "exists" : "missing", value: "" };
  return { key, pointer: w.pointer, op: "prefix", value: w.prefix };
}
/** A rule as the form holds it, to edit. */
export const ruleDraftOf = (a: Accept): RuleDraft => ({ key: nextKey(), event: a.event, actions: (a.actions ?? []).join(", "), where: (a.where ?? []).map(conditionDraftOf) });

/** Names typed in one field, split by commas or spaces. */
export const namesOf = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

const NAME = /^[!-~]+$/;
const chars = (text: string) => [...text].length;
const POINTER = /^(\/([^~]|~[01])*)?$/;
type Issues = Record<string, string>;

/** A rule's conditions as sent, each issue under `at` (`source.accept[i]`) as the server names it. */
function whereOf(drafts: readonly ConditionDraft[], at: string, issues: Issues): Where[] {
  if (drafts.length > L.conditions) issues[`${at}.where`] = `At most ${L.conditions} conditions a rule.`;
  return drafts.map((d, j) => {
    const here = `${at}.where[${j}]`;
    const pointer = d.pointer.trim();
    if (!pointer) issues[`${here}.pointer`] = "Name a field: a JSON pointer such as /title.";
    else if (!pointer.startsWith("/")) issues[`${here}.pointer`] = "A field starts with /: /title, /issue/labels/0/name.";
    else if (!POINTER.test(pointer)) issues[`${here}.pointer`] = "Write ~ in a field's name as ~0, and / in it as ~1.";
    else if (chars(pointer) > L.pointer) issues[`${here}.pointer`] = `At most ${L.pointer} characters.`;
    if (d.op === "exists" || d.op === "missing") return { pointer, exists: d.op === "exists" };
    if (d.op === "prefix") {
      // The server compares the first line trimmed, so blank space before the text could never match.
      const prefix = d.value.trimStart();
      if (!prefix) issues[`${here}.prefix`] = "Give the text it starts with.";
      else if (chars(prefix) > L.text) issues[`${here}.prefix`] = `At most ${L.text} characters.`;
      return { pointer, prefix };
    }
    const values = d.value.split(/\r\n|\r|\n/).filter((line) => line.trim()).map(valueOfLine);
    if (!values.length) issues[`${here}.in`] = "Give at least one value, one a line.";
    else if (values.length > L.list) issues[`${here}.in`] = `At most ${L.list} values.`;
    else if (values.some((v) => chars(JSON.stringify(v)) > L.value)) issues[`${here}.in`] = `Each value is at most ${L.value} characters.`;
    return { pointer, in: values };
  });
}

/** A rule as sent: its event and actions as given (the GitHub picker's) or typed, its conditions; each issue under
 *  `source.accept[index]`. */
export function ruleOf(d: { event: string; actions: string | string[]; where: readonly ConditionDraft[] }, index: number, issues: Issues): Accept {
  const at = `source.accept[${index}]`;
  const event = d.event.trim();
  if (!event) issues[`${at}.event`] = "Name the event.";
  else if (!NAME.test(event) || chars(event) > L.text) issues[`${at}.event`] = `An event's name has no spaces: printable characters only, at most ${L.text}.`;
  const actions = typeof d.actions === "string" ? namesOf(d.actions) : d.actions;
  if (actions.length > L.list) issues[`${at}.actions`] = `At most ${L.list} actions.`;
  else if (actions.some((a) => !NAME.test(a) || chars(a) > L.text)) issues[`${at}.actions`] = `An action's name is printable characters, at most ${L.text}.`;
  const where = whereOf(d.where, at, issues);
  return { event, ...(actions.length ? { actions } : {}), ...(where.length ? { where } : {}) };
}

/** A whole filter as sent, the rules in order, or the issues by field. More rules than the server takes is said at
 *  `source.accept`. */
export function acceptOf(rules: readonly { event: string; actions: string | string[]; where: readonly ConditionDraft[] }[]): { accept: Accept[]; issues: Issues } {
  const issues: Issues = {};
  if (rules.length > L.rules) issues["source.accept"] = `At most ${L.rules} rules.`;
  return { accept: rules.map((r, i) => ruleOf(r, i, issues)), issues };
}

/** The fields under `source.accept` the editor shows an issue at, for rules of these conditions' counts: the rest of
 *  a refusal is said in the form's list of issues. */
export function acceptFields(conditions: readonly number[]): Set<string> {
  const out = new Set(["source.accept"]);
  conditions.forEach((count, i) => {
    const at = `source.accept[${i}]`;
    for (const f of ["", ".event", ".actions", ".where"]) out.add(`${at}${f}`);
    for (let j = 0; j < count; j++) for (const f of ["", ".pointer", ".in", ".prefix", ".exists"]) out.add(`${at}.where[${j}]${f}`);
  });
  return out;
}
