import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The author skill's five documents as static strings, for the `./author-references` entry. The entry is node-free, so a
// browser or a Worker can carry the references without reading the package's files.
const root = fileURLToPath(new URL('../', import.meta.url));
const skill = resolve(root, 'packages/dsl/skills/author');
const output = resolve(root, 'packages/dsl/src/author-references.ts');
const sources = {
  skill: 'SKILL.md',
  language: 'references/language.md',
  workflowFormat: 'references/workflow-format.md',
  jevDecisions: 'references/jev-decisions.md',
  sdkAuthoring: 'references/sdk-authoring.md',
};

const entries = await Promise.all(Object.entries(sources).map(async ([name, file]) => [name, await readFile(resolve(skill, file), 'utf8')]));
const lines = entries.map(([name, text]) => `  ${name}: ${JSON.stringify(text)},`);
const bytes = [
  '// Generated from packages/dsl/skills/author by node scripts/generate-author-references.mjs. Do not edit.',
  '',
  'export const AUTHOR_REFERENCES = {',
  ...lines,
  '} as const;',
  '',
  'export type AuthorReferenceName = keyof typeof AUTHOR_REFERENCES;',
  '',
].join('\n');

if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8').catch(() => '') !== bytes) throw new Error('Author references are stale; run node scripts/generate-author-references.mjs');
  console.log('Author references match the skill files');
} else {
  await writeFile(output, bytes);
  console.log('Generated packages/dsl/src/author-references.ts');
}
