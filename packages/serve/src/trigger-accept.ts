// A webhook trigger's `accept` rules: which verified deliveries fire it, read from the delivery alone, with no I/O. A rule
// names an event, the actions it takes (the body's top-level `action`; any, when it names none), and conditions on the
// body, each a JSON pointer (RFC 6901) and one test: `in` (the value there deep-equals one listed), `exists` (the pointer
// names a value, or names none), `prefix` (the value is a string whose first line, trimmed, starts with it, ignoring
// case). A delivery fires when any rule takes it. The owner's trigger body is the policy; this only reads it.
import { closedSchema } from "./trigger-adapter.js";
import { isObject, type Json } from "./validate.js";

/** The bounds of a trigger's accept: rules, conditions a rule, actions and `in` values a list, a pointer's characters,
 *  an event's, an action's and a prefix's, and each `in` value's as JSON. */
export const ACCEPT_LIMITS = { rules: 20, conditions: 20, list: 20, pointer: 512, text: 200, value: 1024 } as const;

export type Condition = { pointer: string; in: unknown[] } | { pointer: string; exists: boolean } | { pointer: string; prefix: string };
export type Rule = { event: string; actions?: string[]; where?: Condition[] };
type Bad = (field: string, reason: string, message: string) => void;

const L = ACCEPT_LIMITS;
const OPS = ["in", "exists", "prefix"] as const;
/** An event's or an action's name: printable ASCII with no space, as GitHub's event names and a Standard Webhooks
 *  `type` are. */
const NAME = /^[!-~]+$/;
const chars = (text: string) => [...text].length;
const named = (value: unknown): value is string => typeof value === "string" && NAME.test(value) && chars(value) <= L.text;

/** `pointer`'s reference tokens, unescaped, or undefined when it is not an RFC 6901 pointer. */
function tokensOf(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return undefined;
  return pointer.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const ABSENT = Symbol("absent");
/** The value `tokens` name in `doc`, or ABSENT. Own fields only, and an array's index as RFC 6901 writes one. */
function valueAt(doc: unknown, tokens: readonly string[]): unknown {
  let value = doc;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length) return ABSENT;
      value = value[Number(token)];
    } else if (isObject(value) && Object.hasOwn(value, token)) value = value[token];
    else return ABSENT;
  }
  return value;
}

/** Whether two JSON values are equal: an object's fields in any order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

/** A string's first line, trimmed: blank space and lines before it are skipped. */
const firstLine = (text: string) => text.trim().split(/\r\n|\r|\n/, 1)[0]!.trim();

function holds(condition: Condition, doc: unknown): boolean {
  const value = valueAt(doc, tokensOf(condition.pointer)!);
  if ("exists" in condition) return (value !== ABSENT) === condition.exists;
  if (value === ABSENT) return false;
  if ("in" in condition) return condition.in.some((option) => same(option, value));
  return typeof value === "string" && firstLine(value).toLowerCase().startsWith(condition.prefix.toLowerCase());
}

/** Why `rules` do not take a delivery of `event` whose body is `doc` (its JSON, or undefined when it is not JSON), or
 *  undefined when one does. */
export function acceptRefusal(rules: readonly Rule[], event: string | undefined, doc: unknown): string | undefined {
  if (doc === undefined) return "not_json";
  const action = isObject(doc) && typeof doc.action === "string" ? doc.action : undefined;
  const taken = rules.some((rule) => rule.event === event && (!rule.actions || (action !== undefined && rule.actions.includes(action))) && (rule.where ?? []).every((c) => holds(c, doc)));
  return taken ? undefined : "no_rule_matched";
}

function conditionOf(value: unknown, at: string, bad: Bad): Condition | undefined {
  if (!isObject(value)) return bad(at, "wrong_type", `${at} is a condition: {pointer, in | exists | prefix}`), undefined;
  const before = { count: 0 };
  const fail: Bad = (...args) => (before.count++, bad(...args));
  for (const key of Object.keys(value)) if (key !== "pointer" && !(OPS as readonly string[]).includes(key)) fail(`${at}.${key}`, "not_allowed", `A condition keeps no field ${key}: {pointer, in | exists | prefix}.`);
  const ops = OPS.filter((op) => value[op] !== undefined);
  if (ops.length !== 1) return bad(at, "invalid", `${at} names exactly one of in, exists and prefix`), undefined;
  const { pointer } = value;
  if (typeof pointer !== "string" || chars(pointer) > L.pointer || !tokensOf(pointer)) fail(`${at}.pointer`, pointer === undefined ? "missing" : "invalid", `pointer is a JSON pointer (RFC 6901) into the body, "" or "/" and its tokens (~0 for ~, ~1 for /), at most ${L.pointer} characters`);
  const op = ops[0]!;
  const given = value[op];
  if (op === "in" && !(Array.isArray(given) && given.length >= 1 && given.length <= L.list && given.every((item) => chars(JSON.stringify(item) ?? "") <= L.value))) fail(`${at}.in`, "invalid", `in is a list of 1 to ${L.list} JSON values, each at most ${L.value} characters as JSON: the value at pointer equals one of them`);
  if (op === "exists" && typeof given !== "boolean") fail(`${at}.exists`, "wrong_type", "exists is true (the pointer names a value) or false (it names none)");
  if (op === "prefix" && !(typeof given === "string" && given.length > 0 && chars(given) <= L.text)) fail(`${at}.prefix`, "invalid", `prefix is a string of 1 to ${L.text} characters: the value at pointer is a string whose first line, trimmed, starts with it, ignoring case`);
  return before.count ? undefined : ({ pointer, [op]: given } as Condition);
}

