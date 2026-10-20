// The prompt variants of the company-research agent, as a file a person edits and as the agent home keeps them
// (`agent.prompts`, keyed by id: { role: base | overlay | generic | question, label, text, when?: { question, option,
// threshold }, criteria? }). The file holds the base, the overlays and the generic; the Jev question is its own file
// (question.json), which becomes the home's one `question` row when the set is saved, and each overlay's `when.question`
// is that row's id. This is the part the edit tool and the config page share: reading the files, checking them before
// anything is saved, and saying a rule in words.
import { readFile } from "node:fs/promises";

export const ROLES = ["base", "overlay", "generic"];
/** The option every question has for an input no overlay fits: the home reserves it, so no overlay may take it. */
const OTHER = "other";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEYS = new Set(["id", "role", "label", "text", "when"]);
const WHEN_KEYS = new Set(["question", "option", "threshold"]);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The variants in a prompts file: `{ variants: [...] }`, or the array itself. */
export function variantsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.variants)) return parsed.variants;
  throw new Error("a prompts file is { \"variants\": [...] } or an array of variants");
}

/** A prompts file read and parsed; a file that is not JSON is refused naming the file. */
export async function readPromptsFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  try {
    return variantsOf(JSON.parse(text));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

/** The Jev question a prompts file rules on: its id, label, instructions and the options it can answer. */
export async function readQuestion(file) {
  const question = JSON.parse(await readFile(file, "utf8"));
  return { id: question.id, label: question.label ?? question.id, instructions: question.instructions, criteria: question.criteria };
}

/** The question as the home keeps it: a row with role `question`, its instructions as the text and its options as criteria. */
export const questionRow = (question) => ({ id: question.id, role: "question", label: question.label ?? question.id, text: question.instructions, criteria: { ...question.criteria } });

/** The set a home is given: the file's variants and the question's row. */
export const withQuestion = (variants, question) => [...variants, questionRow(question)];

/** The question a home holds, as a `question.json` has it, or undefined: the home's `question` row among its prompts. */
export function questionOf(stored) {
  const row = normalizePrompts(stored).find((variant) => variant.role === "question");
  return row ? { id: row.id, label: row.label, instructions: row.text, criteria: row.criteria ?? {} } : undefined;
}

/**
 * What is wrong with `variants`, one sentence each; an empty list when it can be saved. One base, one generic, any number
 * of overlays; each has an id (one URL segment, used once) and a label; an overlay says when it loads (the question, the
 * option, a threshold from 0 to 1) and the base and the generic never do. With `question`, each overlay's rule is about that
 * question and names one of its options, and no two overlays name the same one.
 */
export function checkPrompts(variants, question) {
  const problems = [];
  if (!Array.isArray(variants) || variants.length === 0) return ["there are no variants"];
  const ids = new Set();
  const options = new Set();
  const criteria = isObject(question?.criteria) ? question.criteria : {};
  const count = { base: 0, overlay: 0, generic: 0 };
  variants.forEach((variant, at) => {
    const where = isObject(variant) && typeof variant.id === "string" ? variant.id : `variant ${at + 1}`;
    if (!isObject(variant)) return void problems.push(`${where}: not an object`);
    for (const key of Object.keys(variant)) if (!KEYS.has(key)) problems.push(`${where}: has a field it does not keep (${key})`);
    if (variant.role === "question") problems.push(`${where}: the question is question.json, not a variant of the prompts file`);
    else if (!ROLES.includes(variant.role)) problems.push(`${where}: role is one of ${ROLES.join(", ")}`);
    else count[variant.role] += 1;
    if (typeof variant.id !== "string" || !ID.test(variant.id)) problems.push(`${where}: id is 1 to 128 letters, digits, dots, underscores or dashes, so it fits a URL`);
    else if (ids.has(variant.id)) problems.push(`${where}: the id is used twice`);
    else ids.add(variant.id);
    if (typeof variant.label !== "string" || variant.label.trim() === "") problems.push(`${where}: label is empty`);
    if (typeof variant.text !== "string" || variant.text.trim() === "") problems.push(`${where}: text is empty`);
    if (variant.role === "overlay") {
      const when = variant.when;
      if (!isObject(when)) return void problems.push(`${where}: an overlay needs a when: { question, option, threshold }`);
      for (const key of Object.keys(when)) if (!WHEN_KEYS.has(key)) problems.push(`${where}: when has a field it does not keep (${key})`);
      if (typeof when.question !== "string" || when.question === "") problems.push(`${where}: when.question is empty`);
      if (typeof when.option !== "string" || when.option === "") problems.push(`${where}: when.option is empty`);
      if (!(typeof when.threshold === "number" && Number.isFinite(when.threshold) && when.threshold >= 0 && when.threshold <= 1)) problems.push(`${where}: when.threshold is a number from 0 to 1`);
      if (question) {
        if (when.question !== question.id) problems.push(`${where}: when.question is ${JSON.stringify(when.question)}, not ${JSON.stringify(question.id)}`);
        else if (when.option === OTHER) problems.push(`${where}: "${OTHER}" is the option for an input no overlay fits, so no overlay takes it`);
        else if (!Object.hasOwn(criteria, when.option)) problems.push(`${where}: ${JSON.stringify(when.option)} is not an option of ${question.id} (${Object.keys(criteria).join(", ")})`);
        else if (options.has(when.option)) problems.push(`${where}: another overlay already takes ${when.option}`);
        else options.add(when.option);
      }
    } else if (variant.when !== undefined) problems.push(`${where}: only an overlay has a when`);
  });
  if (question) {
    if (typeof question.id !== "string" || !ID.test(question.id)) problems.push("question.json: id is 1 to 128 letters, digits, dots, underscores or dashes, so it fits a URL");
    else if (ids.has(question.id)) problems.push(`question.json: the id ${question.id} is also a variant's`);
    if (typeof question.instructions !== "string" || question.instructions.trim() === "") problems.push("question.json: instructions is empty");
    if (!isObject(question.criteria)) problems.push("question.json: criteria is option names to descriptions");
    else {
      for (const [option, line] of Object.entries(question.criteria)) if (typeof line !== "string" || line.trim() === "") problems.push(`question.json: the criterion for ${option} is empty`);
      for (const option of Object.keys(question.criteria)) {
        if (option !== OTHER && !options.has(option)) problems.push(`question.json: ${option} is described but no overlay needs it: take it out of question.json, or add an overlay for it`);
      }
    }
  }
  if (count.base !== 1) problems.push(`there must be exactly one base (found ${count.base})`);
  if (count.generic !== 1) problems.push(`there must be exactly one generic (found ${count.generic})`);
  return problems;
}

const ORDER = { base: 0, overlay: 1, generic: 2, question: 3 };
/** What the home returned, as a list: an array, or a record by id. The base first, then the overlays, the generic, the question. */
export function normalizePrompts(stored) {
  const list = Array.isArray(stored) ? stored : isObject(stored) ? Object.entries(stored).map(([id, variant]) => ({ id, ...variant })) : [];
  return [...list].sort((a, b) => (ORDER[a.role] ?? 4) - (ORDER[b.role] ?? 4));
}

/** A rule in words: "company_kind is nonprofit at 0.8 or more". */
export function ruleText(when) {
  if (!when) return "";
  return `${when.question} is ${when.option} at ${when.threshold} or more`;
}
