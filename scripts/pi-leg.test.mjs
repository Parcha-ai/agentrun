import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accepts, legOf, parseRange, readWorkspaces, resolvedFrom } from './pi-leg.mjs';

const script = fileURLToPath(new URL('./pi-leg.mjs', import.meta.url));
const repo = dirname(dirname(script));
const scratch = mkdtempSync(join(tmpdir(), 'pi-leg-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const ws = (name, peers = {}, devDependencies = {}, scripts = {}) => ({ name, dir: `/nowhere/${name}`, manifest: { name, peerDependencies: peers, devDependencies, scripts } });
const PI = { '@earendil-works/pi-durable': '>=1.0.4 <1.2.0', '@earendil-works/chord': '>=1.0.4 <1.2.0', '@earendil-works/pi-coding-agent': '*' };
const WIDE = { '@earendil-works/pi-durable': '>=1.0.4 <1.3.0', '@earendil-works/chord': '>=1.0.4 <1.3.0' };

test('a range is read as the comparators the manifests use, and any other shape is refused', () => {
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.2.0'), true);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.0.4'), true);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.3.0'), false);
  assert.equal(accepts('>=1.0.4 <1.3.0', '1.0.3'), false);
  assert.equal(accepts('>=1.0.0 <1.1.0', '1.2.0'), false);
  assert.equal(accepts('*', '9.9.9'), true);
  assert.equal(accepts('1.1.0', '1.1.0'), true);
  assert.equal(accepts('1.1.0', '1.2.0'), false);
  assert.equal(accepts('>1.1.0 <=1.2.0', '1.2.0'), true);
  for (const range of ['^1.0.0', '~1.1.0', '>=1.0.4 || 2.0.0', '1.x', '>=1.0']) assert.throws(() => parseRange(range), /a shape this script does not read/, range);
  assert.throws(() => accepts('*', '1.2'), /not a plain x.y.z version/);
});

test('the leg is the pi workspaces whose every pi-family peer accepts the version; the others say which range keeps them out', () => {
  const plan = legOf([ws('@parcha/agentrun-dsl'), ws('@parcha/agentrun-pi', PI), ws('@parcha/pi-durable-disk', WIDE)], '1.2.0');
  assert.deepEqual(plan.pi, ['@parcha/agentrun-pi', '@parcha/pi-durable-disk'], 'a workspace with no pi-family peer is not a pi workspace');
  assert.deepEqual(plan.leg, ['@parcha/pi-durable-disk']);
  assert.deepEqual(plan.out, [{ name: '@parcha/agentrun-pi', why: '@earendil-works/pi-durable >=1.0.4 <1.2.0, @earendil-works/chord >=1.0.4 <1.2.0' }]);
  assert.deepEqual(plan.refused, []);
});

test('a leg workspace that depends on a pi workspace outside the leg is refused: one process would load two pi-durable versions', () => {
  const pi = ws('@parcha/agentrun-pi', WIDE, { '@parcha/pi-durable-disk': '0.1.0' });
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', PI)], '1.2.0').refused, [{ name: '@parcha/agentrun-pi', needs: ['@parcha/pi-durable-disk'] }]);
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', WIDE)], '1.2.0').refused, []);
  assert.deepEqual(legOf([pi, ws('@parcha/pi-durable-disk', WIDE), ws('@parcha/pi-vision', WIDE)], '1.0.4', ['@parcha/agentrun-pi']).refused,
    [{ name: '@parcha/agentrun-pi', needs: ['@parcha/pi-durable-disk'] }], '--only that leaves the dependency out is refused too');
});

test('--only narrows the leg to named pi workspaces and refuses a name that is not one', () => {
  const all = [ws('@parcha/agentrun-pi', WIDE), ws('@parcha/pi-vision', WIDE), ws('@parcha/agentrun-dsl')];
  const plan = legOf(all, '1.0.4', ['@parcha/agentrun-pi']);
  assert.deepEqual([plan.leg, plan.out], [['@parcha/agentrun-pi'], [{ name: '@parcha/pi-vision', why: 'not asked for (--only)' }]]);
  assert.throws(() => legOf(all, '1.0.4', ['@parcha/agentrun-dsl']), /is not a workspace with a pi-family peer/);
});

