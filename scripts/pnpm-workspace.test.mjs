// pnpm installs the packages pnpm-workspace.yaml names; npm's script runner and scripts/build-workspaces.mjs read
// package.json's `workspaces`. One list each, held equal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('pnpm-workspace.yaml names the same packages as package.json workspaces', () => {
  assert.deepEqual(parse(read('pnpm-workspace.yaml')).packages, JSON.parse(read('package.json')).workspaces);
});

test('the pnpm that installs is the one package.json pins, and the console installs with the same', () => {
  const pinned = JSON.parse(read('package.json')).packageManager;
  assert.match(pinned, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('apps/console/package.json')).packageManager, pinned);
});
