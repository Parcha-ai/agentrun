// Which JSON Schema a host tool's input may use on this adapter. Written for AgentRun.
//
// The Claude Agent SDK takes a tool's input schema as zod, which the process layer's bridge builds from the tool's JSON
// Schema (zodShapeFromJsonSchema), and the CLI shows the model the JSON Schema that zod gives back. The bridge carries a
// subset; anything outside it becomes "any" or is ignored, so the model would see, and the tool would be called with, a
// looser input than the host declared. So a tool's schema may use exactly what the bridge carries, and a session whose
// tools use anything else is refused when it opens, naming the tool and where. A keyword the hosts need is added by
// mapping it in the bridge, never by letting it through.
import { CARRIED_CHECKS, CARRIED_FORMATS, inlineLocalRefs, isNullOnly } from "@parcha/agentrun-adapters/process";

/** What the bridge carries into zod. */
const CARRIED = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "nullable", "description"]);
/** What it carries only on a schema of the type it constrains (on any other it would be dropped): the bridge's own lists. */
const STRING_KEYWORDS = [...(CARRIED_CHECKS.string ?? [])];
const NUMBER_KEYWORDS = [...(CARRIED_CHECKS.number ?? [])];
const ARRAY_KEYWORDS = [...(CARRIED_CHECKS.array ?? [])];
const FORMATS = new Set(CARRIED_FORMATS);
/** What only annotates and validates nothing: accepted, and not carried. */
const ANNOTATIONS = new Set(["title", "$schema", "$id", "$comment", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isLiteral = (value: unknown) => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

/** Where `schema` uses what the bridge cannot carry, as `<JSON pointer>: <why>`; empty when it carries all of it. Local
 *  `$ref`s are judged where they lead (the bridge inlines them, as pydantic's `$defs` need); paths are of the inlined schema. */
export function toolSchemaProblems(schema: unknown): string[] {
  let inlined: unknown;
  try {
    inlined = inlineLocalRefs(schema);
  } catch (error) {
    return [`#: ${(error as Error).message}`];
  }
  return problemsAt(inlined, "#");
}

function problemsAt(schema: unknown, at: string): string[] {
  if (!isPlain(schema)) return [`${at}: a schema must be an object`];
  const problems: string[] = [];
  const { type } = schema;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  const only = types.filter((t) => t !== "null");
  const typed = (keywords: string[], ...kinds: string[]) => (only.length === 1 && kinds.includes(only[0] as string) ? keywords : []);
  const constrained = new Set([...typed(STRING_KEYWORDS, "string"), ...typed(NUMBER_KEYWORDS, "number", "integer"), ...typed(ARRAY_KEYWORDS, "array")]);
  for (const keyword of Object.keys(schema)) {
    if (CARRIED.has(keyword) || ANNOTATIONS.has(keyword) || keyword === "oneOf") continue;
    if (!constrained.has(keyword)) problems.push(`${at}: the keyword "${keyword}" is not carried to the model${[...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS].includes(keyword) ? " on this type" : ""}`);
    else if (keyword === "format" && !FORMATS.has(String(schema.format))) problems.push(`${at}: the format "${String(schema.format).slice(0, 40)}" is not carried to the model`);
    else if (keyword === "pattern") {
      try { new RegExp(String(schema.pattern)); } catch { problems.push(`${at}: "pattern" is not a regular expression`); }
    } else if (keyword !== "format" && keyword !== "pattern" && typeof schema[keyword] !== "number") problems.push(`${at}: "${keyword}" must be a number`);
  }
  if (!types.every((t) => typeof t === "string" && TYPES.has(t))) problems.push(`${at}: "type" names an unknown type`);
  if (types.filter((t) => t !== "null").length > 1) problems.push(`${at}: "type" lists more than one non-null type, which would be carried as any`);
  if ("enum" in schema && !(Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(isLiteral))) problems.push(`${at}: "enum" must list strings, numbers, booleans or null`);
  if ("const" in schema && !isLiteral(schema.const)) problems.push(`${at}: "const" must be a string, number, boolean or null`);
  if ("anyOf" in schema) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2) problems.push(`${at}: "anyOf" needs at least two schemas`);
    else schema.anyOf.forEach((option, i) => { if (!isNullOnly(option)) problems.push(...problemsAt(option, `${at}/anyOf/${i}`)); });
  }
  // oneOf is carried only as one schema or null (an Optional field); between real alternatives its "exactly one" is lost.
  if ("oneOf" in schema) {
    const options = Array.isArray(schema.oneOf) ? schema.oneOf : [];
    const plain = options.filter((o) => !isNullOnly(o));
    if (options.length === 2 && plain.length === 1) problems.push(...problemsAt(plain[0], `${at}/oneOf/${options.indexOf(plain[0])}`));
    else problems.push(`${at}: "oneOf" between real alternatives is not carried to the model (only one schema or null is)`);
  }
  if ("items" in schema) {
    if (Array.isArray(schema.items)) problems.push(`${at}: "items" as a list (a tuple) would be carried as any`);
    else problems.push(...problemsAt(schema.items, `${at}/items`));
  }
  if ("properties" in schema) {
    if (!isPlain(schema.properties)) problems.push(`${at}: "properties" must be an object`);
    else for (const [key, prop] of Object.entries(schema.properties)) problems.push(...problemsAt(prop, `${at}/properties/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  if ("required" in schema) {
    const props = isPlain(schema.properties) ? schema.properties : {};
    if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === "string")) problems.push(`${at}: "required" must list property names`);
    else for (const key of schema.required as string[]) if (!(key in props)) problems.push(`${at}: "required" names "${key}", which is not among its properties`);
  }
  if (isPlain(schema.additionalProperties)) problems.push(...problemsAt(schema.additionalProperties, `${at}/additionalProperties`));
  else if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") problems.push(`${at}: "additionalProperties" must be a boolean or a schema`);
  return problems;
}
