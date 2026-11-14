import type { FieldIssue } from "./client";
import { type ExampleInput, exampleOf, type Schema } from "./runStart";
import { choicesOf, linesOf, paramIssueWords, type ParameterText, paramValid, startText } from "./templatePackages";

// An agentic agent's input_schema (its definition's, JSON Schema 2020-12 with a top-level object), as the run forms read
// it: the run's message (`content`, reserved by the server) and one field for each other top-level property, drawn by the
// same renderer as a template's parameters (components/FieldInput.tsx). A schema whose properties the fields can't show
// is typed as JSON, whole.

export { startText };
/** A field's check as the server would make it: paramValid's, for a parameter and an input field alike. */
export const fieldValid = paramValid;

type Scalar = "string" | "number" | "integer" | "boolean";
/** One field, as the form draws it: a template's parameter, or an input_schema property. `array`: a list of `type`,
 *  typed one item a line; its `enum`, `pattern`, `format` and bounds are its items'. */
export type FieldSpec = {
  type: Scalar; array?: boolean; required: boolean;
  title?: string; description?: string; examples?: unknown[]; default?: unknown;
  enum?: (string | number | boolean)[]; pattern?: string; format?: string;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
};
/** The fields an input_schema shows, in its order, and whether the run's message is required. */
export type InputForm = { fields: [string, FieldSpec][]; contentRequired: boolean };
/** How a run form takes an agentic agent's input: its message alone (no input_schema, or one with no field but
 *  `content`); the message and the schema's fields; or the whole input as JSON, for a schema the fields can't show. */
export type AgentInput = { kind: "message" } | { kind: "fields"; form: InputForm } | { kind: "json"; example: ExampleInput };

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const SCALARS: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);
// Words that make a schema more than one plain type: the form has no widget for them.
const COMPOSED = ["oneOf", "anyOf", "allOf", "not", "if", "$ref", "const"];
const composed = (s: Json) => COMPOSED.some((k) => k in s);

const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A property as a field, or null when it is no scalar and no list of one. */
function fieldOf(s: unknown, required: boolean): FieldSpec | null {
  if (!isObject(s) || composed(s)) return null;
  const array = s.type === "array";
  const item = array ? s.items : s;
  if (!isObject(item) || composed(item) || typeof item.type !== "string" || !SCALARS.has(item.type)) return null;
  const choices = Array.isArray(item.enum) && item.enum.every((v) => ["string", "number", "boolean"].includes(typeof v)) ? (item.enum as FieldSpec["enum"]) : undefined;
  return defined<FieldSpec>({
    type: item.type as Scalar, ...(array ? { array: true } : {}), required,
    title: str(s.title), description: str(s.description), examples: Array.isArray(s.examples) ? s.examples : undefined, default: s.default,
    enum: choices, pattern: str(item.pattern), format: str(item.format),
    minimum: num(item.minimum), maximum: num(item.maximum), minLength: num(item.minLength), maxLength: num(item.maxLength),
  });
}

/** An object schema's properties as fields, in its order (`skip` left out), or null when one is no scalar and no list of
 *  one. A template's parameters (served compiled as inputs are) are always fields. */
export function schemaFields(schema: unknown, skip?: string): [string, FieldSpec][] | null {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const required = isObject(schema) && Array.isArray(schema.required) ? schema.required : [];
  const fields: [string, FieldSpec][] = [];
  for (const [key, s] of Object.entries(properties)) {
    if (key === skip) continue;
    const field = fieldOf(s, required.includes(key));
    if (!field) return null;
    fields.push([key, field]);
  }
  return fields;
}

/** How the run forms take an agent's input, from its definition's input_schema (see AgentInput). The message is
 *  required when the schema's `required` lists `content`, or when it requires no other property. */
export function agentInputOf(schema: unknown): AgentInput {
  if (!isObject(schema)) return { kind: "message" };
  const whole = (): AgentInput => ({ kind: "json", example: exampleOf(schema as Schema) });
  if (composed(schema)) return whole();
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  // A required property the schema doesn't describe has no field to fill.
  if (required.some((k) => k !== "content" && !Object.hasOwn(properties, k))) return whole();
  const fields = schemaFields(schema, "content");
  if (!fields) return whole();
  if (!fields.length) return { kind: "message" };
  return { kind: "fields", form: { fields, contentRequired: required.includes("content") || !required.some((k) => k !== "content") } };
}

/** A field's label: its title, else its key. */
export const fieldLabel = (key: string, f: FieldSpec) => f.title || key;

