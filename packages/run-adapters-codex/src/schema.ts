// What the Codex adapter does about the schema of a tool, written for AgentRun. Codex 0.164.0 sanitizes the JSON Schema
// of every tool it offers its model (measured on the pinned binary, test/fixtures/schema-column.json): it drops a set of
// keywords and it drops or retypes a few shapes. So that no difference is silent:
//  - a shape Codex drops or retypes is REFUSED when the session is checked, by tool, JSON pointer and keyword;
//  - a keyword Codex only strips (a bound, a pattern, a format, a title, a default) is DESCRIBED, in plain words, in the
//    tool's description, which Codex forwards whole. The host and the DSL still validate against the original schema;
//    only the model's copy is described.

/** The keywords Codex strips and the adapter describes, with the words for each. */
const DESCRIBED: Readonly<Record<string, (value: unknown) => string | undefined>> = Object.freeze({
  minLength: (v) => `at least ${show(v)} characters`,
  maxLength: (v) => `at most ${show(v)} characters`,
  maxItems: (v) => `at most ${show(v)} items`,
  minProperties: (v) => `at least ${show(v)} properties`,
  maxProperties: (v) => `at most ${show(v)} properties`,
  minimum: (v) => `at least ${show(v)}`,
  maximum: (v) => `at most ${show(v)}`,
  exclusiveMinimum: (v) => `greater than ${show(v)}`,
  exclusiveMaximum: (v) => `less than ${show(v)}`,
  multipleOf: (v) => `a multiple of ${show(v)}`,
  pattern: (v) => `matches ${show(v)}`,
  format: (v) => `format ${show(v)}`,
  uniqueItems: (v) => (v === true ? "items are unique" : undefined),
  title: (v) => `titled ${JSON.stringify(v)}`,
  default: (v) => `default ${show(v)}`,
  examples: (v) => `examples ${show(v)}`,
  nullable: (v) => (v === true ? "may be null" : undefined),
  deprecated: (v) => (v === true ? "deprecated" : undefined),
  readOnly: (v) => (v === true ? "read only" : undefined),
  writeOnly: (v) => (v === true ? "write only" : undefined),
});
/** Keywords Codex strips that mean nothing to a model: a comment for people, the dialect marker `$schema` (Codex drops it
 *  whatever it names, and the shared check has already refused one that names no dialect the harnesses take), and the
 *  DSL's own `criteria`, which the DSL removes from the model's copy itself. Dropped without a word. */
const NOISE: readonly string[] = Object.freeze(["$comment", "$schema", "criteria"]);
/** The order the words of one position are written in. */
const ORDER = ["pattern", "format", "exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum", "multipleOf", "minLength", "maxLength", "maxItems", "minProperties", "maxProperties", "uniqueItems", "nullable", "readOnly", "writeOnly", "deprecated", "default", "examples", "title"];
export const CODEX_DESCRIBED_KEYWORDS: readonly string[] = Object.freeze(Object.keys(DESCRIBED));

/** The heading the described constraints go under, in the tool's description. */
export const DESCRIBED_HEADING = "Constraints on the arguments (checked on every call; not part of the schema you were given):";

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SCALAR = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** The keywords whose value is a map of schemas, a schema, or a list of schemas: where a schema position is. */
const SCHEMA_MAPS = ["properties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf"] as const;
const SCHEMA_ONES = ["items", "additionalProperties", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"] as const;

/** One schema position: its JSON pointer, a readable path for a person, and its node. */
interface Position { pointer: string; path: string; node: Record<string, unknown>; inAllOf: boolean }

const esc = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The schema positions directly below `node`, in the order they are visited. */
function childrenOf({ pointer, path, node, inAllOf }: Position): Position[] {
  const out: Position[] = [];
  const add = (sub: unknown, at: string, readable: string, allOf = inAllOf): void => {
    if (isObject(sub)) out.push({ pointer: at, path: readable, node: sub, inAllOf: allOf });
  };
  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (isObject(map)) for (const [name, sub] of Object.entries(map)) add(sub, `${pointer}/${key}/${esc(name)}`, key === "properties" ? `${path ? `${path}.` : ""}${name}` : `${path ? `${path}.` : ""}${key}.${name}`);
  }
  for (const key of SCHEMA_LISTS) {
    const list = node[key];
    if (Array.isArray(list)) list.forEach((sub, i) => add(sub, `${pointer}/${key}/${i}`, `${path}${path ? " " : ""}(${key} ${i + 1})`, inAllOf || key === "allOf"));
  }
  for (const key of SCHEMA_ONES) {
    const sub = node[key];
    if (isObject(sub)) add(sub, `${pointer}/${key}`, key === "items" ? `${path}[]` : `${path}${path ? "." : ""}(${key})`);
    else if (Array.isArray(sub)) sub.forEach((s, i) => add(s, `${pointer}/${key}/${i}`, `${path}[${i}]`));
  }
  for (const key of ["not", "if", "then", "else"]) add(node[key], `${pointer}/${key}`, `${path}${path ? "." : ""}(${key})`);
  if (Array.isArray(node.prefixItems)) node.prefixItems.forEach((s, i) => add(s, `${pointer}/prefixItems/${i}`, `${path}[${i}]`));
  if (isObject(node.patternProperties)) for (const [name, sub] of Object.entries(node.patternProperties)) add(sub, `${pointer}/patternProperties/${esc(name)}`, `${path}.(${name})`);
  return out;
}

