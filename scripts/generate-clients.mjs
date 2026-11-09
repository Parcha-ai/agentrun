#!/usr/bin/env node
// The CLI's command table, from the OpenAPI document the server serves: one entry per operation it offers, and the
// agentrun-cli skill from the same table (scripts/clients/skill.mjs): its SKILL.md and references/commands.md. The
// TypeScript client's operations (scripts/clients/typescript.mjs) come from the same projection, under the same hash.
// From the same document, the console's API types (scripts/clients/types.mjs): apps/console/src/lib/api.generated.ts.
//   node scripts/generate-clients.mjs           write packages/agentrun/lib/commands.generated.mjs, the skill,
//                                               packages/client/src/operations.generated.ts and the console's types
//   node scripts/generate-clients.mjs --check   fail when a committed file is not the document's, or the skill names a
//                                               command or flag the CLI does not have
// It reads the built server (packages/serve/dist), so it runs after the build. --out, --skill (the skill's folder),
// --client (the TypeScript client's file), --types (the console's types), --resources and --document (a document as
// JSON, in place of the built server's) name other files.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FLAGS, WAIT } from '../packages/agentrun/lib/follow.mjs';
import { SECRETS } from '../packages/agentrun/lib/login.mjs';
import { SKILL_INSTALL } from '../packages/agentrun/lib/skill.mjs';
import { TEMPLATE_VALIDATE } from '../packages/agentrun/lib/template.mjs';
import { allCommands, recipeProblems, referenceText, skillText } from './clients/skill.mjs';
import { clientProblems, clientText } from './clients/typescript.mjs';
import { typesOf, typesText } from './clients/types.mjs';
import { isMain } from './is-main.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = 'packages/agentrun/lib/commands.generated.mjs';
const RESOURCES = 'scripts/clients/resources.json';
const SKILL = 'packages/agentrun/skills/agentrun-cli';
const CLIENT = 'packages/client/src/operations.generated.ts';
const TYPES = 'apps/console/src/lib/api.generated.ts';
// Words the launcher keeps for itself or for the server it starts, and the CLI's own commands of one word: no command
// may begin with one.
const RESERVED = ['api', 'help', 'import', 'reset-password', 'login', 'logout', 'skill'];
// The CLI's hand-written commands: none may be a generated one too.
const HAND = { flags: FLAGS, wait: WAIT, local: [...SECRETS, SKILL_INSTALL, TEMPLATE_VALIDATE] };
const SCALAR = ['string', 'number', 'integer', 'boolean'];
const GLOBAL_FLAGS = ['base-url', 'data', 'body', 'body-type', 'help'];
// Headers the CLI sets itself.
const OWN_HEADERS = ['authorization', 'content-type', 'accept'];
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

/** The document as the built server serves it, its turned-off operations marked as the server marks them. */
export async function servedDocument() {
  const dist = (file) => import(pathToFileURL(resolve(root, 'packages/serve/dist', file)).href);
  await dist('quiet-sqlite-warning.js');
  const [{ openapiDocument }, { ROUTES }] = await Promise.all([dist('openapi.js'), dist('server.js')]);
  return openapiDocument((operationId) => ROUTES.find((route) => route.name === operationId)?.capability);
}

/** JSON with every object's keys sorted, so the hash is the content's and not its key order's. */
export const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
// The CLI's flag for a field, as cli.mjs names it.
const flagOf = (name) => name.replace(/_/g, '-').toLowerCase();

