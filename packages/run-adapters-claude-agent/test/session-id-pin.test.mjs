// The Claude Agent adapter's session ids are a hash of the run's key under a fixed salt (src/ids.ts), so a session
// resumed after an upgrade finds its transcript. Renaming the package keeps the salt; this pins one id, computed outside the
// code (sha256 of the salted name, as a version-5 UUID), so a change to the salt fails here by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidFrom } from '../dist/ids.js';

test('a session id is stable: the salt that derives it never changes', () => {
  assert.equal(uuidFrom('step:pinned-session'), 'cd09de8f-f7ac-567d-9827-356e0dd87656');
});
