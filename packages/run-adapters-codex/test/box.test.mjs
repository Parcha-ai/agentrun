// Codex's own sandbox and the host's box: off in a box, which is the boundary; as the session says only where the
// operator said `unsandboxed`; and a named refusal anywhere else. Nothing probes bubblewrap, and nothing falls back to
// danger-full-access on its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexSandboxMode } from '../dist/harness.js';

const quiet = () => {};

test("in the host's box, Codex's own sandbox is off, and a mode that would nest one is refused by name", () => {
  for (const mode of ['bwrap', 'seatbelt', 'provider']) {
    assert.equal(codexSandboxMode({ mode, cgroup: false }, undefined, quiet), 'danger-full-access', mode);
    assert.equal(codexSandboxMode({ mode, cgroup: false }, 'danger-full-access', quiet), 'danger-full-access', mode);
  }
  for (const asked of ['workspace-write', 'read-only']) {
    assert.throws(() => codexSandboxMode({ mode: 'bwrap', cgroup: true }, asked, quiet), (error) => error.name === 'Unavailable' && error.code === 'box_nested' && error.message.includes(`Codex's own sandbox (${asked}) cannot start inside the host's box`));
  }
});

test('with no box from the host, or one it found unavailable, the turn fails by name, never danger-full-access', () => {
  assert.throws(() => codexSandboxMode(undefined, undefined, quiet), (error) => error.code === 'box_unavailable' && /run only in the host's box, and the host gave this machine no box/.test(error.message));
  assert.throws(() => codexSandboxMode(undefined, 'danger-full-access', quiet), (error) => error.code === 'box_unavailable', 'asking for danger-full-access is not a way around the box');
  assert.throws(() => codexSandboxMode({ mode: 'unavailable', error: 'bwrap_userns_denied', detail: 'setting up uid map: Permission denied' }, undefined, quiet), (error) => error.code === 'box_unavailable' && error.message.includes('its box is unavailable (bwrap_userns_denied: setting up uid map: Permission denied)'));
});

test("unsandboxed, the operator's word: the session's mode, default danger-full-access, said in the log", () => {
  const lines = [];
  const log = (message, fields) => lines.push([message, fields]);
  assert.equal(codexSandboxMode({ mode: 'unsandboxed' }, undefined, log), 'danger-full-access');
  assert.equal(codexSandboxMode({ mode: 'unsandboxed' }, 'workspace-write', log), 'workspace-write');
  assert.deepEqual(lines.map(([message]) => message), Array(2).fill("codex: unsandboxed: Codex's own tools run with no box, on the operator's setting"));
});