/** The hint in a field before anything is typed: its first example, else its default. A list's is one item a line. */
export function placeholderOf(f: FieldSpec): string | undefined {
  const given = f.examples?.length ? f.examples[0] : f.default;
  if (given === undefined || given === null) return undefined;
  return Array.isArray(given) ? given.map(String).join("\n") : typeof given === "object" ? JSON.stringify(given) : String(given);
}

/** One field's text as the input types it: a number or an integer as a number (text that is no number as typed, for the
 *  server to refuse in its own words), a box as true or false, a list one item a line. An empty optional field is not
 *  sent. An empty required one is sent as it shows (a box false, text "", a list []), for the schema to take or refuse:
 *  a schema may allow an empty value. A number has no empty value, so an empty required number is not sent. */
function typedOf(f: FieldSpec, text: string | undefined): unknown {
  const one = (v: string): unknown => {
    if (f.type === "number" || f.type === "integer") return v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
    if (f.type === "boolean") return v === "true" ? true : v === "false" ? false : v;
    return v;
  };
  if (f.array) { const items = linesOf(text); return items.length ? items.map(one) : f.required ? [] : undefined; }
  if (f.type === "boolean") return text === "true" || text === "false" ? text === "true" : f.required ? false : undefined;
  if (text === undefined || text === "") return f.required && f.type === "string" ? "" : undefined;
  return one(text);
}

/** The run form's fields as they start (startText's), and a choice with a default at it: nothing fills in a run input
 *  left out, so the default is chosen in the form, and sent as chosen. */
export function fieldStartText(form: InputForm): ParameterText {
  const start = startText(Object.fromEntries(form.fields));
  for (const [key, f] of form.fields) {
    const choices = f.array ? null : choicesOf(f);
    if (choices && f.default !== undefined && choices.includes(String(f.default))) start[key] = String(f.default);
  }
  return start;
}

/** The typed fields the form sends beside the message, in the schema's order. */
export function fieldValues(form: InputForm, text: ParameterText): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, f] of form.fields) {
    const v = typedOf(f, text[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The whole input the form sends: the message, when one is written, then the typed fields. */
export const inputOf = (form: InputForm, content: string, text: ParameterText): Record<string, unknown> =>
  ({ ...(content.trim() ? { content } : {}), ...fieldValues(form, text) });

/** The field a refusal's issue is at (`input.company`, an item's `input.topics.1`; under `root`, `parameters.repo`), or
 *  null for one at no field. */
export const fieldOfIssue = (path: string, root = "input"): string | null => path.startsWith(`${root}.`) ? path.slice(root.length + 1).split(".")[0]! : null;

const kindWords = (f: FieldSpec) => (f.type === "integer" ? "a whole number" : f.type === "number" ? "a number" : f.type === "boolean" ? "true or false" : "text");

/** What a run form says of a refused field, by its label (paramIssueWords' words for a parameter); a list's item is said
 *  as a line of it. A reason with no words here keeps the server's. */
export function fieldIssueWords(issue: FieldIssue, key: string, f: FieldSpec): string {
  const label = fieldLabel(key, f);
  if (f.array && issue.reason === "wrong_type") return issue.field.endsWith(`.${key}`) ? `${label} takes a list, one item a line.` : `Each line of ${label} is ${kindWords(f)}.`;
  if (f.array && issue.reason === "not_an_option" && f.enum?.length) return `Each line of ${label} is one of: ${f.enum.map(String).join(", ")}.`;
  return paramIssueWords(issue, key, f, label);
}

/** The typed input a run's first message carries back: the server writes it as the message (left out when there is
 *  none), a blank line, then `Input:` and the other fields as JSON in a fence longer than any run of backticks inside.
 *  Null when the message ends in no such block. */
export function typedInputFrom(message: string): Record<string, unknown> | null {
  const fence = /\n(`{3,})$/.exec(message)?.[1];
  if (!fence) return null;
  const opening = `Input:\n${fence}json\n`;
  const at = message.lastIndexOf(opening);
  if (at < 0 || (at > 0 && !message.slice(0, at).endsWith("\n\n"))) return null;
  let fields: unknown;
  try { fields = JSON.parse(message.slice(at + opening.length, message.length - fence.length - 1)); } catch { return null; }
  if (!isObject(fields)) return null;
  return { ...(at > 0 ? { content: message.slice(0, at - 2) } : {}), ...fields };
}

/** Whether an input_schema requires a field other than the message. */
export const requiresFields = (schema: unknown) =>
  isObject(schema) && Array.isArray(schema.required) && schema.required.some((k) => k !== "content");
