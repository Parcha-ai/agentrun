import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { checkManifest, checkReleaseAudit, checkReleaseDispatch, heldPackages, listedPackages, releasePackages, releasePackageNames, releasePreflight } from './release-preflight.mjs';

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
const manifest = directory => ({ name: releasePackageNames[directory], ...(heldPackages.includes(directory) ? { private: true } : {}), version, license: 'MIT', type: 'module', files: ['dist', 'LICENSE'],
  repository: { type: 'git', url: 'git+https://github.com/Parcha-ai/agentrun.git', directory: `packages/${directory}` },
  homepage: 'https://agentrun.ai', bugs: { url: 'https://github.com/Parcha-ai/agentrun/issues' }, publishConfig: { access: 'public', tag: 'beta' },
  ...(directory === 'dsl' || directory === 'pi-durable-archil' || directory === 'pi-browser' ? {} : { dependencies: { '@parcha/agentrun-dsl': version, ...(directory === 'pi' ? { '@parcha/agentrun-jev': version } : {}) } }),
});
const putJson = (path, value) => writeFile(path, JSON.stringify(value));
let baseline;
before(async () => {
  baseline = await mkdtemp(join(tmpdir(), 'agentrun-release-fixture-'));
  await mkdir(join(baseline, '.release/packages'), { recursive: true });
  await putJson(join(baseline, 'package.json'), { version, license: 'MIT', private: true });
  await writeFile(join(baseline, 'LICENSE'), license);
  for (const directory of listedPackages) {
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
  for (const directory of listedPackages) {
    const [packed] = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(root, '.release/packages')], { cwd: join(root, 'packages', directory) })).stdout);
    const sha256 = createHash('sha256').update(await readFile(join(root, '.release/packages', packed.filename))).digest('hex');
    packages.push({ name: packed.name, version, filename: packed.filename, sha256 });
  }
  await putJson(join(root, '.release/verification.json'), { status: 'passed', packages,
    runtimeSmoke: { core: true, jev: true, pi: true, archil: true, browser: true, network: 'prohibited' }, audit: { vulnerabilities: { high: 0, critical: 0 } } });
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
  assert.deepEqual(plan.packages.map(pkg => pkg.name), ['@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi', '@parcha/pi-durable-archil']);
  assert.deepEqual(plan.packages.map(pkg => pkg.filename), [`parcha-agentrun-dsl-${version}.tgz`, `parcha-agentrun-jev-${version}.tgz`, `parcha-agentrun-pi-${version}.tgz`, `parcha-pi-durable-archil-${version}.tgz`]);
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
  await assert.rejects(preflight(root), /All installed package smoke checks/);
  await putJson(path, { ...receipt, packages: receipt.packages.slice(0, 2) });
  await assert.rejects(preflight(root), /exactly 5 verified packages/);
  await putJson(path, { ...receipt, status: 'failed' });
  await assert.rejects(preflight(root), /verification must pass/);
  await putJson(path, { ...receipt, audit: { vulnerabilities: { high: 1, critical: 0 } } });
  await assert.rejects(preflight(root), /High dependency advisories/);
}));