function deref(doc, node) {
  for (let depth = 0; node && typeof node.$ref === 'string' && depth < 20; depth++) {
    node = node.$ref.slice(2).split('/').reduce((at, key) => at?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return node;
}

/** A schema as a flag reads it: its type and its enum, nothing else. */
function shapeOf(doc, schema) {
  const s = deref(doc, schema) ?? {};
  return { type: s.type ?? null, enum: Array.isArray(s.enum) ? s.enum : null };
}

/** A shape's flag type, when one value on the command line can hold it: a scalar type, or an enum of strings. */
function flagType(shape) {
  if (shape.enum?.every((v) => typeof v === 'string')) return { type: 'string', enum: shape.enum };
  const types = (Array.isArray(shape.type) ? shape.type : [shape.type]).filter((type) => type !== 'null');
  return types.length === 1 && SCALAR.includes(types[0]) ? { type: types[0] } : undefined;
}

const firstLine = (text) => (text ?? '').split('\n')[0].trim();
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;
const COMPONENT = '#/components/schemas/';
// The JSON Schema types the client's types are made of, and the keywords that shape a value beyond them.
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];
const UNTYPED = ['prefixItems', 'patternProperties', 'dependentSchemas', 'dependentRequired', 'unevaluatedProperties', 'unevaluatedItems', 'contains', '$dynamicRef'];

/** A schema as a type reads it: its structure only (type, enum, const, properties, required, items, additional
 *  properties, oneOf, anyOf, allOf), no description or bound, so a change of wording changes no type. A component it
 *  names is inlined, marked with its name, so the projection holds every type whole and a client can name it. */
function typeOf(doc, schema) {
  if (schema === true || schema === undefined || schema === null) return {};
  if (schema === false) return { not: {} };
  if (typeof schema.$ref === 'string' && !schema.$ref.startsWith(COMPONENT)) throw new Error(`generate-clients: a type cannot follow ${schema.$ref}, a reference outside ${COMPONENT}`);
  const name = typeof schema.$ref === 'string' && schema.$ref.startsWith(COMPONENT) ? schema.$ref.slice(COMPONENT.length) : undefined;
  const s = deref(doc, schema) ?? {};
  // A keyword that shapes the value beyond what a client's type is made of fails here, loudly, never dropped: a type
  // without it would be wrong. A keyword that only narrows (if/then/else, not, pattern, bounds) leaves the type wider.
  const shaping = UNTYPED.find((keyword) => s[keyword] !== undefined);
  if (shaping) throw new Error(`generate-clients: the client's types cannot express ${shaping}${name ? ` (in ${name})` : ''}; teach typeOf and scripts/clients/typescript.mjs to`);
  const types = (Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type]).filter((type) => !SCHEMA_TYPES.includes(type));
  if (types.length) throw new Error(`generate-clients: the client's types know no type ${types.join(', ')}${name ? ` (in ${name})` : ''}`);
  const out = name ? { name } : {};
  for (const key of ['type', 'enum', 'const', 'required']) if (s[key] !== undefined) out[key] = s[key];
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([key, value]) => [key, typeOf(doc, value)]));
  if (s.additionalProperties !== undefined) out.additionalProperties = typeof s.additionalProperties === 'boolean' ? s.additionalProperties : typeOf(doc, s.additionalProperties);
  if (s.items !== undefined) out.items = typeOf(doc, s.items);
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(s[key])) out[key] = s[key].map((part) => typeOf(doc, part));
  return out;
}

/** The type of an operation's JSON answers, one per success status that has one; null when none is JSON. */
function answerOf(doc, op) {
  const types = Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status)).flatMap(([, response]) => Object.entries(deref(doc, response)?.content ?? {}).filter(([type]) => JSON_TYPE.test(type)).map(([, media]) => typeOf(doc, media.schema)));
  const distinct = [...new Map(types.map((type) => [canonical(type), type])).values()];
  return distinct.length === 0 ? null : distinct.length === 1 ? distinct[0] : { oneOf: distinct };
}

/** What the clients are made of, and all of it: per operation, its route, names, parameters, request body (its types,
 *  top-level fields and its JSON schema's type), success answers' media types and JSON type, and whether the server turns
 *  it off. Every generated file's header holds this projection's hash, so a change elsewhere in the document (a
 *  description) leaves them as they are. */
