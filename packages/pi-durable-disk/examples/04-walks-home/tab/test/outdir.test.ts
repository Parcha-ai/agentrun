import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error the check scripts are plain JavaScript with no declaration file
import { outDir } from '../scripts/outdir.mjs';

test('a "~/x" output directory is the home directory\'s, not a folder named "~" under the working directory', () => {
  assert.equal(outDir('~/tmp/shots', { HOME: '/u/me' }), '/u/me/tmp/shots');
  assert.equal(outDir('~', { HOME: '/u/me' }), '/u/me');
});

test('other paths are left alone, and with no argument it is the current directory', () => {
  assert.equal(outDir('shots/a', { HOME: '/h' }), 'shots/a');
  assert.equal(outDir('/abs/shots', { HOME: '/h' }), '/abs/shots');
  assert.equal(outDir('~other/x', { HOME: '/h' }), '~other/x', '"~user" is not expanded');
  assert.equal(outDir(undefined, { HOME: '/h' }), '.');
});