test('only the scoped, unexpired audit exception admits a high advisory to publication', () => fixture(async root => {
  const advisory = id => ({ url: `https://github.com/advisories/${id}`, severity: 'high' });
  const entry = (overrides = {}) => ({ severity: 'high', nodes: ['node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion'],
    via: ['GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr'].map(advisory), ...overrides });
  const counts = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 };
  const report = vulnerabilities => putJson(join(root, '.release/npm-audit.json'), { vulnerabilities, metadata: { vulnerabilities: counts } });
  const before = Date.parse('2026-10-02T00:00:00Z');
  await assert.rejects(checkReleaseAudit(root, counts, before), /High dependency advisories block publication; .release\/npm-audit.json is missing/);
  await report({ 'brace-expansion': entry() });
  await checkReleaseAudit(root, counts, before);
  await assert.rejects(checkReleaseAudit(root, counts, Date.parse('2026-12-01T00:00:00Z')), /High dependency advisories/);
  await assert.rejects(checkReleaseAudit(root, { ...counts, high: 2, total: 2 }, before), /differs from the verification receipt/);
  await report({ 'brace-expansion': entry({ nodes: ['node_modules/brace-expansion'] }) });
  await assert.rejects(checkReleaseAudit(root, counts, before), /High dependency advisories/);
  await report({ 'brace-expansion': entry({ via: [advisory('GHSA-aaaa-bbbb-cccc')] }) });
  await assert.rejects(checkReleaseAudit(root, counts, before), /High dependency advisories/);
  await report({});
  await assert.rejects(checkReleaseAudit(root, counts, before), /npm audit counts high or critical advisories it does not list/);
}));

test('the release path runs the audit exception check on the receipt it publishes', { skip: Date.now() >= Date.parse('2026-12-01T00:00:00Z') && 'the brace-expansion exception has expired' }, () => fixture(async root => {
  const counts = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 };
  const path = join(root, '.release/verification.json');
  await putJson(path, { ...JSON.parse(await readFile(path)), audit: { vulnerabilities: counts } });
  const vulnerabilities = { 'brace-expansion': { severity: 'high', nodes: ['node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion'],
    via: ['GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr'].map(id => ({ url: `https://github.com/advisories/${id}`, severity: 'high' })) } };
  await putJson(join(root, '.release/npm-audit.json'), { vulnerabilities, metadata: { vulnerabilities: { ...counts, high: 2, total: 2 } } });
  await assert.rejects(preflight(root), /differs from the verification receipt/);
  await putJson(join(root, '.release/npm-audit.json'), { vulnerabilities, metadata: { vulnerabilities: counts } });
  assert.equal((await preflight(root)).status, 'passed');
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
  for (const directory of listedPackages) {
    const cwd = join(root, 'packages', directory);
    await putJson(join(cwd, 'package.json'), { ...manifest(directory), license: 'Apache-2.0', files: ['dist', 'LICENSE', 'NOTICE'] });
    await writeFile(join(cwd, 'LICENSE'), apache);
    await writeFile(join(cwd, 'NOTICE'), notice);
  }
  await recordPackages(root);
  const plan = await preflight(root);
  assert.equal(plan.license, 'Apache-2.0');
  assert.deepEqual(plan.packages.map(pkg => pkg.name), ['@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi', '@parcha/pi-durable-archil']);
  await writeFile(join(root, 'packages/pi-durable-archil/NOTICE'), `${notice}\nThird-party notice kept after the repository's.\n`);
  await recordPackages(root);
  assert.equal((await preflight(root)).packages.length, releasePackages.length, 'a published package may append third-party notices to the root NOTICE');
  // The root header must survive whole: a truncated header, or text run on from it without a blank line, is not an appended notice.
  for (const edited of ['Copyright 2026 Example\n\nThird-party notice.\n', `${notice.trimEnd()} and others\n\nThird-party notice.\n`, `${notice.trimEnd()}\nThird-party notice.\n`]) {
    await writeFile(join(root, 'packages/pi-durable-archil/NOTICE'), edited);
    await recordPackages(root);
    await assert.rejects(preflight(root), /mismatched NOTICE/, edited);
  }
  await writeFile(join(root, 'packages/pi-durable-archil/NOTICE'), notice);
  await recordPackages(root);
  await writeFile(join(root, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n' + 'x'.repeat(1000));
  await assert.rejects(preflight(root), /Apache license text is incomplete/);
  await writeFile(join(root, 'LICENSE'), apache);
  await writeFile(join(root, 'packages/pi/NOTICE'), 'Different attribution\n');
  await recordPackages(root);
  await assert.rejects(preflight(root), /mismatched NOTICE/);
}));

const repoPackages = () => readdirSync(new URL('../packages', import.meta.url)).filter(name => !name.startsWith('.')).sort();
const repoManifest = name => JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));

