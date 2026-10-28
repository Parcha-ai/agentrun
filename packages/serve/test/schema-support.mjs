// A JSON Schema check for tests, over the keywords the contract uses: $ref within the document, allOf, oneOf, anyOf,
// if/then/else, type, enum, const, properties, required, additionalProperties, propertyNames, items, minItems,
// maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum, exclusiveMinimum. `format` and
// `discriminator` add nothing a value must meet here. Answers each problem as "path: what".

const TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isSafeInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: Array.isArray,
  null: (v) => v === null,
};

export function schemaProblems(doc, schema, value, at = "$") {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
    if (target === undefined) return [`${at}: ${schema.$ref} does not resolve`];
    const { $ref: _, ...rest } = schema;
    return [...schemaProblems(doc, target, value, at), ...schemaProblems(doc, rest, value, at)];
  }
  const out = [];
  for (const part of schema.allOf ?? []) out.push(...schemaProblems(doc, part, value, at));
  if (schema.oneOf && schema.oneOf.filter((part) => schemaProblems(doc, part, value, at).length === 0).length !== 1) out.push(`${at}: not exactly one of oneOf`);
  if (schema.anyOf && !schema.anyOf.some((part) => schemaProblems(doc, part, value, at).length === 0)) out.push(`${at}: none of anyOf`);
  if (schema.if !== undefined) {
    const branch = schemaProblems(doc, schema.if, value, at).length === 0 ? schema.then : schema.else;
    out.push(...schemaProblems(doc, branch, value, at));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPES[t]?.(value))) return [...out, `${at}: is not ${types.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) out.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: under ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: over ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push(`${at}: not over ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${at}: items repeat`);
    if (schema.items !== undefined) value.forEach((item, i) => out.push(...schemaProblems(doc, schema.items, item, `${at}[${i}]`)));
  }
  if (TYPES.object(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${at}.${key}: is required`);
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) out.push(...schemaProblems(doc, schema.propertyNames, key, `${at}{${key}}`));
      if (key in properties) out.push(...schemaProblems(doc, properties[key], item, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${key}: is not a field here`);
      else if (typeof schema.additionalProperties === "object") out.push(...schemaProblems(doc, schema.additionalProperties, item, `${at}.${key}`));
    }
  }
  return out;
}
