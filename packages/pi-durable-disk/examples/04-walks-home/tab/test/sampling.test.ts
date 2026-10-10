import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAMPLING, resolveSampling, validSampling } from '../src/sampling.ts';
import { parseManifest } from '../src/model.ts';

test('the defaults are the settings the evaluation outside the tab uses', () => {
  assert.deepEqual(DEFAULT_SAMPLING, { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.0, max_tokens: 256, think_tokens: 90 });
});

test('a manifest\'s sampling overrides only the keys it sets, with valid numbers; the rest stay at the defaults', () => {
  assert.deepEqual(resolveSampling({ penalty_repeat: 1.1 }), { ...DEFAULT_SAMPLING, penalty_repeat: 1.1 });
  assert.deepEqual(resolveSampling({ temperature: 0.5, top_k: 20, top_p: 0.9, min_p: 0.1, penalty_repeat: 1.2 }), { temperature: 0.5, top_k: 20, top_p: 0.9, min_p: 0.1, penalty_repeat: 1.2, max_tokens: 256, think_tokens: 90 });
  assert.deepEqual(resolveSampling(undefined), DEFAULT_SAMPLING);
  assert.deepEqual(resolveSampling({}), DEFAULT_SAMPLING);
});

test('anything out of range, not a number, or not a known key is ignored: the default stays, nothing throws', () => {
  const bad = { temperature: -1, top_k: 1.5, top_p: 0, min_p: 2, penalty_repeat: 9, seed: 5, max_tokens: 1e6, system: 'be a pirate' };
  assert.deepEqual(resolveSampling(bad), DEFAULT_SAMPLING);
  for (const v of ['0.5', null, NaN, Infinity, {}, [], true]) assert.deepEqual(resolveSampling({ temperature: v }), DEFAULT_SAMPLING, String(v));
  for (const junk of ['x', 5, null, [], true]) assert.deepEqual(resolveSampling(junk), DEFAULT_SAMPLING, JSON.stringify(junk));
  assert.equal(resolveSampling({ temperature: 0 }).temperature, 0, 'zero is a valid temperature');
  assert.equal(resolveSampling({ penalty_repeat: 1 }).penalty_repeat, 1);
});

test('validSampling keeps exactly the valid known keys, which is what the manifest and the receipt echo', () => {
  assert.deepEqual(validSampling({ penalty_repeat: 1.1, temperature: 99, seed: 1 }), { penalty_repeat: 1.1 });
  assert.deepEqual(validSampling('x'), {});
});

test('the manifest carries its sampling through parseManifest (valid keys only) and works without it', () => {
  const base = { format: 'gguf-chunks-v1', name: 'm', quant: 'Q4', size: 4, sha256: 'a'.repeat(64), chunk_bytes: 4, chunks: [{ n: 0, path: 'home/model/chunk-0000.bin', offset: 0, size: 4, sha256: 'b'.repeat(64) }] };
  assert.deepEqual(parseManifest(JSON.stringify({ ...base, sampling: { penalty_repeat: 1.1, bogus: 1, top_k: -4 } })).sampling, { penalty_repeat: 1.1 });
  assert.equal(parseManifest(JSON.stringify(base)).sampling, undefined);
  assert.equal(parseManifest(JSON.stringify({ ...base, sampling: 'x' })).sampling, undefined);
});

test('max_tokens is a sampling key too: the answer budget the trainer wants (16 to 512, whole), 256 by default', () => {
  assert.equal(DEFAULT_SAMPLING.max_tokens, 256);
  assert.equal(resolveSampling({ max_tokens: 180 }).max_tokens, 180);
  for (const bad of [0, 15, 513, 1e6, 180.5, -1, '180', null]) assert.equal(resolveSampling({ max_tokens: bad }).max_tokens, 256, String(bad));
});

test('settings are taken at three decimals, the precision the events carry (tidy), so what generates is exactly what is reported', () => {
  assert.equal(resolveSampling({ penalty_repeat: 1.0004 }).penalty_repeat, 1, 'rounded when accepted, not only when shown');
  assert.equal(resolveSampling({ penalty_repeat: 1.0006 }).penalty_repeat, 1.001);
  assert.equal(resolveSampling({ temperature: 0.12345 }).temperature, 0.123);
  assert.equal(resolveSampling({ top_p: 0.0049 }).top_p, 0.95, 'a value that rounds below its range is out of range: the default stays');
});

test('think_tokens is the thinking budget: whole, 16 to 256, 90 by default; max_tokens is the answer budget', () => {
  assert.equal(DEFAULT_SAMPLING.think_tokens, 90);
  assert.equal(resolveSampling({ think_tokens: 60 }).think_tokens, 60);
  for (const bad of [0, 15, 257, 60.5, -1, '60', null]) assert.equal(resolveSampling({ think_tokens: bad }).think_tokens, 90, String(bad));
});