function ruleOf(value: unknown, at: string, bad: Bad): Rule | undefined {
  if (!isObject(value)) return bad(at, "wrong_type", `${at} is a rule: {event, actions?, where?}`), undefined;
  const before = { count: 0 };
  const fail: Bad = (...args) => (before.count++, bad(...args));
  for (const key of Object.keys(value)) if (!["event", "actions", "where"].includes(key)) fail(`${at}.${key}`, "not_allowed", `A rule keeps no field ${key}: {event, actions?, where?}.`);
  const { event, actions, where } = value;
  if (!named(event)) fail(`${at}.event`, event === undefined ? "missing" : "invalid", `event is the event's name, 1 to ${L.text} printable characters with no space, as the trigger's signature scheme reads it (GitHub's X-GitHub-Event, a Standard Webhooks body's type)`);
  if (actions !== undefined && !(Array.isArray(actions) && actions.length >= 1 && actions.length <= L.list && actions.every(named))) fail(`${at}.actions`, "invalid", `actions is a list of 1 to ${L.list} names the body's action is one of (absent: any)`);
  let conditions: (Condition | undefined)[] | undefined;
  if (where !== undefined) {
    if (!Array.isArray(where) || where.length < 1 || where.length > L.conditions) fail(`${at}.where`, "invalid", `where is a list of 1 to ${L.conditions} conditions, all of which hold`);
    else conditions = where.map((c, i) => conditionOf(c, `${at}.where[${i}]`, fail));
  }
  if (before.count) return undefined;
  return { event: event as string, ...(actions ? { actions: actions as string[] } : {}), ...(conditions ? { where: conditions as Condition[] } : {}) };
}

/** A source's `accept`, checked whole: each issue through `bad`, its field under `accept`. Undefined when it does not
 *  read. */
export function acceptOf(value: unknown, bad: Bad): Rule[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > L.rules) return bad("accept", "invalid", `accept is a list of 1 to ${L.rules} rules, {event, actions?, where?}: a delivery fires when one takes it`), undefined;
  let failed = false;
  const fail: Bad = (...args) => ((failed = true), bad(...args));
  const rules = value.map((rule, i) => ruleOf(rule, `accept[${i}]`, fail));
  return failed ? undefined : (rules as Rule[]);
}

const NAME_SCHEMA = { type: "string", minLength: 1, maxLength: L.text, pattern: "^[!-~]+$" };
const POINTER = { type: "string", maxLength: L.pointer, pattern: "^(/([^~]|~[01])*)?$", description: "A JSON pointer (RFC 6901) into the body: \"\" for the whole body, else \"/\" and each token (~0 for ~, ~1 for /)." };
/** `accept` as JSON Schema. */
export const ACCEPT_SCHEMA: Json = {
  type: "array", minItems: 1, maxItems: L.rules,
  description: "Which verified deliveries fire the trigger: a delivery fires when any rule takes it; any other is answered 200 `{\"ok\": \"ignored\"}`, fires nothing, and is said in the log. Absent: every verified delivery fires. A trigger with `accept` starts a run for each event it takes, its last run active or not.",
  items: closedSchema(
    { event: { ...NAME_SCHEMA, description: "The event, as the trigger's signature scheme reads it: for `github`, X-GitHub-Event (`pull_request`, `issue_comment`, and GitHub's `ping`); for `standard`, the JSON body's top-level `type`." } },
    {
      actions: { type: "array", minItems: 1, maxItems: L.list, items: NAME_SCHEMA, description: "The body's top-level `action` is one of these (`opened`, `created`). Absent: any, or none." },
      where: {
        type: "array", minItems: 1, maxItems: L.conditions, description: "Conditions on the body, all of which hold.",
        items: {
          oneOf: [
            closedSchema({ pointer: POINTER, in: { type: "array", minItems: 1, maxItems: L.list, items: {}, description: `The value at pointer equals one of these JSON values (an object's fields in any order), each at most ${L.value} characters as JSON.` } }),
            closedSchema({ pointer: POINTER, exists: { type: "boolean", description: "true: pointer names a value (null included); false: it names none." } }),
            closedSchema({ pointer: POINTER, prefix: { type: "string", minLength: 1, maxLength: L.text, description: "The value at pointer is a string whose first line, trimmed (blank space and lines before it skipped), starts with this, ignoring case." } }),
          ],
        },
      },
    },
  ),
};
