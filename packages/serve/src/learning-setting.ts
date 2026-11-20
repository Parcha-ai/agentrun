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
// Both compare two answers (learn/promote.ts sameAnswer) on agree_on, the definition's dotted paths into the answer's
// JSON object that say the decision (`verdict.decision`); absent, the whole answer. Nothing is read off the output
// schema: its enum can be an echo of the owner's setting, not the decision, and a wrong field that promotes is worse than
// none.
// A compile reads two more (runner/learning-end.ts checkDraftOf, learn/repick.ts), off by default:
//   repick: the answer's quote re-pick (learn/check.ts quoteRule) reads the run's fetched pages on its second pass, as
//     H6c's re-pick tier did, where the compiled one reads its compact facts and its draft alone;
//   repick_max_chars: the most characters of state that second pass sends, its longest strings cut first.
// Each is read when a draft is committed, so a change reaches the workflows compiled after it, never one already kept.

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
  readonly repick?: boolean;
  readonly repick_max_chars?: number;
}
/** The re-pick's settings (learn/repick.ts), each at its default where the definition leaves it out. */
export type RepickLoop = Required<Pick<LearningLoop, "repick" | "repick_max_chars">>;
/** The check's numbers (runner/promotion.ts): what a check record keeps of the loop, with the paths it compares on (the
 *  definition's agree_on; absent, the whole answer). */
export type CheckLoop = Required<Pick<LearningLoop, "compile_after" | "agree_min" | "alone_min">> & Pick<LearningLoop, "agree_on">;
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

/** The most characters of state a re-pick's second pass sends by default: three pages at web_fetch's cut (50,000 each). */
export const REPICK_MAX_CHARS_DEFAULT = 150_000;
/** The most repick_max_chars may be: about 100,000 tokens, half a 200,000-token model's context. */
export const REPICK_MAX_CHARS_MAX = 400_000;

const AUDIT_KEYS = ["audit_every", "audit_every_later", "audit_later_after", "hold_window", "hold_disagree", "stop_window"] as const;
const LOOP_KEYS = ["compile_after", "agree_min", "alone_min", "agree_on", ...AUDIT_KEYS, "repick", "repick_max_chars"] as const;
/** The most paths agree_on names, the most characters of each, and the most segments of each. */
export const AGREE_ON_MAX = 16;
export const AGREE_ON_PATH_MAX = 128;
export const AGREE_ON_SEGMENTS_MAX = 8;
/** An agree_on path's segments: each a key of an object, from the answer's top level down (a dot always splits). */
export const pathSegments = (path: string): string[] => path.split(".");
/** What is wrong with one agree_on path, in words, or undefined. */
function pathIssue(path: string): string | undefined {
  if (path.length > AGREE_ON_PATH_MAX) return `over ${AGREE_ON_PATH_MAX} characters`;
  const segments = pathSegments(path);
  if (segments.some((segment) => !segment)) return "an empty segment";
  if (segments.length > AGREE_ON_SEGMENTS_MAX) return `more than ${AGREE_ON_SEGMENTS_MAX} segments`;
  return undefined;
}
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

/** The paths a revision's two answers are compared on: its `learning.agree_on`; undefined, the whole answer. */
export const agreeOnOf = (learning: unknown): readonly string[] | undefined => (isLoop(learning) && learning.agree_on?.length ? [...learning.agree_on] : undefined);

/** The loop's numbers for a revision's `learning`: its object's, each one it leaves out at its default, with its
 *  agree_on when set. */
export function loopOf(learning: unknown): CheckLoop {
  const set = isLoop(learning) ? learning : {};
  const on = agreeOnOf(learning);
  return {
    compile_after: set.compile_after ?? COMPILE_AFTER_DEFAULT,
    agree_min: set.agree_min ?? AGREE_MIN_DEFAULT,
    alone_min: set.alone_min ?? ALONE_MIN_DEFAULT,
    ...(on ? { agree_on: on } : {}),
  };
}

/** The audit's numbers for a revision's `learning`: its object's, each one it leaves out at its default (AUDIT_DEFAULTS). */
export function auditLoopOf(learning: unknown): AuditLoop {
  const set = isLoop(learning) ? learning : {};
  return Object.fromEntries(AUDIT_KEYS.map((key) => [key, set[key] ?? AUDIT_DEFAULTS[key]])) as unknown as AuditLoop;
}

/** The re-pick's settings for a revision's `learning`: off and REPICK_MAX_CHARS_DEFAULT where its object leaves them out
 *  (`true` is every default, so off). */
export function repickOf(learning: unknown): RepickLoop {
  const set = isLoop(learning) ? learning : {};
  return { repick: set.repick === true, repick_max_chars: set.repick_max_chars ?? REPICK_MAX_CHARS_DEFAULT };
}

/** Whether `n` is a repick_max_chars a definition may set. */
export const isRepickMaxChars = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= REPICK_MAX_CHARS_MAX;

/** What is wrong with a definition's `learning`, in words naming the field (`at` its path), or undefined when it is one
 *  of true, false or an object of the loop's numbers. */
export function learningSettingIssue(value: unknown, at = "learning"): string | undefined {
  if (typeof value === "boolean") return undefined;
  if (!isLoop(value)) return `${at} is true, false or an object of the loop's numbers ({${LOOP_KEYS.map((key) => `${key}?`).join(", ")}}, on with those set)`;
  const other = Object.keys(value).find((key) => !(LOOP_KEYS as readonly string[]).includes(key));
  if (other !== undefined) return `${at}.${other} is not one of the loop's numbers: ${LOOP_KEYS.join(", ")}`;
  const on = (value as Record<string, unknown>).agree_on;
  if (on !== undefined) {
    if (!(Array.isArray(on) && on.length >= 1 && on.length <= AGREE_ON_MAX && on.every((one) => typeof one === "string") && new Set(on).size === on.length)) return `${at}.agree_on is a list of 1 to ${AGREE_ON_MAX} distinct dotted paths into the answer's JSON object (e.g. verdict.decision)`;
    for (const [i, path] of (on as string[]).entries()) {
      const why = pathIssue(path);
      if (why) return `${at}.agree_on[${i}] is not a dotted path into the answer's JSON object (e.g. verdict.decision): ${why}`;
    }
  }
  const { compile_after: after, agree_min: agree, alone_min: alone } = value as Record<string, unknown>;
  if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 1 && (after as number) <= COMPILE_AFTER_MAX)) return `${at}.compile_after is a whole number of completed runs from 1 to ${COMPILE_AFTER_MAX}`;
  for (const [key, share] of [["agree_min", agree], ["alone_min", alone]] as const) {
    if (share !== undefined && !(typeof share === "number" && Number.isFinite(share) && share >= 0 && share <= 1)) return `${at}.${key} is a share from 0 to 1`;
  }
  for (const key of AUDIT_KEYS) {
    const n = (value as Record<string, unknown>)[key];
    if (n !== undefined && !(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= AUDIT_MAX)) return `${at}.${key} ${AUDIT_WORDS[key]}: a whole number from 1 to ${AUDIT_MAX}`;
  }
  const { repick, repick_max_chars: maxChars } = value as Record<string, unknown>;
  if (repick !== undefined && typeof repick !== "boolean") return `${at}.repick is true or false: true, a quote re-pick's second pass reads the run's fetched pages`;
  if (maxChars !== undefined && !isRepickMaxChars(maxChars)) return `${at}.repick_max_chars is the most characters a re-pick's second pass sends: a whole number from 1 to ${REPICK_MAX_CHARS_MAX}`;
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
