// The prompt variants of the company-research agent, as a file a person edits and as the agent home keeps them
// (`agent.prompts`, keyed by id: { role: base | overlay | generic, label, text, when?: { question, option, threshold } }). This is the
// part the edit tool and the config page share: reading a prompts file, checking it before anything is saved, and saying
// a rule in words.
import { readFile } from "node:fs/promises";

export const ROLES = ["base", "overlay", "generic"];
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

/** The Jev question a prompts file rules on: its id and the options it can answer. */
export async function readQuestion(file) {
  const question = JSON.parse(await readFile(file, "utf8"));
  return { id: question.id, instructions: question.instructions, criteria: question.criteria ?? {} };
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
  const count = { base: 0, overlay: 0, generic: 0 };
  variants.forEach((variant, at) => {
    const where = isObject(variant) && typeof variant.id === "string" ? variant.id : `variant ${at + 1}`;
    if (!isObject(variant)) return void problems.push(`${where}: not an object`);
    for (const key of Object.keys(variant)) if (!KEYS.has(key)) problems.push(`${where}: has a field it does not keep (${key})`);
    if (!ROLES.includes(variant.role)) problems.push(`${where}: role is one of ${ROLES.join(", ")}`);
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
        else if (!Object.hasOwn(question.criteria, when.option)) problems.push(`${where}: ${JSON.stringify(when.option)} is not an option of ${question.id} (${Object.keys(question.criteria).join(", ")})`);
        else if (options.has(when.option)) problems.push(`${where}: another overlay already takes ${when.option}`);
        else options.add(when.option);
      }
    } else if (variant.when !== undefined) problems.push(`${where}: only an overlay has a when`);
  });
  if (count.base !== 1) problems.push(`there must be exactly one base (found ${count.base})`);
  if (count.generic !== 1) problems.push(`there must be exactly one generic (found ${count.generic})`);
  return problems;
}

const ORDER = { base: 0, overlay: 1, generic: 2 };
/** What the home returned, as a list: an array, or a record by id. The base first, then the overlays, then the generic. */
export function normalizePrompts(stored) {
  const list = Array.isArray(stored) ? stored : isObject(stored) ? Object.entries(stored).map(([id, variant]) => ({ id, ...variant })) : [];
  return [...list].sort((a, b) => (ORDER[a.role] ?? 3) - (ORDER[b.role] ?? 3));
}

/** A rule in words: "company_kind is nonprofit at 0.8 or more". */
export function ruleText(when) {
  if (!when) return "";
  return `${when.question} is ${when.option} at ${when.threshold} or more`;
}
