import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('./check-node.mjs', import.meta.url).href;
const check = version => spawnSync(process.execPath, ['--input-type=module', '-e',
  `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(script)});`,
], { encoding: 'utf8', timeout: 10_000 });
const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;

test('the floor is the engines field, at the November 2026 security release', () => {
  assert.equal(engines, '>=24.22.3');
});

test('unsupported runtimes get the detected version and a recovery command, without a loader traceback', () => {
  // 24.22.0-24.22.2 share the floor's minor: only the patch tells them apart, and they lack the security fixes.
  for (const version of ['20.20.0', '21.7.3', '22.19.0', '22.23.5', '23.0.0', '23.11.1', '24.0.0', '24.1.0', '24.2.0', '24.11.0', '24.21.0', '24.22.0', '24.22.2']) {
    const result = check(version);
    assert.equal(result.status, 1, version);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(`you have v${version}`), result.stderr);
    assert.match(result.stderr, /Node\.js 24\.22\.3 or newer/);
    assert.match(result.stderr, /nvm install && nvm use/);
    assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/);
  }
});

test('the floor itself, later patches and minors, and later majors pass without output', () => {
  for (const version of ['24.22.3', '24.22.10', '24.23.0', '25.0.0', '26.0.0']) {
    const result = check(version);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
