import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staleUndici } from './check-undici.mjs';

// The shape `npm ls undici --all --json` prints: each package's dependencies by name, a deduped copy with its version only.
const tree = (disk, codingAgent, browser = '6.29.1') => ({ name: 'workspace', dependencies: {
  '@parcha/agentrun-harness': { version: '0.1.0', dependencies: { '@earendil-works/pi-ai': { version: '1.1.0', dependencies: { openai: { version: '7.19.0', dependencies: { undici: { version: disk } } } } } } },
  '@parcha/agentrun-pi': { version: '0.1.0', dependencies: { '@earendil-works/pi-coding-agent': { version: '1.1.0', dependencies: { undici: { version: codingAgent } } } } },
  '@parcha/pi-browser': { version: '0.1.0', dependencies: { undici: { version: browser } } },
  '@parcha/pi-durable-disk': { version: '0.1.0', dependencies: { disk: { version: '1.9.0', dependencies: { undici: { version: disk } } } } },
} });

test('the tree before the overrides fails at every path that reaches undici 8.10.2', () => {
  assert.deepEqual(staleUndici(tree('8.10.2', '8.10.2')), [
    '@parcha/agentrun-harness@0.1.0 > @earendil-works/pi-ai@1.1.0 > openai@7.19.0 > undici@8.10.2',
    '@parcha/agentrun-pi@0.1.0 > @earendil-works/pi-coding-agent@1.1.0 > undici@8.10.2',
    '@parcha/pi-durable-disk@0.1.0 > disk@1.9.0 > undici@8.10.2',
  ]);
  assert.deepEqual(staleUndici(tree('8.12.2', '8.12.1')), ['@parcha/agentrun-pi@0.1.0 > @earendil-works/pi-coding-agent@1.1.0 > undici@8.12.1'], 'one copy left behind is enough');
});

test('undici 8.12.2 and later, and another major (pi-browser keeps 6), pass', () => {
  for (const version of ['8.12.2', '8.12.3', '8.13.0', '9.0.0']) assert.deepEqual(staleUndici(tree(version, version)), [], version);
  assert.deepEqual(staleUndici(tree('8.12.2', '8.12.2', '7.30.1')), []);
});

test('an undici whose version npm cannot report fails', () => {
  assert.deepEqual(staleUndici(tree('8.12.2', undefined)), ['@parcha/agentrun-pi@0.1.0 > @earendil-works/pi-coding-agent@1.1.0 > undici@?']);
  assert.deepEqual(staleUndici(tree('8.12.2', '8.12')), ['@parcha/agentrun-pi@0.1.0 > @earendil-works/pi-coding-agent@1.1.0 > undici@8.12']);
});

test('each major has its own floor: 6.29.1, 7.30.1 and 8.12.2; before 6 fails, and 9 or later passes', () => {
  for (const version of ['5.29.0', '6.29.0', '7.29.0', '7.30.0', '8.12.1']) {
    assert.deepEqual(staleUndici(tree('8.12.2', '8.12.2', version)), [`@parcha/pi-browser@0.1.0 > undici@${version}`], version);
  }
  for (const version of ['6.29.1', '6.30.0', '7.30.1', '7.31.0', '8.12.2', '9.0.0', '10.1.0']) {
    assert.deepEqual(staleUndici(tree('8.12.2', '8.12.2', version)), [], version);
  }
});
