// The follower's hold follows the place's clock allowance: a place whose clock may be off by clockSkewMs holds the live lines twice that long, so a line from a remote writer is never placed before an earlier one arrives.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { demo, localPlace } from '@parcha/agentrun-harness';

async function lengths(t, skew) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-clock-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const spec = join(tmp, 'demo.json');
  writeFileSync(spec, JSON.stringify({ name: 'reference' }));
  const before = { ...process.env };
  Object.assign(process.env, { DEMO_SPEC: spec, DEMO_LINGER_MS: '4000' });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  const { options } = await import(`./reference/demo-fixture.ts?clock=${Date.now()}`);
  const recording = join(tmp, 'recording');
  const seen = [];
  const reader = setInterval(() => { try { seen.push(readFileSync(join(recording, 'events.jsonl'), 'utf8').length); } catch { seen.push(0); } }, 100);
  await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => ({ ...localPlace({ self, paths, destroyBoxes, requestFile }), ...(skew ? { clockSkewMs: skew } : {}) }) });
  clearInterval(reader);
  return seen;
}

test('a place with a large clockSkewMs holds the live lines: events.jsonl stays empty while the run goes; with none, lines are placed as the run goes', { timeout: 120_000 }, async (t) => {
  const plain = await lengths(t, 0);
  assert.ok(plain.some((size) => size > 0), 'with no skew, lines were placed while the run was going');
  const held = await lengths(t, 60_000);
  // The finished file is completed by finishRecording after the run; while the run goes (all but the last reading) nothing was placed.
  assert.ok(held.slice(0, Math.max(1, held.length - 2)).every((size) => size === 0), `with a 60 s allowance nothing was placed during the run: ${held.join(',')}`);
});
