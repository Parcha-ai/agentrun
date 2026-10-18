// Which tool kills an attempt fired, and which it did not: a landed kill is credited to the plan entry that fired, never to another entry at the same point.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossings } from './reference/crossings.ts';
import { notLanded } from './reference/demo.ts';

test('two tool kills at one point with different where: the one that fired is credited, and the one that did not is reported as not landed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'reference-landed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'crossings.jsonl');
  const install = { point: 'transport.box.exec', kind: 'box', target: 'tool', why: 'install', n: 1, where: { tool: 'install' } };
  const fetch = { point: 'transport.box.exec', kind: 'box', target: 'tool', why: 'fetch', n: 1, where: { tool: 'fetch' } };
  const cross = crossings({ run: undefined, tools: [install, fetch] }, log);
  // The fetch crossing comes first: the fetch kill (the second entry) fires.
  assert.equal(cross('transport.box.exec', { info: { tool: 'fetch' } }), true);
  const rows = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.find((row) => row.landed).tool, 1, 'the landed row names the entry that fired');
  assert.deepEqual(notLanded([install, fetch], log), [install], 'the install kill did not fire: it is the one reported, though it shares the point');
});
