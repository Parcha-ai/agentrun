#!/usr/bin/env node
// The CLI's command table, from the OpenAPI document the server serves: one entry per operation it offers.
//   node scripts/generate-clients.mjs           write packages/agentrun/lib/commands.generated.mjs
//   node scripts/generate-clients.mjs --check   fail when the committed table is not the document's
// It reads the built server (packages/serve/dist), so it runs after the build. --out, --resources and --document (a
// document as JSON, in place of the built server's) name other files.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from './is-main.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = 'packages/agentrun/lib/commands.generated.mjs';
const RESOURCES = 'scripts/clients/resources.json';
// Words the launcher keeps for itself or for the server it starts: no command may begin with one.
const RESERVED = ['api', 'help', 'import', 'reset-password'];
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

/** What the table is made of, and all of it: per operation, its route, names, parameters, request body (its types and
 *  top-level fields), success answers' types and whether the server turns it off. The header's hash is this projection's,
 *  so a change elsewhere in the document (a response schema's description) leaves the table as it is. */
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
          properties: Object.entries(schema?.properties ?? {}).map(([name, property]) => ({ name, ...shapeOf(doc, property), required: schema.required?.includes(name) ?? false, description: firstLine(deref(doc, property)?.description) })),
          ...(example !== undefined ? { example } : {}),
        },
        answers: Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status)).flatMap(([, response]) => Object.keys(deref(doc, response)?.content ?? {})),
      });
    }
  }
  return found;
}

/** An operation's command: the map's name, else its tag and its operationId. */
const commandOf = (op, map) => map.commands[op.operationId] ?? [op.tags[0] ?? 'api', kebab(op.operationId)];

/** What is wrong with the map against the operations: a name used twice, a name inside another, a reserved word, an
 *  entry (a name, a secret body, an omitted operation, a file path parameter) for an operation or a parameter the
 *  document no longer has. */
export function problemsOf(ops, map) {
  const ids = new Set(ops.map((op) => op.operationId));
  const problems = [];
  for (const id of [...Object.keys(map.commands), ...map.secretBody, ...Object.keys(map.omit), ...Object.keys(map.multiSegment)]) {
    if (!ids.has(id)) problems.push(`${RESOURCES} names ${id}, which the document has no operation for`);
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
    entries.push({
      command: commandOf(op, map), operationId: op.operationId, method: op.method, path: op.path,
      pathParams: [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
      // The path parameters that are file paths, slashes kept: the rest are encoded whole.
      multiSegment: map.multiSegment[op.operationId] ? [map.multiSegment[op.operationId]] : [],
      query, headers, bodyFlags, hasBody: op.body !== null, bodyRequired: op.body?.required === true, bodyTypes: op.body?.types ?? [], secretBody,
      // A working body, as the document gives it: the command's help prints it as a --body to paste. Never a secret body's.
      ...(op.body?.example !== undefined && !secretBody ? { example: op.body.example } : {}),
      // A download: its answer is the file's bytes, written as received.
      raw: op.answers.length > 0 && !op.answers.includes('application/json'),
      summary: op.summary,
    });
  }
  return entries.sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

export function tableText(ops, map) {
  const hash = createHash('sha256').update(canonical(ops)).digest('hex');
  return [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// SHA-256 of what the table is made of (operationsOf in scripts/generate-clients.mjs): ${hash}`,
    `export const COMMANDS = ${JSON.stringify(commandsOf(ops, map), null, 2)};`,
    '',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, out: { type: 'string' }, resources: { type: 'string' }, document: { type: 'string' } } });
  const output = resolve(root, values.out ?? OUTPUT);
  const map = { secretBody: [], omit: {}, multiSegment: {}, ...JSON.parse(await readFile(resolve(root, values.resources ?? RESOURCES), 'utf8')) };
  const doc = values.document ? JSON.parse(await readFile(resolve(values.document), 'utf8')) : await servedDocument();
  const ops = operationsOf(doc);
  const problems = problemsOf(ops, map);
  if (problems.length) {
    console.error(`The command map does not fit the document:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const text = tableText(ops, map);
  if (values.check) {
    if (await readFile(output, 'utf8').catch(() => '') !== text) {
      console.error(`${values.out ?? OUTPUT} is not the server's document's; run node scripts/generate-clients.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log('The CLI command table matches the server\'s OpenAPI document');
  } else {
    await writeFile(output, text);
    console.log(`Generated ${values.out ?? OUTPUT}`);
  }
}

if (isMain(import.meta)) await main();
