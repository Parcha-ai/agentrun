#!/usr/bin/env node
// The CLI's command table, from the OpenAPI document the server serves: one entry per operation it offers.
//   node scripts/generate-clients.mjs           write packages/agentrun/lib/commands.generated.mjs
//   node scripts/generate-clients.mjs --check   fail when the committed table is not the document's
// It reads the built server (packages/serve/dist), so it runs after the build. --out and --resources name other files.
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

/** JSON with every object's keys sorted, so the hash is the document's and not its key order's. */
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

/** A schema's flag type, when one value on the command line can hold it: a scalar type, or an enum of strings. */
function flagType(doc, schema) {
  const s = deref(doc, schema) ?? {};
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string')) return { type: 'string', enum: s.enum };
  const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((type) => type !== 'null');
  return types.length === 1 && SCALAR.includes(types[0]) ? { type: types[0] } : undefined;
}

const firstLine = (text) => (text ?? '').split('\n')[0].trim();

/** Every operation in the document, with its command: the map's name, else its tag and its operationId. */
function operations(doc, map) {
  const found = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const command = map.commands[op.operationId] ?? [op.tags?.[0] ?? 'api', kebab(op.operationId)];
      found.push({ path, method, item, op, command });
    }
  }
  return found;
}

/** What is wrong with the map against the document: a name used twice, a name inside another, a reserved word, an
 *  entry (a name, a secret body, an omitted operation) for an operation the document no longer has. */
export function problemsOf(doc, map) {
  const all = operations(doc, map);
  const ids = new Set(all.map(({ op }) => op.operationId));
  const problems = [];
  for (const id of [...Object.keys(map.commands), ...map.secretBody, ...Object.keys(map.omit)]) {
    if (!ids.has(id)) problems.push(`${RESOURCES} names ${id}, which the document has no operation for`);
  }
  const byName = new Map();
  for (const { op, command } of all) {
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
export function commandsOf(doc, map) {
  const entries = [];
  for (const { path, method, item, op, command } of operations(doc, map)) {
    if (op['x-agentrun-serve-unsupported'] || map.omit[op.operationId] !== undefined) continue;
    const params = new Map();
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = deref(doc, raw);
      params.set(`${param.in} ${param.name}`, param);
    }
    const query = [...params.values()].filter((p) => p.in === 'query')
      .map((p) => ({ name: p.name, ...(flagType(doc, p.schema) ?? { type: 'string' }), required: p.required === true, description: firstLine(p.description) }));
    const taken = new Set([...GLOBAL_FLAGS, ...query.map((q) => flagOf(q.name))]);
    const headers = [...params.values()].filter((p) => p.in === 'header' && !OWN_HEADERS.includes(p.name.toLowerCase()) && !taken.has(flagOf(p.name)))
      .map((p) => ({ name: p.name, ...(flagType(doc, p.schema) ?? { type: 'string' }), required: p.required === true, description: firstLine(p.description) }));
    for (const h of headers) taken.add(flagOf(h.name));
    const body = deref(doc, op.requestBody);
    const bodyTypes = Object.keys(body?.content ?? {});
    const answers = Object.entries(op.responses ?? {}).filter(([status]) => /^2/.test(status)).flatMap(([, response]) => Object.keys(deref(doc, response)?.content ?? {}));
    const schema = deref(doc, body?.content?.['application/json']?.schema);
    const secretBody = map.secretBody.includes(op.operationId);
    const bodyFlags = secretBody ? [] : Object.entries(schema?.properties ?? {}).flatMap(([name, property]) => {
      const type = flagType(doc, property);
      return type && !taken.has(flagOf(name)) ? [{ name, ...type, required: schema.required?.includes(name) ?? false, description: firstLine(deref(doc, property).description) }] : [];
    });
    entries.push({
      command, operationId: op.operationId, method: method.toUpperCase(), path,
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
      query, headers, bodyFlags, hasBody: body !== undefined, bodyRequired: body?.required === true, bodyTypes, secretBody,
      // A download: its answer is the file's bytes, written as received.
      raw: answers.length > 0 && !answers.includes('application/json'),
      summary: op.summary ?? firstLine(op.description),
    });
  }
  return entries.sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

export function tableText(doc, map) {
  const hash = createHash('sha256').update(canonical(doc)).digest('hex');
  return [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// OpenAPI document SHA-256: ${hash}`,
    `export const COMMANDS = ${JSON.stringify(commandsOf(doc, map), null, 2)};`,
    '',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, out: { type: 'string' }, resources: { type: 'string' } } });
  const output = resolve(root, values.out ?? OUTPUT);
  const map = { secretBody: [], omit: {}, ...JSON.parse(await readFile(resolve(root, values.resources ?? RESOURCES), 'utf8')) };
  const doc = await servedDocument();
  const problems = problemsOf(doc, map);
  if (problems.length) {
    console.error(`The command map does not fit the document:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const text = tableText(doc, map);
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
