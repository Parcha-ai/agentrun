import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FitWriter, fitSnapshot, taughtFor } from '../src/fit.ts';

const policy = (body: string) => JSON.stringify({ mjcf_sha256: body });
const A = 'a'.repeat(64), B = 'b'.repeat(64);

test('the snapshot says, for each skill the page has read and the manifest names, whether it was taught for this body; a skill the manifest dropped is not in it', () => {
  const texts = new Map([['walk', policy(A)], ['sprint', policy(B)], ['gone', policy(A)]]);
  const s = fitSnapshot(A, ['walk', 'sprint', 'spin'], texts);
  assert.deepEqual(JSON.parse(s.text), { version: 1, body_sha: A, skills: { walk: { fits: true, taught_for_body_sha: A }, sprint: { fits: false, taught_for_body_sha: B } }, not_fitting: ['sprint'] });
  assert.deepEqual([s.fitting, s.notFitting], [['walk'], ['sprint']]);
  assert.equal(fitSnapshot(B, ['walk', 'sprint'], texts).notFitting.join(), 'walk', 'the same files against another body');
  assert.equal(taughtFor('not json'), null);
  assert.equal(fitSnapshot(A, ['walk'], new Map([['walk', 'not json']])).notFitting.join(), 'walk', 'a file that does not name its body fits nothing');
});

test('a write that fails is tried again until it lands; a later snapshot replaces one that never landed; the same text twice is one write', async () => {
  let fail = 3;
  const landed: string[] = [];
  const waits: number[] = [];
  const w = new FitWriter(async (t) => { if (fail-- > 0) throw new Error('disk away'); landed.push(t); }, async (ms) => { waits.push(ms); }, 1000, 3000);
  await w.submit('one');
  assert.deepEqual(landed, ['one']);
  assert.deepEqual(waits, [1000, 2000, 3000], 'doubling, capped');
  await w.submit('one');
  assert.deepEqual(landed, ['one'], 'what is already on the disk is not written again');
  fail = 2;
  const first = w.submit('two');
  const second = w.submit('three'); // while two is failing
  await Promise.all([first, second]);
  assert.deepEqual(landed, ['one', 'three'], 'the stale snapshot never lands after the newer one was asked for');
});
