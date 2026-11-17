// An agent definition's `learning`: true, false, or an object, which is on (as true) with the loop's numbers set
// on it. Every number of the loop lives here, on the agent, each with a default: none is an engine constant.
//   compile_after (N): the agent's job compiles into a workflow once it has this many completed agent runs;
//   agree_min (A): the compiled draft is checked once on the inputs of those N runs, and promoted only when, of the inputs
//     it answered alone, at least this share say what the agent's own recorded answer said;
//   alone_min (S): ...and when it answered at least this share of them alone (no escalate, no failed step).
// learn/compile.ts compileDue reads compile_after; runner/promotion.ts's check reads all three.

/** The loop's numbers as a definition may set them (each optional: its default stands in). */
export interface LearningLoop {
  readonly compile_after?: number;
  readonly agree_min?: number;
  readonly alone_min?: number;
}
/** A definition's `learning`, as kept on an agentic revision. */
export type LearningSetting = boolean | LearningLoop;

export const COMPILE_AFTER_DEFAULT = 20;
export const AGREE_MIN_DEFAULT = 0.8;
export const ALONE_MIN_DEFAULT = 0.7;
/** The most completed runs a compile may wait for: the newest this many of an agent's runs are what it counts and checks. */
export const COMPILE_AFTER_MAX = 200;

const LOOP_KEYS = ["compile_after", "agree_min", "alone_min"] as const;

const isLoop = (value: unknown): value is LearningLoop => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether `learning` has the agent's runs learn (true, or an object): never false or absent. */
export const learnsOf = (learning: unknown): boolean => learning === true || isLoop(learning);

/** The loop's numbers for a revision's `learning`: its object's, each one it leaves out at its default. */
export function loopOf(learning: unknown): Required<LearningLoop> {
  const set = isLoop(learning) ? learning : {};
  return {
    compile_after: set.compile_after ?? COMPILE_AFTER_DEFAULT,
    agree_min: set.agree_min ?? AGREE_MIN_DEFAULT,
    alone_min: set.alone_min ?? ALONE_MIN_DEFAULT,
  };
}

/** What is wrong with a definition's `learning`, in words naming the field (`at` its path), or undefined when it is one
 *  of true, false or an object of the loop's numbers. */
export function learningSettingIssue(value: unknown, at = "learning"): string | undefined {
  if (typeof value === "boolean") return undefined;
  if (!isLoop(value)) return `${at} is true, false or an object of the loop's numbers ({compile_after?, agree_min?, alone_min?}, on with those set)`;
  const other = Object.keys(value).find((key) => !(LOOP_KEYS as readonly string[]).includes(key));
  if (other !== undefined) return `${at}.${other} is not one of the loop's numbers: ${LOOP_KEYS.join(", ")}`;
  const { compile_after: after, agree_min: agree, alone_min: alone } = value as Record<string, unknown>;
  if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 1 && (after as number) <= COMPILE_AFTER_MAX)) return `${at}.compile_after is a whole number of completed runs from 1 to ${COMPILE_AFTER_MAX}`;
  for (const [key, share] of [["agree_min", agree], ["alone_min", alone]] as const) {
    if (share !== undefined && !(typeof share === "number" && Number.isFinite(share) && share >= 0 && share <= 1)) return `${at}.${key} is a share from 0 to 1`;
  }
  return undefined;
}

/** A valid `learning` as a revision keeps it: an object's numbers in one order, so two definitions that say the same are
 *  one body. */
export function learningSettingOf(value: LearningSetting): LearningSetting {
  if (!isLoop(value)) return value;
  return Object.fromEntries(LOOP_KEYS.flatMap((key) => (value[key] !== undefined ? [[key, value[key]]] : []))) as LearningLoop;
}
