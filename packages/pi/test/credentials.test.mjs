import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialIn, credentialInValue, FORBIDDEN } from '../dist/credentials.js';

// Each sample is made of parts, so no literal in this file is shaped like the credential it stands for.
const SAMPLES = {
  'machine path': ['/ho', 'me/someone/work/file.txt'].join(''),
  'private key': ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
  'github token': ['gh', 'p_', 'a'.repeat(36)].join(''),
  'provider secret': ['sk', '-proj-', 'b'.repeat(40)].join(''),
  'aws access key': ['AKI', 'A', 'C'.repeat(16)].join(''),
  jwt: ['ey', 'J', 'h'.repeat(12), '.ey', 'J', 'p'.repeat(12), '.', 's'.repeat(12)].join(''),
  'browserbase api key': ['bb', '_live_', 'd'.repeat(24)].join(''),
  'credential url': ['https://user', ':', 'pass', '@example.test/x'].join(''),
  'bearer secret': ['Bear', 'er ', 'e'.repeat(30)].join(''),
  'literal credential': ['api', '_key = "', 'f'.repeat(12), '"'].join(''),
};

test('every shape is named, frozen, and caught by a sample of its own', () => {
  assert.deepEqual(FORBIDDEN.map(([name]) => name), Object.keys(SAMPLES));
  assert.ok(Object.isFrozen(FORBIDDEN));
  for (const [name, sample] of Object.entries(SAMPLES)) assert.equal(credentialIn(`before ${sample} after`), name, name);
});

test('plain text and short look-alikes pass', () => {
  for (const text of ['a report on dependencies', 'sk-short', 'Bearer token', 'see https://example.test/path', 'password', '/home']) assert.equal(credentialIn(text), undefined, text);
});

test('a value is read through its strings and its keys, however deep', () => {
  assert.equal(credentialInValue({ a: [{ b: SAMPLES['github token'] }] }), 'github token');
  assert.equal(credentialInValue({ [SAMPLES['provider secret']]: 1 }), 'provider secret');
  assert.equal(credentialInValue({ a: [1, null, true, 'fine'], b: { c: 2 } }), undefined);
  assert.equal(credentialInValue(JSON.parse(`{"k":"${'\\u0073'}k-proj-${'b'.repeat(40)}"}`)), 'provider secret');
});
