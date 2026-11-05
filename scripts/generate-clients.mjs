#!/usr/bin/env node
// The CLI's command table, from the OpenAPI document the server serves: one entry per operation it offers, and the
// agentrun-cli skill from the same table (scripts/clients/skill.mjs): its SKILL.md and references/commands.md.
//   node scripts/generate-clients.mjs           write packages/agentrun/lib/commands.generated.mjs and the skill
//   node scripts/generate-clients.mjs --check   fail when a committed file is not the document's, or the skill names a
//                                               command or flag the CLI does not have
// It reads the built server (packages/serve/dist), so it runs after the build. --out, --skill and --resources name other
// files.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FLAGS, WAIT } from '../packages/agentrun/lib/follow.mjs';
import { SECRETS } from '../packages/agentrun/lib/login.mjs';
import { SKILL_INSTALL } from '../packages/agentrun/lib/skill.mjs';
import { allCommands, recipeProblems, referenceText, skillText } from './clients/skill.mjs';
import { isMain } from './is-main.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = 'packages/agentrun/lib/commands.generated.mjs';
const RESOURCES = 'scripts/clients/resources.json';
const SKILL = 'packages/agentrun/skills/agentrun-cli';
// Words the launcher keeps for itself or for the server it starts, and the CLI's own commands of one word: no command
// may begin with one.
const RESERVED = ['api', 'help', 'import', 'reset-password', 'login', 'logout', 'skill'];
// The CLI's hand-written commands: none may be a generated one too.
const HAND = { flags: FLAGS, wait: WAIT, local: [...SECRETS, SKILL_INSTALL] };
const SCALAR = ['string', 'number', 'integer', 'boolean'];
const GLOBAL_FLAGS = ['base-url', 'data', 'body', 'help'];
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
const flagOf = (name) => name.replace(/_/g, '-');

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
 *  entry for an operation the document no longer has. */
export function problemsOf(doc, map) {
  const all = operations(doc, map);
  const ids = new Set(all.map(({ op }) => op.operationId));
  const problems = [];
  for (const id of [...Object.keys(map.commands), ...map.secretBody]) {
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
  for (const { command } of [HAND.wait, ...HAND.local]) {
    if (byName.has(command.join(' '))) problems.push(`${byName.get(command.join(' '))} is "${command.join(' ')}", a command the CLI writes by hand`);
  }
  return problems;
}

/** The table: one entry per operation the server offers, sorted by command. */
export function commandsOf(doc, map) {
  const entries = [];
  for (const { path, method, item, op, command } of operations(doc, map)) {
    if (op['x-agentrun-serve-unsupported']) continue;
    const params = new Map();
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = deref(doc, raw);
      params.set(`${param.in} ${param.name}`, param);
    }
    const query = [...params.values()].filter((p) => p.in === 'query')
      .map((p) => ({ name: p.name, ...(flagType(doc, p.schema) ?? { type: 'string' }), required: p.required === true, description: firstLine(p.description) }));
    const taken = new Set([...GLOBAL_FLAGS, ...query.map((q) => flagOf(q.name))]);
    const body = deref(doc, op.requestBody);
    const types = Object.keys(body?.content ?? {});
    const bodyType = types.includes('application/json') ? 'application/json' : types[0];
    const schema = deref(doc, body?.content?.['application/json']?.schema);
    const secretBody = map.secretBody.includes(op.operationId);
    const bodyFlags = secretBody ? [] : Object.entries(schema?.properties ?? {}).flatMap(([name, property]) => {
      const type = flagType(doc, property);
      return type && !taken.has(flagOf(name)) ? [{ name, ...type, required: schema.required?.includes(name) ?? false, description: firstLine(deref(doc, property).description) }] : [];
    });
    entries.push({
      command, operationId: op.operationId, method: method.toUpperCase(), path,
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
      query, bodyFlags, hasBody: body !== undefined, bodyRequired: body?.required === true,
      ...(bodyType ? { bodyType } : {}), secretBody, summary: op.summary ?? firstLine(op.description),
    });
  }
  return entries.sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

const hashOf = (doc) => createHash('sha256').update(canonical(doc)).digest('hex');

export function tableText(doc, map) {
  return [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// OpenAPI document SHA-256: ${hashOf(doc)}`,
    `export const COMMANDS = ${JSON.stringify(commandsOf(doc, map), null, 2)};`,
    '',
  ].join('\n');
}

/** The skill's files, by their path under its folder, and what its text names that the CLI does not have. */
export function skillFiles(doc, map) {
  const commands = allCommands(commandsOf(doc, map), HAND);
  const skill = skillText(commands, hashOf(doc));
  return { files: { 'SKILL.md': skill, 'references/commands.md': referenceText(commands, hashOf(doc)) }, problems: recipeProblems(commands, skill) };
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, out: { type: 'string' }, skill: { type: 'string' }, resources: { type: 'string' } } });
  const map = { secretBody: [], ...JSON.parse(await readFile(resolve(root, values.resources ?? RESOURCES), 'utf8')) };
  const doc = await servedDocument();
  const problems = problemsOf(doc, map);
  if (problems.length) {
    console.error(`The command map does not fit the document:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const skill = skillFiles(doc, map);
  if (skill.problems.length) {
    console.error(`The skill's template does not fit the CLI:\n${skill.problems.map((p) => `  ${p}`).join('\n')}\nFix the template in scripts/clients/skill.mjs.`);
    process.exitCode = 1;
    return;
  }
  const outputs = [[values.out ?? OUTPUT, tableText(doc, map)], ...Object.entries(skill.files).map(([file, text]) => [join(values.skill ?? SKILL, file), text])];
  if (values.check) {
    const stale = [];
    for (const [file, text] of outputs) if (await readFile(resolve(root, file), 'utf8').catch(() => '') !== text) stale.push(file);
    if (stale.length) {
      console.error(`${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} not the server's document's; run node scripts/generate-clients.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log('The CLI command table and its skill match the server\'s OpenAPI document');
  } else {
    for (const [file, text] of outputs) {
      await mkdir(dirname(resolve(root, file)), { recursive: true });
      await writeFile(resolve(root, file), text);
      console.log(`Generated ${file}`);
    }
  }
}

if (isMain(import.meta)) await main();
