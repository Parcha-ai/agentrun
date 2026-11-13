// The computer tools' schemas (computer-surface.generated.ts) as the strictest providers read them. computer_act's steps
// are typed, one anyOf of the protocol's closed step shapes with no words, so a provider can constrain a call to them:
//  - OpenAI's strict mode: the root an object; every object closed, every property in `required` (an optional one a
//    union with null, as a strict request makes it: strictOf below); only the keywords strict mode takes;
//  - Gemini's `parametersJsonSchema` (the field pi-ai sends a Gemini model its tools in): only the JSON Schema keywords
//    Gemini reads, no `const` (it ignores it), enums of strings or numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_TOOL_SCHEMAS } from "@parcha/agentrun-kernel/kernel";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** The keywords OpenAI's strict mode takes. */
const OPENAI_STRICT = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const", "description", "$ref", "$defs", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems"]);
/** The JSON Schema keywords Gemini's parametersJsonSchema reads. */
const GEMINI_JSON_SCHEMA = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required"]);

/** Every subschema of `schema`, with its path. */
function* walk(schema, path = "$") {
  yield [path, schema];
  for (const [name, property] of Object.entries(schema.properties ?? {})) yield* walk(property, `${path}.${name}`);
  if (isObject(schema.items)) yield* walk(schema.items, `${path}[]`);
  for (const [index, variant] of (schema.anyOf ?? []).entries()) yield* walk(variant, `${path}|${index}`);
}

/** `schema` as a strict request sends it: every property required, an optional one a union with null. */
function strictOf(schema) {
  const out = { ...schema };
  if (isObject(schema.items)) out.items = strictOf(schema.items);
  if (schema.anyOf) out.anyOf = schema.anyOf.map(strictOf);
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name, required.has(name) ? strictOf(property) : { anyOf: [strictOf(property), { type: "null" }] }]));
    out.required = Object.keys(schema.properties);
  }
  return out;
}

/** What breaks OpenAI's strict rules in `schema`, as `path: why`. */
function openAiStrictProblems(schema) {
  const problems = [];
  if (schema.type !== "object" || schema.anyOf) problems.push("$: the root must be an object, not a union");
  for (const [path, node] of walk(schema)) {
    for (const key of Object.keys(node)) if (!OPENAI_STRICT.has(key)) problems.push(`${path}: ${key} is not a strict keyword`);
    if (node.type === "object") {
      if (node.additionalProperties !== false) problems.push(`${path}: an object must be closed`);
      const names = Object.keys(node.properties ?? {});
      if (JSON.stringify([...(node.required ?? [])].sort()) !== JSON.stringify([...names].sort())) problems.push(`${path}: every property must be required`);
    }
    if (path.split(/[.[|]/).length > 11) problems.push(`${path}: deeper than strict mode's 10 levels`);
  }
  return problems;
}

/** What Gemini's parametersJsonSchema would not read in `schema`, as `path: why`. */
function geminiProblems(schema) {
  const problems = [];
  for (const [path, node] of walk(schema)) {
    for (const key of Object.keys(node)) if (!GEMINI_JSON_SCHEMA.has(key)) problems.push(`${path}: ${key} is not a keyword Gemini reads`);
    if (node.enum && !node.enum.every((value) => typeof value === "string" || typeof value === "number")) problems.push(`${path}: an enum of strings or numbers`);
  }
  return problems;
}

test("computer_act types its steps: one anyOf of the protocol's nine step shapes, each closed, with its required fields and no words", () => {
  const steps = COMPUTER_TOOL_SCHEMAS.computer_act.properties.steps;
  const shapes = steps.items.anyOf;
  assert.deepEqual(shapes.map((shape) => Object.keys(shape.properties)[0]), ["press", "set", "perform", "click", "type", "key", "nav", "scroll", "drag"]);
  for (const shape of shapes) {
    assert.equal(shape.type, "object");
    assert.equal(shape.additionalProperties, false, JSON.stringify(shape));
    assert.ok(shape.required.includes(Object.keys(shape.properties)[0]), JSON.stringify(shape));
  }
  assert.deepEqual(shapes[1].required.sort(), ["set", "value"]);
  assert.ok(!JSON.stringify(steps.items).includes('"description"'), "no words below the tool's own parameters");
});

for (const [tool, schema] of Object.entries(COMPUTER_TOOL_SCHEMAS)) {
  test(`${tool}'s schema is closed everywhere, and passes OpenAI's strict rules once a strict request makes its optionals nullable`, () => {
    for (const [path, node] of walk(schema)) if (node.type === "object") assert.equal(node.additionalProperties, false, `${tool} ${path}: closed`);
    assert.deepEqual(openAiStrictProblems(strictOf(schema)), []);
  });
  test(`${tool}'s schema is one Gemini's parametersJsonSchema reads whole`, () => {
    assert.deepEqual(geminiProblems(schema), []);
  });
}

test("the checks catch what they check: an open object, a const and a tuple of unlike items are named", () => {
  const bad = { type: "object", properties: { a: { type: "object", properties: {} }, b: { const: "x" }, c: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } }, required: ["a"] };
  const strict = openAiStrictProblems(strictOf(bad));
  assert.ok(strict.some((problem) => problem.startsWith("$: an object must be closed")), strict.join("\n"));
  assert.ok(strict.some((problem) => problem.includes("prefixItems is not a strict keyword")), strict.join("\n"));
  assert.ok(geminiProblems(bad).some((problem) => problem.includes("const is not a keyword Gemini reads")));
});
