import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverrides, findDrift, pinsFor, resolveDependency } from './pi-family-pins.mjs';

const scope = '@earendil-works';
// The coding agent depends on the agent core and on chord; chord is at 1.0.4 at the root and at 1.1.0 under the coding agent.
// The agent core depends on pi-ai. Chord and pi-ai have no @earendil-works dependencies of their own.
const lock = {
  '': { name: 'fixture' },
  [`node_modules/${scope}/pi-coding-agent`]: { version: '1.1.0', dependencies: { [`${scope}/pi-agent-core`]: '^1.1.0', [`${scope}/chord`]: '^1.0.0', typebox: '^1.0.0' } },
  [`node_modules/${scope}/pi-coding-agent/node_modules/${scope}/chord`]: { version: '1.1.0' },
  [`node_modules/${scope}/pi-agent-core`]: { version: '1.1.0', dependencies: { [`${scope}/pi-ai`]: '^1.1.0' } },
  [`node_modules/${scope}/pi-ai`]: { version: '1.1.0' },
  [`node_modules/${scope}/chord`]: { version: '1.0.4' },
  'node_modules/typebox': { version: '1.0.0' },
};
const codingAgent = `node_modules/${scope}/pi-coding-agent`;
const key = name => `${scope}/${name}`;

test('a dependency resolves to its parent\'s own nested version before the root\'s', () => {
  assert.equal(resolveDependency(lock, codingAgent, key('chord')).version, '1.1.0');
  assert.equal(resolveDependency(lock, `node_modules/${scope}/pi-agent-core`, key('chord')).version, '1.0.4');
  assert.equal(resolveDependency(lock, codingAgent, key('pi-ai')).version, '1.1.0');
  assert.equal(resolveDependency(lock, codingAgent, key('missing')), undefined);
});

test('a pinned dependency carries its own pins beside its version', () => {
  assert.deepEqual(pinsFor(lock, codingAgent), {
    [key('pi-agent-core')]: { '.': '1.1.0', [key('pi-ai')]: { '.': '1.1.0' } },
    [key('chord')]: { '.': '1.1.0' },
  });
});

test('npm 10 gives every package with @earendil-works dependencies its own top-level entry', () => {
  const { overrides } = buildOverrides(lock, 10);
  assert.deepEqual(overrides, {
    [`${key('pi-coding-agent')}@1.1.0`]: { [key('pi-agent-core')]: { '.': '1.1.0', [key('pi-ai')]: { '.': '1.1.0' } }, [key('chord')]: { '.': '1.1.0' } },
    [`${key('pi-agent-core')}@1.1.0`]: { [key('pi-ai')]: { '.': '1.1.0' } },
  });
});

test('npm 11 pins a package that another one depends on through its parent only', () => {
  const { overrides } = buildOverrides(lock, 11);
  assert.deepEqual(overrides, {
    [`${key('pi-coding-agent')}@1.1.0`]: { [key('pi-agent-core')]: { '.': '1.1.0', [key('pi-ai')]: { '.': '1.1.0' } }, [key('chord')]: { '.': '1.1.0' } },
  });
});

test('the held versions list every version of a name, nested ones included', () => {
  const { held } = buildOverrides(lock, 10);
  assert.deepEqual([...held.get(key('chord'))].sort(), ['1.0.4', '1.1.0']);
  assert.deepEqual([...held.get(key('pi-ai'))], ['1.1.0']);
  assert.equal(held.has('typebox'), false);
});

test('a lockfile with no @earendil-works package is refused', () => {
  assert.throws(() => buildOverrides({ '': {}, 'node_modules/typebox': { version: '1.0.0' } }, 10), /holds no @earendil-works package/);
});

test('the drift check accepts the versions the lockfile holds, nested ones included', () => {
  const { held } = buildOverrides(lock, 10);
  const consumer = {
    '': {},
    [`node_modules/${scope}/chord`]: { version: '1.0.4' },
    [`node_modules/${scope}/pi-coding-agent/node_modules/${scope}/chord`]: { version: '1.1.0' },
    [`node_modules/${scope}/pi-ai`]: { version: '1.1.0' },
    'node_modules/typebox': { version: '9.9.9' },
  };
  assert.deepEqual(findDrift(consumer, held), []);
  assert.deepEqual(findDrift(undefined, held), []);
});

test('the drift check rejects a version the lockfile does not hold', () => {
  const { held } = buildOverrides(lock, 10);
  const drifted = findDrift({ [`node_modules/${scope}/chord`]: { version: '1.2.0' }, [`node_modules/${scope}/pi-ai`]: { version: '1.1.0' } }, held);
  assert.equal(drifted.length, 1);
  assert.match(drifted[0], /^node_modules\/@earendil-works\/chord@1\.2\.0 \(repository: (1\.0\.4 or 1\.1\.0|1\.1\.0 or 1\.0\.4)\)$/);
});

test('the drift check rejects a name the lockfile does not hold', () => {
  const { held } = buildOverrides(lock, 10);
  assert.deepEqual(findDrift({ [`node_modules/${scope}/pi-codemode`]: { version: '1.1.0' } }, held), [`node_modules/${scope}/pi-codemode@1.1.0 (repository: none)`]);
});
