// ./host's box install (box-install.ts): the one root step, as an operator runs it on the host. These inject the
// effective uid, bwrap's stat and the parser's run, so they run anywhere, unprivileged; the CI job's box tests run the
// real install on a throwaway runner.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BoxInstallError, installBox, profileText } from '@parcha/agentrun-adapters/host';

function setup(stat = { uid: 0, mode: 0o100755 }) {
  const dir = mkdtempSync(join(tmpdir(), 'box-install-'));
  const runs = [];
  return {
    profile: join(dir, 'agentrun-bwrap'),
    runs,
    options: (extra = {}) => ({ euid: 0, stat: () => stat, restricted: () => true, run: (command, args) => (runs.push([command, ...args]), { status: 0, stderr: '' }), profile: join(dir, 'agentrun-bwrap'), ...extra }),
  };
}
const refused = (fn, why) => assert.throws(fn, (e) => e instanceof BoxInstallError && why.test(e.message));

test('the install writes the profile for /usr/bin/bwrap and loads it with apparmor_parser -r', () => {
  const { profile, runs, options } = setup();
  assert.deepEqual(installBox(options()), { status: 'installed', profile, written: true });
  assert.equal(readFileSync(profile, 'utf8'), profileText('/usr/bin/bwrap'));
  assert.match(readFileSync(profile, 'utf8'), /^profile agentrun-bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\n {2}userns,\n\}$/m);
  assert.equal(statSync(profile).mode & 0o777, 0o644);
  assert.deepEqual(runs, [['apparmor_parser', '-r', profile]]);
});

test('the install is idempotent: the same content is not rewritten, and it is loaded either way', () => {
  const { profile, runs, options } = setup();
  installBox(options());
  const first = statSync(profile);
  assert.deepEqual(installBox(options()), { status: 'installed', profile, written: false });
  const second = statSync(profile);
  assert.equal(second.ino, first.ino, 'the file was replaced');
  assert.equal(second.mtimeMs, first.mtimeMs, 'the file was rewritten');
  assert.equal(runs.length, 2, 'loaded both times');
});

test('a setuid bwrap is refused, and nothing is written or loaded', () => {
  const { profile, runs, options } = setup({ uid: 0, mode: 0o104755 });
  refused(() => installBox(options()), /setuid: refused/);
  assert.throws(() => readFileSync(profile));
  assert.deepEqual(runs, []);
});

test('a bwrap that is not root\'s, or not 0755, is refused', () => {
  refused(() => installBox(setup({ uid: 1000, mode: 0o100755 }).options()), /not owned by root: refused/);
  refused(() => installBox(setup({ uid: 0, mode: 0o100775 }).options()), /mode 775, not 0755: refused/);
  refused(() => installBox(setup({ uid: 0, mode: 0o100750 }).options()), /mode 750, not 0755: refused/);
});

test('the install runs only as root, needs bwrap, and fails loudly when the parser does', () => {
  const { options } = setup();
  refused(() => installBox(options({ euid: 1000 })), /runs as root, once, on the host that runs serve/);
  refused(() => installBox(options({ stat: () => { throw new Error('ENOENT'); } })), /is not installed/);
  refused(() => installBox(options({ run: () => ({ status: 1, stderr: 'apparmor_parser: Unable to replace' }) })), /apparmor_parser -r .* failed: apparmor_parser: Unable to replace/);
});

test('a host that does not restrict user namespaces needs nothing: no file, no load', () => {
  const { profile, runs, options } = setup();
  assert.equal(installBox(options({ restricted: () => false })).status, 'not_needed');
  assert.throws(() => readFileSync(profile));
  assert.deepEqual(runs, []);
});
