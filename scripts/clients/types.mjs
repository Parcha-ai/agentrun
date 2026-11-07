// The console's API types (apps/console/src/lib/api.generated.ts), generated with the CLI's command table
// (generate-clients.mjs) from the same OpenAPI document: one TypeScript type per schema of components.schemas, and per
// operation the JSON body it takes and the JSON it answers with on success. A small JSON Schema to TypeScript emitter:
// what a schema says about a value's shape (types, enums, consts, properties, required, items, unions, intersections),
// nothing it says about a value's range or format.

// The keywords that make a value's shape: every other one (descriptions, examples, formats, bounds, marks) is dropped
// before the hash, so a change to a description leaves the file as it is.
const SHAPE = ['$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'oneOf', 'anyOf', 'allOf'];
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const SCHEMAS = '#/components/schemas/';

function shapeOnly(schema) {
  if (schema === true || schema === false || schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(shapeOnly);
  const kept = {};
  for (const key of SHAPE) {
    if (schema[key] === undefined) continue;
    const value = schema[key];
    if (key === 'properties') kept.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, shapeOnly(property)]));
    else if (key === 'enum' || key === 'const' || key === 'required' || key === 'type' || key === '$ref') kept[key] = value;
    else kept[key] = shapeOnly(value);
  }
  return kept;
}

function derefAny(doc, node) {
  for (let depth = 0; node && typeof node.$ref === 'string' && depth < 20; depth++) {
    node = node.$ref.slice(2).split('/').reduce((at, key) => at?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return node;
}

/** What the types are made of, and all of it: each schema's shape, and each operation's JSON body and JSON success
 *  answers' shapes. The header's hash is this projection's. */
export function typesOf(doc) {
  const schemas = Object.fromEntries(Object.entries(doc.components?.schemas ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, schema]) => [name, shapeOnly(schema)]));
  const operations = {};
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const body = derefAny(doc, op.requestBody)?.content?.['application/json']?.schema;
      const answers = Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status))
        .map(([status, response]) => [status, derefAny(doc, response)?.content?.['application/json']?.schema])
        .filter(([, schema]) => schema !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
      operations[op.operationId] = {
        ...(body !== undefined ? { body: shapeOnly(body) } : {}),
        answers: Object.fromEntries(answers.map(([status, schema]) => [status, shapeOnly(schema)])),
      };
    }
  }
  return { schemas, operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))) };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const keyOf = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
/** Whether a type's text has `|` or `&` outside its brackets and strings, so it needs parentheses inside another. */
function compound(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if ('{[(<'.includes(c)) depth++;
    else if ('}])>'.includes(c)) depth--;
    else if (depth === 0 && (c === '|' || c === '&')) return true;
  }
  return false;
}
const wrap = (text) => (compound(text) ? `(${text})` : text);
const union = (parts) => {
  const unique = [...new Set(parts)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.length === 1 ? unique[0] : unique.map((part) => (/ & /.test(part) && compound(part) ? `(${part})` : part)).join(' | ');
};

/** A schema's TypeScript type, `indent` the depth of the line it starts on. */
export function typeOf(schema, indent = 0) {
  if (schema === true || schema === undefined || schema === null) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith(SCHEMAS)) throw new Error(`a $ref the types cannot follow: ${schema.$ref}`);
    return `components[${JSON.stringify(schema.$ref.slice(SCHEMAS.length))}]`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value)));
  const parts = [];
  const { oneOf, anyOf, allOf, ...rest } = schema;
  const alternatives = [...(oneOf ?? []), ...(anyOf ?? [])];
  const hasOwn = Object.keys(rest).length > 0;
  if (hasOwn) parts.push(ownTypeOf(rest, indent));
  if (alternatives.length) parts.push(union(alternatives.map((part) => typeOf(part, indent))));
  for (const part of allOf ?? []) parts.push(typeOf(part, indent));
  if (parts.length === 0) return 'unknown';
  // A schema with its own keywords beside oneOf/anyOf (a `type` and a list of shapes) is each shape: its own `type`
  // only narrows them, so it stands only when it holds properties.
  if (alternatives.length && hasOwn && !rest.properties && !rest.items && rest.additionalProperties === undefined) parts.shift();
  return parts.length === 1 ? parts[0] : parts.map(wrap).join(' & ');
}

function ownTypeOf(schema, indent) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type !== undefined ? [schema.type] : [schema.properties || schema.additionalProperties !== undefined ? 'object' : schema.items || schema.prefixItems ? 'array' : null];
  return union(types.map((type) => {
    switch (type) {
      case 'string': return 'string';
      case 'number': case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': return arrayOf(schema, indent);
      case 'object': return objectOf(schema, indent);
      default: return 'unknown';
    }
  }));
}

function arrayOf(schema, indent) {
  if (Array.isArray(schema.prefixItems)) return `[${schema.prefixItems.map((item) => typeOf(item, indent)).join(', ')}${schema.items === false ? '' : `, ...${wrap(typeOf(schema.items, indent))}[]`}]`;
  return `${wrap(typeOf(schema.items, indent))}[]`;
}

function objectOf(schema, indent) {
  const properties = Object.entries(schema.properties ?? {});
  const extra = schema.additionalProperties;
  const index = extra && typeof extra === 'object' ? typeOf(extra, indent) : null;
  if (properties.length === 0) return extra === false ? 'Record<string, never>' : `Record<string, ${index ?? 'unknown'}>`;
  const pad = '  '.repeat(indent + 1);
  const required = new Set(schema.required ?? []);
  const lines = properties.map(([name, property]) => `${pad}${keyOf(name)}${required.has(name) ? '' : '?'}: ${typeOf(property, indent + 1)};`);
  const text = `{\n${lines.join('\n')}\n${'  '.repeat(indent)}}`;
  // A map with named properties too: each value the index's, beside the named ones.
  return index ? `${text} & Record<string, ${index}>` : text;
}

/** The file: `components`, each schema by name, and `operations`, each operation by its operationId with its JSON
 *  `body` (never when it takes none) and its JSON `answer` (each success status's, as one union). */
export function typesText(types, hash) {
  const lines = [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// SHA-256 of what the types are made of (typesOf in scripts/clients/types.mjs): ${hash}`,
    '/* eslint-disable */',
    '',
    'export interface components {',
  ];
  for (const [name, schema] of Object.entries(types.schemas)) lines.push(`  ${keyOf(name)}: ${typeOf(schema, 1)};`);
  lines.push('}', '', 'export interface operations {');
  for (const [id, op] of Object.entries(types.operations)) {
    const answers = Object.values(op.answers);
    lines.push(`  ${keyOf(id)}: {`);
    lines.push(`    body: ${op.body === undefined ? 'never' : typeOf(op.body, 2)};`);
    lines.push(`    answer: ${answers.length ? union(answers.map((schema) => typeOf(schema, 2))) : 'never'};`);
    lines.push('  };');
  }
  lines.push('}', '');
  return lines.join('\n');
}
