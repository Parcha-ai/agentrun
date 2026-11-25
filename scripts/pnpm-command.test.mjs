import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pnpmCommand } from './pnpm-command.mjs';

const exists = () => true;

test('under pnpm run, the pnpm that ran the script runs again: its native binary directly, its Node script with this node', () => {
  assert.deepEqual(pnpmCommand(['install'], { env: { npm_execpath: '/opt/pnpm/pnpm' }, exists }), { command: '/opt/pnpm/pnpm', args: ['install'] });
  assert.deepEqual(pnpmCommand(['install'], { env: { npm_execpath: 'C:\\pnpm\\pnpm.exe' }, exists }), { command: 'C:\\pnpm\\pnpm.exe', args: ['install'] });
  assert.deepEqual(pnpmCommand(['run', 'build'], { env: { npm_execpath: '/opt/pnpm/bin/pnpm.mjs' }, execPath: '/opt/node', exists }), { command: '/opt/node', args: ['/opt/pnpm/bin/pnpm.mjs', 'run', 'build'] });
});

test('under npm run, or a pnpm that is gone, pnpm comes from PATH', () => {
  assert.deepEqual(pnpmCommand(['install'], { env: { npm_execpath: '/opt/npm/bin/npm-cli.js' }, exists }), { command: 'pnpm', args: ['install'] });
  assert.deepEqual(pnpmCommand(['install'], { env: { npm_execpath: '/gone/pnpm' }, exists: () => false }), { command: 'pnpm', args: ['install'] });
  assert.deepEqual(pnpmCommand(['install'], { env: {} }), { command: 'pnpm', args: ['install'] });
});