export function operationsOf(doc) {
  const found = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const params = new Map();
      for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = deref(doc, raw);
        params.set(`${p.in} ${p.name}`, { name: p.name, in: p.in, required: p.required === true, ...shapeOf(doc, p.schema), description: firstLine(p.description) });
      }
      const body = deref(doc, op.requestBody);
      const media = body?.content?.['application/json'];
      const schema = deref(doc, media?.schema);
      // The JSON body's first documented example (an OpenAPI 3.1 media type's examples, else its example).
      const example = Object.values(media?.examples ?? {}).map((e) => deref(doc, e)?.value).find((value) => value !== undefined) ?? media?.example;
      found.push({
        operationId: op.operationId, method: method.toUpperCase(), path, tags: op.tags ?? [], summary: op.summary ?? firstLine(op.description),
        unsupported: op['x-agentrun-serve-unsupported'] !== undefined, parameters: [...params.values()],
        body: body === undefined ? null : {
          required: body.required === true, types: Object.keys(body.content ?? {}),
          properties: Object.entries(schema?.properties ?? {}).map(([name, property]) => ({ name, ...shapeOf(doc, property), ...(deref(doc, property)?.const !== undefined ? { const: deref(doc, property).const } : {}), required: schema.required?.includes(name) ?? false, description: firstLine(deref(doc, property)?.description) })),
          type: schema === undefined ? null : typeOf(doc, body.content['application/json'].schema),
          ...(example !== undefined ? { example } : {}),
        },
        answers: Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status)).flatMap(([, response]) => Object.keys(deref(doc, response)?.content ?? {})),
        answer: answerOf(doc, op),
        // The headers a success answers with, as the document declares them (ETag, Location): a client returns the ones
        // a later request needs, an ETag for If-Match.
        answerHeaders: [...new Set(Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status)).flatMap(([, response]) => Object.keys(deref(doc, response)?.headers ?? {})))].sort(),
      });
    }
  }
  return found;
}

/** The string fields of a body schema, each as its path of property names; `*` stands for any key of a map
 *  (additionalProperties), whose every value a body may name as it likes. */
function stringPaths(doc, schema, path = [], seen = new Set()) {
  const s = deref(doc, schema);
  if (!s || typeof s !== 'object' || seen.has(s)) return [];
  seen = new Set([...seen, s]);
  const found = [...['oneOf', 'anyOf', 'allOf'].flatMap((key) => (s[key] ?? []).flatMap((part) => stringPaths(doc, part, path, seen)))];
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes('string') || s.enum?.some((v) => typeof v === 'string')) found.push(path);
  for (const [name, property] of Object.entries(s.properties ?? {})) found.push(...stringPaths(doc, property, [...path, name], seen));
  if (s.additionalProperties && typeof s.additionalProperties === 'object') found.push(...stringPaths(doc, s.additionalProperties, [...path, '*'], seen));
  // A list's items: `[]`, each of them, which a public field may name (`scopes.[]`), unlike a map's values.
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) found.push(...stringPaths(doc, s.items, [...path, '[]'], seen));
  return found;
}

/** What is wrong with the map's public fields (the string fields of a secret body that are no secret, which the CLI
 *  leaves in what it prints): one that is not a secret body's, or not one of its body's string fields by its full path,
 *  or one under a map, whose values are always secrets. */
export function publicFieldProblems(doc, map) {
  const problems = [];
  for (const [id, fields] of Object.entries(map.publicFields ?? {})) {
    if (!map.secretBody.includes(id)) problems.push(`${RESOURCES} names public fields of ${id}, whose body is no secret body`);
    let schema;
    for (const item of Object.values(doc.paths ?? {})) for (const method of METHODS) if (item[method]?.operationId === id) schema = deref(doc, item[method].requestBody)?.content?.['application/json']?.schema;
    const paths = new Set(stringPaths(doc, schema).filter((path) => !path.includes('*')).map((path) => path.join('.')));
    for (const field of fields) if (!paths.has(field)) problems.push(`${RESOURCES} names ${id}'s public field ${field}, which is not a string field of its body (by its full path, under no map)`);
  }
  return problems;
}

/** An operation's command: the map's name, else its tag and its operationId. */
export const commandOf = (op, map) => map.commands[op.operationId] ?? [op.tags[0] ?? 'api', kebab(op.operationId)];

/** What is wrong with the map against the operations: a name used twice, a name inside another, a reserved word, an
 *  entry (a name, a secret body, an omitted operation, a file path parameter) for an operation or a parameter the
 *  document no longer has. */
