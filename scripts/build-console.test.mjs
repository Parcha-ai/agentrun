import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildConsole, consoleDepsInstalled, consoleInputsHash, consoleIsCurrent, HASH_FILE, stampConsole } from './build-console.mjs';

/** A repository with a console's inputs, and an npm that records what it was asked and builds as the console's own
 *  build does: dist/index.html, then the stamp. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-console-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('apps/console/src/main.tsx', 'export const a = 1;\n');
  put('apps/console/index.html', '<!doctype html>\n');
  put('apps/console/package.json', '{"name":"console"}\n');
  const lock = (version) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'console' }, 'node_modules/vite': { version }, 'node_modules/@esbuild/darwin-arm64': { version: '0.21.5', optional: true } } });
  put('apps/console/package-lock.json', lock('5.4.21'));
  put('packages/dsl/src/graph.ts', 'export const g = 1;\n');
  const asked = [];
  const run = (args, cwd) => {
    asked.push(args.join(' '));
    // As npm ci records what it installed: the lockfile's packages for this platform, the optional one left out.
    if (args[0] === 'ci') { const { packages } = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')); put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': packages['node_modules/vite'] } })); }
    if (args.join(' ') === 'run build') { mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist', 'index.html'), 'built\n'); stampConsole(root); }
  };
  return { root, put, lock, asked, build: () => buildConsole(root, { run, log: () => {} }) };
}

test('a fresh checkout installs and builds the console; built again from the same sources, it is skipped', (t) => {
  const r = repo(t);
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build']);
  assert.equal(r.build(), 'current');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build'], 'nothing asked of npm the second time');
});

test('a changed source rebuilds; a file touched but unchanged does not; a changed lockfile installs again first', (t) => {
  const r = repo(t);
  r.build();
  r.asked.length = 0;
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(r.root, 'apps/console/src/main.tsx'), later, later);
  assert.equal(r.build(), 'current', 'a newer file time with the same bytes is not a change');
  r.put('apps/console/src/main.tsx', 'export const a = 2;\n');
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['run build'], 'the dependencies are current, so no install');
  r.asked.length = 0;
  r.put('packages/dsl/src/graph.ts', 'export const g = 2;\n');
  assert.equal(r.build(), 'built', 'the DSL sources the console imports are its inputs too');
  r.asked.length = 0;
  r.put('apps/console/package-lock.json', r.lock('5.4.22'));
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build']);
});

test('a dist with no record of its inputs, or another tree\'s, is not current', (t) => {
  const r = repo(t);
  r.put('apps/console/dist/index.html', 'built elsewhere\n');
  assert.equal(consoleIsCurrent(r.root), false, 'no hash beside it');
  r.put(`apps/console/dist/${HASH_FILE}`, 'f'.repeat(64));
  assert.equal(consoleIsCurrent(r.root), false, 'a hash of other sources');
  r.put(`apps/console/dist/${HASH_FILE}`, `${consoleInputsHash(r.root)}\n`);
  assert.equal(consoleIsCurrent(r.root), true);
});

test('dependencies npm installed by itself, as a source check does before going offline, are not installed again', (t) => {
  const r = repo(t);
  assert.equal(consoleDepsInstalled(r.root), false, 'none yet');
  r.put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.21' } } }));
  assert.equal(consoleDepsInstalled(r.root), true, 'another platform\'s optional package is not needed');
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['run build']);
  r.put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.20' } } }));
  assert.equal(consoleDepsInstalled(r.root), false, 'a version the lockfile does not name');
});
