// Structural checks of request bodies against the contract's schemas, as field issues (`422 input_invalid`).
import { type InputIssue, invalid } from "./errors.js";
import { HARNESSES } from "./harness.js";
import { THINKING_LEVELS } from "./model.js";
import { placeIssues } from "./place.js";

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^/\\\u0000][^\\\u0000]*$/;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with every object's keys sorted, so two equal values read the same. */
export const stable = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(stable).join(",")}]` : isObject(value) ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);

export const DEFINITION_FIELDS = ["id", "version", "name", "description", "instructions", "workflow", "model", "thinking", "harness", "place", "skills", "tools"];
/** Why a field a definition may have elsewhere has no place in an agent store's revision. */
export const NOT_KEPT: Record<string, string> = {
  input_schema: "The agent store keeps no input_schema: an agentic run takes {content}, and a workflow checks its input against its own schema.",
  output_schema: "The agent store keeps no output_schema: a workflow run's output is its workflow's.",
  max_cost_usd: "The agent store keeps no max_cost_usd on a definition: give one with each run.",
};
/** `provider/model-id`. */
export const MODEL_REF = /^[^/\s]+\/\S+$/;
const SKILL_FILE = "/SKILL.md";

const issue = (field: string, reason: string, message: string, fix?: string): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });

function names(value: unknown, field: string, out: InputIssue[]): void {
  if (!Array.isArray(value)) return void out.push(issue(field, "wrong_type", `${field} is not a list of names`));
  if (!value.every((name) => typeof name === "string" && name !== "")) out.push(issue(field, "wrong_type", `${field} holds an item that is not a non-empty string`));
  else if (new Set(value).size !== value.length) out.push(issue(field, "duplicate", `${field} names one item twice`));
}

/** The skills a revision's files hold: each `<name>/SKILL.md`, by name, sorted. */
export const skillNames = (files: Iterable<string>): string[] => [...files].filter((path) => path.endsWith(SKILL_FILE)).map((path) => path.slice(0, -SKILL_FILE.length)).sort();

/**
 * A definition as `POST /agents` and `PUT .../definition` take it: what one revision of an agent keeps. `instructions`
 * makes an agentic revision, `workflow` (an agentrun-dsl workflow) a workflow revision. `creating` asks for a name.
 */
export function definitionIssues(definition: unknown, { at = "definition", creating = true } = {}): InputIssue[] {
  if (!isObject(definition)) return [issue(at, definition === undefined ? "missing" : "wrong_type", `${at} is not an object`)];
  const out: InputIssue[] = [];
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_FIELDS.includes(key)) out.push(issue(`${at}.${key}`, "not_allowed", NOT_KEPT[key] ?? `The definition keeps no field ${key}.`, `Remove ${at}.${key}.`));
  }
  const d = definition;
  if (creating && d.name === undefined) out.push(issue(`${at}.name`, "missing", `${at}.name is required`));
  if (d.instructions === undefined && d.workflow === undefined) out.push(issue(`${at}.instructions`, "missing", `${at} needs instructions (an agentic revision) or a workflow (a workflow revision)`));
  if (d.instructions !== undefined && d.workflow !== undefined) out.push(issue(`${at}.workflow`, "not_allowed", `${at} has instructions or a workflow, not both`, `Remove ${at}.workflow or ${at}.instructions.`));
  if (d.id !== undefined && (typeof d.id !== "string" || !ID.test(d.id))) out.push(issue(`${at}.id`, "bad_format", `${at}.id must match ${ID.source}`));
  if (d.version !== undefined && (!Number.isSafeInteger(d.version) || (d.version as number) < 1)) out.push(issue(`${at}.version`, "wrong_type", `${at}.version is not a positive integer`));
  if (d.name !== undefined && (typeof d.name !== "string" || d.name.trim() === "")) out.push(issue(`${at}.name`, typeof d.name === "string" ? "too_short" : "wrong_type", `${at}.name is not a non-empty string`));
  if (d.description !== undefined && typeof d.description !== "string") out.push(issue(`${at}.description`, "wrong_type", `${at}.description is not a string`));
  if (d.instructions !== undefined && typeof d.instructions !== "string") out.push(issue(`${at}.instructions`, "wrong_type", `${at}.instructions is not a string`));
  if (d.workflow !== undefined && !isObject(d.workflow)) out.push(issue(`${at}.workflow`, "wrong_type", `${at}.workflow is not an object`));
  if (d.model !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.model`, "not_allowed", "A workflow revision keeps no model: its model nodes run on this host's default.", `Remove ${at}.model.`));
    else if (typeof d.model !== "string" || !MODEL_REF.test(d.model)) out.push(issue(`${at}.model`, "bad_format", `${at}.model is "provider/model-id"`));
  }
  if (d.harness !== undefined && !(HARNESSES as readonly unknown[]).includes(d.harness)) out.push(issue(`${at}.harness`, "not_an_option", `${at}.harness is one of ${HARNESSES.join(", ")}`));
  if (d.place !== undefined) out.push(...placeIssues(d.place, `${at}.place`));
  if (d.thinking !== undefined) {
    if (d.workflow !== undefined) out.push(issue(`${at}.thinking`, "not_allowed", "A workflow revision keeps no thinking level: each model node carries its own.", `Remove ${at}.thinking.`));
    else if (!(THINKING_LEVELS as readonly unknown[]).includes(d.thinking)) out.push(issue(`${at}.thinking`, "not_an_option", `${at}.thinking is one of ${THINKING_LEVELS.join(", ")}: thinking is never off`));
  }
  if (d.skills !== undefined) names(d.skills, `${at}.skills`, out);
  if (d.tools !== undefined) names(d.tools, `${at}.tools`, out);
  return out;
}

