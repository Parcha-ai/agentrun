// The viewer computes a paid call's receipt key itself (it imports no package): the same SHA-256 and canonical JSON as the DSL's
// `canonicalHash`, checked against Node's own digest, and against the DSL when it is built beside this checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { argsHashOf, receiptKeyOf, sha256Hex } from '../src/receipt-key.ts';

const node = (text: string) => createHash('sha256').update(text).digest('hex');

test('sha256 matches Node\'s on the known vectors, block boundaries and multi-byte text', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) assert.equal(sha256Hex('x'.repeat(length)), node('x'.repeat(length)), `${length} bytes`);
  for (const text of ['héllo wörld', '日本語のテキスト', 'emoji 🙂 mixed', '{"q":"a b\\n"}']) assert.equal(sha256Hex(text), node(text), text);
});

test('the arguments\' hash ignores key order at every depth and keeps array order', () => {
  assert.equal(argsHashOf({ a: 1, b: { x: [1, 2], y: null } }), argsHashOf({ b: { y: null, x: [1, 2] }, a: 1 }));
  assert.notEqual(argsHashOf({ a: [1, 2] }), argsHashOf({ a: [2, 1] }));
  assert.equal(argsHashOf({ a: 1 }), node('{"a":1}'));
  assert.equal(receiptKeyOf('paid', undefined), `paid:${node('{}')}`);
});

test('a fetch wrapper is keyed as the gateway tool it names, and any other tool as itself', () => {
  assert.equal(receiptKeyOf('fetch', { tool: 'registry', args: { name: 'x' } }), `registry:${node('{"name":"x"}')}`);
  assert.equal(receiptKeyOf('fetch', { url: 'https://example.test' }), `fetch:${node('{"url":"https://example.test"}')}`);
  assert.equal(receiptKeyOf('browser_read', { what: 'text' }), `browser_read:${node('{"what":"text"}')}`);
});

// The viewer holds a second copy of the DSL's canonicalHash and of gatewayIntentOf's fetch-wrapper rule. This test is required: it fails when
// the DSL is not built (npm run build first), and compares every key over a fixed vector set.
const built = (name: string) => new URL(`../../../packages/dsl/dist/recovery/${name}.js`, import.meta.url);
const VECTORS: [string, unknown][] = [
  ['an empty object', {}],
  ['a plain call', { q: 1 }],
  ['nested objects in another key order', { b: { z: [1, { y: 2, x: 1 }], a: null }, a: true }],
  ['arrays keep their order', { list: [3, 1, 2], pairs: [[1, 2], [2, 1]] }],
  ['unicode and escapes', { text: 'héllo wörld 日本語 🙂', quote: 'a "b" \\ \n\t' }],
  ['numbers 1.0, -0, 1e21, 0.1 and a large integer', { one: 1.0, negativeZero: -0, big: 1e21, tenth: 0.1, int: 12345678901234567890 }],
  ['an undefined member', { a: undefined, b: 1 }],
  ['a fetch wrapper naming a gateway tool', { tool: 'registry', args: { name: 'left-pad', version: '1.3.0' } }],
  ['a fetch wrapper with its arguments in another key order', { args: { version: '1.3.0', name: 'left-pad' }, tool: 'registry' }],
  ['a fetch with a url, not a wrapper', { url: 'https://example.test/a?b=1' }],
  ['a fetch whose args is an array', { tool: 'registry', args: [1, 2] }],
];

test('the same digests and receipt keys as the DSL, over a fixed vector set (the DSL must be built)', async () => {
  const hashFile = built('canonical-hash');
  const intentFile = built('handoff-receipts');
  assert.ok(existsSync(hashFile) && existsSync(intentFile), 'The DSL is not built: run npm run build before the viewer tests');
  const { canonicalHash } = await import(hashFile.href) as { canonicalHash: (value: unknown) => string };
  const { gatewayIntentOf } = await import(intentFile.href) as { gatewayIntentOf: (name: string, args: unknown) => { tool: string; argsHash: string } };
  for (const [label, value] of VECTORS) {
    assert.equal(argsHashOf(value as never), canonicalHash(value), `canonicalHash: ${label}`);
    for (const name of ['fetch', 'paid']) {
      const intent = gatewayIntentOf(name, value);
      assert.equal(receiptKeyOf(name, value as never), `${intent.tool}:${intent.argsHash}`, `${name}: ${label}`);
    }
  }
  const intent = gatewayIntentOf('paid', undefined);
  assert.equal(receiptKeyOf('paid', undefined), `${intent.tool}:${intent.argsHash}`, 'no arguments');
});
