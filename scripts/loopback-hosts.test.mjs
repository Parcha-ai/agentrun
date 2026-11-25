// The hosts AgentRun takes as this machine, held in three places that cannot import each other: the CLI's
// (packages/agentrun/lib/device.mjs LOOPBACK, the hosts a device sign-in may reach over http), the TypeScript client's and
// the Python client's (the hosts AGENTRUN_TOKEN may go to). Read as text from each file, the three sets must be one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCES = {
  cli: new URL('../packages/agentrun/lib/device.mjs', import.meta.url),
  typescript: new URL('../packages/client/src/client.ts', import.meta.url),
  python: new URL('../python/agentrun/_client.py', import.meta.url),
};

/** The quoted hosts of the one line in `file` that defines LOOPBACK (const LOOPBACK = new Set([...]) or
 *  _LOOPBACK = (...)), sorted. */
function hostsOf(name, file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => /^(?:const LOOPBACK = new Set\(\[|_LOOPBACK = \()/.test(line));
  assert.equal(lines.length, 1, `${name}: one line defines LOOPBACK (found ${lines.length})`);
  const hosts = [...lines[0].replace(/\s*(?:\/\/|#).*$/, '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hosts.length > 0, `${name}: LOOPBACK names hosts`);
  return hosts.sort();
}

test('the CLI, the TypeScript client and the Python client take the same hosts as this machine', () => {
  const sets = Object.fromEntries(Object.entries(SOURCES).map(([name, file]) => [name, hostsOf(name, file)]));
  assert.deepEqual(sets.cli, ['127.0.0.1', '[::1]', 'localhost']);
  assert.deepEqual(sets.typescript, sets.cli, 'the TypeScript client holds the CLI\'s hosts');
  assert.deepEqual(sets.python, sets.cli, 'the Python client holds the CLI\'s hosts');
});