/** The skill files a body names: an object of relative paths inside `.agents/skills/` to text. */
function skillFileIssues(skills: unknown, out: InputIssue[]): void {
  if (!isObject(skills)) return void out.push(issue("skills", "wrong_type", "skills is not an object of paths to text"));
  for (const [path, text] of Object.entries(skills)) {
    if (path.length > 512 || !SKILL_PATH.test(path)) out.push(issue(`skills.${path}`, "bad_format", `the skill path ${JSON.stringify(path)} is not a relative path inside .agents/skills/`));
    else if (typeof text !== "string") out.push(issue(`skills.${path}`, "wrong_type", `the skill ${path} is not text`));
  }
}

/** A definition's skill names against the files its revision holds: each named skill has its SKILL.md, and each
 *  SKILL.md is named. */
export function skillIssues(named: unknown, files: Iterable<string>): InputIssue[] {
  if (!Array.isArray(named)) return [];
  const held = skillNames(files);
  return [
    ...named.filter((name) => !held.includes(name)).map((name) => issue(`skills.${name}${SKILL_FILE}`, "missing", `the definition names the skill ${name}, and skills holds no ${name}${SKILL_FILE}`)),
    ...held.filter((name) => !named.includes(name)).map((name) => issue(`skills.${name}${SKILL_FILE}`, "not_allowed", `skills holds ${name}${SKILL_FILE}, a skill the definition does not name`, `Name ${name} in definition.skills, or leave it out.`)),
  ];
}

export type DefinitionBody = { definition: Json; skills?: Record<string, string>; note?: string };

/**
 * `{definition, skills?, note?}`, as `POST /agents` and `PUT .../definition` take it. `skills` are the revision's skill
 * files (absent on an edit: the current revision's); `note` says what the revision changes. Throws `422 input_invalid`
 * naming every field that is wrong.
 */
export function checkDefinitionBody(body: Json, { creating = true } = {}): DefinitionBody {
  const out: InputIssue[] = [];
  for (const key of Object.keys(body)) if (!["definition", "skills", "note"].includes(key)) out.push(issue(key, "not_allowed", `The body keeps no field ${key}.`, `Remove ${key}.`));
  out.push(...definitionIssues(body.definition, { creating }));
  if (body.skills !== undefined || creating) skillFileIssues(body.skills ?? {}, out);
  if (body.note !== undefined && !(typeof body.note === "string" && body.note.length <= 2_000)) out.push(issue("note", "wrong_type", "note is text of at most 2000 characters"));
  if (out.length) throw invalid(out);
  return { definition: body.definition as Json, ...(body.skills !== undefined || creating ? { skills: (body.skills ?? {}) as Record<string, string> } : {}), ...(typeof body.note === "string" ? { note: body.note } : {}) };
}

const TYPE_CHECK: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isSafeInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: isObject,
  array: Array.isArray,
  null: (v) => v === null,
};

/** The default input schema: `{content: string}`. */
export const DEFAULT_INPUT_SCHEMA = { type: "object", required: ["content"], properties: { content: { type: "string" } } };

/**
 * An object against a JSON Schema at its top level (a run's input against `input_schema`, a submitted output against
 * `output_schema`): each required property present, each property of a declared type of that type. Deeper keywords
 * are not checked here.
 */
export function inputIssues(input: Json, schema: Json, at = "input"): InputIssue[] {
  const out: InputIssue[] = [];
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const key of required) if (input[key] === undefined) out.push(issue(`${at}.${key}`, "missing", `${at}.${key} is required`));
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isObject(property)) {
      if (schema.additionalProperties === false) out.push(issue(`${at}.${key}`, "not_allowed", `${at} keeps no field ${key}`, `Remove ${at}.${key}.`));
      continue;
    }
    const types = (Array.isArray(property.type) ? property.type : [property.type]).filter((t): t is string => typeof t === "string" && t in TYPE_CHECK);
    if (types.length && !types.some((t) => TYPE_CHECK[t]!(value))) out.push(issue(`${at}.${key}`, "wrong_type", `${at}.${key} is not ${types.join(" or ")}`));
    if (Array.isArray(property.enum) && !property.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) out.push(issue(`${at}.${key}`, "not_an_option", `${at}.${key} is not one of the options`));
  }
  return out;
}
