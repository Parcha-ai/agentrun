// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/zod.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: the doc comment names the Claude Agent SDK; 2026-10-28: local $refs inlined (refs.ts), and
// the checks, annotations and Optional shape of zod-carry.ts carried.
/**
 * JSON Schema to zod, for harness SDKs whose tool APIs take zod (the Claude
 * Agent SDK's in-process MCP tools, OpenCode's plugin tools). `HostTool`s carry
 * JSON Schema; this converts the subset tool schemas use.
 *
 * zod is passed in (`import { z } from 'zod'`, v3 or v4) so this package
 * does not pin one: use the one the harness SDK was built against.
 *
 * Adapted from the AI SDK's bridge (vercel/ai cbb6b49,
 * `packages/harness-claude-code/src/bridge/json-schema-to-zod.ts`,
 * Apache-2.0); changed to take `z` as a parameter and to export the shape.
 */

import { inlineLocalRefs } from './refs.js';
import { carryAnnotations, carryChecks, optionalOf } from './zod-carry.js';

// biome-ignore lint/suspicious/noExplicitAny: whichever zod the caller passes.
type Z = any;
// biome-ignore lint/suspicious/noExplicitAny: a zod type of that zod.
type ZodType = any;

type JsonLiteral = string | number | boolean | null;

export interface JsonSchemaObject {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: boolean | JsonSchemaObject;
  required?: string[];
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  nullable?: boolean;
}

/** A zod object for a JSON Schema object (extra properties allowed unless `additionalProperties: false`). */
export function zodFromJsonSchema(schema: unknown, z: Z): ZodType {
  const inlined = inlineLocalRefs(schema);
  return toZodObject(isSchema(inlined) ? inlined : {}, z);
}

/** The raw shape (`{ key: zodType }`) of a JSON Schema object, for APIs that take a shape. */
export function zodShapeFromJsonSchema(schema: unknown, z: Z): Record<string, ZodType> {
  const inlined = inlineLocalRefs(schema);
  return toZodShape(isSchema(inlined) ? inlined : undefined, z);
}

function toZodObject(schema: JsonSchemaObject, z: Z): ZodType {
  const object = z.object(toZodShape(schema, z));
  if (schema.additionalProperties === false) return object.strict();
  // JSON Schema allows additional properties by default; zod strips them.
  return object.catchall(isSchema(schema.additionalProperties) ? toZodType(schema.additionalProperties, z) : z.unknown());
}

function toZodShape(schema: JsonSchemaObject | undefined, z: Z): Record<string, ZodType> {
  if (!schema?.properties) return {};
  const required = new Set(schema.required);
  const shape: Record<string, ZodType> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let type = toZodType(prop, z);
    if (!required.has(key)) type = type.optional();
    if (prop.description) type = type.describe(prop.description);
    shape[key] = type;
  }
  return shape;
}

function toZodType(schema: JsonSchemaObject | undefined, z: Z): ZodType {
  if (!schema) return z.any();
  let type = forConst(schema, z) ?? forEnum(schema, z) ?? forUnion(schema, z) ?? carryChecks(forType(schema, z), schema as Record<string, unknown>);
  if (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'))) type = type.nullable();
  if (schema.description) type = type.describe(schema.description);
  return carryAnnotations(type, schema as Record<string, unknown>);
}

function forType(schema: JsonSchemaObject, z: Z): ZodType {
  const types = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : ([schema.type].filter(Boolean) as string[]);
  if (types.length > 1) return z.any();
  if (Array.isArray(schema.type) && types.length === 0) return z.null();
  switch (types[0] ?? (schema.properties ? 'object' : undefined)) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(Array.isArray(schema.items) ? z.any() : toZodType(schema.items, z));
    case 'object':
      return toZodObject(schema, z);
    case 'null':
      return z.null();
    default:
      return z.any();
  }
}

function forConst(schema: JsonSchemaObject, z: Z): ZodType | undefined {
  if (!('const' in schema)) return undefined;
  return isLiteral(schema.const) ? z.literal(schema.const) : z.any();
}

function forEnum(schema: JsonSchemaObject, z: Z): ZodType | undefined {
  if (!Array.isArray(schema.enum)) return undefined;
  if (!schema.enum.every(isLiteral)) return z.any();
  const values = schema.enum as JsonLiteral[];
  if (values.length === 0) return z.any();
  if (values.length === 1) return z.literal(values[0]);
  return z.union(values.map((v) => z.literal(v)));
}

function forUnion(schema: JsonSchemaObject, z: Z): ZodType | undefined {
  const options = schema.anyOf ?? schema.oneOf;
  if (!options || options.length < 2) return undefined;
  const optional = optionalOf(options);
  if (optional) return toZodType(optional, z).nullable();
  return z.union(options.map((o) => toZodType(o, z)));
}

function isSchema(input: unknown): input is JsonSchemaObject {
  return input != null && typeof input === 'object' && !Array.isArray(input);
}

function isLiteral(value: unknown): value is JsonLiteral {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