export function problemsOf(ops, map) {
  const ids = new Set(ops.map((op) => op.operationId));
  const problems = [];
  for (const id of [...Object.keys(map.commands), ...map.secretBody, ...Object.keys(map.omit), ...Object.keys(map.multiSegment)]) {
    if (!ids.has(id)) problems.push(`${RESOURCES} names ${id}, which the document has no operation for`);
  }
  for (const [id, fill] of Object.entries(map.bodyFill ?? {})) {
    const op = ops.find((o) => o.operationId === id);
    if (!op) problems.push(`${RESOURCES} names ${id}, which the document has no operation for`);
    else for (const [name, value] of Object.entries(fill)) {
      const property = op.body?.properties.find((p) => p.name === name);
      if (!property) problems.push(`${RESOURCES} fills ${id}'s body field ${name}, which its body does not have`);
      else if (property.const !== undefined && canonical(property.const) !== canonical(value)) problems.push(`${RESOURCES} fills ${id}'s body field ${name} with another value than its const`);
    }
  }
  for (const [id, name] of Object.entries(map.multiSegment)) {
    const op = ops.find((o) => o.operationId === id);
    if (op && !op.path.includes(`{${name}}`)) problems.push(`${RESOURCES} names ${id}'s path parameter ${name}, which its route ${op.path} does not have`);
  }
  const byName = new Map();
  for (const op of ops) {
    const command = commandOf(op, map);
    const name = command.join(' ');
    if (byName.has(name)) problems.push(`${byName.get(name)} and ${op.operationId} are both "${name}"`);
    byName.set(name, op.operationId);
    if (RESERVED.includes(command[0])) problems.push(`${op.operationId} begins with "${command[0]}", a word the launcher keeps`);
  }
  for (const name of byName.keys()) {
    if (byName.has(name.split(' ')[0]) && name.includes(' ')) problems.push(`"${name.split(' ')[0]}" is a command and a group of commands (${name})`);
  }
  for (const { command } of [HAND.wait, ...HAND.local]) {
    if (byName.has(command.join(' '))) problems.push(`${byName.get(command.join(' '))} is "${command.join(' ')}", a command the CLI writes by hand`);
  }
  return problems;
}

