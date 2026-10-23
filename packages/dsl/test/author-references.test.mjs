// The author references as a host meets them: resolved by the package's name from its build, each document carried as its
// file has it, and a built entry with no import of any kind, so a browser or a Worker loads it without Node's builtins.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableImports } from '../../../scripts/reachable-imports.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const skill = join(packageRoot, 'skills/author');
const documents = {
  skill: 'SKILL.md',
  language: 'references/language.md',
  workflowFormat: 'references/workflow-format.md',
  jevDecisions: 'references/jev-decisions.md',
  sdkAuthoring: 'references/sdk-authoring.md',
};

test('the entry resolves by the package name and carries each document as its file has it', async () => {
  const { AUTHOR_REFERENCES } = await import('@parcha/agentrun-dsl/author-references');
  assert.deepEqual(Object.keys(AUTHOR_REFERENCES).sort(), Object.keys(documents).sort());
  for (const [name, file] of Object.entries(documents)) assert.equal(AUTHOR_REFERENCES[name], readFileSync(join(skill, file), 'utf8'), name);
});

test('the built entry has no import of any kind', () => {
  const built = readFileSync(join(packageRoot, 'dist/author-references.js'), 'utf8');
  assert.doesNotMatch(built, /^\s*(?:import\b|export\s[^;]*\sfrom\b)/m);
  assert.deepEqual(reachableImports(packageRoot, 'dist/author-references.js'), []);
});
