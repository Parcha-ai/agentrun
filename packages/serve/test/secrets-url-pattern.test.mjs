import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, redactLearned, secretShapes, learnedSecretShapes } from '../dist/learn/secrets.js';
const scheme = 'https';
const extraction = String.raw`export GH_TOKEN=$(sed -n 's|${scheme}://x-access-token:\([^@]*\)@github.com|\1|p' ~/.git-credentials | head -1)`;
const url = password => `${scheme}://fixture-user:${password}@example.test/`;

test('a complete sed capture expression is a URL-matching pattern, not a credential value', () => {
  for (const pattern of [extraction, extraction.replace('x-access-token', '[^:]*')]) {
    assert.deepEqual(secretShapes(pattern), []);
    assert.deepEqual(learnedSecretShapes(pattern), []);
    assert.equal(redactSecrets(pattern, []), pattern);
    assert.equal(redactLearned(pattern, []), pattern);
  }
});

test('actual credential URLs remain redacted including regex punctuation and special characters', () => {
  for (const password of ['fixture-password', 'a[b]c', String.raw`a\b(c)`, '[^token]', '(fixture)', '%5B%5E%40%5D*', String.raw`\([^@]*\)`]) {
    const input = url(password);
    assert.ok(secretShapes(input).includes('URL with a password'));
    assert.notEqual(redactSecrets(input, []), input);
    assert.ok(redactSecrets(input, []).includes('[redacted]'));
  }
});

test('a malformed sed expression or a literal credential inside sed is never exempted', () => {
  for (const input of [
    extraction.replace(String.raw`\)@`, '@'),
    extraction.replace(String.raw`|\1|p`, '|literal|p'),
    extraction.replace("|p'", '|p'),
    extraction.replace(String.raw`:\(`, String.raw`:fixture-secret\(`),
    extraction.replace(String.raw`\([^@]*\)`, 'fixture-secret'),
  ]) {
    assert.ok(secretShapes(input).includes('URL with a password'));
    assert.notEqual(redactSecrets(input, []), input);
  }
});

test('the exemption only covers the pattern span and cannot hide a nearby or explicitly held secret', () => {
  const input = `${extraction}\nFetch ${url('fixture-password')}`;
  const cleaned = redactSecrets(input, []);
  assert.ok(secretShapes(input).includes('URL with a password'));
  assert.ok(cleaned.startsWith(extraction));
  assert.ok(cleaned.includes('[redacted]'));
  assert.doesNotMatch(cleaned, /fixture-password/);
  assert.notEqual(redactSecrets(extraction, ['x-access-token']), extraction);
});
