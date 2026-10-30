// In a box, the CLI's config directory is lent to the spawn's own box (the kernel's MachineSpawn.binds): the harness's
// own, and on a resume the SDK's resume dir, which the CLI reads its transcript from. Unboxed, nothing is lent.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sandboxSpawn } from '../dist/spawn.js';

const ROOT = mkdtempSync(join(tmpdir(), 'claude-binds-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const CONFIG = join(ROOT, 'dh-claude-1');
mkdirSync(CONFIG);

/** What the machine was asked to start, by a spawn of the CLI with `env` on a machine of `isolation`. */
function started(isolation, env) {
  const asked = [];
  const machine = { root: ROOT, ...(isolation ? { isolation } : {}), start: (options) => { asked.push(options); throw new Error('recorded'); } };
  const spawn = sandboxSpawn({ machine, executable: '/pinned/claude', env: { HOME: '/h', CLAUDE_CONFIG_DIR: CONFIG }, signal: new AbortController().signal, onError: () => {} });
  // The start threw (the machine here only records), so the CLI never ran: the process says so, and is heard.
  spawn({ command: '/pinned/claude', args: [], env: { HOME: '/h', ...env }, signal: new AbortController().signal }).on('error', () => {});
  assert.equal(asked.length, 1, 'the machine was asked to start the CLI');
  return asked[0];
}

test("boxed, the harness's own config directory is the spawn's bind; on a resume, the SDK's resume dir too", () => {
  for (const mode of ['bwrap', 'seatbelt', 'provider']) {
    assert.deepEqual(started({ mode, cgroup: false }, { CLAUDE_CONFIG_DIR: CONFIG }).binds, [CONFIG], mode);
  }
  const resume = mkdtempSync(join(tmpdir(), 'claude-resume-'));
  mkdirSync(join(resume, 'projects'));
  try {
    assert.deepEqual(started({ mode: 'bwrap', cgroup: false }, { CLAUDE_CONFIG_DIR: resume }).binds, [CONFIG, resume]);
  } finally {
    rmSync(resume, { recursive: true, force: true });
  }
});

test('unboxed, or with an unavailable box, the spawn lends nothing', () => {
  assert.equal('binds' in started(undefined, { CLAUDE_CONFIG_DIR: CONFIG }), false);
  assert.equal('binds' in started({ mode: 'unsandboxed' }, { CLAUDE_CONFIG_DIR: CONFIG }), false);
  assert.equal('binds' in started({ mode: 'unavailable', error: 'bwrap_missing', detail: 'x' }, { CLAUDE_CONFIG_DIR: CONFIG }), false);
});
