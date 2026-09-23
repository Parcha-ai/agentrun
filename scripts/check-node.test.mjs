import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = new URL('./check-node.mjs', import.meta.url).href;
const check = version => spawnSync(process.execPath, ['--input-type=module', '-e',
  `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(script)});`,
], { encoding: 'utf8', timeout: 10_000 });

test('unsupported runtimes get the detected version and a recovery command, without a loader traceback', () => {
  for (const version of ['20.20.0', '21.7.3', '22.14.0', '22.18.9']) {
    const result = check(version);
    assert.equal(result.status, 1, version);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(`you have v${version}`), result.stderr);
    assert.match(result.stderr, /Node\.js 22\.19 or newer/);
    assert.match(result.stderr, /nvm install && nvm use/);
    assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/);
  }
});

test('the minimum version, current pin and later majors pass without output', () => {
  for (const version of ['22.19.0', '22.23.2', '23.0.0', '24.0.0']) {
    const result = check(version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
