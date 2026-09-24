#!/usr/bin/env node
// Registry reads and a clean install only. This script never publishes or calls a model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePackageNames } from './release-preflight.mjs';

const exec = promisify(execFile);

export async function registryResponse(url, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), retryNotFound = false, timeoutMs = 10_000 } = {}) {
  const attempts = retryNotFound ? 61 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
      if (attempt === attempts - 1) throw error;
      await wait(5000);
      continue;
    }
    const transient = response.status === 429 || response.status >= 500 || (retryNotFound && response.status === 404);
    if (!transient || attempt === attempts - 1) return response;
    await response.body?.cancel();
    await wait(5000);
  }
}

// `npm install` resolves versions from the abbreviated packument (the install Accept header), which the
// registry serves and caches separately from the per-version document checked above. Both packuments
// must list every release version before the one clean install runs.
export const PACKUMENT_ACCEPT = { full: 'application/json', abbreviated: 'application/vnd.npm.install-v1+json' };

export async function waitForRegistryVersions(registry, packages, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 10_000, attempts = 61 } = {}) {
  let missing = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    missing = [];
    for (const pkg of packages) {
      for (const [view, accept] of Object.entries(PACKUMENT_ACCEPT)) {
        let response;
        try { response = await fetchImpl(`${registry}${encodeURIComponent(pkg.name)}`, { headers: { accept }, signal: AbortSignal.timeout(timeoutMs) }); }
        catch { missing.push(`${pkg.name}@${pkg.version} (${view}: request failed)`); continue; }
        const transient = response.status === 404 || response.status === 429 || response.status >= 500;
        if (!response.ok && !transient) throw new Error(`Registry rejected the ${view} packument of ${pkg.name}: HTTP ${response.status}`);
        if (!response.ok) { await response.body?.cancel(); missing.push(`${pkg.name}@${pkg.version} (${view}: HTTP ${response.status})`); continue; }
        const packument = await response.json();
        if (!packument?.versions || !Object.hasOwn(packument.versions, pkg.version)) missing.push(`${pkg.name}@${pkg.version} (${view})`);
      }
    }
    if (!missing.length) return { attempts: attempt + 1 };
    if (attempt < attempts - 1) await wait(5000);
  }
  throw new Error(`Registry packuments never listed ${missing.join(', ')}`);
}

export async function verifyPublished(root, selected, { allowAbsent = false, fetchImpl = fetch, wait } = {}) {
  assert.ok(['dsl', 'jev', 'pi', 'all'].includes(selected));
  assert.ok(!allowAbsent || selected !== 'all', 'Absence probes select exactly one package');
  const receiptPath = join(root, `.release/published-${selected}.json`);
  await mkdir(join(root, '.release'), { recursive: true });
  const receipt = { status: 'running', startedAt: new Date().toISOString(), packages: [], cleanRegistryInstall: false };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  try {
    const plan = JSON.parse(await readFile(join(root, '.release/release-plan.json'), 'utf8'));
    assert.equal(plan.status, 'passed');
    assert.equal(plan.registry, 'https://registry.npmjs.org/');
    assert.deepEqual(plan.packages.map(pkg => pkg.directory), ['dsl', 'jev', 'pi']);
    for (const pkg of plan.packages) {
      assert.equal(pkg.name, releasePackageNames[pkg.directory]);
      assert.match(pkg.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
    }
    const results = [];
    for (const pkg of plan.packages.filter(pkg => selected === 'all' || selected === pkg.directory)) {
      const metadataResponse = await registryResponse(`${plan.registry}${encodeURIComponent(pkg.name)}/${pkg.version}`, { fetchImpl, wait, retryNotFound: !allowAbsent });
      if (allowAbsent && metadataResponse.status === 404) {
        receipt.status = 'absent';
        receipt.tag = plan.tag;
        receipt.packages.push({ name: pkg.name, version: pkg.version, status: 'absent' });
        return receipt;
      }
      assert.ok(metadataResponse.ok, `Registry rejected ${pkg.name}: HTTP ${metadataResponse.status}`);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.name, pkg.name);
      assert.equal(metadata.version, pkg.version);
      assert.equal(metadata.dist.integrity, pkg.integrity, 'Published integrity differs from verified bytes');
      const url = new URL(metadata.dist.tarball);
      assert.equal(url.origin, 'https://registry.npmjs.org');
      const response = await registryResponse(url, { fetchImpl, wait, retryNotFound: true, timeoutMs: 30_000 });
      assert.ok(response.ok, 'Published tarball download failed');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), pkg.sha256, 'Published tarball differs from verified archive');
      results.push({ name: pkg.name, version: pkg.version, sha256: pkg.sha256, status: 'matched' });
    }
    if (selected === 'all') {
      receipt.registryVisible = await waitForRegistryVersions(plan.registry, plan.packages, { fetchImpl, wait });
      const consumer = await mkdtemp(join(tmpdir(), 'agentrun-registry-consumer-'));
      try {
        await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'agentrun-registry-consumer', private: true, type: 'module' }));
        await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org/', ...plan.packages.map(pkg => `${pkg.name}@${pkg.version}`)], { cwd: consumer, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
        for (const pkg of plan.packages) assert.equal(lock.packages[`node_modules/${pkg.name}`].integrity, pkg.integrity, 'Installed archive integrity mismatch');
        await writeFile(join(consumer, 'deny-network.mjs'), `import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module';
    const deny=()=>{throw new Error('Networking prohibited in registry smoke tests');};
    globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;syncBuiltinESMExports();\n`);
        await writeFile(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
    import {runTriageDemo} from '@parcha/agentrun-dsl/demo';
    import {createJevRunner} from '@parcha/agentrun-jev'; import {createPiRunner} from '@parcha/agentrun-pi';
    assert.equal(typeof createJevRunner,'function');assert.equal(typeof createPiRunner,'function');
    for(const scenario of ['billing','technical','ambiguous']){const {result}=await runTriageDemo(scenario);assert.equal(result.status,scenario==='ambiguous'?'escalated':'complete');}\n`);
        await exec(process.execPath, ['--import', './deny-network.mjs', 'smoke.mjs'], { cwd: consumer, timeout: 30_000, maxBuffer: 1024 * 1024 });
      } finally { await rm(consumer, { recursive: true, force: true }); }
    }
    Object.assign(receipt, { status: 'passed', tag: plan.tag, packages: results, cleanRegistryInstall: selected === 'all' });
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.message : 'Registry verification failed';
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--package', 'Usage: node scripts/verify-published.mjs --package dsl|jev|pi|all [--allow-absent]');
  assert.ok(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === '--allow-absent'));
  const selected = process.argv[3];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await verifyPublished(root, selected, { allowAbsent: process.argv[4] === '--allow-absent' });
    if (result.status === 'absent') {
      console.log(`Registry confirms ${selected} is absent at the release version.`);
      process.exitCode = 3;
    } else console.log(`Published ${selected}: exact verified bytes${selected === 'all' ? ' and clean registry installation' : ''} passed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Registry verification failed');
    process.exitCode = 1;
  }
}