/** The table: one entry per operation the server offers, sorted by command. */
export function commandsOf(ops, map) {
  const entries = [];
  for (const op of ops) {
    if (op.unsupported || map.omit[op.operationId] !== undefined) continue;
    const flag = (p) => ({ name: p.name, ...(flagType(p) ?? { type: 'string' }), required: p.required, description: p.description });
    const query = op.parameters.filter((p) => p.in === 'query').map(flag);
    const taken = new Set([...GLOBAL_FLAGS, ...query.map((q) => flagOf(q.name))]);
    const headers = op.parameters.filter((p) => p.in === 'header' && !OWN_HEADERS.includes(p.name.toLowerCase()) && !taken.has(flagOf(p.name))).map(flag);
    for (const h of headers) taken.add(flagOf(h.name));
    const secretBody = map.secretBody.includes(op.operationId);
    const bodyFlags = secretBody ? [] : (op.body?.properties ?? []).flatMap((p) => {
      const type = flagType(p);
      return type && !taken.has(flagOf(p.name)) ? [{ name: p.name, ...type, required: p.required, description: p.description }] : [];
    });
    // What a body made of flags alone carries besides them: each required field the document fixes to one value (its
    // const), and what the map fills (an MCP request's id). A whole --body is sent as given.
    const bodyFill = secretBody ? {} : {
      ...Object.fromEntries((op.body?.properties ?? []).filter((p) => p.required && p.const !== undefined).map((p) => [p.name, p.const])),
      ...(map.bodyFill?.[op.operationId] ?? {}),
    };
    entries.push({
      command: commandOf(op, map), operationId: op.operationId, method: op.method, path: op.path,
      pathParams: [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
      // The path parameters that are file paths, slashes kept: the rest are encoded whole.
      multiSegment: map.multiSegment[op.operationId] ? [map.multiSegment[op.operationId]] : [],
      // A secret body's string fields that are no secret, by their full path: every other one is cut from what is printed.
      ...(secretBody ? { publicFields: map.publicFields[op.operationId] ?? [] } : {}),
      query, headers, bodyFlags, ...(Object.keys(bodyFill).length ? { bodyFill } : {}), hasBody: op.body !== null, bodyRequired: op.body?.required === true, bodyTypes: op.body?.types ?? [], secretBody,
      // A working body, as the document gives it: the command's help prints it as a --body to paste. Never a secret body's.
      ...(op.body?.example !== undefined && !secretBody ? { example: op.body.example } : {}),
      // A download: its answer is the file's bytes, written as received.
      raw: op.answers.length > 0 && !op.answers.includes('application/json'),
      summary: op.summary,
    });
  }
  return entries.sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

const hashOf = (ops) => createHash('sha256').update(canonical(ops)).digest('hex');

/** The console's types, their header holding the hash of what they are made of (typesOf). */
export function consoleTypesText(doc) {
  const types = typesOf(doc);
  return typesText(types, hashOf(types));
}

/** The skill's files, by their path under its folder, and what its text names that the CLI does not have. Its header
 *  holds the table's hash: both are made of the same projection. */
export function skillFiles(ops, map) {
  const commands = allCommands(commandsOf(ops, map), HAND);
  const skill = skillText(commands, hashOf(ops));
  return { files: { 'SKILL.md': skill, 'references/commands.md': referenceText(commands, hashOf(ops)) }, problems: recipeProblems(commands, skill) };
}

/** The routes whose body is a secret, offered or omitted: what the CLI's raw call guards. */
const secretRoutesOf = (ops, map) => ops.filter((op) => !op.unsupported && map.secretBody.includes(op.operationId))
  .map((op) => ({ operationId: op.operationId, method: op.method, path: op.path, publicFields: map.publicFields[op.operationId] ?? [] }))
  .sort((a, b) => a.operationId.localeCompare(b.operationId));

export function tableText(ops, map) {
  const hash = hashOf(ops);
  return [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// SHA-256 of what the table is made of (operationsOf in scripts/generate-clients.mjs): ${hash}`,
    `export const COMMANDS = ${JSON.stringify(commandsOf(ops, map), null, 2)};`,
    '',
    '// Every route whose body carries a secret, a command\'s or one with no command (omitted): a raw `api` call to one never',
    '// takes its body from the command line, and what it prints has the body\'s values cut, its public fields kept.',
    `export const SECRET_ROUTES = ${JSON.stringify(secretRoutesOf(ops, map), null, 2)};`,
    '',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, out: { type: 'string' }, skill: { type: 'string' }, client: { type: 'string' }, resources: { type: 'string' }, document: { type: 'string' }, types: { type: 'string' } } });
  const map = { secretBody: [], omit: {}, multiSegment: {}, publicFields: {}, bodyFill: {}, ...JSON.parse(await readFile(resolve(root, values.resources ?? RESOURCES), 'utf8')) };
  const doc = values.document ? JSON.parse(await readFile(resolve(values.document), 'utf8')) : await servedDocument();
  const ops = operationsOf(doc);
  const problems = [...problemsOf(ops, map), ...publicFieldProblems(doc, map), ...clientProblems(ops, map, commandOf)];
  if (problems.length) {
    console.error(`The command map does not fit the document:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const skill = skillFiles(ops, map);
  if (skill.problems.length) {
    console.error(`The skill's template does not fit the CLI:\n${skill.problems.map((p) => `  ${p}`).join('\n')}\nFix the template in scripts/clients/skill.mjs.`);
    process.exitCode = 1;
    return;
  }
  const outputs = [[values.out ?? OUTPUT, tableText(ops, map)], ...Object.entries(skill.files).map(([file, text]) => [join(values.skill ?? SKILL, file), text]), [values.client ?? CLIENT, clientText(ops, map, commandOf, hashOf(ops))], [values.types ?? TYPES, consoleTypesText(doc)]];
  if (values.check) {
    const stale = [];
    for (const [file, text] of outputs) if (await readFile(resolve(root, file), 'utf8').catch(() => '') !== text) stale.push(file);
    if (stale.length) {
      console.error(`${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} not the server's document's; run node scripts/generate-clients.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log('The CLI command table, its skill, the TypeScript client\'s operations and the console\'s API types match the server\'s OpenAPI document');
  } else {
    for (const [file, text] of outputs) {
      await mkdir(dirname(resolve(root, file)), { recursive: true });
      await writeFile(resolve(root, file), text);
      console.log(`Generated ${file}`);
    }
  }
}

if (isMain(import.meta)) await main();
