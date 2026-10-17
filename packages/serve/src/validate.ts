// Structural checks of request bodies against the contract's schemas, as field issues (`422 input_invalid`).
import { type InputIssue, invalid } from "./errors.js";

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^/\\\u0000][^\\\u0000]*$/;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const DEFINITION_FIELDS = ["id", "version", "name", "description", "instructions", "skills", "tools", "input_schema", "output_schema", "workflow", "max_cost_usd"];
const REQUIRED = ["version", "name", "instructions", "skills", "tools"];

const issue = (field: string, reason: string, message: string, fix?: string): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });

function names(value: unknown, field: string, out: InputIssue[]): void {
  if (!Array.isArray(value)) return void out.push(issue(field, "wrong_type", `${field} is not a list of names`));
  if (!value.every((name) => typeof name === "string" && name !== "")) out.push(issue(field, "wrong_type", `${field} holds an item that is not a non-empty string`));
  else if (new Set(value).size !== value.length) out.push(issue(field, "duplicate", `${field} names one item twice`));
}

/** A definition as `POST /agents` takes it (`DefinitionInput`): exactly the fields an agent home keeps. */
export function definitionIssues(definition: unknown, at = "definition"): InputIssue[] {
  if (!isObject(definition)) return [issue(at, definition === undefined ? "missing" : "wrong_type", `${at} is not an object`)];
  const out: InputIssue[] = [];
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_FIELDS.includes(key)) {
      const why = key === "model" || key === "thinking" ? "The definition names no model; the host binds it." : `The definition keeps no field ${key}.`;
      out.push(issue(`${at}.${key}`, "not_allowed", why, `Remove ${at}.${key}.`));
    }
  }
  for (const key of REQUIRED) if (definition[key] === undefined) out.push(issue(`${at}.${key}`, "missing", `${at}.${key} is required`));
  const d = definition;
  if (d.id !== undefined && (typeof d.id !== "string" || !ID.test(d.id))) out.push(issue(`${at}.id`, "bad_format", `${at}.id must match ${ID.source}`));
  if (d.version !== undefined && (!Number.isSafeInteger(d.version) || (d.version as number) < 1)) out.push(issue(`${at}.version`, "wrong_type", `${at}.version is not a positive integer`));
  if (d.name !== undefined && (typeof d.name !== "string" || d.name === "")) out.push(issue(`${at}.name`, typeof d.name === "string" ? "too_short" : "wrong_type", `${at}.name is not a non-empty string`));
  if (d.description !== undefined && typeof d.description !== "string") out.push(issue(`${at}.description`, "wrong_type", `${at}.description is not a string`));
  if (d.instructions !== undefined && typeof d.instructions !== "string") out.push(issue(`${at}.instructions`, "wrong_type", `${at}.instructions is not a string`));
  if (d.skills !== undefined) names(d.skills, `${at}.skills`, out);
  if (d.tools !== undefined) names(d.tools, `${at}.tools`, out);
  for (const key of ["input_schema", "output_schema", "workflow"]) if (d[key] !== undefined && !isObject(d[key])) out.push(issue(`${at}.${key}`, "wrong_type", `${at}.${key} is not an object`));
  if (d.max_cost_usd !== undefined && !(typeof d.max_cost_usd === "number" && Number.isFinite(d.max_cost_usd) && d.max_cost_usd >= 0)) out.push(issue(`${at}.max_cost_usd`, "wrong_type", `${at}.max_cost_usd is not a non-negative number`));
  return out;
}

/** `AgentCreate`: `{definition, skills?}`. Throws `422 input_invalid` naming every field that is wrong. */
export function checkAgentCreate(body: Json): { definition: Json; skills: Record<string, string> } {
  const out: InputIssue[] = [];
  for (const key of Object.keys(body)) if (key !== "definition" && key !== "skills") out.push(issue(key, "not_allowed", `The body keeps no field ${key}.`, `Remove ${key}.`));
  out.push(...definitionIssues(body.definition));
  const skills = body.skills ?? {};
  if (!isObject(skills)) out.push(issue("skills", "wrong_type", "skills is not an object of paths to text"));
  else {
    for (const [path, text] of Object.entries(skills)) {
      if (path.length > 512 || !SKILL_PATH.test(path)) out.push(issue(`skills.${path}`, "bad_format", `the skill path ${JSON.stringify(path)} is not a relative path inside .agents/skills/`));
      else if (typeof text !== "string") out.push(issue(`skills.${path}`, "wrong_type", `the skill ${path} is not text`));
    }
  }
  if (out.length) throw invalid(out);
  return { definition: body.definition as Json, skills: skills as Record<string, string> };
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

/** An output against the definition's `output_schema`: its required keys present and each top-level property of its
 *  declared type, nothing deeper (the caller checks that it is an object). */
export const outputIssues = (output: Json, schema: Json): InputIssue[] => inputIssues(output, schema, "output").filter((i) => i.reason === "missing" || i.reason === "wrong_type");

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
