#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditBlockers } from './audit-exceptions.mjs';

const exec = promisify(execFile);
// The packages a release may publish, by directory, in publication order: dependencies first (dsl, then jev and pi, which use it), the
// packages that depend on none of them after. This list is the gate for a new package: a workspace package that is not private and not
// named here fails the preflight, so a package is never published (or half-released, on a missing trusted publisher) by accident.
export const releasePackageNames = { dsl: '@parcha/agentrun-dsl', jev: '@parcha/agentrun-jev', pi: '@parcha/agentrun-pi', 'pi-durable-archil': '@parcha/pi-durable-archil', 'pi-browser': '@parcha/pi-browser' };
export const listedPackages = Object.keys(releasePackageNames);
// A package whose own manifest says "private": true is held: it is built, tested, typechecked, verified and checked to be at the workspace
// version like every package, and it is never published. Lifting a hold removes that one flag; the publish set below follows it.
const here = dirname(fileURLToPath(import.meta.url));
const isHeld = directory => JSON.parse(readFileSync(join(here, '..', 'packages', directory, 'package.json'), 'utf8')).private === true;
export const heldPackages = listedPackages.filter(isHeld);
/** What a release publishes, in order: the listed packages that are not held. */
export const releasePackages = listedPackages.filter(directory => !heldPackages.includes(directory));
const repository = 'git+https://github.com/Parcha-ai/agentrun.git';
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
export function checkReleaseDispatch(tag, commit, environment) {
  assert.equal(environment.GITHUB_REF, `refs/tags/${tag}`, 'Dispatch the workflow on the requested release tag so provenance names the right ref');
  assert.equal(environment.GITHUB_SHA, commit, 'Dispatch SHA must equal the checked-out release commit so provenance names the right source');
}
async function command(file, args, cwd) {
  return (await exec(file, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

export function checkManifest(manifest, directory, version, license) {
  assert.equal(manifest.name, releasePackageNames[directory], 'Unexpected package name');
  assert.equal(manifest.version, version, 'Package versions must match the workspace version');
  assert.equal(manifest.license, license, 'Every package must use the approved root license');
  assert.equal(manifest.private, undefined, 'Release packages must not be private');
  assert.deepEqual(manifest.repository, { type: 'git', url: repository, directory: `packages/${directory}` }, 'Public repository metadata is incomplete');
  assert.equal(manifest.homepage, 'https://agentrun.ai', 'Set the canonical public homepage');
  assert.deepEqual(manifest.bugs, { url: 'https://github.com/Parcha-ai/agentrun/issues' }, 'Set the public issue tracker');
  assert.equal(manifest.publishConfig?.access, 'public', 'Publication must explicitly be public');
  assert.equal(manifest.publishConfig?.tag, 'beta', 'This release workflow only publishes beta');
  if (manifest.publishConfig.registry !== undefined) assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/', 'Unexpected publication registry');
  if (directory === 'jev' || directory === 'pi') assert.equal(manifest.dependencies?.['@parcha/agentrun-dsl'], version, 'Internal dependencies must use the exact release version');
  if (directory === 'pi') assert.equal(manifest.dependencies?.['@parcha/agentrun-jev'], version, 'Pi must use the exact Jev release version');
}

// A high or critical advisory blocks publication unless a scoped, expiring exception in
// audit-exceptions.mjs accepts it, re-checked here against the raw report at publication time.
export async function checkReleaseAudit(root, counts, now = Date.now()) {
  if (!counts?.high && !counts?.critical) {
    assert.equal(counts?.high, 0, 'High dependency advisories block publication');
    assert.equal(counts?.critical, 0, 'Critical dependency advisories block publication');
    return;
  }
  let audit;
  try { audit = await json(join(root, '.release/npm-audit.json')); }
  catch (error) { if (error.code === 'ENOENT') assert.fail('High dependency advisories block publication; .release/npm-audit.json is missing'); throw error; }
  assert.deepEqual(audit.metadata?.vulnerabilities, counts, 'The audit report differs from the verification receipt');
  const { accepted, blocking } = auditBlockers(audit, now);
  assert.equal(accepted.length + blocking.length, counts.high + counts.critical, 'npm audit counts high or critical advisories it does not list');
  assert.ok(!blocking.some(entry => entry.severity === 'critical'), 'Critical dependency advisories block publication');
  assert.deepEqual(blocking, [], 'High dependency advisories block publication');
}

export async function releasePreflight(root, tag, { checkGit = true } = {}) {
  const workspace = await json(join(root, 'package.json'));
  assert.match(workspace.version, /^\d+\.\d+\.\d+-beta\.\d+$/, 'Only an explicit beta version can be released');
  assert.equal(tag, `v${workspace.version}`, 'Tag must match the exact workspace version');
  assert.ok(['MIT', 'Apache-2.0'].includes(workspace.license), 'Release requires an approved MIT or Apache-2.0 license; UNLICENSED is not publishable');
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.ok(license.length > 900, 'Root LICENSE must contain the complete approved license');
  if (workspace.license === 'MIT') assert.match(license, /Permission is hereby granted, free of charge/);
  else { assert.match(license, /Apache License/); assert.match(license, /Version 2\.0, January 2004/); assert.ok(license.length > 9000, 'Apache license text is incomplete'); }
  let notice;
  try { notice = await readFile(join(root, 'NOTICE'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let commit = null;
  if (checkGit) {
    commit = await command('git', ['rev-parse', 'HEAD'], root);
    assert.equal(await command('git', ['rev-parse', `refs/tags/${tag}^{commit}`], root), commit, 'Release tag must identify the checked-out source');
    assert.equal(await command('git', ['status', '--porcelain'], root), '', 'Release source must be committed and clean');
    if (process.env.GITHUB_ACTIONS === 'true') checkReleaseDispatch(tag, commit, process.env);
  }
  const receipt = await json(join(root, '.release/verification.json'));
  assert.equal(receipt.status, 'passed', 'Clean package verification must pass first');
  assert.deepEqual(receipt.runtimeSmoke, { core: true, jev: true, pi: true, archil: true, browser: true, network: 'prohibited' }, 'All installed package smoke checks are required');
  await checkReleaseAudit(root, receipt.audit?.vulnerabilities);
  assert.equal(receipt.packages?.length, listedPackages.length, `Expected exactly ${listedPackages.length} verified packages`);
  // The gate for a new package: every workspace package that is not private is named in releasePackageNames.
  for (const directory of await readdir(join(root, 'packages'))) {
    const manifest = await json(join(root, 'packages', directory, 'package.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (manifest && manifest.private !== true) assert.ok(listedPackages.includes(directory), `Workspace package ${directory} is neither private nor named in releasePackageNames (scripts/release-preflight.mjs); add it there, or mark it private, before a release`);
  }
  // Held and published are read from the tree being checked, not from the checkout this script runs in: a package is held when its manifest in
  // `root` says private. (The constants exported above are the same reading of this checkout, for the workflow.)
  const heldHere = [];
  for (const directory of listedPackages) if ((await json(join(root, 'packages', directory, 'package.json'))).private === true) heldHere.push(directory);
  const releaseHere = listedPackages.filter(directory => !heldHere.includes(directory));
  // A held package is bumped with the workspace like the rest and skipped only at publication.
  for (const directory of heldHere) {
    const held = await json(join(root, 'packages', directory, 'package.json'));
    assert.equal(held.version, workspace.version, `Held package ${releasePackageNames[directory]} must be at the workspace version ${workspace.version}, found ${held.version}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'agentrun-release-preflight-'));
  const packages = [];
  try {
    for (const directory of releaseHere) {
      const manifest = await json(join(root, 'packages', directory, 'package.json'));
      checkManifest(manifest, directory, workspace.version, workspace.license);
      const verified = receipt.packages.find(entry => entry.name === manifest.name);
      assert.ok(verified, `Missing verification receipt for ${manifest.name}`);
      assert.equal(verified.version, manifest.version);
      const filename = `${manifest.name.slice(1).replace('/', '-')}-${workspace.version}.tgz`;
      assert.equal(verified.filename, filename, 'Unexpected verified archive filename');
      const archive = join(root, '.release/packages', filename);
      const bytes = await readFile(archive);
      assert.equal(digest(bytes), verified.sha256, 'Verified archive bytes changed');
      const packedManifest = JSON.parse(await command('tar', ['-xOf', archive, 'package/package.json'], root));
      assert.deepEqual(packedManifest, manifest, 'Packed metadata differs from the release source');
      assert.equal((await command('tar', ['-xOf', archive, 'package/LICENSE'], root)).trim(), license.trim(), `Missing or mismatched LICENSE in ${manifest.name}`);
      // A package may carry third-party notices after the repository's NOTICE (pi-browser keeps Stagehand's MIT licence), never instead of
      // it: the packed NOTICE is the root NOTICE exactly, or the root NOTICE, a blank line, and more. A truncated or edited root header
      // is not a prefix that passes.
      if (notice !== undefined) {
        const packedNotice = (await command('tar', ['-xOf', archive, 'package/NOTICE'], root)).trim();
        assert.ok(packedNotice === notice.trim() || packedNotice.startsWith(`${notice.trim()}\n\n`), `Missing or mismatched NOTICE in ${manifest.name}`);
      }
      // Bind the checked source/build to the already verified bytes. Publish these exact archives, never a fresh pack.
      const [repacked] = JSON.parse(await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', directory)));
      assert.equal(digest(await readFile(join(temporary, repacked.filename))), verified.sha256, 'Current package contents differ from the verified archive');
      packages.push({ name: manifest.name, version: manifest.version, directory, filename, sha256: verified.sha256, integrity: `sha512-${digest(bytes, 'sha512')}` });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { status: 'passed', tag, commit, license: workspace.license, registry: 'https://registry.npmjs.org/', distTag: 'beta', packages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(process.argv.length, 4, 'Usage: node scripts/release-preflight.mjs --tag v0.1.0-beta.1');
  assert.equal(process.argv[2], '--tag');
  const output = join(root, '.release/release-plan.json');
  await rm(output, { force: true });
  const result = await releasePreflight(root, process.argv[3]);
  await mkdir(join(root, '.release'), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Release preflight passed for ${result.tag} at ${result.commit}. Exact archive hashes: .release/release-plan.json`);
}
