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
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${at}/${i}`));
    if (!isPlain(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const here = `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) problems.push(`${tool}: ${here}: a remote $ref (${JSON.stringify(value).slice(0, 80)}) is refused; only a local one ("#/$defs/...") is followed`);
      else walk(value, here);
    }
  };
  walk(schema, "");
  return problems;
}
