// The recordings the build bundles into the gallery, and the recorded runs kept with the test fixtures: each obeys the
// format with the blobs it holds, and its manifest's cost and processes are the counters' fold of its lines (RECORDING.md
// section 6), so the gallery's card and the strip agree.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import { parseLines, validate } from '../src/format.ts';

const root = new URL('../recordings/', import.meta.url);
const ids = readdirSync(root).filter((name) => statSync(new URL(name, root)).isDirectory()).sort();

test('the gallery bundles recordings', () => {
  assert.ok(ids.length > 0);
});

/** Runs recorded, not cut by hand, that the tests read and the gallery does not bundle (test/fixtures/README.md). */
const kept = ['ten-kills-seed21'].map((id) => ({ id: `fixtures/${id}`, dir: new URL(`../test/fixtures/${id}/`, import.meta.url) }));

for (const { id, dir } of [...ids.map((id) => ({ id, dir: new URL(`${id}/`, root) })), ...kept]) {
  test(`${id}: obeys the format, and its manifest's cost and processes are the fold's`, () => {
    const at = (name: string) => new URL(name, dir);
    const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
    const lines = parseLines(readFileSync(at('events.jsonl'), 'utf8'));
    const blobs = new Set(readdirSync(at('blobs')).map((name) => name.split('.')[0]!));
    assert.deepEqual(validate(manifest, lines, blobs), []);
    const counters = countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);
    assert.equal(manifest.cost.usd, counters.cost);
    assert.equal(manifest.generations, counters.processes);
  });
}
