// An agent definition's `learning`: true, false, or an object, which is on (as true) with the loop's numbers set
// on it. Every number of the loop lives here, on the agent, each with a default: none is an engine constant.
//   compile_after (N): the agent's job compiles into a workflow once it has this many completed agent runs;
//   agree_min (A): the compiled draft is checked once on the inputs of those N runs, and promoted only when, of the inputs
//     it answered alone, at least this share say what the agent's own recorded answer said;
//   alone_min (S): ...and when it answered at least this share of them alone (no escalate, no failed step).
// learn/compile.ts compileDue reads compile_after; runner/promotion.ts's check reads all three.
// Once a workflow serves, its shadow audit (runner/audit.ts) reads the other six:
//   audit_every (k): a run it serves is audited at 1 in k, drawn from the run's id (learn/audit.ts auditDrawn);
//   audit_every_later, audit_later_after: 1 in this many once the digest served audit_later_after runs;
//   hold_window, hold_disagree: it stops serving (a hold) when its last hold_window audit rows hold at least
//     hold_disagree disagreements;
//   stop_window: a second hold within this many served runs of the first stops it for good.
// Both compare two answers (learn/promote.ts sameAnswer) on agree_on, the answer's top-level JSON keys that say the
// decision (agreeOnOf): the definition's list, else its output_schema's top-level enum, const and boolean fields, else
// the whole answer.

/** The loop's settings as a definition may set them (each optional: its default stands in). */
export interface LearningLoop {
  readonly compile_after?: number;
  readonly agree_min?: number;
  readonly alone_min?: number;
  readonly agree_on?: readonly string[];
  readonly audit_every?: number;
  readonly audit_every_later?: number;
  readonly audit_later_after?: number;
  readonly hold_window?: number;
  readonly hold_disagree?: number;
  readonly stop_window?: number;
}
/** The fields two answers are compared on, and where the list came from: the definition's `learning.agree_on`, or its
 *  output schema's decision fields. Absent: the whole answer. */
export interface AgreeOn {
  readonly agree_on: readonly string[];
  readonly agree_from: "definition" | "schema";
}
/** The check's numbers (runner/promotion.ts): what a check record keeps of the loop, with the fields it compares on. */
export type CheckLoop = Required<Pick<LearningLoop, "compile_after" | "agree_min" | "alone_min">> & Partial<AgreeOn>;
/** The audit's numbers (runner/audit.ts). */
export type AuditLoop = Required<Pick<LearningLoop, "audit_every" | "audit_every_later" | "audit_later_after" | "hold_window" | "hold_disagree" | "stop_window">>;
/** A definition's `learning`, as kept on an agentic revision. */
export type LearningSetting = boolean | LearningLoop;

export const COMPILE_AFTER_DEFAULT = 20;
export const AGREE_MIN_DEFAULT = 0.8;
export const ALONE_MIN_DEFAULT = 0.7;
/** The most completed runs a compile may wait for: the newest this many of an agent's runs are what it counts and checks. */
export const COMPILE_AFTER_MAX = 200;
export const AUDIT_DEFAULTS: AuditLoop = { audit_every: 10, audit_every_later: 20, audit_later_after: 50, hold_window: 10, hold_disagree: 3, stop_window: 100 };
/** The most any audit number may be: 1 in 1,000 runs, a window of 1,000 (the ledger keeps more rows than that). */
export const AUDIT_MAX = 1_000;

const AUDIT_KEYS = ["audit_every", "audit_every_later", "audit_later_after", "hold_window", "hold_disagree", "stop_window"] as const;
const LOOP_KEYS = ["compile_after", "agree_min", "alone_min", "agree_on", ...AUDIT_KEYS] as const;
/** The most keys agree_on names, and the most characters of each. */
export const AGREE_ON_MAX = 16;
export const AGREE_ON_KEY_MAX = 64;
/** Each audit number's words, for its 422. */
const AUDIT_WORDS: Record<(typeof AUDIT_KEYS)[number], string> = {
  audit_every: "audits 1 in this many served runs",
  audit_every_later: "audits 1 in this many served runs once audit_later_after served",
  audit_later_after: "is the served runs after which audit_every_later applies",
  hold_window: "is the audit rows the hold rule reads",
  hold_disagree: "is the disagreements in hold_window rows that hold the workflow",
  stop_window: "is the served runs within which a second hold stops the workflow",
};

const isLoop = (value: unknown): value is LearningLoop => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether `learning` has the agent's runs learn (true, or an object): never false or absent. */
export const learnsOf = (learning: unknown): boolean => learning === true || isLoop(learning);

/** A JSON Schema of one field that says a decision: an `enum`, a `const` or `type: "boolean"`. Never a number (a
 *  confidence two runs never repeat), an array (compared in order) or free text. */
const decisionField = (schema: unknown): boolean =>
  isLoop(schema) && (Array.isArray((schema as Record<string, unknown>).enum) || "const" in schema || (schema as Record<string, unknown>).type === "boolean");

