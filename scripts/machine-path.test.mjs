// The one machine-path rule (machine-path.mjs), as export-source.mjs and verify-packages.mjs both apply it. The paths are
// joined from parts so this file holds none the rule would find.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MACHINE_PATH } from './machine-path.mjs';

const path = (...parts) => ['', ...parts].join('/');

test('a home folder is a machine path: a user name under home or Users, or under a drive\'s Users folder', () => {
  for (const text of [path('home', 'bob', 'x'), path('Users', 'alice', 'x'), `"${path('Users', 'Sharedfolks', 'x')}"`, ['C:', 'Users', 'carol', 'x'].join('\\')]) {
    assert.ok(MACHINE_PATH.test(text), text);
  }
});

test('macOS\'s shared folder, an API route template and a passwd line are not', () => {
  for (const text of [path('Users', 'Shared', 'agentrun', 'labels.json'), ['C:', 'Users', 'Shared', 'x'].join('\\'), `/agents/{agent_id}${path('home', 'files', '{path}')}`, `pda:x:1500:1500::${path('home', 'pda:')}bin/bash`]) {
    assert.equal(MACHINE_PATH.test(text), false, text);
  }
});
