// The recovery entry points as a host meets them: resolved by the package's name from its build, typed, and reaching
// nothing outside this package, its declared dependencies and Node's builtins.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableImports } from '../../../scripts/reachable-imports.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const entries = ['./recovery', './recovery/testing'];

test('every exports target exists in the build', () => {
  for (const [entry, target] of Object.entries(manifest.exports)) {
    for (const file of typeof target === 'string' ? [target] : Object.values(target)) assert.ok(existsSync(join(packageRoot, file)), `${entry} names ${file}`);
  }
});

test('the recovery entry points resolve by the package name', async () => {
  for (const entry of entries) {
    assert.ok(manifest.exports[entry], entry);
    await import(`${manifest.name}${entry.slice(1)}`);
  }
});

test('the recovery entry points reach only this package, its declared dependencies and Node builtins', () => {
  const declared = Object.keys(manifest.dependencies ?? {});
  for (const entry of entries) {
    for (const file of Object.values(manifest.exports[entry])) {
      const outside = reachableImports(packageRoot, file).filter(specifier => !specifier.startsWith('node:') && !declared.some(name => specifier === name || specifier.startsWith(`${name}/`)));
      assert.deepEqual(outside, [], `${entry} (${file})`);
    }
  }
});

test('the store contract compiles for a caller under strict NodeNext', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./recovery-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});
