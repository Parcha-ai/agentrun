// Manifest.providers (RECORDING.md draft 18): `real` or `scripted`, optional. The format refuses another value, and the shell hands a panel's view the
// run's own providers and its baseline's, so a ledger can tell a replay from a paid run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineViewOf, viewContext } from '../src/app.ts';
import { validate, type Manifest, type Recording } from '../src/format.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import { lines, manifest } from './restore-drill.ts';

const base = manifest as unknown as Manifest;

test('the format takes providers real or scripted, or none, and refuses another value', () => {
  assert.deepEqual(validate({ ...base, providers: 'real' }, lines), []);
  assert.deepEqual(validate({ ...base, providers: 'scripted' }, lines), []);
  assert.deepEqual(validate(base, lines), [], 'a manifest with no providers still validates: the price of the kills reads not comparable, the format does not refuse it');
  for (const wrong of ['live', 'replay', '', 1, null, true]) {
    assert.match(validate({ ...base, providers: wrong }, lines).join('\n'), /manifest\.providers is not real or scripted/, String(wrong));
  }
});

test('the shell hands a view the run\'s own providers beside the time, the focus and the baseline', () => {
  const baseline = baselineViewOf('the paid run', { id: 'b', manifest: { ...base, providers: 'real' }, lines, blobUrl: () => undefined, blobType: () => undefined } as Recording);
  assert.deepEqual(viewContext(5, undefined, undefined, base), { t: 5 }, 'a manifest with no providers hands none');
  assert.deepEqual(viewContext(5, '/root/steps/0/items/2', baseline, { ...base, providers: 'scripted' }), { t: 5, focus: '/root/steps/0/items/2', baseline, providers: 'scripted' });
  assert.equal(viewContext(0, undefined, undefined, { ...base, providers: 'real' }).providers, 'real');
});

test('a baseline view carries its own manifest\'s providers, its counters at its end and how long it ran', () => {
  const other = { id: 'b', manifest: { ...base, providers: 'scripted' as const }, lines, blobUrl: () => undefined, blobType: () => undefined } as Recording;
  const view = baselineViewOf('a replay', other);
  assert.equal(view.label, 'a replay');
  assert.equal(view.providers, 'scripted');
  assert.deepEqual(view.counters, countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true));
  assert.equal(view.ms, 60_000);
  assert.equal(baselineViewOf('no field', { ...other, manifest: base } as Recording).providers, undefined, 'no providers on the manifest: none on the view');
});
