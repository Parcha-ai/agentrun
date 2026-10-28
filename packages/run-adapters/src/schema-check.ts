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
const SCHEMA_ONE = new Set(["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "not", "if", "then", "else"]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

/** Where `schema`, the input schema of the tool `tool`, is refused on every harness, as `<tool>: <JSON pointer>: <why>`;
 *  empty when it may be used. */
export function toolSchemaProblems(tool: string, schema: unknown): string[] {
  if (!isPlain(schema) || schema.type !== "object") {
    return [`${tool}: /: the root must be {"type": "object"} (a tool's input is an object of arguments), not ${JSON.stringify(isPlain(schema) ? schema.type ?? null : schema).slice(0, 60)}`];
  }
  const problems: string[] = [];
  metaschema ??= new Ajv2020({ strict: false, allErrors: true });
  if (!metaschema.validateSchema(schema)) {
    // One problem per place: the metaschema's own anyOf wrappers repeat a place's failure.
    const seen = new Set<string>();
    for (const error of metaschema.errors ?? []) {
      if (error.keyword === "anyOf" || seen.has(error.instancePath)) continue;
      seen.add(error.instancePath);
      problems.push(`${tool}: ${pointer(error.instancePath)}: ${error.message ?? "invalid"} (not valid JSON Schema 2020-12)`);
    }
  }
  // Only where a schema sits: a "$ref" inside default, examples, const or enum is a value, and a property's name is a name.
  const walk = (node: unknown, at: string) => {
    if (!isPlain(node)) return;
    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) problems.push(`${tool}: ${at}/$ref: a remote $ref (${JSON.stringify(ref).slice(0, 80)}) is refused; only a local one ("#/$defs/...") is followed`);
    for (const [key, value] of Object.entries(node)) {
      const here = `${at}/${escape(key)}`;
      if (SCHEMA_MAPS.has(key) && isPlain(value)) for (const [name, sub] of Object.entries(value)) walk(sub, `${here}/${escape(name)}`);
      else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) value.forEach((sub, i) => walk(sub, `${here}/${i}`));
      else if (SCHEMA_ONE.has(key)) walk(value, here);
    }
  };
  walk(schema, "");
  return problems;
}
