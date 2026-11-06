// A 422's field issues told from the request body's schema: each with a value its field accepts (`example`), said in
// its message too, and a field the body does not keep that an object inside the same body does keep told where it
// belongs. Everything here is read from the schema; no field is named.
import type { InputIssue } from "./errors.js";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** `schema` with its `$ref`s followed through `root` (`#/components/...`). */
export function deref(root: Json, schema: unknown): Json | undefined {
  let node = schema;
  for (let depth = 0; isObject(node) && typeof node.$ref === "string" && depth < 20; depth++) {
    node = node.$ref.slice(2).split("/").reduce<unknown>((at, key) => (isObject(at) ? at[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), root);
  }
  return isObject(node) ? node : undefined;
}

/** The schema and the branches of its oneOf, anyOf and allOf, each followed. */
const branches = (root: Json, schema: Json | undefined): Json[] => {
  if (!schema) return [];
  const parts = ["oneOf", "anyOf", "allOf"].flatMap((key) => (Array.isArray(schema[key]) ? (schema[key] as unknown[]) : []));
  return [schema, ...parts.flatMap((part) => branches(root, deref(root, part)))];
};

/** The schema of `key` in an object `schema`, from the first branch that has it; never one this server refuses. */
function propertyOf(root: Json, schema: Json | undefined, key: string): Json | undefined {
  for (const branch of branches(root, schema)) {
    const property = isObject(branch.properties) ? deref(root, branch.properties[key]) : undefined;
    if (property && property["x-agentrun-serve-unsupported"] === undefined) return property;
    if (/^\d+$/.test(key) && branch.items !== undefined) return deref(root, branch.items);
  }
  return undefined;
}

/** The schema at a field's path (`definition.learning`) in the body's schema. */
export const schemaAt = (root: Json, schema: Json | undefined, path: readonly string[]): Json | undefined =>
  path.reduce<Json | undefined>((at, key) => (at ? propertyOf(root, at, key) : undefined), schema);

/** A value made from `schema`'s structure, to be checked before it is suggested: `true`, `"…"`, its least number, a list
 *  of what its items need, an object of its required properties (each its first explicit value, else made the same way). */
function derivedOf(root: Json, schema: Json | undefined, depth = 0): unknown {
  const s = deref(root, schema) ?? {};
  const [explicit] = explicitOf(s);
  if (explicit !== undefined && depth > 0) return explicit;
  const choice = (Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : [])[0];
  if (choice !== undefined && s.type === undefined && s.properties === undefined) return derivedOf(root, deref(root, choice), depth + 1);
  const type = (Array.isArray(s.type) ? s.type : [s.type]).find((t) => typeof t === "string" && t !== "null") ?? (s.properties !== undefined || Array.isArray(s.allOf) ? "object" : s.items !== undefined ? "array" : undefined);
  if (type === "boolean") return true;
  if (type === "string") return "…";
  if (type === "integer" || type === "number") return typeof s.minimum === "number" ? s.minimum : typeof s.exclusiveMinimum === "number" ? Math.floor(s.exclusiveMinimum) + 1 : 1;
  if (type === "array") return typeof s.minItems === "number" && s.minItems > 0 && depth < 6 ? [derivedOf(root, deref(root, s.items), depth + 1)] : [];
  if (type === "object" && depth < 6) {
    const out: Json = {};
    for (const branch of branches(root, s)) {
      for (const key of Array.isArray(branch.required) ? branch.required : []) {
        if (typeof key === "string" && !(key in out)) out[key] = derivedOf(root, propertyOf(root, s, key), depth + 1);
      }
    }
    return out;
  }
  return null;
}

/** What `schema` itself gives as a value: its examples, its example, its const, its options. */
const explicitOf = (s: Json): unknown[] => [...(Array.isArray(s.examples) ? s.examples : []), s.example, s.const, ...(Array.isArray(s.enum) ? s.enum : [])].filter((value) => value !== undefined);

/** Whether `value` meets `schema`: the keywords the document's request schemas use (type, const, enum, the string,
 *  number, list and object bounds, pattern, required and closed objects, oneOf, anyOf, allOf). */
export function matches(root: Json, schema: Json | undefined, value: unknown, depth = 0): boolean {
  const s = deref(root, schema);
  if (!s || depth > 12) return true;
  if (Array.isArray(s.allOf) && !s.allOf.every((part) => matches(root, deref(root, part), value, depth + 1))) return false;
  for (const key of ["oneOf", "anyOf"]) if (Array.isArray(s[key]) && !(s[key] as unknown[]).some((part) => matches(root, deref(root, part), value, depth + 1))) return false;
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(s.enum) && !s.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) return false;
  const types = (Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type]) as string[];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  if (types.length && !types.some((type) => type === kind || (type === "number" && kind === "integer"))) return false;
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) return false;
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) return false;
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if ((typeof s.minimum === "number" && value < s.minimum) || (typeof s.maximum === "number" && value > s.maximum)) return false;
    if ((typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) || (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)) return false;
  }
  if (Array.isArray(value)) {
    if ((typeof s.minItems === "number" && value.length < s.minItems) || (typeof s.maxItems === "number" && value.length > s.maxItems)) return false;
    if (s.items !== undefined && !value.every((item) => matches(root, deref(root, s.items), item, depth + 1))) return false;
  }
  if (isObject(value)) {
    const properties = isObject(s.properties) ? s.properties : {};
    if (Array.isArray(s.required) && !s.required.every((key) => typeof key !== "string" || key in value)) return false;
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        if (!matches(root, deref(root, properties[key]), child, depth + 1)) return false;
      } else if (s.additionalProperties === false) return false;
      else if (isObject(s.additionalProperties) && !matches(root, s.additionalProperties, child, depth + 1)) return false;
    }
  }
  return true;
}