test('the publish set is the explicit release map minus the held packages, and a package marked private is never in it', () => {
  for (const name of listedPackages) {
    const held = repoManifest(name).private === true;
    assert.equal(heldPackages.includes(name), held, `${name}: held exactly when its manifest says private`);
    assert.equal(releasePackages.includes(name), !held, `${name}: published exactly when it is not held`);
  }
  assert.deepEqual(releasePackages, listedPackages.filter(name => !heldPackages.includes(name)));
  // A held package keeps what a published one has, so lifting the hold removes the flag and nothing else.
  for (const name of heldPackages) assert.equal(repoManifest(name).publishConfig?.access, 'public');
});

test('publication order is dependency order, fixed by the release map and not by directory listing', () => {
  assert.deepEqual(listedPackages, ['dsl', 'jev', 'pi', 'pi-durable-archil', 'pi-browser'], 'dsl before jev and pi, the packages that depend on none of them after');
  const names = new Map(listedPackages.map(directory => [releasePackageNames[directory], directory]));
  for (const directory of listedPackages) {
    for (const dependency of Object.keys(repoManifest(directory).dependencies ?? {})) {
      if (names.has(dependency)) assert.ok(listedPackages.indexOf(names.get(dependency)) < listedPackages.indexOf(directory), `${dependency} is published before ${releasePackageNames[directory]}, which depends on it`);
    }
  }
  assert.ok(releasePackages.every((directory, index) => index === 0 || listedPackages.indexOf(releasePackages[index - 1]) < listedPackages.indexOf(directory)), 'the publish set keeps that order');
});

test('a workspace package that is neither private nor in the release map fails the preflight; a private one does not', () => fixture(async root => {
  const extra = join(root, 'packages', 'pi-newcomer');
  await mkdir(extra, { recursive: true });
  await putJson(join(extra, 'package.json'), { name: '@parcha/pi-newcomer', version, license: 'MIT' });
  await assert.rejects(preflight(root), /pi-newcomer is neither private nor named in releasePackageNames/);
  await putJson(join(extra, 'package.json'), { name: '@parcha/pi-newcomer', version, license: 'MIT', private: true });
  assert.deepEqual((await preflight(root)).packages.map(pkg => pkg.directory), releasePackages, 'a private package needs no entry and is not published');
  assert.deepEqual(repoPackages(), [...listedPackages].sort(), 'the repository lists every package it has');
}));

test('the release workflow publishes the release set and names no package of its own', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /for package in \$\(node --input-type=module -e "import \{ releasePackages \} from '\.\/scripts\/release-preflight\.mjs'; console\.log\(releasePackages\.join\(' '\)\)"\); do/);
  for (const name of listedPackages) assert.doesNotMatch(workflow, new RegExp(`for package in [^\\n]*\\b${name}\\b`), `${name} is not hard-coded in the publish loop`);
});

test('a held package is checked at the workspace version, never published', () => fixture(async root => {
  assert.ok(heldPackages.length > 0, 'the repository holds a package while publishing is on hold; delete this test with the last hold');
  const [held] = heldPackages;
  const plan = await preflight(root);
  assert.ok(!plan.packages.some(pkg => pkg.directory === held || pkg.name === releasePackageNames[held]), 'a held package at the workspace version passes and is not in the publish set');
  assert.deepEqual(plan.packages.map(pkg => pkg.directory), releasePackages);
  const path = join(root, 'packages', held, 'package.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  await putJson(path, { ...current, version: '0.1.0-beta.2' });
  await assert.rejects(preflight(root), /Held package .* must be at the workspace version 0\.1\.0-beta\.1, found 0\.1\.0-beta\.2/);
  await putJson(path, { ...current, version });
  assert.equal((await preflight(root)).packages.length, releasePackages.length);
}));