/** The fields a revision's two answers are compared on: its `learning.agree_on`, else its `outputSchema`'s top-level
 *  properties that say a decision (decisionField), in the schema's order; undefined when neither names one (the whole
 *  answer is compared). */
export function agreeOnOf(learning: unknown, outputSchema?: unknown): AgreeOn | undefined {
  if (isLoop(learning) && learning.agree_on?.length) return { agree_on: [...learning.agree_on], agree_from: "definition" };
  const properties = isLoop(outputSchema) ? (outputSchema as Record<string, unknown>).properties : undefined;
  if (!isLoop(properties)) return undefined;
  const fields = Object.entries(properties).filter(([, field]) => decisionField(field)).map(([key]) => key);
  return fields.length ? { agree_on: fields, agree_from: "schema" } : undefined;
}

/** The loop's numbers for a revision's `learning`: its object's, each one it leaves out at its default; with the fields
 *  its answers are compared on (agreeOnOf, from `learning` and the revision's `outputSchema`) when any. */
export function loopOf(learning: unknown, outputSchema?: unknown): CheckLoop {
  const set = isLoop(learning) ? learning : {};
  return {
    compile_after: set.compile_after ?? COMPILE_AFTER_DEFAULT,
    agree_min: set.agree_min ?? AGREE_MIN_DEFAULT,
    alone_min: set.alone_min ?? ALONE_MIN_DEFAULT,
    ...agreeOnOf(learning, outputSchema),
  };
}

/** The check's numbers (loopOf) of a revision's body: its `learning` and its `outputSchema`. */
export const loopOfBody = (body: unknown): CheckLoop => {
  const { learning, outputSchema } = (isLoop(body) ? body : {}) as { learning?: unknown; outputSchema?: unknown };
  return loopOf(learning, outputSchema);
};

/** The audit's numbers for a revision's `learning`: its object's, each one it leaves out at its default (AUDIT_DEFAULTS). */
export function auditLoopOf(learning: unknown): AuditLoop {
  const set = isLoop(learning) ? learning : {};
  return Object.fromEntries(AUDIT_KEYS.map((key) => [key, set[key] ?? AUDIT_DEFAULTS[key]])) as unknown as AuditLoop;
}

/** What is wrong with a definition's `learning`, in words naming the field (`at` its path), or undefined when it is one
 *  of true, false or an object of the loop's numbers. */
export function learningSettingIssue(value: unknown, at = "learning"): string | undefined {
  if (typeof value === "boolean") return undefined;
  if (!isLoop(value)) return `${at} is true, false or an object of the loop's numbers ({${LOOP_KEYS.map((key) => `${key}?`).join(", ")}}, on with those set)`;
  const other = Object.keys(value).find((key) => !(LOOP_KEYS as readonly string[]).includes(key));
  if (other !== undefined) return `${at}.${other} is not one of the loop's numbers: ${LOOP_KEYS.join(", ")}`;
  const on = (value as Record<string, unknown>).agree_on;
  const key = (one: unknown) => typeof one === "string" && one.length >= 1 && one.length <= AGREE_ON_KEY_MAX;
  if (on !== undefined && !(Array.isArray(on) && on.length >= 1 && on.length <= AGREE_ON_MAX && on.every(key) && new Set(on).size === on.length)) return `${at}.agree_on is a list of 1 to ${AGREE_ON_MAX} distinct top-level answer keys, each 1 to ${AGREE_ON_KEY_MAX} characters`;
  const { compile_after: after, agree_min: agree, alone_min: alone } = value as Record<string, unknown>;
  if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 1 && (after as number) <= COMPILE_AFTER_MAX)) return `${at}.compile_after is a whole number of completed runs from 1 to ${COMPILE_AFTER_MAX}`;
  for (const [key, share] of [["agree_min", agree], ["alone_min", alone]] as const) {
    if (share !== undefined && !(typeof share === "number" && Number.isFinite(share) && share >= 0 && share <= 1)) return `${at}.${key} is a share from 0 to 1`;
  }
  for (const key of AUDIT_KEYS) {
    const n = (value as Record<string, unknown>)[key];
    if (n !== undefined && !(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= AUDIT_MAX)) return `${at}.${key} ${AUDIT_WORDS[key]}: a whole number from 1 to ${AUDIT_MAX}`;
  }
  const audit = auditLoopOf(value);
  if (audit.hold_disagree > audit.hold_window) return `${at}.hold_disagree is at most hold_window (${audit.hold_window}): the disagreements are counted in that many rows`;
  return undefined;
}

/** A valid `learning` as a revision keeps it: an object's keys in one order, so two definitions that say the same are
 *  one body (agree_on's list as its owner gave it: its order is theirs). */
export function learningSettingOf(value: LearningSetting): LearningSetting {
  if (!isLoop(value)) return value;
  return Object.fromEntries(LOOP_KEYS.flatMap((key) => (value[key] !== undefined ? [[key, key === "agree_on" ? [...value.agree_on!] : value[key]]] : []))) as LearningLoop;
}
