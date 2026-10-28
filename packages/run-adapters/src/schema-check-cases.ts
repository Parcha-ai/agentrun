// The cases `toolSchemaProblems` decides, for every adapter's own check() tests: each harness runs the same table, so
// their columns agree by test. Written for AgentRun.

/** One case: the input schema, and where it is refused (JSON pointers), or `[]` when it may be used. */
export interface SchemaCheckCase {
  name: string;
  schema: unknown;
  refusedAt: string[];
}

const P = { a: { type: "string" }, b: { type: "string" } };
/** A schema `depth` objects deep, each one property down. */
const nested = (depth: number): Record<string, unknown> => {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < depth; i += 1) schema = { type: "object", properties: { a: schema } };
  return schema;
};

export const SCHEMA_CHECK_CASES: readonly SchemaCheckCase[] = Object.freeze([
  // The root: an object of arguments, nothing else.
  { name: "a root with no type", schema: { properties: P, required: ["a"] }, refusedAt: ["/"] },
  { name: "a root anyOf of objects", schema: { anyOf: [{ type: "object", properties: P }, { type: "object" }] }, refusedAt: ["/"] },
  { name: "a root of type array", schema: { type: "array", items: { type: "string" } }, refusedAt: ["/"] },
  { name: 'a root of type ["object", "null"]', schema: { type: ["object", "null"], properties: P }, refusedAt: ["/"] },
  { name: "a root that is only a $ref", schema: { $ref: "#/$defs/X", $defs: { X: { type: "object", properties: P } } }, refusedAt: ["/"] },
  { name: "a root that is not a schema object", schema: "object", refusedAt: ["/"] },
  { name: "no schema at all", schema: undefined, refusedAt: ["/"] },
  // JSON Schema 2020-12.
  { name: 'a type of "strng"', schema: { type: "object", properties: { a: { type: "strng" } } }, refusedAt: ["/properties/a/type"] },
  { name: "a minimum given as a string", schema: { type: "object", properties: { n: { type: "number", minimum: "1" } } }, refusedAt: ["/properties/n/minimum"] },
  { name: "required not an array", schema: { type: "object", properties: P, required: "a" }, refusedAt: ["/required"] },
  { name: "tuple items (an array of schemas)", schema: { type: "object", properties: { t: { type: "array", items: [{ type: "string" }, { type: "number" }] } } }, refusedAt: ["/properties/t/items"] },
  // $schema: a dialect Anthropic's API takes (measured: 2020-12, 2019-09, draft-07, -06, -04), or refused there.
  { name: "a $schema of draft-07", schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: P }, refusedAt: [] },
  { name: "a $schema of 2020-12", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: P }, refusedAt: [] },
  { name: "a $schema that is not a string", schema: { $schema: 42, type: "object", properties: P }, refusedAt: ["/$schema"] },
  { name: "a $schema naming no dialect", schema: { $schema: "https://example.com/unknown", type: "object", properties: P }, refusedAt: ["/$schema"] },
  // A check never throws: a schema so deep the metaschema check overflows is a problem at "/", and so is one deeper still.
  { name: "a schema 2,000 objects deep (the metaschema check overflows)", schema: nested(2_000), refusedAt: ["/"] },
  { name: "a schema 5,000 objects deep", schema: nested(5_000), refusedAt: ["/"] },
  { name: "a schema 100 objects deep", schema: nested(100), refusedAt: [] },
  // $ref: local followed, remote refused.
  { name: "a remote $ref by URL", schema: { type: "object", properties: { r: { $ref: "https://example.com/schema.json" } } }, refusedAt: ["/properties/r/$ref"] },
  { name: "a remote $ref by file", schema: { type: "object", properties: { r: { $ref: "other.json#/x" } } }, refusedAt: ["/properties/r/$ref"] },
  { name: "a local $ref into $defs", schema: { type: "object", properties: { r: { $ref: "#/$defs/X" } }, $defs: { X: { type: "object", properties: P } } }, refusedAt: [] },
  {
    name: "a remote $ref in a schema position deep inside (anyOf in $defs)",
    schema: { type: "object", properties: { r: { $ref: "#/$defs/X" } }, $defs: { X: { anyOf: [{ $ref: "https://example.com/a.json" }, { type: "null" }] } } },
    refusedAt: ["/$defs/X/anyOf/0/$ref"],
  },
  {
    name: "a remote $ref in a contentSchema (a schema position)",
    schema: { type: "object", properties: { payload: { type: "string", contentMediaType: "application/json", contentSchema: { $ref: "https://example.com/payload.json" } } } },
    refusedAt: ["/properties/payload/contentSchema/$ref"],
  },
  // Values, not schemas: a "$ref" key inside default, examples, const or enum is data, and a property named "$ref" is a name.
  { name: 'a "$ref" inside a default (a value)', schema: { type: "object", properties: { d: { type: "object", default: { $ref: "data-template.json" } } } }, refusedAt: [] },
  { name: 'a "$ref" inside examples (values)', schema: { type: "object", properties: { d: { type: "object", examples: [{ $ref: "https://example.com/x.json" }] } } }, refusedAt: [] },
  { name: 'a "$ref" inside a const (a value)', schema: { type: "object", properties: { c: { const: { $ref: "other.json#/y" } } } }, refusedAt: [] },
  { name: 'a "$ref" inside an enum (values)', schema: { type: "object", properties: { e: { enum: [{ $ref: "z.json" }, null] } } }, refusedAt: [] },
  { name: 'a property named "$ref" (a name)', schema: { type: "object", properties: { $ref: { type: "string" } } }, refusedAt: [] },
  // What may be used.
  { name: "an empty object", schema: { type: "object" }, refusedAt: [] },
  { name: "an open object", schema: { type: "object", additionalProperties: true }, refusedAt: [] },
  {
    name: "a generated schema (titles, defaults, formats, bounds, a nullable union, prefixItems)",
    schema: {
      type: "object",
      title: "Input",
      properties: {
        q: { type: "string", title: "Q", minLength: 1, pattern: "^[a-z]+$" },
        when: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }], default: null },
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false },
        n: { type: "integer", minimum: 0, maximum: 4 },
      },
      required: ["q"],
      additionalProperties: false,
    },
    refusedAt: [],
  },
]);
