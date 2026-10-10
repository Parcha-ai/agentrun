// The durable entry point as a host meets it: resolved by the package's name from its build, typed, and loadable
// without pi's coding agent, its agent core or its TUI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const CODING_AGENT_ONLY = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui'];

/** Every bare specifier a built file reaches, itself included, following relative imports. Declarations are walked as
 *  declarations: a relative `./x.js` in a `.d.ts` names `./x.d.ts`. */
function reachable(entry) {
  const declarations = entry.endsWith('.d.ts');
  const seen = new Set(), bare = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (!specifier.startsWith('.')) bare.add(specifier);
      else visit(resolve(dirname(file), declarations ? specifier.replace(/\.js$/, '.d.ts') : specifier));
    }
  };
  visit(join(packageRoot, entry));
  return [...bare];
}

test('the durable entry point resolves by the package name', async () => {
  for (const file of Object.values(manifest.exports['./durable'])) assert.ok(existsSync(join(packageRoot, file)), file);
  await import(`${manifest.name}/durable`);
});

test('the durable entry point never reaches the coding agent, its agent core or its TUI', () => {
  for (const file of Object.values(manifest.exports['./durable'])) {
    const reached = reachable(file).filter(specifier => CODING_AGENT_ONLY.some(name => specifier === name || specifier.startsWith(`${name}/`)));
    assert.deepEqual(reached, [], file);
  }
});

test('a durable store is typed by the recovery contract of the DSL package', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./durable-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});
