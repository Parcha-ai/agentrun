#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, '.release');
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = { status: 'running', startedAt: new Date().toISOString(), node: process.version, commands: [],
  limitations: ['Dependency installation uses the network; build and demonstrations prohibit Node networking.',
    'Model responses are scripted. This verifies downloaded source usability, not live model quality or publication rights.'] };
await mkdir(release, { recursive: true });
const saveReceipt = () => writeFile(join(release, 'source-consumer.json'), JSON.stringify(receipt, null, 2) + '\n');
await saveReceipt();
let temporary;

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, 'Source verification requires Node.js >=22.19.0');
  assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-source.mjs');
  temporary = await mkdtemp(join(tmpdir(), 'agentrun-source-consumer-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SystemRoot|TMPDIR|TEMP|TMP|LANG|LC_ALL)$/i.test(key)));
  const sourceReceipt = JSON.parse(await readFile(join(release, 'source-export-receipt.json'), 'utf8'));
  assert.equal(sourceReceipt.status, 'passed', 'Source export must pass before verification');
  assert.equal(sourceReceipt.archive.path, '.release/agentrun-dsl-source.tar.gz');
  const archive = join(temporary, 'source.tar.gz');
  await cp(join(root, sourceReceipt.archive.path), archive);
  const bytes = await readFile(archive);
  assert.equal(hash(bytes), sourceReceipt.archive.sha256, 'Archive hash differs from export receipt');
  assert.equal(bytes.length, sourceReceipt.archive.size, 'Archive size differs from export receipt');
  receipt.archive = { sha256: hash(bytes), size: bytes.length };
  async function run(command, args, cwd = temporary, expectedExit = 0, offline = false) {
    const record = { command: [command === process.execPath ? 'node' : command, ...args], network: offline ? 'prohibited' : 'allowed' };
    receipt.commands.push(record);
    try {
      const result = await exec(command, args, { cwd, env: offline ? { ...env, NODE_OPTIONS: `--import=${join(temporary, 'deny-network.mjs')}` } : env,
        timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      Object.assign(record, result, { exitCode: 0 });
    } catch (error) {
      Object.assign(record, { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? null });
      if (error.killed || typeof error.code !== 'number') throw new Error(`Command failed to finish: ${record.command.join(' ')}`);
    }
    assert.equal(record.exitCode, expectedExit, `${record.command.join(' ')} failed: ${record.stderr.slice(-3000) || record.stdout.slice(-3000)}`);
    return record.stdout;
  }
  const listing = (await run('tar', ['-tzf', archive])).trim().split('\n');
  assert.equal(new Set(listing).size, listing.length, 'Archive contains duplicate paths');
  for (const name of listing) {
    assert.ok(name.startsWith('agentrun-dsl-source/'), 'Archive path has an unexpected root');
    assert.ok(!/[\\\x00-\x1f\x7f]/.test(name), 'Archive contains an unsafe path');
    const parts = name.replace(/\/$/, '').split('/');
    assert.ok(parts.every(part => part && part !== '.' && part !== '..'), 'Archive path escapes source directory');
    assert.ok(!parts.includes('site') && !parts.includes('dist'), 'Source archive contains website or build output');
  }
  const types = (await run('tar', ['-tvzf', archive])).trim().split('\n');
  assert.equal(types.length, listing.length, 'Archive listings disagree');
  assert.ok(types.every(line => line.startsWith('-') || line.startsWith('d')), 'Archive links and special files are prohibited');
  const files = listing.filter(name => !name.endsWith('/')).map(name => name.slice('agentrun-dsl-source/'.length)).sort();
  assert.deepEqual(files, sourceReceipt.files.map(file => file.path).sort(), 'Archive inventory differs from export receipt');
  const treeHash = hash(sourceReceipt.files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
  assert.equal(treeHash, sourceReceipt.sourceTreeSha256, 'Source tree hash differs from export receipt');
  await run('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', temporary]);
  const consumer = join(temporary, 'agentrun-dsl-source');
  for (const file of sourceReceipt.files) {
    const content = await readFile(join(consumer, file.path));
    assert.equal(hash(content), file.sha256, `Extracted file differs from receipt: ${file.path}`);
    assert.equal(content.length, file.size, `Extracted file size differs from receipt: ${file.path}`);
  }
  receipt.source = { files: files.length, sha256: treeHash };
  await writeFile(join(temporary, 'deny-network.mjs'), `import net from 'node:net';
import http from 'node:http'; import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Networking prohibited during source consumer verification'); };
globalThis.fetch = denied; net.Socket.prototype.connect = denied;
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
syncBuiltinESMExports();
`);
  for (const name of ['user.npmrc', 'global.npmrc']) await writeFile(join(temporary, name), '');
  env.npm_config_userconfig = join(temporary, 'user.npmrc');
  env.npm_config_globalconfig = join(temporary, 'global.npmrc');
  env.npm_config_cache = join(temporary, 'npm-cache');
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  await run('npm', ['run', 'build'], consumer, 0, true);
  const demo = await run('npm', ['run', 'demo'], consumer, 0, true);
  assert.match(demo, /Report: Pilot the repository workflow first\./);
  assert.match(demo, /3 subquestions researched; 3 sources retained\./);
  assert.match(demo, /Calls: 3 tools, 3 system one decisions, 5 model steps\./);
  const empty = await run('npm', ['run', 'demo', '--', '--no-evidence'], consumer, 2, true);
  assert.match(empty, /Stopped before writing findings or a report\./);
  assert.match(empty, /1 model step\./);
  assert.doesNotMatch(empty, /^Report:/m);
  // The README's first workflow must run from the source archive without model access.
  for (const [scenario, expectedStatus, agentCalls, judgeCalls, exit] of [
    ['password', 'complete', 0, 1, 0],
    ['invoice', 'complete', 0, 1, 0],
    ['payment', 'complete', 1, 2, 0],
    ['unresolved', 'escalated', 1, 2, 2],
  ]) {
    const support = JSON.parse(await run(process.execPath, ['examples/run-support-answer.mjs', scenario], consumer, exit, true));
    assert.equal(support.mode, 'scripted adapters; no live calls');
    assert.equal(support.status, expectedStatus);
    assert.equal(support.agentCalls, agentCalls);
    assert.equal(support.judgeCalls, judgeCalls);
  }
  await run(process.execPath, ['examples/run-typed-research.ts', '--export', 'research.json'], consumer, 0, true);
  const graph = await run(process.execPath, ['packages/dsl/dist/cli.js', 'inspect', 'research.json'], consumer, 0, true);
  assert.match(graph, /research-one-question/);
  const inspected = JSON.parse(await run(process.execPath, ['packages/dsl/dist/cli.js', 'inspect', 'research.json', '--json'], consumer, 0, true));
  assert.equal(inspected.name, 'deep-research');
  assert.equal(inspected.checked, 'structure-only');
  assert.ok(inspected.nodes.some(node => node.kind === 'workflow' && node.childWorkflow === 'research-one-question'));
  receipt.graph = { name: inspected.name, sha256: inspected.sha256, nodes: inspected.nodes.length };
  receipt.piExtension = JSON.parse(await run(process.execPath, ['scripts/verify-pi-install.mjs'], consumer, 0, true));
  assert.equal(receipt.piExtension.nativeSkillExpansion, true);
  receipt.status = 'passed';
  console.log('Downloaded source: install, build, demos, graph export/inspection, and native Pi discovery passed. Receipt: .release/source-consumer.json');
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error instanceof Error ? error.message : 'Unknown source verification failure';
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await saveReceipt();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
