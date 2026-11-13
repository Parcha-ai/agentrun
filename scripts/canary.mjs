#!/usr/bin/env node
// A canary from main: the release packages at one main commit, published under npm's `canary` dist-tag (never `latest`), so
// a tester runs main with `npx -y @parcha/agentrun@canary`. Two steps, each its own command:
//   node scripts/canary.mjs versions <run number> <commit sha>   set every listed package (held ones too) to its canary version, and every
//       exact pin between them; nothing is committed. x.y.z becomes x.y.(z+1)-canary.<run>.g<sha7>, x.y.z-beta.N becomes
//       x.y.z-canary.<run>.g<sha7>: above every beta of that core, below the next plain release.
//   node scripts/canary.mjs plan <commit sha>   after npm run verify:packages: .release/release-plan.json, the plan
//       verify-published --canary reads, from the archives verify-packages verified (.release/verification.json).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listedPackages, releasePackages } from './release-preflight.mjs';
import { isMain } from './is-main.mjs';

const CANARY = /-canary\.\d+\.g[0-9a-f]{7}$/;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const manifestPath = (root, directory) => join(root, 'packages', directory, 'package.json');

/** The canary version of `version` for workflow run `run` at commit `sha` (the full 40 hex). */
export function canaryVersion(version, run, sha) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-beta\.\d+)?$/.exec(String(version));
  assert.ok(match, `${version} is not a version this repository releases (x.y.z or x.y.z-beta.N)`);
  assert.ok(Number.isSafeInteger(run) && run > 0, `the run number is a positive integer, not ${run}`);
  assert.match(String(sha), /^[0-9a-f]{40}$/, `a canary names its full commit sha, not ${sha}`);
  const [, major, minor, patch, beta] = match;
  return `${major}.${minor}.${beta ? patch : Number(patch) + 1}-canary.${run}.g${sha.slice(0, 7)}`;
}

/** Sets each package under `directories` to its canary version and every exact pin to another of them; returns name → version. */
export async function setCanaryVersions(root, directories, run, sha) {
  const manifests = await Promise.all(directories.map(directory => json(manifestPath(root, directory))));
  for (const manifest of manifests) assert.ok(!CANARY.test(manifest.version), `${manifest.name}@${manifest.version} is already a canary`);
  const versions = Object.fromEntries(manifests.map(manifest => [manifest.name, canaryVersion(manifest.version, run, sha)]));
  for (const [index, manifest] of manifests.entries()) {
    manifest.version = versions[manifest.name];
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) if (Object.hasOwn(versions, name)) manifest[field][name] = versions[name];
    }
    await writeFile(manifestPath(root, directories[index]), JSON.stringify(manifest, null, 2) + '\n');
  }
  return versions;
}

/** The publish plan of a canary at `commit`: each package's archive as verify-packages verified it, in `directories` order. */
export async function canaryPlan(root, directories, commit) {
  assert.match(String(commit), /^[0-9a-f]{40}$/);
  const receipt = await json(join(root, '.release/verification.json'));
  assert.equal(receipt.status, 'passed', 'The package verification must pass first (npm run verify:packages)');
  const suffix = `.g${commit.slice(0, 7)}`;
  const packages = [];
  for (const directory of directories) {
    const manifest = await json(manifestPath(root, directory));
    assert.ok(CANARY.test(manifest.version) && manifest.version.endsWith(suffix), `${manifest.name}@${manifest.version} names commit ${manifest.version.split('.g').at(-1)}, not ${commit.slice(0, 7)}`);
    const verified = receipt.packages?.find(entry => entry.name === manifest.name);
    assert.ok(verified, `the verification has no archive of ${manifest.name}`);
    assert.equal(verified.version, manifest.version);
    const bytes = await readFile(join(root, '.release/packages', verified.filename));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), verified.sha256, `the verified archive bytes changed: ${verified.filename}`);
    packages.push({ name: manifest.name, version: manifest.version, directory, filename: verified.filename, sha256: verified.sha256, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
  }
  return { status: 'passed', tag: 'canary', commit, registry: 'https://registry.npmjs.org/', distTag: 'canary', packages };
}

if (isMain(import.meta)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, ...args] = process.argv.slice(2);
  const usage = 'Usage: node scripts/canary.mjs versions <run number> <commit sha> | plan <commit sha>';
  if (command === 'versions' && args.length === 2) {
    // Every listed package, held ones too: verify:packages installs them all, so a held package's exact pins must follow
    // (a release bumps a held package with the rest and skips it only at publication). The plan publishes releasePackages.
    const versions = await setCanaryVersions(root, listedPackages, Number(args[0]), args[1]);
    for (const [name, version] of Object.entries(versions)) console.log(`${name}@${version}`);
  } else if (command === 'plan' && args.length === 1) {
    const plan = await canaryPlan(root, releasePackages, args[0]);
    await mkdir(join(root, '.release'), { recursive: true });
    await writeFile(join(root, '.release/release-plan.json'), JSON.stringify(plan, null, 2) + '\n');
    console.log(`Canary plan for ${args[0]}: ${plan.packages.length} packages. Exact archive hashes: .release/release-plan.json`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
}