/** Every schema position of `schema`, depth first, with `$defs` and union branches. A loop with its own stack, so no
 *  depth of schema overflows the call stack. */
function positions(schema: unknown): Position[] {
  const out: Position[] = [];
  if (!isObject(schema)) return out;
  const stack: Position[] = [{ pointer: "", path: "", node: schema, inAllOf: false }];
  // A node already visited is skipped, so a cycle (an object that contains itself, which only code can build) ends
  // here whichever caller reaches it. A node shared by two places (not a cycle) is walked at the first.
  const seen = new WeakSet<object>();
  for (let here = stack.pop(); here; here = stack.pop()) {
    if (seen.has(here.node)) continue;
    seen.add(here.node);
    out.push(here);
    const below = childrenOf(here);
    for (let i = below.length - 1; i >= 0; i -= 1) stack.push(below[i]!);
  }
  return out;
}

/** The shapes of `schema` Codex would drop or retype, as one refusal each: `<tool>: <pointer>: <keyword> is not supported by
 *  Codex 0.164.0 (it drops or retypes it)`. Empty when Codex carries the schema (less what is described). */
export function codexSchemaProblems(tool: string, schema: unknown): string[] {
  const problems: string[] = [];
  const refuse = (pointer: string, keyword: string) => problems.push(`${tool}: ${pointer || "/"}: ${keyword} is not supported by Codex 0.164.0 (it drops or retypes it)`);
  for (const { pointer, node } of positions(schema)) {
    if (Array.isArray(node.items)) refuse(`${pointer}/items`, "items (an array)");
    if (node.prefixItems !== undefined) refuse(`${pointer}/prefixItems`, "prefixItems");
    if (node.patternProperties !== undefined) refuse(`${pointer}/patternProperties`, "patternProperties");
    const conditional = ["if", "then", "else"].find((key) => node[key] !== undefined);
    if (conditional) refuse(`${pointer}/${conditional}`, "if/then/else");
    if (node.not !== undefined) refuse(`${pointer}/not`, "not");
    if ((Array.isArray(node.enum) && node.enum.some((v) => !SCALAR(v))) || (node.const !== undefined && !SCALAR(node.const))) refuse(`${pointer}/${node.const !== undefined && !SCALAR(node.const) ? "const" : "enum"}`, "enum with a non-scalar value");
    // With no `type`, Codex types an enum or a const `string`: a number, a boolean or a null in it would be mistyped.
    const values = Array.isArray(node.enum) ? node.enum : node.const !== undefined ? [node.const] : [];
    if (node.type === undefined && values.every(SCALAR) && values.some((v) => typeof v !== "string")) refuse(`${pointer}/${Array.isArray(node.enum) ? "enum" : "const"}`, "enum with non-string values and no type (Codex types it string)");
    for (const key of ["contains", "dependentRequired", "propertyNames"]) if (node[key] !== undefined) refuse(`${pointer}/${key}`, key);
    if (node.items === true || node.items === false) refuse(`${pointer}/items`, "items (a boolean)");
    if (Array.isArray(node.allOf) && node.allOf.some((member) => isObject(member) && positions(member).some((p) => CODEX_DESCRIBED_KEYWORDS.some((k) => k !== "title" && k !== "default" && p.node[k] !== undefined)))) refuse(`${pointer}/allOf`, "allOf with constraints in its members");
  }
  return problems;
}

/** One line per position that has a stripped keyword, sorted by JSON pointer: `<path>: <type>, <words>`. */
export function describeDropped(schema: unknown): string[] {
  const lines: [string, string][] = [];
  for (const { pointer, path, node } of positions(schema)) {
    const words = ORDER.flatMap((key) => (node[key] === undefined ? [] : [DESCRIBED[key]!(node[key])].filter((w): w is string => w !== undefined)));
    if (!words.length) continue;
    const type = typeof node.type === "string" ? [node.type] : [];
    lines.push([pointer, `${path || "(the whole value)"}: ${[...type, ...words].join(", ")}`]);
  }
  return lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, line]) => line);
}

/** The description Codex forwards for a tool: its own, then the described constraints under one heading. */
export function describedDescription(description: string, schema: unknown): string {
  const lines = describeDropped(schema);
  return lines.length ? `${description}\n\n${DESCRIBED_HEADING}\n${lines.map((l) => `- ${l}`).join("\n")}` : description;
}

/** `schema` as Codex forwards it, once its strippable keywords are gone: the original less the described keywords, a position
 *  left empty typed `{ "type": "string" }` and an object position with no `properties` given `properties: {}`, as measured.
 *  For tests, and the recorded column. */
export function stripDescribed(schema: unknown): unknown {
  const copy = structuredClone(schema);
  for (const { node } of positions(copy)) {
    let stripped = false;
    for (const key of [...CODEX_DESCRIBED_KEYWORDS, ...NOISE]) if (key in node) { delete node[key]; stripped = true; }
    // A const is an enum of one; an enum or const with no type is typed string (strings only: the others are refused).
    if (node.const !== undefined) { node.enum = [node.const]; delete node.const; }
    if (Array.isArray(node.enum) && node.type === undefined) node.type = "string";
    if (stripped && Object.keys(node).length === 0) node.type = "string";
    if (node.type === "object" && node.properties === undefined) node.properties = {};
  }
  return copy;
}