test('a module loads the nearest copy above its real directory, as a bare import resolves', () => {
  const root = join(scratch, 'resolve');
  write(join(root, 'node_modules/@earendil-works/chord/package.json'), { name: '@earendil-works/chord', version: '1.1.0' });
  write(join(root, 'packages/pi/node_modules/@earendil-works/chord/package.json'), { name: '@earendil-works/chord', version: '1.2.0' });
  write(join(root, 'packages/pi/package.json'), { name: '@parcha/agentrun-pi' });
  write(join(root, 'packages/disk/package.json'), { name: '@parcha/pi-durable-disk' });
  assert.equal(resolvedFrom(join(root, 'packages/pi'), '@earendil-works/chord').version, '1.2.0');
  assert.equal(resolvedFrom(join(root, 'packages/disk'), '@earendil-works/chord').version, '1.1.0');
  assert.equal(resolvedFrom(join(root, 'packages/disk'), '@earendil-works/pi-tui'), undefined);
});

/** A repository with `workspaces` under packages/, for running the script as CI does. */
function repoOf(name, workspaces) {
  const root = join(scratch, name);
  write(join(root, 'package.json'), { name: 'workspace', private: true, workspaces: ['packages/*'] });
  for (const { manifest } of workspaces) write(join(root, 'packages', manifest.name.split('/')[1], 'package.json'), manifest);
  return root;
}
const leg = (root, ...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

test('the plan names what runs and what does not; --require-all fails while any pi workspace is out, and a refusal always fails', () => {
  const partial = repoOf('partial', [ws('@parcha/agentrun-pi', PI), ws('@parcha/pi-durable-disk', WIDE), ws('@parcha/agentrun-dsl')]);
  const planned = leg(partial, '--pi', '1.2.0', '--plan', '--out', join(partial, 'out/leg.json'));
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /^pi 1\.2\.0: in the leg: @parcha\/pi-durable-disk$/m);
  assert.match(planned.stdout, /^pi 1\.2\.0: not in the leg: @parcha\/agentrun-pi \(@earendil-works\/pi-durable >=1\.0\.4 <1\.2\.0, @earendil-works\/chord >=1\.0\.4 <1\.2\.0\)$/m);
  const strict = leg(partial, '--pi', '1.2.0', '--plan', '--require-all');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /FAILED: --require-all, and 1 pi workspace\(s\) are not in the leg/);
  const all = repoOf('all', [ws('@parcha/agentrun-pi', WIDE), ws('@parcha/pi-durable-disk', WIDE)]);
  assert.equal(leg(all, '--pi', '1.2.0', '--plan', '--require-all').status, 0);
  const refused = repoOf('refused', [ws('@parcha/agentrun-pi', WIDE, { '@parcha/pi-durable-disk': '0.1.0' }), ws('@parcha/pi-durable-disk', PI)]);
  const out = leg(refused, '--pi', '1.2.0', '--plan');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /REFUSED: @parcha\/agentrun-pi depends on @parcha\/pi-durable-disk, which is not in the leg/);
});

test('an empty leg installs nothing and passes, saying so; an unread range shape, a missing version or no mode stops the script', () => {
  const none = repoOf('none', [ws('@parcha/agentrun-pi', PI)]);
  const empty = leg(none, '--pi', '1.2.0', '--scratch', '--npm', 'false');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /in the leg: none/);
  assert.doesNotMatch(empty.stdout, /^\$ /m, 'no command ran');
  const caret = repoOf('caret', [ws('@parcha/agentrun-pi', { '@earendil-works/pi-durable': '^1.0.4' })]);
  const unread = leg(caret, '--pi', '1.2.0', '--plan');
  assert.equal(unread.status, 2);
  assert.match(unread.stderr, /a shape this script does not read/);
  assert.equal(leg(none).status, 2);
  const neither = leg(none, '--pi', '1.2.0');
  assert.equal(neither.status, 2);
  assert.match(neither.stderr, /give --plan \(change nothing\) or --scratch/);
});

test('the install refuses an npm other than the pinned one before it changes anything', () => {
  const root = repoOf('npm', [ws('@parcha/pi-durable-disk', WIDE, { '@earendil-works/pi-durable': '1.1.0' })]);
  const fake = join(root, 'fake-npm.mjs');
  write(fake, 'console.log("10.9.2");\n');
  const out = leg(root, '--pi', '1.2.0', '--scratch', '--npm', `${process.execPath} ${fake}`);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAILED: the install needs npm 11\.21\.0; .* is 10\.9\.2/);
});

test("every pi-family peer range in this repository is one the script reads", () => {
  const workspaces = readWorkspaces(repo);
  for (const version of ['1.0.4', '1.1.0', '1.2.0']) assert.doesNotThrow(() => legOf(workspaces, version));
});
