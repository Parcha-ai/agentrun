// The prompt set validator (the P4 fold of pi-durable-agent's home.ts checkPrompts), kept with the store (A). A prompt set
// is what a run's host chooses a starting prompt from before the run's first turn (choosePrompt, the runner's): one `base`,
// one `generic`, any number of `overlay`s with a Jev rule, and at most one `question` the overlays' rules answer. This is
// the one check over a set's shape; the choice itself is the runner's. Nothing of the old agent-home model (its doc
// families, its lock) is folded: those die with the home. Ported verbatim in its rules and words.
import { type PromptVariant } from "./agent-body.js";

/** A set the validator refuses: its shape is not one the store keeps. */
export class PromptsInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptsInvalid";
  }
}
const invalid = (message: string): never => {
  throw new PromptsInvalid(message);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A prompt id: one URL path segment. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The option every question has, for an input no overlay fits. */
export const OTHER_OPTION = "other";
const ROLES = new Set(["base", "overlay", "generic", "question"]);
const VARIANT_FIELDS = new Set(["id", "role", "label", "text", "when", "criteria"]);
const RULE_FIELDS = new Set(["question", "option", "threshold"]);
const MAX_VARIANTS = 64;
const MAX_LABEL = 200;
const MAX_QUESTION = 2_000;
const MAX_TEXT_BYTES = 64 * 1024;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const extraField = (value: Record<string, unknown>, fields: Set<string>) => Object.keys(value).find((key) => !fields.has(key));

type PromptRule = NonNullable<PromptVariant["when"]>;

function checkRule(id: string, when: unknown): PromptRule {
  if (!isObject(when)) invalid(`the prompt ${id}'s when is not an object`);
  const extra = extraField(when as Record<string, unknown>, RULE_FIELDS);
  if (extra !== undefined) invalid(`the prompt ${id}'s when has a field a rule does not keep: ${extra}`);
  const { question, option, threshold } = when as Record<string, unknown>;
  if (typeof question !== "string" || !ID_PATTERN.test(question)) invalid(`the prompt ${id}'s question ${JSON.stringify(question)} is not a prompt id`);
  if (!isText(option, MAX_LABEL)) invalid(`the prompt ${id}'s option is not a non-empty string of at most ${MAX_LABEL} characters`);
  if (option === OTHER_OPTION) invalid(`the prompt ${id}'s option is "${OTHER_OPTION}", which every question has for an input no overlay fits`);
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) invalid(`the prompt ${id}'s threshold ${String(threshold)} is not a number from 0 to 1`);
  return { question: question as string, option: option as string, threshold: threshold as number };
}

function checkCriteria(id: string, criteria: unknown): Record<string, string> {
  if (!isObject(criteria)) invalid(`the prompt ${id}'s criteria are not option names to descriptions`);
  for (const [option, description] of Object.entries(criteria as Record<string, unknown>)) {
    if (!isText(description, MAX_QUESTION)) invalid(`the prompt ${id}'s criterion for ${option} is not a non-empty string of at most ${MAX_QUESTION} characters`);
  }
  return { ...(criteria as Record<string, string>) };
}

/** A prompt set as stored, in the given order, or a refusal naming the first thing that is wrong: one `base`, one
 *  `generic`, any number of `overlay`s, at most one `question`, each id one URL segment and given once, the stated sizes,
 *  and rules that name the question row and an option no other overlay needs. */
export function checkPrompts(variants: unknown): [string, PromptVariant][] {
  if (!Array.isArray(variants)) invalid("the prompts are not a list of variants");
  const list = variants as unknown[];
  if (list.length > MAX_VARIANTS) invalid(`the prompts are ${list.length} variants; a set has at most ${MAX_VARIANTS}`);
  const checked: [string, PromptVariant][] = [];
  for (const [index, variant] of list.entries()) {
    if (!isObject(variant)) invalid(`prompt ${index} is not an object`);
    const { id, role, label, text, when } = variant as Record<string, unknown>;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) invalid(`prompt ${index}'s id ${JSON.stringify(id)} does not match ${ID_PATTERN.source}`);
    if (checked.some(([seen]) => seen === id)) invalid(`the prompt id ${id as string} is given twice`);
    const extra = extraField(variant as Record<string, unknown>, VARIANT_FIELDS);
    if (extra !== undefined) invalid(`the prompt ${id as string} has a field a variant does not keep: ${extra}`);
    if (typeof role !== "string" || !ROLES.has(role)) invalid(`the prompt ${id as string}'s role ${JSON.stringify(role)} is not base, overlay, generic or question`);
    if (!isText(label, MAX_LABEL)) invalid(`the prompt ${id as string}'s label is not a non-empty string of at most ${MAX_LABEL} characters`);
    if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) invalid(`the prompt ${id as string}'s text is not a non-empty string of at most ${MAX_TEXT_BYTES} bytes`);
    if (when !== undefined && role !== "overlay") invalid(`the prompt ${id as string} is the ${role}; only an overlay has a when`);
    if ((variant as Record<string, unknown>).criteria !== undefined && role !== "question") invalid(`the prompt ${id as string} is the ${role}; only a question has criteria`);
    checked.push([id as string, {
      role: role as PromptVariant["role"], label: label as string, text: text as string,
      ...(when === undefined ? {} : { when: checkRule(id as string, when) }),
      ...((variant as Record<string, unknown>).criteria === undefined ? {} : { criteria: checkCriteria(id as string, (variant as Record<string, unknown>).criteria) }),
    }]);
  }
  for (const role of ["base", "generic"]) {
    const count = checked.filter(([, variant]) => variant.role === role).length;
    if (count !== 1) invalid(`the prompts have ${count} ${role} variants; a set has exactly one`);
  }
  const questions = checked.filter(([, variant]) => variant.role === "question").map(([id]) => id);
  if (questions.length > 1) invalid(`the prompts have ${questions.length} questions (${questions.join(", ")}); a set has at most one`);
  const options = new Map<string, string>();
  for (const [id, { when }] of checked) {
    if (!when) continue;
    if (when.question !== questions[0]) invalid(`the prompt ${id}'s question ${when.question} is not the set's question row`);
    if (options.has(when.option)) invalid(`the option ${when.option} is needed by both ${options.get(when.option)} and ${id}`);
    options.set(when.option, id);
  }
  for (const [id, { criteria }] of checked) {
    const unknown = Object.keys(criteria ?? {}).find((option) => option !== OTHER_OPTION && !options.has(option));
    if (unknown !== undefined) invalid(`the question ${id} describes ${unknown}, which no overlay needs`);
  }
  return checked;
}
