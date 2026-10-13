import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { extractSnippet, isMissing, judge, loadSpec, strangerEnv, validateSpec } from './stranger.mjs';

const readme = ['# Title', '', '## Install', '```sh', 'npm i x', '```', '', '## Offline tests', 'text', '```js', 'one();', '```', '```js', 'two();', '```', '### Sub', '```js', 'sub();', '```', '## Next', '```js', 'next();', '```', ''].join('\n');

test('a snippet is the nth block of its language under its heading, subheadings included', () => {
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js' }), 'one();\n');
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 1 }), 'two();\n');
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 2 }), 'sub();\n');
  assert.throws(() => extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 3 }), /no js block number 3/);
  assert.throws(() => extractSnippet(readme, { heading: 'Offline tests', fence: 'ts' }), /no ts block/);
  assert.throws(() => extractSnippet(readme, { heading: 'Missing', fence: 'js' }), /no heading/);
});

const spec = { expect: { exitCode: 0, pattern: 'Status: complete' }, timeoutMs: 1000 };
const done = (over = {}) => ({ exitCode: 0, stdout: 'Status: complete\n', stderr: '', timedOut: false, ...over });

test('a command passes only with the expected exit code and output', () => {
  assert.deepEqual(judge(spec, done()), []);
  assert.match(judge(spec, done({ exitCode: 1 }))[0], /exit code 1, expected 0/);
  assert.match(judge(spec, done({ stdout: 'nope' }))[0], /does not match/);
  assert.deepEqual(judge({ ...spec, expect: { exitCode: 2, pattern: 'x' } }, done({ exitCode: 2, stdout: 'x' })), []);
  assert.ok(judge(spec, done({ timedOut: true, exitCode: -1 })).some(problem => /no exit within 1000 ms/.test(problem)));
});

test('a stranger starts with the PATH, an empty home and a private cache, and no key', () => {
  const env = strangerEnv('/bin', '/h', '/c');
  assert.deepEqual(Object.keys(env).filter(key => !key.startsWith('npm_config_')), ['PATH', 'HOME']);
  assert.equal(Object.keys(env).some(key => /KEY|TOKEN|SECRET/i.test(key)), false);
});

test('a spec is complete, or says why it has no path', () => {
  assert.throws(() => validateSpec({ package: 'p', expect: 'no-key path missing' }, 'p'), /needs a reason/);
  assert.equal(isMissing(validateSpec({ package: 'p', expect: 'no-key path missing', reason: 'r' }, 'p')), true);
  assert.throws(() => validateSpec({ package: 'p', install: [], command: ['x'], expect: { pattern: 'x' }, timeoutMs: 1 }, 'p'), /install/);
  assert.throws(() => validateSpec({ package: 'p', install: ['dsl'], command: ['x'], expect: {}, timeoutMs: 1 }, 'p'), /expect.pattern/);
});

test('every spec in the repository is valid and every snippet it runs is in its README', async () => {
  const names = (await readdir(new URL('./stranger/', import.meta.url))).map(file => file.replace(/\.json$/, ''));
  assert.ok(names.includes('agentrun-dsl') && names.includes('agentrun-jev'));
  for (const name of names) {
    const loaded = await loadSpec(name);
    for (const file of loaded.files ?? []) {
      const text = extractSnippet(await readFile(new URL(`../${file.readme}`, import.meta.url), 'utf8'), file);
      for (const [from] of file.replace ?? []) assert.ok(text.includes(from), `${name}: ${from}`);
    }
  }
});
