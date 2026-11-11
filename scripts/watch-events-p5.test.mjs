// pi 1.5 removed `watchEvents`. Nothing in the sources imports it from pi-durable.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every .ts, .mts and .js file under each package's src/. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?ts|m?js)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(repo, 'packages'))) if (existsSync(join(repo, 'packages', pkg, 'src'))) walk(join(repo, 'packages', pkg, 'src'));
  return out;
}

test('no source imports watchEvents from pi-durable', () => {
  // A named import, or a destructured dynamic import on either side of the import() call.
  const pattern = /\{[^}]*\bwatchEvents\b[^}]*\}\s*from\s*['"]@earendil-works\/pi-durable['"]|\bwatchEvents\b[^;]*import\(['"]@earendil-works\/pi-durable['"]\)|import\(['"]@earendil-works\/pi-durable['"]\)[^;]*\bwatchEvents\b/;
  const importing = sources().filter((file) => pattern.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importing.map((file) => relative(repo, file)), []);
});
