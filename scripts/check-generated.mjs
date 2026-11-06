#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkTokens } from '../apps/console/tokens-check.mjs';

const paths = ['packages/dsl/schema', 'packages/dsl/skills/author/references/language.md', 'docs/dependencies.md', 'packages/pi/src/demo-data.ts'];
const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], { encoding: 'utf8' }).trim();
assert.equal(status, '', `Generated release files are stale or untracked. Regenerate and commit them:\n${status}`);
console.log('All generated schema, author language, Pi demo and dependency inventory files match the checkout.');

// The console's design tokens are generated outside this repository and vendored with their vocabulary; the header of
// apps/console/src/tokens.css names the command that regenerates both.
const tokenErrors = checkTokens(new URL('../apps/console/', import.meta.url));
assert.deepEqual(tokenErrors, [], `The console's vendored design tokens are not the generated pair:\n${tokenErrors.join('\n')}`);
console.log("The console's vendored design tokens match their vocabulary and are unedited.");
