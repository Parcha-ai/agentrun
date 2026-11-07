// pi 1.5 removed `watchEvents`, on which the live path was built. On the held branch pi/family-1.5 an adapter rebuilds it
// on observeCommits (packages/pi-durable-disk/src/live-events.ts) for exactly two callers, until P5 moves the live path to
// conversation.watch with ConversationTranscript and pi.live and deletes the adapter. This lists those callers: a new
// one fails here, and so does one left after P5 (P5 empties CALLERS and deletes this test). Nothing in the sources
// imports watchEvents from pi.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTER = 'packages/pi-durable-disk/src/live-events.ts';
/** The door's GET /events, and a recording's live pi lines: the adapter's callers until P5. */
export const CALLERS = ['packages/harness/src/record.ts', 'packages/pi-durable-disk/src/serve.ts'];

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

test('the watchEvents adapter has exactly the listed callers, until P5', () => {
  assert.ok(existsSync(join(repo, ADAPTER)), `${ADAPTER} is the adapter`);
  const found = sources().map((file) => relative(repo, file)).filter((file) => file !== ADAPTER && /\bwatchEvents\(/.test(readFileSync(join(repo, file), 'utf8'))).sort();
  assert.deepEqual(found, [...CALLERS].sort());
});

test('no source imports watchEvents from pi-durable', () => {
  // A named import, or a destructured dynamic import on either side of the import() call.
  const pattern = /\{[^}]*\bwatchEvents\b[^}]*\}\s*from\s*['"]@earendil-works\/pi-durable['"]|\bwatchEvents\b[^;]*import\(['"]@earendil-works\/pi-durable['"]\)|import\(['"]@earendil-works\/pi-durable['"]\)[^;]*\bwatchEvents\b/;
  const importing = sources().filter((file) => pattern.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importing.map((file) => relative(repo, file)), []);
});
