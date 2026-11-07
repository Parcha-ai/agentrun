// pi 1.5 removed `watchEvents`, on which the live path was built. On the held branch pi/family-1.5 each place that
// called it is a placeholder that refuses with one message, until P5 moves the live path to conversation.watch with
// ConversationTranscript and pi.live. This lists exactly those places: a new one fails here, and so does one left
// after P5 (P5 empties PLACEHOLDERS and this test with it). Nothing in the sources imports watchEvents from pi.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const MESSAGE = 'live events move to conversation.watch in P5';
/** The door's GET /events, and a recording's live pi lines. */
export const PLACEHOLDERS = ['packages/harness/src/record.ts', 'packages/pi-durable-disk/src/serve.ts'];

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

test('the watchEvents placeholders are exactly the listed places, each refusing with the one message', () => {
  const found = sources().filter((file) => readFileSync(file, 'utf8').includes(MESSAGE)).map((file) => relative(repo, file)).sort();
  assert.deepEqual(found, [...PLACEHOLDERS].sort());
});

test('no source imports watchEvents from pi-durable', () => {
  // A named import, or a destructured dynamic import on either side of the import() call.
  const pattern = /\{[^}]*\bwatchEvents\b[^}]*\}\s*from\s*['"]@earendil-works\/pi-durable['"]|\bwatchEvents\b[^;]*import\(['"]@earendil-works\/pi-durable['"]\)|import\(['"]@earendil-works\/pi-durable['"]\)[^;]*\bwatchEvents\b/;
  const importing = sources().filter((file) => pattern.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importing.map((file) => relative(repo, file)), []);
});
