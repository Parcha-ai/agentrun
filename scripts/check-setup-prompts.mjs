#!/usr/bin/env node
// Every demo's SETUP-PROMPT.md against its spec (demo.json beside it), through checkSetupPrompt: each key env name,
// program command and package name in the spec appears in the prompt, and the prompt names no credential env name the
// spec does not list. With directories as arguments, those demos; otherwise every examples/*/ with a demo.json.
// Exits 1 when a prompt is missing or does not match. Needs the built @parcha/agentrun-pi.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSetupPrompt } from '@parcha/agentrun-pi/signin';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** The demo directories under `examples`, those holding a demo.json. */
export function demoDirs(examples = join(repo, 'examples')) {
  return readdirSync(examples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(examples, entry.name, 'demo.json')))
    .map((entry) => join(examples, entry.name))
    .sort();
}

/** One line per problem in `dir`'s prompt; empty when it matches its spec. */
export function checkDemo(dir) {
  const prompt = join(dir, 'SETUP-PROMPT.md');
  if (!existsSync(prompt)) return ['SETUP-PROMPT.md is missing'];
  const report = checkSetupPrompt(JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8')), readFileSync(prompt, 'utf8'));
  return [
    ...report.missing.map((name) => `the spec needs ${name}, and the prompt never names it`),
    ...report.extra.map((name) => `the prompt names ${name}, which the spec does not list`),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : demoDirs();
  let failed = 0;
  for (const dir of dirs) {
    const problems = checkDemo(dir);
    const name = relative(process.cwd(), dir).startsWith('..') ? dir : relative(process.cwd(), dir) || dir;
    if (problems.length) failed += 1;
    console.log(problems.length ? `FAIL ${name}\n${problems.map((line) => `  ${line}`).join('\n')}` : `ok   ${name}`);
  }
  console.log(`${dirs.length} demo ${dirs.length === 1 ? 'spec' : 'specs'} checked, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