/** How a 422's suggestions are checked: the operation's documented request bodies, the body that was sent, and the
 *  server's own check of a body (its field issues). Without a check, only a value the document gives that meets the schema
 *  is suggested. */
export type Told = { examples?: readonly unknown[]; body?: unknown; check?: (body: unknown) => readonly InputIssue[] };

const valueAt = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((at, key) => (isObject(at) ? at[key] : Array.isArray(at) ? at[Number(key)] : undefined), value);
/** `body` with `value` at `path`, the objects on the way made where missing. */
function withValue(body: unknown, path: readonly string[], value: unknown): Json {
  const copy: Json = isObject(body) ? structuredClone(body) : {};
  let at = copy;
  for (const key of path.slice(0, -1)) at = (isObject(at[key]) ? at[key] : (at[key] = {})) as Json;
  at[path.at(-1)!] = value;
  return copy;
}

/** A value for the field at `path` the server takes, or undefined: the documented body's value there, else what the
 *  schema gives, else one made from it. Each must pass the server's own check of the body with it in place when the route
 *  has one (no issue at the field or under it), else meet the schema; one made from the schema needs the server's check. */
function suggestion(root: Json, schema: Json, path: readonly string[], told: Told): unknown {
  const field = path.join(".");
  const passes = (value: unknown, made: boolean) => {
    if (value === undefined) return false;
    if (!told.check || told.body === undefined) return !made && matches(root, schema, value);
    return !told.check(withValue(told.body, path, value)).some((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
  };
  for (const value of [...(told.examples ?? []).map((example) => valueAt(example, path)), ...explicitOf(schema)]) if (passes(value, false)) return value;
  const made = derivedOf(root, schema);
  const empty = made === null || (typeof made === "object" && Object.keys(made).length === 0);
  return !empty && passes(made, true) ? made : undefined;
}

/** Where below `schema` an object keeps `key`, as the path to that object: the shallowest, by the properties' order. */
function homeOf(root: Json, schema: Json | undefined, key: string): string[] | undefined {
  let level: { path: string[]; schema: Json }[] = [{ path: [], schema: schema ?? {} }];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: { path: string[]; schema: Json }[] = [];
    for (const { path, schema: at } of level) {
      for (const branch of branches(root, at)) {
        for (const name of Object.keys(isObject(branch.properties) ? branch.properties : {})) {
          const child = propertyOf(root, at, name);
          if (!child) continue;
          if (propertyOf(root, child, key)) return [...path, name];
          next.push({ path: [...path, name], schema: child });
        }
      }
    }
    level = next;
  }
  return undefined;
}

/** `{a: {b: value}}` from the path `[a, b]`. */
const nested = (path: readonly string[], value: unknown): unknown => path.reduceRight((inner, key) => ({ [key]: inner }), value);
const clause = (message: string) => message.trimEnd().replace(/[.;:,]+$/, "");

/** Each issue told from `schema`, the request body's, with only values the server takes (`told`). Kept as it is: an issue
 *  that already says what to write (its own `fix`, but for a not_allowed field's that an object below keeps), one whose
 *  field the schema does not reach, and one with no value to suggest. */
export function explain(issues: readonly InputIssue[], root: Json, schema: Json | undefined, told: Told = {}): InputIssue[] {
  return issues.map((issue) => {
    if (issue.example !== undefined || typeof issue.field !== "string" || !schema) return issue;
    const path = issue.field.split(".");
    const key = path.at(-1)!;
    const parent = schemaAt(root, schema, path.slice(0, -1));
    if (issue.reason === "not_allowed") {
      // A field the object it was sent in does not have, which an object inside it does: it belongs there.
      if (!parent || propertyOf(root, parent, key)) return issue;
      const home = homeOf(root, parent, key);
      if (!home) return issue;
      const where = [...path.slice(0, -1), ...home];
      const value = suggestion(root, schemaAt(root, parent, [...home, key])!, [...where, key], told);
      const moved = `${clause(issue.message)}: ${key} belongs under ${where.join(".")}.`;
      if (value === undefined) return { ...issue, message: moved, fix: `${key} belongs under ${where.join(".")}.` };
      const example = nested(home, { [key]: value });
      return { ...issue, message: moved, fix: `${key} belongs under ${where.join(".")}: ${JSON.stringify(example)}`, example };
    }
    const field = issue.fix === undefined ? schemaAt(root, schema, path) : undefined;
    if (!field) return issue;
    const example = suggestion(root, field, path, told);
    if (example === undefined) return issue;
    const options = Array.isArray(field.enum) && field.enum.length > 1 && !field.enum.every((option) => issue.message.includes(String(option))) ? `, one of ${field.enum.map((option) => JSON.stringify(option)).join(", ")}` : "";
    return { ...issue, message: `${clause(issue.message)}${options}, e.g. ${JSON.stringify(example)}`, example };
  });
}
