/** Zod documents _zod.def as the traversal interface for schema tools:
 * https://zod.dev/packages/core. Keep this dependency-free and fail closed on new
 * constructs: the JSON interpreter cannot execute a schema library's parser hooks. */
const TYPES = new Set([
  "string", "number", "boolean", "null", "literal", "enum", "object", "array",
  "tuple", "record", "union", "intersection", "optional", "nullable", "nonoptional",
  "any", "unknown", "never",
]);
const CHECKS = new Set([
  "less_than", "greater_than", "multiple_of", "number_format", "min_length",
  "max_length", "length_equals", "string_format",
]);
const SCHEMA_KEYWORDS = new Set([
  "$ref", "$schema", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$defs", "definitions",
  "type", "enum", "const", "properties", "patternProperties", "additionalProperties", "required",
  "propertyNames", "dependentRequired", "dependentSchemas", "dependencies", "unevaluatedProperties",
  "items", "prefixItems", "additionalItems", "contains", "minContains", "maxContains", "unevaluatedItems",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
  "uniqueItems", "minProperties", "maxProperties", "contentEncoding", "contentMediaType", "contentSchema",
]);
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertZodJsonContract(schema: unknown, inputRoot = false): void {
  const seen = new Set<object>();
  const fail = (path: string, reason: string): never => {
    throw new Error(`${path}: ${reason}; use JSON-representable Zod schemas and put parsing or custom checks in an explicit workflow step`);
  };
  const check = (value: unknown, path: string): void => {
    if (!record(value) || !record(value._zod) || !record(value._zod.def)) fail(path, "unsupported Zod check representation");
    const def = (value as { _zod: { def: RecordValue } })._zod.def;
    if (!CHECKS.has(String(def.check))) fail(path, `Zod check ${String(def.check)} is not supported`);
    if (def.check === "string_format" && !(def.pattern instanceof RegExp) && def.format !== "url") {
      fail(path, `Zod format ${String(def.format)} has no JSON-runtime validation rule`);
    }
    if (def.pattern instanceof RegExp && def.pattern.flags) fail(path, "regular-expression flags do not survive JSON Schema conversion");
    if (def.normalize || def.hostname || def.protocol) fail(path, "URL normalization and custom URL constraints do not survive JSON Schema conversion");
  };
  const visit = (value: unknown, path: string): void => {
    if (!record(value) || !record(value._zod) || !record(value._zod.def)) fail(path, "unsupported Zod schema representation");
    const node = value as RecordValue & { _zod: { def: RecordValue }; meta?: () => RecordValue | undefined };
    if (seen.has(node)) return;
    seen.add(node);
    const def = node._zod.def;
    if (!TYPES.has(String(def.type))) fail(path, `Zod ${String(def.type)} is not supported`);
    if (def.coerce) fail(path, "Zod coercion is not supported");
    if (typeof node.meta === "function") {
      const metadata = node.meta();
      for (const key of Object.keys(metadata ?? {})) if (SCHEMA_KEYWORDS.has(key)) fail(path, `metadata cannot override JSON Schema keyword ${key}`);
    }
    if (def.check !== undefined) check(node, path);
    if (def.checks !== undefined) {
      if (!Array.isArray(def.checks)) fail(path, "unsupported Zod checks representation");
      (def.checks as unknown[]).forEach((entry, index) => check(entry, `${path}.checks[${index}]`));
    }
    if (def.type === "object") {
      if (!record(def.shape)) fail(path, "unsupported Zod object shape");
      for (const [key, child] of Object.entries(def.shape as RecordValue)) visit(child, `${path}.${key}`);
      if (def.catchall !== undefined) visit(def.catchall, `${path}.*`);
    }
    for (const field of ["element", "innerType", "keyType", "valueType", "left", "right", "rest"]) {
      if (def[field] !== undefined && def[field] !== null) visit(def[field], `${path}.${field}`);
    }
    for (const field of ["options", "items"]) {
      if (def[field] === undefined) continue;
      if (!Array.isArray(def[field])) fail(path, `unsupported Zod ${field} representation`);
      (def[field] as unknown[]).forEach((child, index) => visit(child, `${path}.${field}[${index}]`));
    }
  };
  visit(schema, "schema");
  if (inputRoot) {
    const objectInput = (value: unknown): boolean => {
      const def = (value as { _zod: { def: RecordValue } })._zod.def;
      if (def.type === "object" || def.type === "record") return true;
      if (def.type === "union") return (def.options as unknown[]).every(objectInput);
      if (def.type === "intersection") return objectInput(def.left) || objectInput(def.right);
      if (def.type === "nonoptional") return objectInput(def.innerType);
      return false;
    };
    if (!objectInput(schema)) fail("schema", "workflow input must be an object schema, or a union/intersection constrained to objects");
  }
}
