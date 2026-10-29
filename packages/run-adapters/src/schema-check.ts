// What every harness adapter refuses in a tool's input schema before a session starts. Written for AgentRun.
//
// Three checks, the same on every harness so their columns agree by construction: the root is `{ "type": "object" }`
// (a tool's input is an object of arguments; on the pinned Claude CLI one tool with any other root loses every tool of
// the session, the submit tool too); the schema is valid JSON Schema 2020-12 (what Anthropic's API checks, and an
// invalid schema means nothing on any harness); and no `$ref` leaves the schema (a remote one is fetched by no harness,
// so the model never sees what it names). A local `$ref` into `$defs` is fine. Each adapter's `check()` calls this
// first, then adds only its own harness's measured refusals.
import { Ajv2020 } from "ajv/dist/2020.js";

let metaschema: Ajv2020 | undefined;

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (path: string) => path || "/";
const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The keywords whose value is a schema, a list of schemas, or a map of names to schemas (JSON Schema 2020-12, with the
 *  older spellings a generator still writes). Every other keyword holds values (default, examples, const, enum, ...). */
const SCHEMA_ONE = new Set(["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "not", "if", "then", "else", "contentSchema"]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

/** The `$schema` dialects Anthropic's API takes (measured; with or without a trailing "#"). Any other value, or one that
 *  is not a string, it rejects. A schema is checked as 2020-12 whichever of these it names, as the API does. */
const DIALECTS = new Set([
  "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema", "http://json-schema.org/draft-06/schema", "http://json-schema.org/draft-04/schema",
]);

/** Where `schema`, the input schema of the tool `tool`, is refused on every harness, as `<tool>: <JSON pointer>: <why>`;
 *  empty when it may be used. */
export function toolSchemaProblems(tool: string, schema: unknown): string[] {
  if (!isPlain(schema) || schema.type !== "object") {
    return [`${tool}: /: the root must be {"type": "object"} (a tool's input is an object of arguments), not ${String(JSON.stringify(isPlain(schema) ? schema.type ?? null : schema) ?? schema).slice(0, 60)}`];
  }
  // A schema is sent as JSON: one that is not JSON (a cycle in its objects, a BigInt) is refused before anything walks it.
  try {
    JSON.stringify(schema);
  } catch (error) {
    return [`${tool}: /: the schema is not JSON (${String((error as Error)?.message ?? error).split("\n")[0]!.slice(0, 80)}); a tool's input schema is sent as JSON`];
  }
  const problems: string[] = [];
  const { $schema: dialect, ...body } = schema;
  if (dialect !== undefined && !(typeof dialect === "string" && DIALECTS.has(dialect.replace(/#$/, "")))) {
    problems.push(`${tool}: /$schema: ${String(JSON.stringify(dialect)).slice(0, 80)} names no JSON Schema dialect (2020-12, 2019-09, draft-07, -06 or -04)`);
  }
  metaschema ??= new Ajv2020({ strict: false, allErrors: true });
  let valid: boolean;
  try {
    valid = metaschema.validateSchema(body) as boolean;
  } catch (error) {
    problems.push(`${tool}: /: ${String((error as Error)?.message ?? error).slice(0, 120)} (not valid JSON Schema 2020-12)`);
    valid = true;
  }
  if (!valid) {
    // One problem per place: the metaschema's own anyOf wrappers repeat a place's failure.
    const seen = new Set<string>();
    for (const error of metaschema.errors ?? []) {
      if (error.keyword === "anyOf" || seen.has(error.instancePath)) continue;
      seen.add(error.instancePath);
      problems.push(`${tool}: ${pointer(error.instancePath)}: ${error.message ?? "invalid"} (not valid JSON Schema 2020-12)`);
    }
  }
  // Only where a schema sits: a "$ref" inside default, examples, const or enum is a value, and a property's name is a name.
  // A loop with its own stack, not recursion, so no depth of schema can overflow it.
  const pending: [unknown, string][] = [[schema, ""]];
  while (pending.length) {
    const [node, at] = pending.pop()!;
    if (!isPlain(node)) continue;
    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) problems.push(`${tool}: ${at}/$ref: a remote $ref (${JSON.stringify(ref).slice(0, 80)}) is refused; only a local one ("#/$defs/...") is followed`);
    const next: [unknown, string][] = [];
    for (const [key, value] of Object.entries(node)) {
      const here = `${at}/${escape(key)}`;
      if (SCHEMA_MAPS.has(key) && isPlain(value)) for (const [name, sub] of Object.entries(value)) next.push([sub, `${here}/${escape(name)}`]);
      else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) value.forEach((sub, i) => next.push([sub, `${here}/${i}`]));
      else if (SCHEMA_ONE.has(key)) next.push([value, here]);
    }
    // Children in reverse onto the stack, so they're visited in the schema's order.
    for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i]!);
  }
  return problems;
}
