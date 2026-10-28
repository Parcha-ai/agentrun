// What the JSON Schema to zod bridge (zod.ts) carries beyond its upstream subset. Written for AgentRun.
//
// A tool schema reaches a harness's model through zod, so a keyword the bridge drops leaves the model a looser schema
// than the host declared. These are the common validation keywords, each on the type it constrains, carried as zod
// checks (which zod gives back in the JSON Schema the model is shown), the annotations carried as zod 4's metadata, and
// the Optional shape (one schema or null). What a harness may not use is decided with the same lists (the Claude Agent
// adapter's toolSchemaProblems).

// biome-ignore lint/suspicious/noExplicitAny: a zod type of whichever zod the caller passes.
type ZodType = any;
type Schema = Record<string, unknown>;

/** The formats zod 3 and 4 both check, by their JSON Schema name. */
export const CARRIED_FORMATS: readonly string[] = Object.freeze(["email", "uri", "url", "uuid", "date-time", "date"]);
/** The validation keywords carried, by the type each constrains. */
export const CARRIED_CHECKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  string: ["minLength", "maxLength", "pattern", "format"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  array: ["minItems", "maxItems"],
});

const num = (schema: Schema, key: string) => (typeof schema[key] === "number" ? (schema[key] as number) : undefined);

/** `type` with the checks `schema`'s keywords make for its one non-null type. */
export function carryChecks(type: ZodType, schema: Schema): ZodType {
  const kinds = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t) => typeof t === "string" && t !== "null");
  const kind = kinds.length === 1 ? (kinds[0] as string) : undefined;
  if (kind === "string") {
    if (num(schema, "minLength") !== undefined) type = type.min(num(schema, "minLength"));
    if (num(schema, "maxLength") !== undefined) type = type.max(num(schema, "maxLength"));
    if (typeof schema.pattern === "string") type = type.regex(new RegExp(schema.pattern));
    if (schema.format === "email") type = type.email();
    else if (schema.format === "uri" || schema.format === "url") type = type.url();
    else if (schema.format === "uuid") type = type.uuid();
    else if (schema.format === "date-time") type = type.datetime({ offset: true });
    else if (schema.format === "date") type = type.date();
  } else if (kind === "number" || kind === "integer") {
    if (num(schema, "minimum") !== undefined) type = type.gte(num(schema, "minimum"));
    if (num(schema, "maximum") !== undefined) type = type.lte(num(schema, "maximum"));
    if (num(schema, "exclusiveMinimum") !== undefined) type = type.gt(num(schema, "exclusiveMinimum"));
    if (num(schema, "exclusiveMaximum") !== undefined) type = type.lt(num(schema, "exclusiveMaximum"));
    if (num(schema, "multipleOf") !== undefined) type = type.multipleOf(num(schema, "multipleOf"));
  } else if (kind === "array") {
    if (num(schema, "minItems") !== undefined) type = type.min(num(schema, "minItems"));
    if (num(schema, "maxItems") !== undefined) type = type.max(num(schema, "maxItems"));
  }
  return type;
}

/** `type` with `schema`'s title, examples and default as metadata, for the model to read; they check nothing. */
export function carryAnnotations(type: ZodType, schema: Schema): ZodType {
  const annotations: Schema = {};
  if (typeof schema.title === "string") annotations.title = schema.title;
  if (Array.isArray(schema.examples)) annotations.examples = schema.examples;
  if ("default" in schema) annotations.default = schema.default;
  return Object.keys(annotations).length && typeof type.meta === "function" ? type.meta(annotations) : type;
}

/** `{ "type": "null" }`, with at most a title or description beside it. */
export function isNullOnly(schema: unknown): boolean {
  return schema !== null && typeof schema === "object" && !Array.isArray(schema) && (schema as Schema).type === "null" && Object.keys(schema).every((k) => ["type", "title", "description"].includes(k));
}

/** Of a union's options, the one schema beside null (an Optional field), or undefined when it is a real union. */
export function optionalOf<T>(options: readonly T[]): T | undefined {
  const plain = options.filter((o) => !isNullOnly(o));
  return options.length === 2 && plain.length === 1 ? plain[0] : undefined;
}
