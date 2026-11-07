import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryVersion, setCanaryVersions, canaryPlan } from './canary.mjs';

// Three packages in dependency order: a beta one, a beta one that pins it, and one on its own version line that pins both.
const directories = ['dsl', 'serve', 'agentrun'];
const manifests = {
  dsl: { name: '@parcha/agentrun-dsl', version: '0.1.0-beta.31' },
  serve: { name: '@parcha/agentrun-serve', version: '0.1.0-beta.31', dependencies: { '@parcha/agentrun-dsl': '0.1.0-beta.31', zod: '4.1.0' } },
  agentrun: { name: '@parcha/agentrun', version: '0.3.6', dependencies: { '@parcha/agentrun-serve': '0.1.0-beta.31' }, peerDependencies: { '@parcha/agentrun-dsl': '0.1.0-beta.31' } },
};
async function tree(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-canary-test-'));
  try {
    for (const directory of directories) {
      await mkdir(join(root, 'packages', directory), { recursive: true });
      await writeFile(join(root, 'packages', directory, 'package.json'), JSON.stringify(manifests[directory], null, 2) + '\n');
    }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root, directory) => readFile(join(root, 'packages', directory, 'package.json'), 'utf8').then(JSON.parse);

test('a canary version: a plain x.y.z goes to the next patch, a beta keeps its core; the suffix names the run and the commit', () => {
  assert.equal(canaryVersion('0.3.6', 7, '6b9806298aa30d8e7f37fee29642865c18036b31'), '0.3.7-canary.7.g6b98062');
  assert.equal(canaryVersion('0.1.0-beta.31', 7, '6b9806298aa30d8e7f37fee29642865c18036b31'), '0.1.0-canary.7.g6b98062');
  assert.throws(() => canaryVersion('0.1', 7, '6b9806298aa30d8e7f37fee29642865c18036b31'), /not a version/);
  assert.throws(() => canaryVersion('0.3.6', 0, '6b9806298aa30d8e7f37fee29642865c18036b31'), /run number/);
  assert.throws(() => canaryVersion('0.3.6', 7, '6b98062'), /full commit sha/);
});

test('setCanaryVersions sets every package and every exact pin between them, and leaves other dependencies alone', () => tree(async root => {
  const set = await setCanaryVersions(root, directories, 7, '6b9806298aa30d8e7f37fee29642865c18036b31');
  assert.deepEqual(set, { '@parcha/agentrun-dsl': '0.1.0-canary.7.g6b98062', '@parcha/agentrun-serve': '0.1.0-canary.7.g6b98062', '@parcha/agentrun': '0.3.7-canary.7.g6b98062' });
  const serve = await read(root, 'serve');
  assert.deepEqual(serve.dependencies, { '@parcha/agentrun-dsl': '0.1.0-canary.7.g6b98062', zod: '4.1.0' });
  const agentrun = await read(root, 'agentrun');
  assert.equal(agentrun.version, '0.3.7-canary.7.g6b98062');
  assert.equal(agentrun.dependencies['@parcha/agentrun-serve'], '0.1.0-canary.7.g6b98062');
  assert.equal(agentrun.peerDependencies['@parcha/agentrun-dsl'], '0.1.0-canary.7.g6b98062');
  // Run twice, it refuses: a canary version is not a release version to start from.
  await assert.rejects(setCanaryVersions(root, directories, 8, '6b9806298aa30d8e7f37fee29642865c18036b31'), /already a canary/);
}));

test('canaryPlan lists the verified archives, in order, with their hashes, and refuses a plan that is not one canary', () => tree(async root => {
  await setCanaryVersions(root, directories, 7, '6b9806298aa30d8e7f37fee29642865c18036b31');
  await mkdir(join(root, '.release/packages'), { recursive: true });
  const verified = [];
  for (const directory of directories) {
    const { name, version } = await read(root, directory);
    const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    const bytes = Buffer.from(`archive of ${name}`);
    await writeFile(join(root, '.release/packages', filename), bytes);
    verified.push({ name, version, filename, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const receipt = packages => writeFile(join(root, '.release/verification.json'), JSON.stringify({ status: 'passed', packages }));
  await receipt(verified);
  const plan = await canaryPlan(root, directories, '6b9806298aa30d8e7f37fee29642865c18036b31');
  assert.equal(plan.status, 'passed');
  assert.equal(plan.tag, 'canary');
  assert.equal(plan.distTag, 'canary');
  assert.equal(plan.registry, 'https://registry.npmjs.org/');
  assert.deepEqual(plan.packages.map(pkg => [pkg.directory, pkg.version]), [['dsl', '0.1.0-canary.7.g6b98062'], ['serve', '0.1.0-canary.7.g6b98062'], ['agentrun', '0.3.7-canary.7.g6b98062']]);
  const bytes = Buffer.from('archive of @parcha/agentrun-dsl');
  assert.equal(plan.packages[0].integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  // A plan of a commit other than the one the versions name, a failed verification, or changed archive bytes is refused.
  await assert.rejects(canaryPlan(root, directories, '0000000000000000000000000000000000000000'), /names commit/);
  await writeFile(join(root, '.release/packages', verified[1].filename), 'changed');
  await assert.rejects(canaryPlan(root, directories, '6b9806298aa30d8e7f37fee29642865c18036b31'), /bytes changed/);
  await writeFile(join(root, '.release/verification.json'), JSON.stringify({ status: 'failed', packages: verified }));
  await assert.rejects(canaryPlan(root, directories, '6b9806298aa30d8e7f37fee29642865c18036b31'), /verification/);
}));
