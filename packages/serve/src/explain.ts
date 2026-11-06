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

/** A value `schema` accepts, made from it alone: its first example, its const or its first option; else by its type,
 *  `true`, `"…"`, its least number, a list of what its items need, an object of its required properties. */
export function acceptedOf(root: Json, schema: Json | undefined, depth = 0): unknown {
  const s = deref(root, schema) ?? {};
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const choice = (Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : [])[0];
  if (choice !== undefined && s.type === undefined && s.properties === undefined) return acceptedOf(root, deref(root, choice), depth + 1);
  const type = (Array.isArray(s.type) ? s.type : [s.type]).find((t) => typeof t === "string" && t !== "null") ?? (s.properties !== undefined || Array.isArray(s.allOf) ? "object" : s.items !== undefined ? "array" : undefined);
  if (type === "boolean") return true;
  if (type === "string") return "…";
  if (type === "integer" || type === "number") return typeof s.minimum === "number" ? s.minimum : typeof s.exclusiveMinimum === "number" ? Math.floor(s.exclusiveMinimum) + 1 : 1;
  if (type === "array") return typeof s.minItems === "number" && s.minItems > 0 && depth < 6 ? [acceptedOf(root, deref(root, s.items), depth + 1)] : [];
  if (type === "object" && depth < 6) {
    const out: Json = {};
    for (const branch of branches(root, s)) {
      for (const key of Array.isArray(branch.required) ? branch.required : []) {
        if (typeof key === "string" && !(key in out)) out[key] = acceptedOf(root, propertyOf(root, s, key), depth + 1);
      }
    }
    return out;
  }
  return type === "object" ? {} : null;
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

/** Each issue told from `schema`, the request body's. Kept as it is: an issue that already says what to write (its own
 *  `fix`, but for a not_allowed field's that an object below keeps), one whose field the schema does not reach, and one
 *  whose schema gives nothing to write (an open object, an empty list). */
export function explain(issues: readonly InputIssue[], root: Json, schema: Json | undefined): InputIssue[] {
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
      const example = nested(home, { [key]: acceptedOf(root, schemaAt(root, parent, [...home, key])) });
      const where = [...path.slice(0, -1), ...home].join(".");
      return { ...issue, message: `${clause(issue.message)}: ${key} belongs under ${where}.`, fix: `${key} belongs under ${where}: ${JSON.stringify(example)}`, example };
    }
    const field = issue.fix === undefined ? schemaAt(root, schema, path) : undefined;
    if (!field) return issue;
    const example = acceptedOf(root, field);
    if (example === null || (typeof example === "object" && Object.keys(example).length === 0)) return issue;
    const options = Array.isArray(field.enum) && field.enum.length > 1 && !field.enum.every((option) => issue.message.includes(String(option))) ? `, one of ${field.enum.map((option) => JSON.stringify(option)).join(", ")}` : "";
    return { ...issue, message: `${clause(issue.message)}${options}, e.g. ${JSON.stringify(example)}`, example };
  });
}
