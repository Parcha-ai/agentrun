// The build output's round trip on a made-up repository: pack takes every ignored file outside node_modules, unpack
// restores them in another checkout of the same tree, and refuses another tree, another Node, a changed archive, or an
// archive that writes into a tracked file; pack refuses a build that left a file git neither tracks nor ignores.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outputPaths, pack, unpack } from './ci-build-output.mjs';

const script = fileURLToPath(new URL('./ci-build-output.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ci-build-output-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], { cwd, encoding: 'utf8' });

/** A committed repository with an ignored dist and node_modules, and a clone of it: the build job's and a test job's. */
function checkouts(name) {
  const built = join(scratch, name, 'built');
  write(join(built, '.gitignore'), 'dist/\nnode_modules/\n*.tsbuildinfo\n');
  write(join(built, 'packages/a/src/index.ts'), 'export const a = 1;\n');
  write(join(built, 'packages/a/package.json'), '{}\n');
  git(built, 'init', '-q');
  git(built, 'add', '.');
  git(built, 'commit', '-qm', 'one');
  const tested = join(scratch, name, 'tested');
  git(scratch, 'clone', '-q', built, tested);
  // The build: a dist, an incremental build's record, and installed packages, which stay out of the output.
  write(join(built, 'packages/a/dist/index.js'), 'export const a = 1;\n');
  write(join(built, 'packages/a/dist/sub/deep.js'), 'deep\n');
  write(join(built, 'packages/a/tsconfig.tsbuildinfo'), '{}\n');
  write(join(built, 'node_modules/x/index.js'), 'x\n');
  write(join(built, 'packages/a/node_modules/y/index.js'), 'y\n');
  return { built, tested, out: join(scratch, name, 'out') };
}

test('pack takes every file git ignores outside node_modules; unpack puts them in a checkout of the same tree, newer than it', () => {
  const { built, tested, out } = checkouts('round');
  assert.deepEqual(outputPaths(built), ['packages/a/dist/', 'packages/a/tsconfig.tsbuildinfo']);
  const packed = pack(built, out);
  assert.equal(packed.files, 3);
  assert.equal(packed.node, process.version);
  assert.equal(packed.tree, git(built, 'rev-parse', 'HEAD^{tree}').trim());
  const checkedOut = statSync(join(tested, 'packages/a/src/index.ts')).mtimeMs;
  unpack(tested, out);
  assert.equal(readFileSync(join(tested, 'packages/a/dist/sub/deep.js'), 'utf8'), 'deep\n');
  assert.ok(existsSync(join(tested, 'packages/a/tsconfig.tsbuildinfo')));
  assert.ok(!existsSync(join(tested, 'node_modules')), 'node_modules is not in the output');
  assert.ok(statSync(join(tested, 'packages/a/dist/index.js')).mtimeMs >= checkedOut, 'the output is no older than the checkout');
  const cli = spawnSync(process.execPath, [script, 'unpack', out], { cwd: tested, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^unpacked 3 files in 2 directories, [\d.]+ MB, built on Node v[\d.]+ from the tree [0-9a-f]{40}, in [\d.]+ s$/m);
});

test('unpack refuses another tree, another Node and an archive that is not the one packed, and changes nothing', () => {
  const { built, tested, out } = checkouts('refused');
  pack(built, out);
  const manifest = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  write(join(tested, 'packages/a/src/index.ts'), 'export const a = 2;\n');
  git(tested, 'commit', '-qam', 'two');
  assert.throws(() => unpack(tested, out), /it was built from the tree [0-9a-f]{40}, and this checkout is [0-9a-f]{40}/);
  git(tested, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(out, 'build.json'), JSON.stringify({ ...manifest, node: 'v0.0.0' }));
  assert.throws(() => unpack(tested, out), /it was built on Node v0\.0\.0, and this job runs v/);
  writeFileSync(join(out, 'build.json'), JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  assert.throws(() => unpack(tested, out), /build\.tar is not the archive the build job packed/);
  assert.ok(!existsSync(join(tested, 'packages/a/dist')), 'nothing was unpacked');
});

test('an archive that writes into a tracked file fails the unpack, and a build that leaves an unignored file fails the pack', () => {
  const { built, tested, out } = checkouts('tracked');
  pack(built, out);
  const manifest = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  // An archive whose entries include a tracked source file, changed.
  const forged = join(scratch, 'tracked', 'forged');
  write(join(forged, 'packages/a/src/index.ts'), 'export const a = 3;\n');
  execFileSync('tar', ['-cf', join(out, 'build.tar'), '-C', forged, 'packages/a/src/index.ts']);
  const sha256 = createHash('sha256').update(readFileSync(join(out, 'build.tar'))).digest('hex');
  writeFileSync(join(out, 'build.json'), JSON.stringify({ ...manifest, sha256 }));
  assert.throws(() => unpack(tested, out), /unpacking the build output changed files git does not ignore:\n M packages\/a\/src\/index\.ts/);
  write(join(built, 'packages/a/generated.ts'), 'stray\n');
  assert.throws(() => pack(built, join(scratch, 'tracked', 'out2')), /the build changed or added files git does not ignore[^]*\?\? packages\/a\/generated\.ts/);
});
