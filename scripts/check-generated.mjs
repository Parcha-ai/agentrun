#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const paths = ['packages/dsl/schema', 'packages/dsl/skills/author/references/language.md', 'docs/dependencies.md'];
const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], { encoding: 'utf8' }).trim();
assert.equal(status, '', `Generated release files are stale or untracked. Regenerate and commit them:\n${status}`);
console.log('All generated schema, author language and dependency inventory files match the checkout.');
