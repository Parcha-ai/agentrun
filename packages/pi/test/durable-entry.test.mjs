// The durable entry point as a host meets it: resolved by the package's name from its build, typed, and loadable
// without pi's coding agent, its agent core or its TUI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableImports } from '../../../scripts/reachable-imports.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const CODING_AGENT_ONLY = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui'];

test('the durable entry point resolves by the package name', async () => {
  for (const file of Object.values(manifest.exports['./durable'])) assert.ok(existsSync(join(packageRoot, file)), file);
  await import(`${manifest.name}/durable`);
});

test('the durable entry point never reaches the coding agent, its agent core or its TUI', () => {
  for (const file of Object.values(manifest.exports['./durable'])) {
    const reached = reachableImports(packageRoot, file).filter(specifier => CODING_AGENT_ONLY.some(name => specifier === name || specifier.startsWith(`${name}/`)));
    assert.deepEqual(reached, [], file);
  }
});

test('a durable store is typed by the recovery contract of the DSL package', () => {
  // The durable entry's declarations reach pi-durable's, whose dependencies carry upstream declaration errors, so
  // declaration files are not checked here; the fixture's own assignments still are, strictly. The DSL package's
  // contract is checked without skipLibCheck by its own recovery-types fixture.
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck',
    fileURLToPath(new URL('./durable-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});
