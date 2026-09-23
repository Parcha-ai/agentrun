import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifest, checkReleaseDispatch, releasePackages, releasePackageNames, releasePreflight } from './release-preflight.mjs';

const exec = promisify(execFile);
const version = '0.1.0-beta.1';
const license = `MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.\n`;
const manifest = directory => ({ name: releasePackageNames[directory], version, license: 'MIT', type: 'module', files: ['dist', 'LICENSE'],
  repository: { type: 'git', url: 'git+https://github.com/Parcha-ai/agentrun.git', directory: `packages/${directory}` },
  homepage: 'https://agentrun.ai', bugs: { url: 'https://github.com/Parcha-ai/agentrun/issues' }, publishConfig: { access: 'public', tag: 'beta' },
  ...(directory === 'dsl' ? {} : { dependencies: { '@parcha/agentrun-dsl': version, ...(directory === 'pi' ? { '@parcha/agentrun-jev': version } : {}) } }),
});
const putJson = (path, value) => writeFile(path, JSON.stringify(value));
let baseline;
before(async () => {
  baseline = await mkdtemp(join(tmpdir(), 'agentrun-release-fixture-'));
  await mkdir(join(baseline, '.release/packages'), { recursive: true });
  await putJson(join(baseline, 'package.json'), { version, license: 'MIT', private: true });
  await writeFile(join(baseline, 'LICENSE'), license);
  for (const directory of releasePackages) {
    const cwd = join(baseline, 'packages', directory);
    await mkdir(join(cwd, 'dist'), { recursive: true });
    await putJson(join(cwd, 'package.json'), manifest(directory));
    await writeFile(join(cwd, 'LICENSE'), license);
    await writeFile(join(cwd, 'dist/index.js'), 'export const fixture = true;\n');
  }
  await recordPackages(baseline);
});
async function recordPackages(root) {
  const packages = [];
  for (const directory of releasePackages) {
    const [packed] = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(root, '.release/packages')], { cwd: join(root, 'packages', directory) })).stdout);
    const sha256 = createHash('sha256').update(await readFile(join(root, '.release/packages', packed.filename))).digest('hex');
    packages.push({ name: packed.name, version, filename: packed.filename, sha256 });
  }
  await putJson(join(root, '.release/verification.json'), { status: 'passed', packages,
    runtimeSmoke: { core: true, jev: true, pi: true, network: 'prohibited' }, audit: { vulnerabilities: { high: 0, critical: 0 } } });
}
after(async () => { await rm(baseline, { recursive: true, force: true }); });
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-release-case-'));
  try { await cp(baseline, root, { recursive: true }); await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const preflight = root => releasePreflight(root, `v${version}`, { checkGit: false });

test('provenance requires both the dispatch tag and SHA to match checked-out source', () => {
  const tag = `v${version}`, commit = 'a'.repeat(40);
  checkReleaseDispatch(tag, commit, { GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: commit });
  assert.throws(() => checkReleaseDispatch(tag, commit, { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit }), /requested release tag/);
  assert.throws(() => checkReleaseDispatch(tag, commit, { GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: 'b'.repeat(40) }), /Dispatch SHA/);
});

test('a failed TypeScript floor rerun replaces stale success evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-floor-failure-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, '.release'));
    await mkdir(join(root, 'bin'));
    await cp(new URL('./check-typescript-floor.mjs', import.meta.url), join(root, 'scripts/check-typescript-floor.mjs'));
    await writeFile(join(root, '.release/typescript-floor.json'), '{"status":"passed"}');
    await writeFile(join(root, 'bin/npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(exec(process.execPath, ['scripts/check-typescript-floor.mjs'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } }));
    assert.equal(JSON.parse(await readFile(join(root, '.release/typescript-floor.json'), 'utf8')).status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release plan binds the exact verified tarballs in dependency order', () => fixture(async root => {
  const plan = await preflight(root);
  assert.deepEqual(plan.packages.map(pkg => pkg.directory), releasePackages);
  assert.deepEqual(plan.packages.map(pkg => pkg.name), ['@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi']);
  assert.deepEqual(plan.packages.map(pkg => pkg.filename), [`parcha-agentrun-dsl-${version}.tgz`, `parcha-agentrun-jev-${version}.tgz`, `parcha-agentrun-pi-${version}.tgz`]);
  assert.ok(plan.packages.every(pkg => /^sha512-/.test(pkg.integrity) && /^[a-f0-9]{64}$/.test(pkg.sha256)));
}));
test('unlicensed source and inconsistent tags fail before publication', () => fixture(async root => {
  await assert.rejects(releasePreflight(root, 'v0.1.0', { checkGit: false }), /Tag must match/);
  await putJson(join(root, 'package.json'), { version, license: 'UNLICENSED' });
  await assert.rejects(preflight(root), /approved MIT or Apache/);
}));
test('public identity, exact dependencies and beta-only policy are mandatory', () => {
  for (const [key, value, reason] of [['repository', undefined, /repository metadata/], ['bugs', undefined, /issue tracker/], ['publishConfig', { access: 'public', tag: 'latest' }, /only publishes beta/], ['version', '0.1.0', /versions must match/], ['license', 'UNLICENSED', /approved root license/], ['dependencies', { '@parcha/agentrun-dsl': '^0.1.0' }, /exact release version/]]) {
    assert.throws(() => checkManifest({ ...manifest('jev'), [key]: value }, 'jev', version, 'MIT'), reason);
  }
});
test('a changed archive is not released with an older receipt', () => fixture(async root => {
  await writeFile(join(root, '.release/packages', `parcha-agentrun-dsl-${version}.tgz`), 'changed');
  await assert.rejects(preflight(root), /archive bytes changed/);
}));
test('a changed build cannot reuse previously verified package bytes', () => fixture(async root => {
  await writeFile(join(root, 'packages/dsl/dist/index.js'), 'export const fixture = false;\n');
  await assert.rejects(preflight(root), /Current package contents differ/);
}));
test('an added root notice must also be packed', () => fixture(async root => {
  await writeFile(join(root, 'NOTICE'), 'Example attribution\n');
  await assert.rejects(preflight(root), /NOTICE/);
}));
test('even a hash-matching verified archive is refused without its license', () => fixture(async root => {
  const staging = join(root, 'license-free');
  await mkdir(join(staging, 'package/dist'), { recursive: true });
  await cp(join(root, 'packages/dsl/package.json'), join(staging, 'package/package.json'));
  await cp(join(root, 'packages/dsl/dist/index.js'), join(staging, 'package/dist/index.js'));
  const archive = join(root, '.release/packages', `parcha-agentrun-dsl-${version}.tgz`);
  await exec('tar', ['-czf', archive, '-C', staging, 'package']);
  const receiptPath = join(root, '.release/verification.json');
  const receipt = JSON.parse(await readFile(receiptPath));
  receipt.packages[0].sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await putJson(receiptPath, receipt);
  await assert.rejects(preflight(root), /LICENSE/);
}));
test('incomplete or unsuccessful verification cannot approve release', () => fixture(async root => {
  const path = join(root, '.release/verification.json');
  const receipt = JSON.parse(await readFile(path));
  await putJson(path, { ...receipt, runtimeSmoke: { core: true, jev: true, network: 'prohibited' } });
  await assert.rejects(preflight(root), /All three installed package smoke checks/);
  await putJson(path, { ...receipt, packages: receipt.packages.slice(0, 2) });
  await assert.rejects(preflight(root), /exactly three verified packages/);
  await putJson(path, { ...receipt, status: 'failed' });
  await assert.rejects(preflight(root), /verification must pass/);
  await putJson(path, { ...receipt, audit: { vulnerabilities: { high: 1, critical: 0 } } });
  await assert.rejects(preflight(root), /High dependency advisories/);
}));

test('Pi release rejects a missing, stale, or ranged Jev dependency', () => {
  for (const dependency of [undefined, '0.0.1', '^' + version]) {
    const candidate = manifest('pi');
    candidate.dependencies['@parcha/agentrun-jev'] = dependency;
    assert.throws(() => checkManifest(candidate, 'pi', version, 'MIT'), /exact Jev release version/);
  }
  checkManifest(manifest('pi'), 'pi', version, 'MIT');
});


test('Apache release preserves the approved root license and notices in every archive', () => fixture(async root => {
  const apache = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
  const notice = 'Copyright 2026 Example Company\n';
  await putJson(join(root, 'package.json'), { version, license: 'Apache-2.0', private: true });
  await writeFile(join(root, 'LICENSE'), apache);
  await writeFile(join(root, 'NOTICE'), notice);
  for (const directory of releasePackages) {
    const cwd = join(root, 'packages', directory);
    await putJson(join(cwd, 'package.json'), { ...manifest(directory), license: 'Apache-2.0', files: ['dist', 'LICENSE', 'NOTICE'] });
    await writeFile(join(cwd, 'LICENSE'), apache);
    await writeFile(join(cwd, 'NOTICE'), notice);
  }
  await recordPackages(root);
  const plan = await preflight(root);
  assert.equal(plan.license, 'Apache-2.0');
  assert.deepEqual(plan.packages.map(pkg => pkg.name), ['@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi']);
  await writeFile(join(root, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n' + 'x'.repeat(1000));
  await assert.rejects(preflight(root), /Apache license text is incomplete/);
  await writeFile(join(root, 'LICENSE'), apache);
  await writeFile(join(root, 'packages/pi/NOTICE'), 'Different attribution\n');
  await recordPackages(root);
  await assert.rejects(preflight(root), /mismatched NOTICE/);
}));
